# Warm Central TX wedge cities from engine_only → neon (reasoning_atoms in deployment Neon).
# Requires DATABASE_URL (deployment Neon) and CODEWARM_CATALOG_DIR if not default.
#
# Usage:
#   .\scripts\warm-codewarm-wedge-batch.ps1
#   .\scripts\warm-codewarm-wedge-batch.ps1 -StartAt san_antonio_tx

param(
  [string]$StartAt = "austin_tx",
  [double]$BudgetCap = 200
)

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

$queue = @(
  @{ key = "austin_tx"; edition = "2024" },
  @{ key = "san_antonio_tx"; edition = "2021" },
  @{ key = "round_rock_tx"; edition = "2021" },
  @{ key = "georgetown_tx"; edition = "2021" },
  @{ key = "hutto_tx"; edition = "2021" },
  @{ key = "leander_tx"; edition = "2021" },
  @{ key = "new_braunfels_tx"; edition = "2021" },
  @{ key = "dripping_springs_tx"; edition = "2021" },
  @{ key = "killeen_tx"; edition = "2021" },
  @{ key = "schertz_tx"; edition = "2021" },
  @{ key = "boerne_tx"; edition = "2021" },
  @{ key = "bastrop_county_tx"; edition = "2021" },
  @{ key = "brownsville_tx"; edition = "2021" },
  @{ key = "converse_tx"; edition = "2021" },
  @{ key = "copperas_cove_tx"; edition = "2021" },
  @{ key = "crowley_tx"; edition = "2021" },
  @{ key = "el_paso_tx"; edition = "2021" },
  @{ key = "elgin_tx"; edition = "2021" },
  @{ key = "keller_tx"; edition = "2021" },
  @{ key = "lago_vista_tx"; edition = "2021" },
  @{ key = "live_oak_tx"; edition = "2021" },
  @{ key = "lockhart_tx"; edition = "2021" },
  @{ key = "manor_tx"; edition = "2021" },
  @{ key = "mission_tx"; edition = "2021" },
  @{ key = "pasadena_tx"; edition = "2021" },
  @{ key = "plano_tx"; edition = "2021" },
  @{ key = "rollingwood_tx"; edition = "2021" },
  @{ key = "saginaw_tx"; edition = "2021" },
  @{ key = "sugar_land_tx"; edition = "2021" },
  @{ key = "taylor_tx"; edition = "2021" },
  @{ key = "watauga_tx"; edition = "2021" },
  @{ key = "wimberley_tx"; edition = "2021" }
)

$started = $false
$report = @()

foreach ($item in $queue) {
  if (-not $started) {
    if ($item.key -ne $StartAt) { continue }
    $started = $true
  }

  Write-Host "=== Warming $($item.key) (edition $($item.edition), budget `$$BudgetCap) ==="
  $deadline = (Get-Date).AddHours(1)
  $logPath = Join-Path $PSScriptRoot "_codewarm-$($item.key)-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"

  pnpm --filter @workspace/scripts run warm:codewarm-jurisdiction -- `
    $item.key `
    --edition $item.edition `
    --budget-cap $BudgetCap `
    2>&1 | Tee-Object -FilePath $logPath

  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Warm failed for $($item.key) — see $logPath"
  }

  $summary = Get-Content $logPath -Tail 5 | Where-Object { $_ -match '^\{' } | Select-Object -Last 1
  $report += [pscustomobject]@{
    jurisdiction = $item.key
    edition = $item.edition
    log = $logPath
    summary = $summary
  }

  if ((Get-Date) -gt $deadline) {
    Write-Warning "1hr wall clock exceeded at $($item.key) — stopping batch"
    break
  }
}

$report | Format-Table -AutoSize
$report | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $PSScriptRoot "_codewarm-wedge-batch-report.json")
Write-Host "Batch report: scripts/_codewarm-wedge-batch-report.json"
