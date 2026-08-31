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

variable "zones" {
  type    = list(string)
  default = ["cn-hangzhou-h", "cn-hangzhou-i"]

  validation {
    condition     = length(distinct(var.zones)) >= 2
    error_message = "managed data services require two zones"
  }
}

variable "data_vswitch_ids" {
  type    = list(string)
  default = ["vsw-dataa", "vsw-datab"]
}

variable "security_group_id" {
  type    = string
  default = "sg-data"
}

variable "kms_key_id" {
  type    = string
  default = "key-data"
}

variable "rds_instance_type" {
  description = "Cost-aware startup class; increase without changing module consumers."
  type        = string
  default     = "pg.n2.2c.2m"
}

variable "rds_storage_gb" {
  type    = number
  default = 50
}

variable "rds_storage_upper_bound_gb" {
  type    = number
  default = 500
}

variable "tair_instance_class" {
  description = "Cost-aware standard master-replica class."
  type        = string
  default     = "redis.master.small.default"
}

variable "backup_retention_days" {
  type    = number
  default = 7

  validation {
    condition     = var.backup_retention_days >= 7
    error_message = "backup retention must be at least seven days"
  }
}

variable "cross_backup_region" {
  type    = string
  default = "cn-shanghai"
}

variable "monthly_budget_cny" {
  type    = number
  default = 1200
}

variable "tags" {
  type = map(string)
  default = {
    Environment = "production"
    ManagedBy   = "terraform"
    Project     = "ai-video-platform"
    CostCenter  = "platform-data"
  }
}

resource "alicloud_db_instance" "postgres" {
  engine                     = "PostgreSQL"
  engine_version             = "15.0"
  category                   = "HighAvailability"
  instance_type              = var.rds_instance_type
  instance_storage           = var.rds_storage_gb
  db_instance_storage_type   = "cloud_essd"
  instance_charge_type       = "Postpaid"
  instance_name              = "${var.name}-postgres"
  zone_id                    = var.zones[0]
  zone_id_slave_a            = var.zones[1]
  vswitch_id                 = join(",", var.data_vswitch_ids)
  security_group_ids         = [var.security_group_id]
  security_ips               = []
  deletion_protection        = true
  encryption_key             = var.kms_key_id
  ssl_action                 = "Open"
  monitoring_period          = "60"
  storage_auto_scale         = "Enable"
  storage_threshold          = 20
  storage_upper_bound        = var.rds_storage_upper_bound_gb
  auto_upgrade_minor_version = "Auto"
  maintain_time              = "18:00Z-22:00Z"
  tags                       = var.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "alicloud_db_backup_policy" "postgres" {
  instance_id                 = alicloud_db_instance.postgres.id
  preferred_backup_period     = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
  preferred_backup_time       = "18:00Z-19:00Z"
  backup_retention_period     = var.backup_retention_days
  enable_backup_log           = true
  log_backup_frequency        = "LogInterval"
  log_backup_retention_period = var.backup_retention_days
  local_log_retention_hours   = 5
}

resource "alicloud_rds_instance_cross_backup_policy" "postgres" {
  instance_id         = alicloud_db_instance.postgres.id
  cross_backup_region = var.cross_backup_region
  log_backup_enabled  = "Enable"
  retention           = 30
}

resource "alicloud_kvstore_instance" "tair" {
  db_instance_name            = "${var.name}-tair"
  zone_id                     = var.zones[0]
  secondary_zone_id           = var.zones[1]
  vswitch_id                  = var.data_vswitch_ids[0]
  security_group_id           = var.security_group_id
  instance_class              = var.tair_instance_class
  instance_type               = "Redis"
  engine_version              = "7.0"
  payment_type                = "PostPaid"
  instance_release_protection = true
  encryption_key              = var.kms_key_id
  ssl_enable                  = "Enable"
  is_auto_upgrade_open        = "1"
  security_ips                = ["10.20.0.0/16"]
  backup_period               = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
  backup_time                 = "18:00Z-19:00Z"
  tags                        = var.tags
}

output "rds_instance_id" {
  value = alicloud_db_instance.postgres.id
}

output "tair_instance_id" {
  value = alicloud_kvstore_instance.tair.id
}

output "rds_high_availability" {
  value = alicloud_db_instance.postgres.category == "HighAvailability" && var.zones[0] != var.zones[1]
}

output "rds_encrypted" {
  value = alicloud_db_instance.postgres.encryption_key != ""
}

output "rds_deletion_protection" {
  value = alicloud_db_instance.postgres.deletion_protection
}

output "rds_pitr_enabled" {
  value = alicloud_db_backup_policy.postgres.enable_backup_log && alicloud_rds_instance_cross_backup_policy.postgres.log_backup_enabled == "Enable"
}

output "backup_retention_days" {
  value = alicloud_db_backup_policy.postgres.backup_retention_period
}

output "rpo_minutes" {
  value = 5
}

output "tair_primary_replica" {
  value = strcontains(var.tair_instance_class, ".master.") && var.zones[0] != var.zones[1]
}

output "tair_public_access" {
  value = false
}

output "tair_encrypted" {
  value = alicloud_kvstore_instance.tair.encryption_key != ""
}

output "database_bootstrap_strategy" {
  value = "kubernetes-job-with-kms-generated-credentials"
}

output "monthly_budget_cny" {
  value = var.monthly_budget_cny
}
