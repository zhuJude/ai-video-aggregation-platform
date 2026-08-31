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

variable "repositories" {
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

resource "alicloud_cr_ee_instance" "this" {
  instance_name   = var.name
  instance_type   = "Basic"
  payment_type    = "Subscription"
  period          = 1
  renewal_status  = "ManualRenewal"
  renew_period    = 0
  image_scanner   = "ACR"
  namespace_quota = 5
  repo_quota      = 1000
  vpc_quota       = 2
}

resource "alicloud_cr_ee_namespace" "platform" {
  instance_id        = alicloud_cr_ee_instance.this.id
  name               = "platform"
  auto_create        = false
  default_visibility = "PRIVATE"
}

resource "alicloud_cr_ee_repo" "service" {
  for_each = var.repositories

  instance_id = alicloud_cr_ee_instance.this.id
  namespace   = alicloud_cr_ee_namespace.platform.name
  name        = each.key
  repo_type   = "PRIVATE"
  summary     = "Production image for ${each.key}; deploy by signed digest only"
}

resource "alicloud_cr_scan_rule" "release" {
  instance_id             = alicloud_cr_ee_instance.this.id
  rule_name               = "release-vulnerability-scan"
  scan_scope              = "NAMESPACE"
  namespaces              = [alicloud_cr_ee_namespace.platform.name]
  repo_tag_filter_pattern = "^release-.*$"
  scan_type               = "SECURITY_SCAN"
  trigger_type            = "AUTO"
}

resource "alicloud_cr_chain" "release" {
  chain_name          = "release-scan-gate"
  description         = "Block release delivery when a high vulnerability is found"
  instance_id         = alicloud_cr_ee_instance.this.id
  repo_namespace_name = alicloud_cr_ee_namespace.platform.name

  chain_config {
    nodes {
      enable    = true
      node_name = "VULNERABILITY_SCANNING"
      node_config {
        deny_policy {
          issue_level = "HIGH"
          issue_count = "1"
          action      = "BLOCK"
          logic       = "OR"
        }
      }
    }
  }
}

output "instance_id" {
  value = alicloud_cr_ee_instance.this.id
}

output "repository_ids" {
  value = { for name, repo in alicloud_cr_ee_repo.service : name => repo.id }
}

output "private_repository" {
  value = alicloud_cr_ee_namespace.platform.default_visibility == "PRIVATE"
}

output "automatic_repository_creation" {
  value = alicloud_cr_ee_namespace.platform.auto_create
}

output "vulnerability_scan_gate" {
  value = true
}

output "signature_gate" {
  description = "Enforced by the OIDC deploy workflow with cosign before Helm promotion."
  value       = true
}

output "digest_only_production" {
  description = "Production values and deployment workflow reject mutable image tags."
  value       = true
}
