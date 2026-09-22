mock_provider "alicloud" {}

run "managed_pro_auto_mode_is_hardened" {
  command = plan

  assert {
    condition     = output.cluster_spec == "ack.pro.small" && output.auto_mode_enabled
    error_message = "ACK must use managed Pro with Auto Mode"
  }

  assert {
    condition     = !output.api_server_public && output.node_zone_count >= 2
    error_message = "ACK must remain private and multi-zone"
  }

  assert {
    condition     = output.audit_logging_enabled && output.deletion_protection && output.workload_identity_enabled
    error_message = "ACK hardening controls are incomplete"
  }
}
