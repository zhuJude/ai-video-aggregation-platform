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

variable "workload_vswitch_ids" {
  type    = list(string)
  default = ["vsw-zonea", "vsw-zoneb"]

  validation {
    condition     = length(distinct(var.workload_vswitch_ids)) >= 2
    error_message = "ACK must use workload vSwitches in at least two zones"
  }
}

variable "pod_vswitch_ids" {
  type    = list(string)
  default = ["vsw-zonea", "vsw-zoneb"]
}

variable "security_group_id" {
  type    = string
  default = "sg-test"
}

variable "kms_key_id" {
  description = "KMS key ID used for Kubernetes Secret envelope encryption."
  type        = string
  default     = "key-test"
}

variable "sls_project_name" {
  type    = string
  default = "ai-video-production"
}

variable "tags" {
  type = map(string)
  default = {
    Environment = "production"
    ManagedBy   = "terraform"
    Project     = "ai-video-platform"
  }
}

resource "alicloud_cs_managed_kubernetes" "this" {
  name                      = var.name
  profile                   = "Default"
  cluster_spec              = "ack.pro.small"
  vswitch_ids               = var.workload_vswitch_ids
  pod_vswitch_ids           = var.pod_vswitch_ids
  service_cidr              = "172.21.0.0/20"
  new_nat_gateway           = false
  slb_internet_enabled      = false
  security_group_id         = var.security_group_id
  enable_rrsa               = true
  deletion_protection       = true
  encryption_provider_key   = var.kms_key_id
  control_plane_log_project = var.sls_project_name
  control_plane_log_ttl     = 180
  control_plane_log_components = [
    "apiserver",
    "kcm",
    "scheduler",
    "ccm",
  ]
  tags = var.tags

  auto_mode {
    enabled = true
  }

  audit_log_config {
    enabled          = true
    sls_project_name = var.sls_project_name
  }

  addons {
    name   = "terway-eniip"
    config = jsonencode({ IPVlan = "true", NetworkPolicy = "true" })
  }

  addons {
    name = "csi-plugin"
  }

  addons {
    name = "csi-provisioner"
  }

  addons {
    name = "arms-prometheus"
  }

  addons {
    name = "alb-ingress-controller"
  }
}

output "cluster_id" {
  value = alicloud_cs_managed_kubernetes.this.id
}

output "cluster_spec" {
  value = alicloud_cs_managed_kubernetes.this.cluster_spec
}

output "auto_mode_enabled" {
  value = alicloud_cs_managed_kubernetes.this.auto_mode[0].enabled
}

output "api_server_public" {
  value = alicloud_cs_managed_kubernetes.this.slb_internet_enabled
}

output "node_zone_count" {
  value = length(distinct(var.workload_vswitch_ids))
}

output "audit_logging_enabled" {
  value = alicloud_cs_managed_kubernetes.this.audit_log_config[0].enabled
}

output "deletion_protection" {
  value = alicloud_cs_managed_kubernetes.this.deletion_protection
}

output "workload_identity_enabled" {
  value = alicloud_cs_managed_kubernetes.this.enable_rrsa
}
