mock_provider "alicloud" {}

run "rds_and_tair_are_durable" {
  command = plan

  assert {
    condition     = output.rds_high_availability && output.rds_encrypted && output.rds_deletion_protection
    error_message = "RDS durability controls are incomplete"
  }

  assert {
    condition     = output.rds_pitr_enabled && output.rpo_minutes <= 5
    error_message = "RDS recovery objectives are not met"
  }

  assert {
    condition     = output.tair_primary_replica && !output.tair_public_access && output.tair_encrypted
    error_message = "Tair durability controls are incomplete"
  }
}
