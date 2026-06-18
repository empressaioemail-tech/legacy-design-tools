# Deepen Central TX jurisdictions — building-code adoption layer (61a)
#
# Usage:
#   .\scripts\deepen-central-tx-batch.ps1 -AllowBatch
#   .\scripts\deepen-central-tx-batch.ps1 -AllowBatch -StartAt san_antonio_tx -BudgetCap 200

param(
  [string]$StartAt = "austin_tx",
  [double]$BudgetCap = 200,
  [switch]$AllowBatch,
  [int]$JurisdictionTimeoutMinutes = 90,
  [switch]$IncludeClassBTail,
  [switch]$FullPackageForSanAntonio
)

if (-not $AllowBatch) {
  Write-Error @"
BATCH PAUSED — safe deepen fix must be merged before resuming.
Run single jurisdiction: pnpm --filter @workspace/scripts exec tsx deepen-central-tx-jurisdiction.mjs <key>
To force resume after merge: .\scripts\deepen-central-tx-batch.ps1 -AllowBatch -StartAt <key>
"@
  exit 1
}

$ErrorActionPreference = "Continue"
$env:NODE_OPTIONS = "--use-system-ca"
if (-not $env:CODEWARM_HTTP_TIMEOUT_MS) {
  $env:CODEWARM_HTTP_TIMEOUT_MS = "180000"
}

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

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$progressPath = Join-Path $PSScriptRoot "_deepen-central-tx-batch-progress.jsonl"
$reportPath = Join-Path $PSScriptRoot "_deepen-central-tx-batch-report.json"

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

if ($IncludeClassBTail) {
  $queue += @(
    "waco_tx",
    "temple_tx",
    "san_marcos_tx",
    "seguin_tx",
    "cibolo_tx",
    "belton_tx",
    "universal_city_tx"
  )
}

function Get-JurisdictionRate {
  param([string]$Key)
  $out = & pnpm --filter @workspace/scripts exec tsx report-verified-rates.mjs $Key 2>&1
  if ($LASTEXITCODE -ne 0) { return $null }
  try {
    $parsed = $out | ConvertFrom-Json
    return $parsed.jurisdictions[0]
  } catch {
    return $null
  }
}

function Parse-DeepenSummary {
  param([string]$LogPath)
  if (-not (Test-Path $LogPath)) { return $null }
  $lines = Get-Content $LogPath -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\{' }
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    try {
      $obj = $lines[$i] | ConvertFrom-Json
      if ($obj.PSObject.Properties.Name -contains "afterVerifiedRate") { return $obj }
      if ($obj.PSObject.Properties.Name -contains "totalEstimatedCostUsd") { return $obj }
    } catch { continue }
  }
  return $null
}

function Write-ProgressLine {
  param([hashtable]$Row)
  ($Row | ConvertTo-Json -Compress -Depth 6) | Add-Content -Path $progressPath -Encoding utf8
}

$started = $false
$report = @()

foreach ($key in $queue) {
  if (-not $started) {
    if ($key -ne $StartAt) { continue }
    $started = $true
  }

  $startedAt = (Get-Date).ToString("o")
  Write-Host "=== DEEPEN $key (safe incremental, budget `$$BudgetCap, timeout ${JurisdictionTimeoutMinutes}m) ==="

  $beforeRate = Get-JurisdictionRate -Key $key
  $beforeVerified = if ($beforeRate) { $beforeRate.verifiedRate } else { $null }

  $logPath = Join-Path $PSScriptRoot "_deepen-$key-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
  $errPath = "$logPath.err"

  $job = Start-Job -ScriptBlock {
    param($Root, $Key, $Budget, $CatalogDir, $DbUrl, $HttpTimeoutMs, $LogPath, $FullPackageSa)
    Set-Location $Root
    $env:NODE_OPTIONS = "--use-system-ca"
    $env:CODEWARM_CATALOG_DIR = $CatalogDir
    $env:DATABASE_URL = $DbUrl
    $env:CODEWARM_HTTP_TIMEOUT_MS = $HttpTimeoutMs
    $deepenArgs = @($Key, "--budget-cap", $Budget)
    if ($FullPackageSa -and $Key -eq "san_antonio_tx") {
      $deepenArgs += "--full-package"
    }
    & pnpm --filter @workspace/scripts exec tsx deepen-central-tx-jurisdiction.mjs @deepenArgs 2>&1 |
      Tee-Object -FilePath $LogPath
    return $LASTEXITCODE
  } -ArgumentList $repoRoot, $key, $BudgetCap, $env:CODEWARM_CATALOG_DIR, $env:DATABASE_URL, $env:CODEWARM_HTTP_TIMEOUT_MS, $logPath, ($FullPackageForSanAntonio.IsPresent)

  $wait = Wait-Job -Job $job -Timeout ($JurisdictionTimeoutMinutes * 60)
  $hung = $false
  $exitCode = -1

  if (-not $wait) {
    $hung = $true
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    $exitCode = -2
    Write-Warning "TIMEOUT: $key exceeded ${JurisdictionTimeoutMinutes}m; killed job"
    if (-not (Test-Path $logPath)) {
      "job timeout" | Set-Content -Path $logPath -Encoding utf8
    }
  } else {
    $received = Receive-Job -Job $job
    Remove-Job -Job $job -Force
    if ($received -is [array]) {
      $exitCode = [int]($received[-1])
    } else {
      $exitCode = [int]$received
    }
    if ($LASTEXITCODE -ne 0 -and $exitCode -eq 0) {
      $exitCode = $LASTEXITCODE
    }
  }

  $summary = Parse-DeepenSummary -LogPath $logPath
  $afterRate = Get-JurisdictionRate -Key $key
  $afterVerified = if ($afterRate) { $afterRate.verifiedRate } else { $null }

  $costUsd = if ($summary -and $null -ne $summary.totalEstimatedCostUsd) {
    [double]$summary.totalEstimatedCostUsd
  } else { $null }

  $row = [ordered]@{
    jurisdiction = $key
    startedAt = $startedAt
    finishedAt = (Get-Date).ToString("o")
    log = $logPath
    exitCode = $exitCode
    hung = $hung
    beforeVerifiedRate = $beforeVerified
    afterVerifiedRate = $afterVerified
    estimatedCostUsd = $costUsd
    budgetCapUsd = $BudgetCap
    underBudget = if ($null -ne $costUsd) { $costUsd -le $BudgetCap } else { $null }
  }
  Write-ProgressLine -Row $row
  $report += [pscustomobject]$row

  Write-Host ($row | ConvertTo-Json -Compress)

  if ($exitCode -ne 0) {
    Write-Warning "Deepen failed for $key with exit code $exitCode - see $logPath"
  }
}

$report | ConvertTo-Json -Depth 6 | Set-Content $reportPath -Encoding utf8
Write-Host "Progress log: $progressPath"
Write-Host "Batch report: $reportPath"
