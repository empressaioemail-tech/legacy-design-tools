# Deepen Central TX jurisdictions — building-code adoption layer (61a)
#
# Usage:
#   .\scripts\deepen-central-tx-batch.ps1
#   .\scripts\deepen-central-tx-batch.ps1 -StartAt san_antonio_tx

param(
  [string]$StartAt = "austin_tx",
  [double]$BudgetCap = 200,
  [switch]$AllowBatch
)

if (-not $AllowBatch) {
  Write-Error @"
BATCH PAUSED — safe deepen fix must be merged before resuming.
Run single jurisdiction: pnpm --filter @workspace/scripts exec tsx deepen-central-tx-jurisdiction.mjs <key>
To force resume after merge: .\scripts\deepen-central-tx-batch.ps1 -AllowBatch -StartAt <key>
"@
  exit 1
}

$ErrorActionPreference = "Stop"
$env:NODE_OPTIONS = "--use-system-ca"

if (-not $env:DATABASE_URL) {
  if (-not $env:GOOGLE_APPLICATION_CREDENTIALS) {
    $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\Users\cente\google-cloud-sdk\smartcity-agent-key.json"
  }
  $gcloud = "C:\Users\cente\google-cloud-sdk\bin\gcloud.cmd"
  $env:DATABASE_URL = & $gcloud secrets versions access latest `
    --secret=DEPLOYMENT_DATABASE_URL `
    --project=legacy-design-tools-prod 2>$null
}

$env:CODEWARM_CATALOG_DIR = "P:\doc_repo\_catalog\codes"

$queue = @(
  "austin_tx",
  "san_antonio_tx",
  "round_rock_tx",
  "georgetown_tx",
  "hutto_tx",
  "leander_tx",
  "new_braunfels_tx",
  "dripping_springs_tx",
  "killeen_tx",
  "schertz_tx",
  "boerne_tx"
)

$started = $false
$report = @()

foreach ($key in $queue) {
  if (-not $started) {
    if ($key -ne $StartAt) { continue }
    $started = $true
  }

  Write-Host "=== DEEPEN $key (safe incremental, budget `$$BudgetCap) ==="
  $deadline = (Get-Date).AddHours(1)
  $logPath = Join-Path $PSScriptRoot "_deepen-$key-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"

  pnpm --filter @workspace/scripts exec tsx deepen-central-tx-jurisdiction.mjs `
    $key --budget-cap $BudgetCap `
    2>&1 | Tee-Object -FilePath $logPath

  $report += [pscustomobject]@{
    jurisdiction = $key
    log = $logPath
    exitCode = $LASTEXITCODE
  }

  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Deepen failed for $key — see $logPath"
  }
  if ((Get-Date) -gt $deadline) {
    Write-Warning "1hr wall clock exceeded at $key — stopping batch"
    break
  }
}

$report | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $PSScriptRoot "_deepen-central-tx-batch-report.json")
Write-Host "Batch report: scripts/_deepen-central-tx-batch-report.json"
