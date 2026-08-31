$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$chart = Join-Path $repoRoot 'infra\helm\platform-service'
$productionValues = Join-Path $repoRoot 'infra\helm\environments\production.yaml'
$providerRuntimeValues = Join-Path $repoRoot 'infra\helm\environments\provider-runtime.yaml'

$rendered = & helm template platform-service $chart -f $productionValues
if ($LASTEXITCODE -ne 0) { throw 'helm template production render failed' }
$manifest = $rendered -join "`n"

$requiredPatterns = @{
  'non-root pod security'       = 'runAsNonRoot:\s+true'
  'read-only root filesystem'   = 'readOnlyRootFilesystem:\s+true'
  'all capabilities dropped'    = '(?s)capabilities:.*drop:.*-\s+ALL'
  'runtime default seccomp'     = '(?s)seccompProfile:.*type:\s+RuntimeDefault'
  'startup probe'               = 'startupProbe:'
  'liveness probe'              = 'livenessProbe:'
  'readiness probe'             = 'readinessProbe:'
  'resource requests'           = '(?s)requests:.*cpu:.*memory:'
  'resource limits'             = '(?s)limits:.*cpu:.*memory:'
  'graceful termination'        = 'terminationGracePeriodSeconds:'
  'topology spread'             = 'topologySpreadConstraints:'
  'pod disruption budget'       = 'kind:\s+PodDisruptionBudget'
  'horizontal pod autoscaler'   = 'kind:\s+HorizontalPodAutoscaler'
  'custom qps autoscaling'      = 'requests-per-second'
  'default-deny network policy' = '(?s)kind:\s+NetworkPolicy.*policyTypes:.*Ingress.*Egress'
  'DNS egress'                  = '(?s)namespaceSelector:.*kubernetes\.io/metadata\.name:\s+kube-system.*port:\s+53'
  'RRSA service account'        = 'ack\.aliyun\.com/role-arn:'
}

foreach ($entry in $requiredPatterns.GetEnumerator()) {
  if ($manifest -notmatch $entry.Value) {
    throw "render policy missing: $($entry.Key)"
  }
}

if ($manifest -match 'kind:\s+Secret') {
  throw 'chart must reference KMS/CSI secrets and never render secret payloads'
}

$workerRendered = & helm template provider-runtime $chart -f $productionValues -f $providerRuntimeValues
if ($LASTEXITCODE -ne 0) { throw 'helm template KEDA render failed' }
$workerManifest = $workerRendered -join "`n"
if ($workerManifest -notmatch 'kind:\s+ScaledObject') { throw 'KEDA ScaledObject missing' }
if ($workerManifest -notmatch 'rocketmq') { throw 'RocketMQ KEDA trigger missing' }

$canaryRendered = & helm template canary $chart -f $productionValues `
  --set ingress.enabled=true `
  --set ingress.canary.enabled=true `
  --set ingress.canary.weight=10
if ($LASTEXITCODE -ne 0) { throw 'helm template ALB canary render failed' }
$canaryManifest = $canaryRendered -join "`n"
if ($canaryManifest -notmatch 'alb\.ingress\.kubernetes\.io/canary:\s+"true"') { throw 'ALB canary marker missing' }
if ($canaryManifest -notmatch 'alb\.ingress\.kubernetes\.io/canary-weight:\s+"10"') { throw 'ALB canary weight missing' }

Write-Host 'Helm render policy tests passed.'
