mock_provider "alicloud" {}

run "managed_data_is_durable_and_private" {
  command = plan

  module {
    source = "./modules/data"
  }

  assert {
    condition     = output.rds_high_availability && output.rds_encrypted && output.rds_deletion_protection
    error_message = "RDS must be HA, KMS encrypted and deletion protected"
  }

  assert {
    condition     = output.rds_pitr_enabled && output.backup_retention_days >= 7 && output.rpo_minutes <= 5
    error_message = "RDS backup policy must support the platform RPO and recovery window"
  }

  assert {
    condition     = output.tair_primary_replica && !output.tair_public_access && output.tair_encrypted
    error_message = "Tair must use encrypted private primary-replica topology"
  }

  assert {
    condition     = output.database_bootstrap_strategy == "kubernetes-job-with-kms-generated-credentials"
    error_message = "database users must not be provisioned with Terraform plaintext passwords"
  }
}

run "rocketmq_is_private_serverless_and_recoverable" {
  command = plan

  module {
    source = "./modules/messaging"
  }

  assert {
    condition     = output.serverless && output.private_vpc_only && output.storage_encrypted
    error_message = "RocketMQ must use encrypted Serverless capacity on private VPC endpoints"
  }

  assert {
    condition     = alltrue([for name in ["domain-events", "delayed-polling", "retry", "dead-letter"] : contains(output.topic_names, name)])
    error_message = "RocketMQ must define domain, polling, retry and dead-letter topics"
  }

  assert {
    condition     = output.max_retry_times > 0 && output.dead_letter_topic == "dead-letter"
    error_message = "consumer retry must be bounded and end in a DLQ"
  }
}

run "oss_is_private_versioned_and_lifecycle_managed" {
  command = plan

  module {
    source = "./modules/storage"
  }

  assert {
    condition     = output.private && output.public_access_blocked && output.encrypted && output.versioned
    error_message = "OSS must be private, public-blocked, encrypted and versioned"
  }

  assert {
    condition     = output.temp_expiration_hours == 24 && output.deleted_recovery_days == 7 && output.failed_expiration_days == 7
    error_message = "OSS lifecycle must enforce temporary and recovery windows"
  }

  assert {
    condition     = output.cross_region_critical_replication
    error_message = "critical configuration and non-rebuildable objects require cross-region replication"
  }
}
