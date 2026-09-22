variable "account_id" {
  description = "Alibaba Cloud account ID; supplied by CI/environment tfvars."
  type        = string
  default     = "1234567890123456"
}

variable "rrsa_oidc_provider_arn" {
  description = "ACK RRSA OIDC provider ARN; supplied after the bootstrap plan."
  type        = string
  default     = "acs:ram::1234567890123456:oidc-provider/ack-rrsa"
}

variable "certificate_id" {
  description = "Certificate resource ID only; private key material never enters Terraform."
  type        = string
  default     = "cert-set-by-deployment"
}

locals {
  stack_name = "ai-video-${local.environment}"
}

module "network" {
  source = "../../modules/network"

  name     = local.stack_name
  vpc_cidr = var.vpc_cidr
  zones    = var.availability_zones
  tags     = local.common_tags
}

module "security" {
  source = "../../modules/security"

  name                   = local.stack_name
  region                 = var.region
  account_id             = var.account_id
  vpc_id                 = module.network.vpc_id
  vswitch_ids            = module.network.data_vswitch_ids
  zones                  = var.availability_zones
  rrsa_oidc_provider_arn = var.rrsa_oidc_provider_arn
  oss_bucket_name        = "ai-video-production-assets"
  rocketmq_instance_id   = "rmq-ai-video-production"
  tags                   = merge(local.common_tags, { CostCenter = "platform-security" })
}

module "ack" {
  source = "../../modules/ack"

  name                 = local.stack_name
  workload_vswitch_ids = module.network.workload_vswitch_ids
  pod_vswitch_ids      = module.network.workload_vswitch_ids
  security_group_id    = module.network.security_group_id
  kms_key_id           = module.security.kms_key_id
  sls_project_name     = local.stack_name
  tags                 = local.common_tags
}

module "data" {
  source = "../../modules/data"

  name               = local.stack_name
  zones              = var.availability_zones
  data_vswitch_ids   = module.network.data_vswitch_ids
  security_group_id  = module.network.security_group_id
  kms_key_id         = module.security.kms_key_id
  monthly_budget_cny = 1200
  tags               = merge(local.common_tags, { CostCenter = "platform-data" })
}

module "messaging" {
  source = "../../modules/messaging"

  name               = local.stack_name
  vpc_id             = module.network.vpc_id
  vswitch_id         = module.network.data_vswitch_ids[0]
  kms_key_id         = module.security.kms_key_id
  monthly_budget_cny = 500
  tags               = merge(local.common_tags, { CostCenter = "platform-messaging" })
}

module "storage" {
  source = "../../modules/storage"

  bucket_name                    = "ai-video-production-assets"
  kms_key_id                     = module.security.kms_key_id
  replication_destination_bucket = "ai-video-production-critical-dr"
  replication_destination_region = "oss-cn-shanghai"
  replication_role_arn           = "acs:ram::${var.account_id}:role/oss-replication"
  replica_kms_key_id             = "kms-dr-key-set-by-deployment"
  monthly_budget_cny             = 300
  tags                           = merge(local.common_tags, { CostCenter = "platform-storage" })
}

module "registry" {
  source = "../../modules/registry"

  name = local.stack_name
}

module "edge" {
  source = "../../modules/edge"

  name           = local.stack_name
  vpc_id         = module.network.vpc_id
  certificate_id = var.certificate_id
  zone_mappings = [
    for index, zone in var.availability_zones : {
      zone_id    = zone
      vswitch_id = module.network.workload_vswitch_ids[index]
    }
  ]
  hosts = {
    user  = "www.example.cn"
    admin = "admin.example.cn"
    api   = "api.example.cn"
  }
  tags = local.common_tags
}

module "observability" {
  source = "../../modules/observability"

  name             = local.stack_name
  region           = var.region
  ack_cluster_id   = module.ack.cluster_id
  kms_key_id       = module.security.kms_key_id
  sls_kms_role_arn = "acs:ram::${var.account_id}:role/aliyunlogdefaultrole"
  tags             = merge(local.common_tags, { CostCenter = "platform-observability" })
}

output "monthly_budget_policy" {
  value = {
    threshold_cny             = 3000
    alerts_percent            = [50, 80, 100]
    cost_center_activation    = "required-before-apply"
    terraform_provider_status = "budget-resource-not-supported"
  }
}
