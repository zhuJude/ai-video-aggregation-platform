[CmdletBinding()]
param([ValidateSet('local', 'kubernetes')][string]$Mode = 'local')
$ErrorActionPreference = 'Stop'
if ($Mode -eq 'local') {
  foreach ($service in @('edge-gateway', 'generation-service', 'provider-runtime', 'redis', 'rocketmq-broker')) {
    docker compose --project-name ai-video-local -f infra/local/compose.yaml -f infra/local/compose.services.yaml restart $service
    if ($LASTEXITCODE -ne 0) { throw "Restart failed: $service" }
  }
} else {
  kubectl -n platform delete pod -l 'app.kubernetes.io/name in (edge-gateway,generation-service,provider-runtime)' --wait=false
  if ($LASTEXITCODE -ne 0) { throw 'Kubernetes fault injection failed.' }
}
