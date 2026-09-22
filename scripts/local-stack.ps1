[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('up', 'down', 'status', 'reset')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
$projectName = 'ai-video-local'
$repoRoot = Split-Path -Parent $PSScriptRoot
$baseCompose = Join-Path $repoRoot 'infra/local/compose.yaml'
$servicesCompose = Join-Path $repoRoot 'infra/local/compose.services.yaml'
$composeArgs = @('--project-name', $projectName, '-f', $baseCompose, '-f', $servicesCompose)

function Invoke-Compose {
  & docker compose @composeArgs @args
  if ($LASTEXITCODE -ne 0) {
    throw "docker compose failed with exit code $LASTEXITCODE"
  }
}

function Wait-Postgres {
  $deadline = [DateTime]::UtcNow.AddMinutes(2)
  do {
    & docker compose @composeArgs exec -T postgres pg_isready -U platform 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { return }
    Start-Sleep -Seconds 2
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'PostgreSQL did not become ready within two minutes.'
}

function Ensure-Databases {
  $databaseNames = @(
    'identity', 'iam', 'asset', 'catalog', 'generation', 'notification',
    'operations', 'payment', 'provider_runtime', 'quote_routing', 'reporting', 'wallet'
  )
  foreach ($databaseName in $databaseNames) {
    $exists = ((@(& docker compose @composeArgs exec -T postgres psql -U platform -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$databaseName'") -join "`n")).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Could not inspect database $databaseName." }
    if ($exists -ne '1') {
      & docker compose @composeArgs exec -T postgres createdb -U platform $databaseName
      if ($LASTEXITCODE -ne 0) { throw "Could not create database $databaseName." }
    }
  }
}

function Invoke-PrismaMigration([string]$serviceDirectory, [string]$databaseName, [string]$environmentName = 'DATABASE_URL') {
  $previous = [Environment]::GetEnvironmentVariable($environmentName, 'Process')
  try {
    [Environment]::SetEnvironmentVariable(
      $environmentName,
      "postgresql://platform:local-only-password@127.0.0.1:5432/$databaseName",
      'Process'
    )
    & corepack pnpm --filter "@repo/$serviceDirectory" exec prisma migrate deploy
    if ($LASTEXITCODE -ne 0) { throw "Migration failed for $serviceDirectory." }
  }
  finally {
    [Environment]::SetEnvironmentVariable($environmentName, $previous, 'Process')
  }
}

function Invoke-Migrations {
  $migrations = @(
    @('identity-service', 'identity', 'IDENTITY_DATABASE_URL'),
    @('iam-service', 'iam', 'IAM_DATABASE_URL'),
    @('asset-service', 'asset', 'DATABASE_URL'),
    @('catalog-service', 'catalog', 'DATABASE_URL'),
    @('generation-service', 'generation', 'DATABASE_URL'),
    @('notification-service', 'notification', 'DATABASE_URL'),
    @('operations-service', 'operations', 'DATABASE_URL'),
    @('payment-service', 'payment', 'DATABASE_URL'),
    @('provider-runtime', 'provider_runtime', 'DATABASE_URL'),
    @('quote-routing-service', 'quote_routing', 'DATABASE_URL'),
    @('wallet-service', 'wallet', 'DATABASE_URL')
  )
  foreach ($migration in $migrations) {
    Invoke-PrismaMigration $migration[0] $migration[1] $migration[2]
  }

  $reportingApplied = ((@(& docker compose @composeArgs exec -T postgres psql -U platform -d reporting -tAc "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ProjectionVersion')") -join "`n")).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Could not inspect reporting-service migration state.' }
  if ($reportingApplied -ne 't') {
    $reportingMigration = Join-Path $repoRoot 'services/reporting-service/prisma/migrations/0001_reporting_projections/migration.sql'
    Get-Content -Raw $reportingMigration | & docker compose @composeArgs exec -T postgres psql -v ON_ERROR_STOP=1 -U platform -d reporting
    if ($LASTEXITCODE -ne 0) { throw 'Migration failed for reporting-service.' }
  }
}

Push-Location $repoRoot
try {
  switch ($Action) {
    'up' {
      Invoke-Compose up -d postgres redis rocketmq-namesrv rocketmq-broker minio mailpit local-support minio-init
      Wait-Postgres
      Ensure-Databases
      Invoke-Migrations
      Invoke-Compose up -d --build
      Write-Host 'Local-only test accounts are supplied by the web mock fixtures.'
      Write-Host 'User: +8613800000000 / SMS code 123456'
      Write-Host 'Admin: admin@example.local / password Local-only-password! / TOTP 123456'
      Write-Host 'No real provider credentials are configured.'
    }
    'down' {
      Invoke-Compose down
    }
    'status' {
      Invoke-Compose ps
    }
    'reset' {
      $confirmation = Read-Host "Type RESET $projectName to delete only this local stack's volumes"
      if ($confirmation -cne "RESET $projectName") {
        throw 'Reset cancelled: confirmation did not match.'
      }
      Invoke-Compose down --volumes --remove-orphans
    }
  }
}
finally {
  Pop-Location
}
