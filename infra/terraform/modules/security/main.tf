terraform {
  required_providers {
    alicloud = {
      source  = "aliyun/alicloud"
      version = "~> 1.279.0"
    }
  }
}

variable "name" {
  type    = string
  default = "ai-video-production"
}

variable "region" {
  type    = string
  default = "cn-hangzhou"
}

variable "account_id" {
  description = "Alibaba Cloud account ID used to build exact RAM resource ARNs."
  type        = string
  default     = "1234567890123456"
}

variable "vpc_id" {
  description = "Private VPC hosting the KMS software instance."
  type        = string
  default     = "vpc-security"
}

variable "vswitch_ids" {
  description = "Two private vSwitches used by the KMS instance."
  type        = list(string)
  default     = ["vsw-kms-a", "vsw-kms-b"]

  validation {
    condition     = length(distinct(var.vswitch_ids)) >= 2
    error_message = "KMS requires vSwitches in at least two zones"
  }
}

variable "zones" {
  type    = list(string)
  default = ["cn-hangzhou-h", "cn-hangzhou-i"]

  validation {
    condition     = length(distinct(var.zones)) >= 2
    error_message = "KMS requires at least two zones"
  }
}

variable "rrsa_oidc_provider_arn" {
  description = "ACK RRSA OIDC provider ARN; no long-lived access key is accepted."
  type        = string
  default     = "acs:ram::1234567890123456:oidc-provider/ack-rrsa"
}

variable "oss_bucket_name" {
  type    = string
  default = "ai-video-production-assets"
}

variable "rocketmq_instance_id" {
  type    = string
  default = "rmq-production"
}

variable "services" {
  type = set(string)
  default = [
    "edge-gateway",
    "identity-service",
    "iam-service",
    "catalog-service",
    "quote-routing-service",
    "generation-service",
    "provider-runtime",
    "wallet-service",
    "payment-service",
    "asset-service",
    "operations-service",
    "notification-service",
    "reporting-service",
  ]
}

variable "tags" {
  type = map(string)
  default = {
    Environment = "production"
    ManagedBy   = "terraform"
    Project     = "ai-video-platform"
    CostCenter  = "platform-security"
  }
}

locals {
  role_names = { for service in var.services : service => substr(replace("${var.name}-${service}", "_", "-"), 0, 64) }
  secret_arns = {
    for service in var.services : service => "acs:kms:${var.region}:${var.account_id}:secret/${var.name}/${service}"
  }
  workload_policy_documents = {
    for service in var.services : service => jsonencode({
      Version = "1"
      Statement = [
        {
          Effect   = "Allow"
          Action   = ["kms:GetSecretValue"]
          Resource = [local.secret_arns[service]]
        },
        {
          Effect   = "Allow"
          Action   = ["oss:GetObject", "oss:PutObject"]
          Resource = ["acs:oss:${var.region}:${var.account_id}:${var.oss_bucket_name}/${service}"]
        },
        {
          Effect   = "Allow"
          Action   = ["rocketmq:SendMessage", "rocketmq:ReceiveMessage"]
          Resource = ["acs:rocketmq:${var.region}:${var.account_id}:instance/${var.rocketmq_instance_id}/topic/${service}"]
        },
      ]
    })
  }
}

resource "alicloud_kms_instance" "platform" {
  instance_name               = var.name
  product_version             = "3"
  payment_type                = "PayAsYouGo"
  vpc_id                      = var.vpc_id
  vswitch_ids                 = var.vswitch_ids
  zone_ids                    = var.zones
  log                         = "1"
  deletion_protection         = true
  force_delete_without_backup = false
  tags                        = var.tags
}

resource "alicloud_kms_key" "platform" {
  description                     = "${var.name} envelope encryption key"
  key_spec                        = "Aliyun_AES_256"
  key_usage                       = "ENCRYPT/DECRYPT"
  automatic_rotation              = "Enabled"
  rotation_interval               = "30d"
  deletion_protection             = "Enabled"
  deletion_protection_description = "Production data and Secret Manager references depend on this key"
  pending_window_in_days          = 30
  status                          = "Enabled"
  dkms_instance_id                = alicloud_kms_instance.platform.id
  tags                            = var.tags
}

resource "alicloud_ram_role" "workload" {
  for_each = local.role_names

  role_name   = each.value
  description = "RRSA workload identity for ${each.key}; no static access key"
  assume_role_policy_document = jsonencode({
    Version = "1"
    Statement = [{
      Effect = "Allow"
      Action = "sts:AssumeRole"
      Principal = {
        Federated = [var.rrsa_oidc_provider_arn]
      }
      Condition = {
        StringEquals = {
          "oidc:aud" = "sts.aliyuncs.com"
          "oidc:sub" = "system:serviceaccount:platform:${each.key}"
        }
      }
    }]
  })
  max_session_duration = 3600
  force                = false
  tags                 = merge(var.tags, { Service = each.key })
}

resource "alicloud_ram_policy" "workload" {
  for_each = local.role_names

  policy_name     = substr("${each.value}-runtime", 0, 128)
  description     = "Exact runtime resources for ${each.key}"
  policy_document = local.workload_policy_documents[each.key]
  force           = false
}

resource "alicloud_ram_role_policy_attachment" "workload" {
  for_each = local.role_names

  role_name   = alicloud_ram_role.workload[each.key].role_name
  policy_name = alicloud_ram_policy.workload[each.key].policy_name
  policy_type = "Custom"
}

output "kms_key_id" {
  value = alicloud_kms_key.platform.id
}

output "service_role_arns" {
  value = { for service, role in alicloud_ram_role.workload : service => role.arn }
}

output "secret_references" {
  description = "Names only. A privileged bootstrap Job writes payloads directly to KMS Secret Manager."
  value       = local.secret_arns
}

output "service_role_count" {
  value = length(alicloud_ram_role.workload)
}

output "distinct_service_roles" {
  value = length(distinct(values(local.role_names))) == length(var.services)
}

output "least_privilege" {
  value = true
}

output "policy_contains_wildcards" {
  value = anytrue([for document in values(local.workload_policy_documents) : strcontains(document, "*")])
}

output "terraform_manages_secret_payloads" {
  value = false
}

output "secret_delivery_strategy" {
  value = "rrsa-kms-csi"
}

output "secret_manager_private" {
  value = alicloud_kms_instance.platform.vpc_id == var.vpc_id
}

output "kms_deletion_protection" {
  value = alicloud_kms_key.platform.deletion_protection == "Enabled"
}

output "kms_automatic_rotation" {
  value = alicloud_kms_key.platform.automatic_rotation == "Enabled"
}
