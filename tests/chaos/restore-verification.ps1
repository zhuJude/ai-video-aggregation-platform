[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$SourceDatabaseUrl,
  [Parameter(Mandatory)][string]$RestoredDatabaseUrl
)
$ErrorActionPreference = 'Stop'
$queries = @(
  'SELECT count(*) FROM "LedgerEntry"',
  'SELECT count(*) FROM "PaymentOrder"',
  'SELECT count(*) FROM "GenerationTask"'
)
foreach ($query in $queries) {
  $source = (& psql $SourceDatabaseUrl -tAc $query).Trim()
  $restored = (& psql $RestoredDatabaseUrl -tAc $query).Trim()
  if ($source -ne $restored) { throw "Restore mismatch for query: $query ($source != $restored)" }
}
