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
  default = "vpc-message"
}

variable "vswitch_id" {
  type    = string
  default = "vsw-message"
}

variable "kms_key_id" {
  type    = string
  default = "key-message"
}

variable "monthly_budget_cny" {
  type    = number
  default = 500
}

variable "tags" {
  type = map(string)
  default = {
    Environment = "production"
    ManagedBy   = "terraform"
    Project     = "ai-video-platform"
    CostCenter  = "platform-messaging"
  }
}

locals {
  topics = {
    domain-events   = "NORMAL"
    delayed-polling = "DELAY"
    retry           = "NORMAL"
    dead-letter     = "NORMAL"
  }
}

resource "alicloud_rocketmq_instance" "this" {
  instance_name   = var.name
  service_code    = "rmq"
  series_code     = "standard"
  sub_series_code = "serverless"
  payment_type    = "PayAsYouGo"
  remark          = "Private RocketMQ 5 Serverless event backbone"
  ip_whitelists   = []
  tags            = var.tags

  product_info {
    msg_process_spec       = "rmq.s2.2xlarge"
    message_retention_time = 168
    auto_scaling           = true
    storage_encryption     = true
    storage_secret_key     = var.kms_key_id
    trace_on               = true
  }

  network_info {
    vpc_info {
      vpc_id = var.vpc_id
      vswitches {
        vswitch_id = var.vswitch_id
      }
    }

    internet_info {
      internet_spec = "disable"
      flow_out_type = "uninvolved"
    }
  }

  acl_info {
    default_vpc_auth_free = false
    acl_types             = ["default", "apache_acl"]
  }
}

resource "alicloud_rocketmq_topic" "topics" {
  for_each = local.topics

  instance_id  = alicloud_rocketmq_instance.this.id
  topic_name   = each.key
  message_type = each.value
  remark       = "terraform"
}

resource "alicloud_rocketmq_consumer_group" "platform" {
  consumer_group_id   = "platform-workers"
  instance_id         = alicloud_rocketmq_instance.this.id
  delivery_order_type = "Concurrently"

  consume_retry_policy {
    retry_policy             = "DefaultRetryPolicy"
    max_retry_times          = 16
    dead_letter_target_topic = alicloud_rocketmq_topic.topics["dead-letter"].topic_name
  }
}

output "instance_id" {
  value = alicloud_rocketmq_instance.this.id
}

output "serverless" {
  value = alicloud_rocketmq_instance.this.sub_series_code == "serverless"
}

output "private_vpc_only" {
  value = alicloud_rocketmq_instance.this.network_info[0].internet_info[0].internet_spec == "disable"
}

output "storage_encrypted" {
  value = alicloud_rocketmq_instance.this.product_info[0].storage_encryption
}

output "topic_names" {
  value = sort(keys(local.topics))
}

output "max_retry_times" {
  value = alicloud_rocketmq_consumer_group.platform.consume_retry_policy[0].max_retry_times
}

output "dead_letter_topic" {
  value = alicloud_rocketmq_topic.topics["dead-letter"].topic_name
}

output "monthly_budget_cny" {
  value = var.monthly_budget_cny
}
