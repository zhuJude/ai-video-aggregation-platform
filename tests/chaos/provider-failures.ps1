[CmdletBinding()]
param([string]$BaseUrl = 'http://127.0.0.1:3130')
$ErrorActionPreference = 'Stop'
$scenarios = @('rate-limit', 'server-error', 'auth-error', 'zero-balance', 'timeout', 'duplicate-callback', 'out-of-order-callback')
foreach ($scenario in $scenarios) {
  $response = Invoke-WebRequest -Method Post -Uri "$BaseUrl/__control/scenario" -ContentType 'application/json' -Body (@{ scenario = $scenario } | ConvertTo-Json)
  if ($response.StatusCode -notin 200, 204) { throw "Provider scenario failed: $scenario" }
}
