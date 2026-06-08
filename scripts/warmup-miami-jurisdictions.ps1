# Warm Miami Beach + Miami-Dade cortex-local code_atoms via api-server.
# Requires api-server running locally (dev:local) with DATABASE_URL set.
#
# Usage:
#   .\scripts\warmup-miami-jurisdictions.ps1
#   .\scripts\warmup-miami-jurisdictions.ps1 -BaseUrl "http://localhost:5000"

param(
  [string]$BaseUrl = "http://localhost:5000"
)

$keys = @("miami_beach_fl", "miami_dade_fl")

foreach ($key in $keys) {
  Write-Host "Enqueueing warmup for $key ..."
  $warmup = Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/codes/warmup/$key"
  $warmup | ConvertTo-Json -Depth 5

  $deadline = (Get-Date).AddMinutes(15)
  do {
    Start-Sleep -Seconds 5
    $status = Invoke-RestMethod -Uri "$BaseUrl/api/codes/warmup-status/$key"
    Write-Host "$key state=$($status.state) completed=$($status.completed) pending=$($status.pending)"
    if ($status.state -eq "completed" -or $status.state -eq "failed") { break }
  } while ((Get-Date) -lt $deadline)

  $status | ConvertTo-Json -Depth 5
}

Write-Host "Web code retrieval supplements Layer-1 gaps at finding-generation time (no interim seed)."
