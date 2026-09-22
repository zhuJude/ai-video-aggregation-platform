mock_provider "alicloud" {}

run "workload_identities_are_isolated_and_secretless" {
  command = plan

  module {
    source = "./modules/security"
  }

  assert {
    condition     = output.service_role_count == 13 && output.distinct_service_roles
    error_message = "each platform service requires a distinct RRSA workload role"
  }

  assert {
    condition     = output.least_privilege && !output.policy_contains_wildcards
    error_message = "RAM policies must scope actions and resources without wildcards"
  }

  assert {
    condition     = output.terraform_manages_secret_payloads == false && output.secret_delivery_strategy == "rrsa-kms-csi"
    error_message = "Terraform must never place application secret payloads in state"
  }

  assert {
    condition     = output.kms_deletion_protection && output.kms_automatic_rotation && output.secret_manager_private
    error_message = "KMS keys require deletion protection, rotation and private Secret Manager capacity"
  }
}

run "registry_is_private_scanned_and_signed" {
  command = plan

  module {
    source = "./modules/registry"
  }

  assert {
    condition     = output.private_repository && !output.automatic_repository_creation
    error_message = "ACR must only expose explicitly managed private repositories"
  }

  assert {
    condition     = output.vulnerability_scan_gate && output.signature_gate && output.digest_only_production
    error_message = "production images require scan, signature and immutable digest gates"
  }
}

run "telemetry_is_encrypted_and_retained_by_class" {
  command = plan

  module {
    source = "./modules/observability"
  }

  assert {
    condition     = output.application_retention_days == 30 && output.audit_retention_days >= 180 && output.security_retention_days >= 180
    error_message = "application logs require 30 days and audit/security logs at least 180 days"
  }

  assert {
    condition     = output.log_encryption && output.prometheus_enabled && output.alerting_enabled
    error_message = "SLS logs must be encrypted and ACK metrics must feed ARMS alerts"
  }
}
