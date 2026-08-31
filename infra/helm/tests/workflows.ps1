$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$stagingPath = Join-Path $repoRoot '.github\workflows\deploy-staging.yml'
$productionPath = Join-Path $repoRoot '.github\workflows\deploy-production.yml'

foreach ($path in @($stagingPath, $productionPath)) {
  if (-not (Test-Path $path)) { throw "missing deployment workflow: $path" }
}

$staging = Get-Content $stagingPath -Raw
$production = Get-Content $productionPath -Raw
$combined = "$staging`n$production"

foreach ($pattern in @(
  'id-token:\s+write',
  'aliyun/configure-aliyun-credentials-action@v1',
  'role-to-assume:',
  'oidc-provider-arn:',
  'cosign\s+sign',
  'image\.digest="\$DIGEST"',
  '\^sha256:\[a-f0-9\]\{64\}\$',
  'helm\s+rollback'
)) {
  if ($combined -notmatch $pattern) { throw "workflow policy missing: $pattern" }
}

if ($combined -match 'ALICLOUD_ACCESS_KEY_SECRET|ALIBABA_CLOUD_ACCESS_KEY_SECRET|secrets\.ALI') {
  throw 'static Alibaba Cloud credentials are forbidden'
}
if ($combined -match 'terraform\s+apply') {
  throw 'deployment workflows may verify plans but must not auto-apply infrastructure'
}

if ($staging -notmatch 'workflow_run:' -or $staging -notmatch 'workflows:\s*\[ci\]') {
  throw 'staging must start only after the integration CI workflow'
}
if ($staging -notmatch 'conclusion\s*==\s*''success''') {
  throw 'staging must require successful CI'
}

foreach ($pattern in @(
  'workflow_dispatch:',
  'environment:\s*production',
  'actions/download-artifact@v4',
  'plan_sha256',
  'sha256sum\s+--check',
  'for weight in 10 50 100',
  'alb\.ingress\.kubernetes\.io/canary-weight',
  'sleep\s+300',
  'verify-backup'
)) {
  if ($production -notmatch $pattern) { throw "production workflow policy missing: $pattern" }
}

Write-Host 'Deployment workflow policy tests passed.'
