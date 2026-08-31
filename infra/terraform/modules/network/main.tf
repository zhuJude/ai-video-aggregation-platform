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

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "zones" {
  type    = list(string)
  default = ["cn-hangzhou-h", "cn-hangzhou-i"]

  validation {
    condition     = length(distinct(var.zones)) >= 2
    error_message = "network must span at least two distinct zones"
  }
}

variable "workload_cidrs" {
  type    = list(string)
  default = ["10.20.0.0/20", "10.20.16.0/20"]
}

variable "data_cidrs" {
  type    = list(string)
  default = ["10.20.32.0/24", "10.20.33.0/24"]
}

variable "tags" {
  type = map(string)
  default = {
    Environment = "production"
    ManagedBy   = "terraform"
    Project     = "ai-video-platform"
  }
}

variable "snat_table_id_override" {
  description = "Optional SNAT table ID for imported/recovered NAT gateways; null uses the managed gateway table."
  type        = string
  default     = null
}

resource "alicloud_vpc" "this" {
  vpc_name   = var.name
  cidr_block = var.vpc_cidr
  tags       = var.tags
}

resource "alicloud_vswitch" "workload" {
  count = length(var.zones)

  vpc_id       = alicloud_vpc.this.id
  zone_id      = var.zones[count.index]
  cidr_block   = var.workload_cidrs[count.index]
  vswitch_name = "${var.name}-workload-${count.index + 1}"
  tags         = merge(var.tags, { Tier = "workload" })
}

resource "alicloud_vswitch" "data" {
  count = length(var.zones)

  vpc_id       = alicloud_vpc.this.id
  zone_id      = var.zones[count.index]
  cidr_block   = var.data_cidrs[count.index]
  vswitch_name = "${var.name}-data-${count.index + 1}"
  tags         = merge(var.tags, { Tier = "data" })
}

resource "alicloud_security_group" "workloads" {
  security_group_name = "${var.name}-workloads"
  description         = "Private ACK workloads; no public ingress rules"
  vpc_id              = alicloud_vpc.this.id
  security_group_type = "enterprise"
  inner_access_policy = "Drop"
  tags                = var.tags
}

resource "alicloud_security_group_rule" "https_egress" {
  type              = "egress"
  ip_protocol       = "tcp"
  port_range        = "443/443"
  cidr_ip           = "0.0.0.0/0"
  policy            = "accept"
  priority          = 10
  security_group_id = alicloud_security_group.workloads.id
  description       = "TLS egress through controlled NAT"
}

resource "alicloud_security_group_rule" "dns_udp_egress" {
  type              = "egress"
  ip_protocol       = "udp"
  port_range        = "53/53"
  cidr_ip           = var.vpc_cidr
  policy            = "accept"
  priority          = 20
  security_group_id = alicloud_security_group.workloads.id
  description       = "VPC DNS resolution"
}

resource "alicloud_nat_gateway" "egress" {
  vpc_id              = alicloud_vpc.this.id
  vswitch_id          = alicloud_vswitch.workload[0].id
  nat_gateway_name    = "${var.name}-egress"
  nat_type            = "Enhanced"
  payment_type        = "PayAsYouGo"
  deletion_protection = true
  tags                = var.tags
}

resource "alicloud_eip_address" "egress" {
  address_name         = "${var.name}-egress"
  payment_type         = "PayAsYouGo"
  internet_charge_type = "PayByTraffic"
  bandwidth            = "10"
  deletion_protection  = true
  tags                 = var.tags
}

resource "alicloud_eip_association" "egress" {
  allocation_id = alicloud_eip_address.egress.id
  instance_id   = alicloud_nat_gateway.egress.id
  instance_type = "Nat"
  vpc_id        = alicloud_vpc.this.id
}

resource "alicloud_snat_entry" "workloads" {
  count = length(alicloud_vswitch.workload)

  snat_table_id     = var.snat_table_id_override != null ? var.snat_table_id_override : one(alicloud_nat_gateway.egress.snat_table_ids)
  source_vswitch_id = alicloud_vswitch.workload[count.index].id
  snat_ip           = alicloud_eip_address.egress.ip_address
  snat_entry_name   = "${var.name}-workload-${count.index + 1}"
}

output "vpc_id" {
  value = alicloud_vpc.this.id
}

output "workload_vswitch_ids" {
  value = alicloud_vswitch.workload[*].id
}

output "data_vswitch_ids" {
  value = alicloud_vswitch.data[*].id
}

output "security_group_id" {
  value = alicloud_security_group.workloads.id
}

output "workload_vswitch_count" {
  value = length(alicloud_vswitch.workload)
}

output "data_vswitch_count" {
  value = length(alicloud_vswitch.data)
}

output "private_ingress_only" {
  value = true
}

output "controlled_nat_egress" {
  value = alicloud_nat_gateway.egress.nat_type == "Enhanced"
}
