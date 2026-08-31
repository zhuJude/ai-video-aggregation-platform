mock_provider "alicloud" {}

run "network_is_private_and_multi_zone" {
  command = plan

  module {
    source = "./modules/network"
  }

  variables {
    snat_table_id_override = "stb-test"
  }

  assert {
    condition     = output.workload_vswitch_count == 2 && output.data_vswitch_count == 2
    error_message = "workload and data vSwitches must span two zones"
  }

  assert {
    condition     = output.private_ingress_only && output.controlled_nat_egress
    error_message = "network must deny public ingress and use controlled NAT egress"
  }
}

run "ack_is_protected_pro_auto_mode" {
  command = plan

  module {
    source = "./modules/ack"
  }

  assert {
    condition     = output.cluster_spec == "ack.pro.small" && output.auto_mode_enabled
    error_message = "ACK must use managed Pro with Auto Mode"
  }

  assert {
    condition     = !output.api_server_public && output.node_zone_count >= 2
    error_message = "ACK API must be private and nodes must span two zones"
  }

  assert {
    condition     = output.audit_logging_enabled && output.deletion_protection && output.workload_identity_enabled
    error_message = "ACK must enable audit logging, deletion protection and workload identity"
  }
}

run "edge_allows_only_waf_https" {
  command = plan

  module {
    source = "./modules/edge"
  }

  assert {
    condition     = output.waf_enabled && output.https_only && output.tls_policy == "tls_cipher_policy_1_2_strict"
    error_message = "public traffic must enter through WAF-enabled ALB using TLS 1.2+"
  }

  assert {
    condition     = length(output.allowed_hosts) == 3
    error_message = "edge must route user, admin and API hosts explicitly"
  }
}
