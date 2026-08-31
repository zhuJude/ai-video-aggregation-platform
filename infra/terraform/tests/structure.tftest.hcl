run "production_requires_two_zones" {
  command = plan

  module {
    source = "./environments/production"
  }

  assert {
    condition     = output.availability_zone_count >= 2
    error_message = "production must use at least two availability zones"
  }
}

run "production_uses_remote_encrypted_state" {
  command = plan

  module {
    source = "./environments/production"
  }

  assert {
    condition     = output.state_policy.backend == "oss" && output.state_policy.encrypted && output.state_policy.versioned && output.state_policy.locked
    error_message = "production state must use encrypted, versioned and locked OSS storage"
  }
}

run "staging_is_isolated_from_production" {
  command = plan

  module {
    source = "./environments/staging"
  }

  assert {
    condition     = output.environment == "staging" && output.vpc_cidr != "10.20.0.0/16"
    error_message = "staging must use an isolated state and VPC"
  }
}
