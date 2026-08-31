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

variable "vpc_id" {
  type    = string
  default = "vpc-test"
}

variable "zone_mappings" {
  type = list(object({
    zone_id    = string
    vswitch_id = string
  }))
  default = [
    { zone_id = "cn-hangzhou-h", vswitch_id = "vsw-zone-a" },
    { zone_id = "cn-hangzhou-i", vswitch_id = "vsw-zone-b" },
  ]
}

variable "certificate_id" {
  description = "Certificate ID supplied by the deployment environment; certificate material is never stored in Terraform."
  type        = string
  default     = "cert-test"
}

variable "tls_security_policy_id" {
  type    = string
  default = "tls_cipher_policy_1_2_strict"
}

variable "hosts" {
  type = map(string)
  default = {
    user  = "www.example.cn"
    admin = "admin.example.cn"
    api   = "api.example.cn"
  }
}

variable "tags" {
  type = map(string)
  default = {
    Environment = "production"
    ManagedBy   = "terraform"
    Project     = "ai-video-platform"
  }
}

resource "alicloud_alb_load_balancer" "this" {
  load_balancer_name    = var.name
  vpc_id                = var.vpc_id
  address_type          = "Internet"
  load_balancer_edition = "StandardWithWaf"
  tags                  = var.tags

  load_balancer_billing_config {
    pay_type = "PayAsYouGo"
  }

  dynamic "zone_mappings" {
    for_each = var.zone_mappings
    content {
      zone_id    = zone_mappings.value.zone_id
      vswitch_id = zone_mappings.value.vswitch_id
    }
  }

  deletion_protection_config {
    enabled = true
  }

  modification_protection_config {
    status = "ConsoleProtection"
    reason = "Managed by Terraform"
  }
}

resource "alicloud_alb_server_group" "hosts" {
  for_each = var.hosts

  server_group_name = "${var.name}-${each.key}"
  server_group_type = "Instance"
  vpc_id            = var.vpc_id
  protocol          = "HTTP"
  tags              = var.tags

  health_check_config {
    health_check_enabled  = true
    health_check_protocol = "HTTP"
    health_check_method   = "GET"
    health_check_path     = "/readyz"
    health_check_codes    = ["http_2xx", "http_3xx"]
  }
}

resource "alicloud_alb_listener" "https" {
  load_balancer_id     = alicloud_alb_load_balancer.this.id
  listener_protocol    = "HTTPS"
  listener_port        = 443
  security_policy_id   = var.tls_security_policy_id
  listener_description = "TLS 1.2+ public entry"

  certificates {
    certificate_id = var.certificate_id
  }

  default_actions {
    type = "ForwardGroup"
    forward_group_config {
      server_group_tuples {
        server_group_id = alicloud_alb_server_group.hosts["api"].id
      }
    }
  }
}

resource "alicloud_alb_listener" "http" {
  load_balancer_id     = alicloud_alb_load_balancer.this.id
  listener_protocol    = "HTTP"
  listener_port        = 80
  listener_description = "Redirect HTTP to HTTPS"

  default_actions {
    type = "ForwardGroup"
    forward_group_config {
      server_group_tuples {
        server_group_id = alicloud_alb_server_group.hosts["api"].id
      }
    }
  }
}

resource "alicloud_alb_rule" "http_redirect" {
  listener_id = alicloud_alb_listener.http.id
  rule_name   = "redirect-all-to-https"
  priority    = 1

  rule_conditions {
    type = "Path"
    path_config {
      values = ["/*"]
    }
  }

  rule_actions {
    order = 1
    type  = "Redirect"
    redirect_config {
      protocol  = "HTTPS"
      port      = "443"
      http_code = "301"
    }
  }
}

resource "alicloud_alb_rule" "hosts" {
  for_each = var.hosts

  listener_id = alicloud_alb_listener.https.id
  rule_name   = "route-${each.key}"
  priority    = 10 + index(sort(keys(var.hosts)), each.key)

  rule_conditions {
    type = "Host"
    host_config {
      values = [each.value]
    }
  }

  rule_actions {
    order = 1
    type  = "ForwardGroup"
    forward_group_config {
      server_group_tuples {
        server_group_id = alicloud_alb_server_group.hosts[each.key].id
        weight          = 100
      }
    }
  }
}

output "load_balancer_id" {
  value = alicloud_alb_load_balancer.this.id
}

output "origin_dns_name" {
  value = alicloud_alb_load_balancer.this.dns_name
}

output "waf_enabled" {
  value = alicloud_alb_load_balancer.this.load_balancer_edition == "StandardWithWaf"
}

output "https_only" {
  value = alicloud_alb_listener.https.listener_protocol == "HTTPS" && contains([for action in alicloud_alb_rule.http_redirect.rule_actions : action.type], "Redirect")
}

output "tls_policy" {
  value = alicloud_alb_listener.https.security_policy_id
}

output "allowed_hosts" {
  value = sort(values(var.hosts))
}
