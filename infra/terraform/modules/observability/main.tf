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

variable "ack_cluster_id" {
  type    = string
  default = "ack-production"
}

variable "kms_key_id" {
  type    = string
  default = "key-telemetry"
}

variable "sls_kms_role_arn" {
  type    = string
  default = "acs:ram::1234567890123456:role/aliyunlogdefaultrole"
}

variable "application_retention_days" {
  type    = number
  default = 30
}

variable "audit_retention_days" {
  type    = number
  default = 180
}

variable "security_retention_days" {
  type    = number
  default = 180
}

variable "alert_dispatch_rule_id" {
  description = "ARMS dispatch rule backed by on-call contacts; configured outside Terraform state."
  type        = string
  default     = "dispatch-platform-oncall"
}

variable "tags" {
  type = map(string)
  default = {
    Environment = "production"
    ManagedBy   = "terraform"
    Project     = "ai-video-platform"
    CostCenter  = "platform-observability"
  }
}

locals {
  logstores = {
    application = var.application_retention_days
    audit       = var.audit_retention_days
    security    = var.security_retention_days
  }
  alerts = {
    api_error_rate = {
      expression = "sum(rate(http_requests_total{status=~\"5..\"}[5m])) / sum(rate(http_requests_total[5m])) > 0.05"
      duration   = "5m"
      message    = "API 5xx rate exceeds 5% for five minutes"
    }
    api_latency = {
      expression = "histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le)) > 2"
      duration   = "5m"
      message    = "API p95 latency exceeds two seconds"
    }
    workload_availability = {
      expression = "sum(kube_deployment_status_replicas_available) < sum(kube_deployment_spec_replicas)"
      duration   = "10m"
      message    = "One or more production replicas remain unavailable"
    }
  }
}

resource "alicloud_log_project" "platform" {
  project_name = substr(replace(var.name, "_", "-"), 0, 63)
  description  = "Encrypted application, audit and security telemetry"
  tags         = var.tags
}

resource "alicloud_log_store" "platform" {
  for_each = local.logstores

  project_name          = alicloud_log_project.platform.project_name
  logstore_name         = each.key
  retention_period      = each.value
  hot_ttl               = 30
  infrequent_access_ttl = each.value > 30 ? 30 : null
  shard_count           = 2
  auto_split            = true
  max_split_shard_count = 32
  append_meta           = true
  mode                  = "standard"

  encrypt_conf {
    enable       = true
    encrypt_type = "default"
    user_cmk_info {
      cmk_key_id = var.kms_key_id
      arn        = var.sls_kms_role_arn
      region_id  = var.region
    }
  }
}

resource "alicloud_arms_environment" "ack" {
  environment_name     = "${var.name}-ack"
  environment_type     = "CS"
  environment_sub_type = "ACK"
  managed_type         = "agent"
  bind_resource_id     = var.ack_cluster_id
  tags                 = var.tags
}

resource "alicloud_arms_prometheus_alert_rule" "platform" {
  for_each = local.alerts

  cluster_id                 = var.ack_cluster_id
  prometheus_alert_rule_name = "${var.name}-${replace(each.key, "_", "-")}"
  expression                 = each.value.expression
  duration                   = each.value.duration
  message                    = each.value.message
  notify_type                = "ALERT_MANAGER"
  dispatch_rule_id           = var.alert_dispatch_rule_id
  type                       = "CUSTOM"
}

output "sls_project_name" {
  value = alicloud_log_project.platform.project_name
}

output "application_retention_days" {
  value = alicloud_log_store.platform["application"].retention_period
}

output "audit_retention_days" {
  value = alicloud_log_store.platform["audit"].retention_period
}

output "security_retention_days" {
  value = alicloud_log_store.platform["security"].retention_period
}

output "log_encryption" {
  value = true
}

output "prometheus_enabled" {
  value = alicloud_arms_environment.ack.environment_type == "CS"
}

output "alerting_enabled" {
  value = length(alicloud_arms_prometheus_alert_rule.platform) > 0
}

output "archive_policy" {
  value = "audit-security-infrequent-after-30d"
}
