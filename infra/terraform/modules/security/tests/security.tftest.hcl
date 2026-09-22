mock_provider "alicloud" {}

run "service_policies_have_no_wildcards" {
  command = plan

  assert {
    condition     = output.service_role_count == 13 && output.distinct_service_roles
    error_message = "service identities must remain one-to-one"
  }

  assert {
    condition     = !output.policy_contains_wildcards && !output.terraform_manages_secret_payloads
    error_message = "workload policies must remain scoped and state must stay secretless"
  }
}
