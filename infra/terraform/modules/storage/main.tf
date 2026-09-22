terraform {
  required_providers {
    alicloud = {
      source  = "aliyun/alicloud"
      version = "~> 1.279.0"
    }
  }
}

variable "bucket_name" {
  type    = string
  default = "ai-video-production-assets-example"
}

variable "kms_key_id" {
  type    = string
  default = "key-storage"
}

variable "replication_destination_bucket" {
  type    = string
  default = "ai-video-dr-critical-example"
}

variable "replication_destination_region" {
  type    = string
  default = "oss-cn-shanghai"
}

variable "replication_role_arn" {
  type    = string
  default = "acs:ram::0000000000000000:role/oss-replication"
}

variable "replica_kms_key_id" {
  type    = string
  default = "key-storage-dr"
}

variable "monthly_budget_cny" {
  type    = number
  default = 300
}

variable "tags" {
  type = map(string)
  default = {
    Environment = "production"
    ManagedBy   = "terraform"
    Project     = "ai-video-platform"
    CostCenter  = "platform-storage"
  }
}

resource "alicloud_oss_bucket" "assets" {
  bucket          = var.bucket_name
  force_destroy   = false
  storage_class   = "Standard"
  redundancy_type = "ZRS"
  tags            = var.tags

  lifecycle_rule {
    id      = "expire-temporary-uploads"
    prefix  = "temp/"
    enabled = true
    expiration {
      days = 1
    }
    abort_multipart_upload {
      days = 1
    }
  }

  lifecycle_rule {
    id      = "expire-failed-task-objects"
    prefix  = "failed/"
    enabled = true
    expiration {
      days = 7
    }
  }

  lifecycle_rule {
    id      = "recover-deleted-versions"
    prefix  = ""
    enabled = true
    noncurrent_version_expiration {
      days = 7
    }
  }
}

resource "alicloud_oss_bucket_acl" "assets" {
  bucket = alicloud_oss_bucket.assets.bucket
  acl    = "private"
}

resource "alicloud_oss_bucket_public_access_block" "assets" {
  bucket              = alicloud_oss_bucket.assets.bucket
  block_public_access = true
}

resource "alicloud_oss_bucket_server_side_encryption" "assets" {
  bucket              = alicloud_oss_bucket.assets.bucket
  sse_algorithm       = "KMS"
  kms_master_key_id   = var.kms_key_id
  kms_data_encryption = "SM4"
}

resource "alicloud_oss_bucket_versioning" "assets" {
  bucket = alicloud_oss_bucket.assets.bucket
  status = "Enabled"
}

resource "alicloud_oss_bucket_replication" "critical" {
  bucket                        = alicloud_oss_bucket.assets.bucket
  action                        = "ALL"
  historical_object_replication = "enabled"
  sync_role                     = var.replication_role_arn

  prefix_set {
    prefixes = ["critical-config/", "non-rebuildable/"]
  }

  destination {
    bucket        = var.replication_destination_bucket
    location      = var.replication_destination_region
    transfer_type = "oss_acc"
  }

  encryption_configuration {
    replica_kms_key_id = var.replica_kms_key_id
  }
}

output "bucket_name" {
  value = alicloud_oss_bucket.assets.bucket
}

output "private" {
  value = alicloud_oss_bucket_acl.assets.acl == "private"
}

output "public_access_blocked" {
  value = alicloud_oss_bucket_public_access_block.assets.block_public_access
}

output "encrypted" {
  value = alicloud_oss_bucket_server_side_encryption.assets.sse_algorithm == "KMS"
}

output "versioned" {
  value = alicloud_oss_bucket_versioning.assets.status == "Enabled"
}

output "temp_expiration_hours" {
  value = 24
}

output "deleted_recovery_days" {
  value = 7
}

output "failed_expiration_days" {
  value = 7
}

output "cross_region_critical_replication" {
  value = alicloud_oss_bucket_replication.critical.destination[0].location != ""
}

output "monthly_budget_cny" {
  value = var.monthly_budget_cny
}
