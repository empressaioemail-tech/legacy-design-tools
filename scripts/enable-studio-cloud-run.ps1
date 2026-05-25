# Apply Studio production env + mnml secrets to cortex-api on Cloud Run.
# Run AFTER deploy-canary and AFTER MNML_API_URL / MNML_API_KEY exist in Secret Manager.
param(
  [string]$ProjectId = "legacy-design-tools-prod",
  [string]$Region = "us-central1",
  [string]$Service = "cortex-api",
  [switch]$MockMnml,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$envVars = "RENDERS_PROD_ENABLED=true"
if ($MockMnml) {
  $envVars += ",MNML_RENDER_MODE=mock"
  Write-Host "Mock mnml: kickoffs use placeholder images (no MNML_API_* required)." -ForegroundColor Yellow
} else {
  $envVars += ",MNML_RENDER_MODE=http"
}

$args = @(
  "run", "services", "update", $Service,
  "--region=$Region",
  "--project=$ProjectId",
  "--update-env-vars=$envVars"
)

if (-not $MockMnml) {
  $args += "--update-secrets=MNML_API_URL=MNML_API_URL:latest,MNML_API_KEY=MNML_API_KEY:latest"
}

Write-Host "`nStudio enable — $Service ($ProjectId / $Region)`n" -ForegroundColor Cyan
Write-Host "gcloud $($args -join ' ')`n" -ForegroundColor DarkGray

if ($DryRun) {
  Write-Host "[dry-run] No changes applied." -ForegroundColor Yellow
  exit 0
}

& gcloud @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "`nDone. Smoke:" -ForegroundColor Green
Write-Host "  gcloud run services describe $Service --region=$Region --project=$ProjectId --format='value(status.url)'"
Write-Host "  POST /api/engagements/<id>/renders (202) — see docs/studio-prod-enable.md"
