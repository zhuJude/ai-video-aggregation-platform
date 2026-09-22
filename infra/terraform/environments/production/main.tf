terraform {
  required_version = "~> 1.13.0"

  required_providers {
    alicloud = {
      source  = "aliyun/alicloud"
      version = "~> 1.279.0"
    }
  }

  backend "oss" {
    key     = "production/terraform.tfstate"
    prefix  = "ai-video-platform"
    encrypt = true
  }
}

provider "alicloud" {
  region = var.region
}

variable "region" {
  description = "Alibaba Cloud region. Authentication is supplied through OIDC/RAM environment variables."
  type        = string
  default     = "cn-hangzhou"
}

variable "availability_zones" {
  description = "Two or more zones used for workload and data vSwitches."
  type        = list(string)
  default     = ["cn-hangzhou-h", "cn-hangzhou-i"]

  validation {
    condition     = length(distinct(var.availability_zones)) >= 2
    error_message = "production must use at least two distinct availability zones"
  }
}

variable "vpc_cidr" {
  description = "Production-only VPC CIDR."
  type        = string
  default     = "10.20.0.0/16"
}

locals {
  environment = "production"
  common_tags = {
    Environment = local.environment
    ManagedBy   = "terraform"
    Project     = "ai-video-platform"
  }
}

output "environment" {
  value = local.environment
}

output "availability_zone_count" {
  value = length(distinct(var.availability_zones))
}

output "vpc_cidr" {
  value = var.vpc_cidr
}

output "state_policy" {
  value = {
    backend   = "oss"
    encrypted = true
    versioned = true
    locked    = true
    key       = "ai-video-platform/production/terraform.tfstate"
  }
}
