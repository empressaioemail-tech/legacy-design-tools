# Local UI loop on Windows — real api-server on :8080 (not Cloud Run proxy).
#
# Prerequisites:
#   - pnpm install (win32-x64 optional deps for lightningcss + @tailwindcss/oxide
#     must not be stubbed in pnpm-workspace.yaml overrides)
#   - DATABASE_URL set (Neon cortex-prod or dev branch) — required for dev:local
#   - Canva tables: from repo root, `cd lib/db; pnpm run push` (applies 0020_add_canva.sql)
#
# api-server modes:
#   - `pnpm run dev`        → dev-proxy.mjs → Cloud Run (no local /api/canva/*)
#   - `pnpm run dev:local`  → build + dist/index.mjs on PORT (this script)
#
# Canva OAuth (optional, for real connect):
#   CANVA_CLIENT_ID, CANVA_CLIENT_SECRET
#   CANVA_REDIRECT_URI=http://localhost:8080/api/canva/oauth/callback
#   CANVA_OAUTH_SUCCESS_URL=http://localhost:20295/
#   See artifacts/api-server/README-canva.md
#
# Usage (two terminals, or run this script which starts API in a new window):
#   .\scripts\dev-local-windows.ps1
#   .\scripts\verify-local-pipeline.ps1
# Runbook: docs/local-dev-windows.md
# Preview: http://localhost:20295  |  API: http://localhost:8080/api/healthz
#
# Do NOT set VITE_CANVA_API=0 unless you want the portal-ui mock (no real OAuth).

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# Optional local secrets file (copy from .env.local.example)
$EnvLocal = Join-Path $Root ".env.local"
if (Test-Path $EnvLocal) {
  Get-Content $EnvLocal | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { return }
    $name = $Matches[1]
    $value = $Matches[2].Trim().Trim('"').Trim("'")
    Set-Item -Path "env:$name" -Value $value
  }
  Write-Host "Loaded $EnvLocal" -ForegroundColor DarkGray
}

# Minimal dev boot env (api-server chat route requires these)
if (-not $env:SNAPSHOT_SECRET) { $env:SNAPSHOT_SECRET = "dev-local-snapshot-secret" }
if (-not $env:AI_INTEGRATIONS_ANTHROPIC_BASE_URL) {
  $env:AI_INTEGRATIONS_ANTHROPIC_BASE_URL = "http://127.0.0.1:9"
}
if (-not $env:AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
  $env:AI_INTEGRATIONS_ANTHROPIC_API_KEY = "dev-key-not-real"
}
# BRIEFING_LLM_MODE is required (fail-loud when unset); dev explicitly
# requests the deterministic mock generator.
if (-not $env:BRIEFING_LLM_MODE) { $env:BRIEFING_LLM_MODE = "mock" }

# GCS ADC for GLB/sheet serve (Replit sidecar :1106 is not available on Windows).
$DefaultGcpKey = "C:\Users\cente\google-cloud-sdk\smartcity-agent-key.json"
if (-not $env:GOOGLE_APPLICATION_CREDENTIALS -and (Test-Path $DefaultGcpKey)) {
  $env:GOOGLE_APPLICATION_CREDENTIALS = $DefaultGcpKey
}
if (-not $env:PRIVATE_OBJECT_DIR) {
  $env:PRIVATE_OBJECT_DIR = "/legacy-design-tools-prod-objects/.private"
}
if (-not $env:PUBLIC_OBJECT_SEARCH_PATHS) {
  $env:PUBLIC_OBJECT_SEARCH_PATHS = "/legacy-design-tools-prod-objects/public"
}

if (-not $env:DATABASE_URL) {
  Write-Host ""
  Write-Host "WARNING: DATABASE_URL is not set. api-server dev:local will fail to boot." -ForegroundColor Yellow
  Write-Host "  Create $EnvLocal from .env.local.example with your Neon URL." -ForegroundColor Yellow
  Write-Host "  Or: `$env:DATABASE_URL = 'postgresql://...'" -ForegroundColor Yellow
  Write-Host "  Then apply schema: cd lib/db; pnpm run push" -ForegroundColor Yellow
  Write-Host ""
} else {
  # Terminal 1 — local api-server (new window)
  $apiCmd = @"
Set-Location '$Root'
`$env:PORT = '8080'
`$env:NODE_ENV = 'development'
if (Test-Path '$EnvLocal') {
  Get-Content '$EnvLocal' | ForEach-Object {
    if (`$_ -match '^\s*#' -or `$_ -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { return }
    Set-Item -Path "env:`$(`$Matches[1])" -Value `$Matches[2].Trim().Trim('"').Trim("'")
  }
}
if (-not `$env:SNAPSHOT_SECRET) { `$env:SNAPSHOT_SECRET = 'dev-local-snapshot-secret' }
if (-not `$env:AI_INTEGRATIONS_ANTHROPIC_BASE_URL) { `$env:AI_INTEGRATIONS_ANTHROPIC_BASE_URL = 'http://127.0.0.1:9' }
if (-not `$env:AI_INTEGRATIONS_ANTHROPIC_API_KEY) { `$env:AI_INTEGRATIONS_ANTHROPIC_API_KEY = 'dev-key-not-real' }
if (-not `$env:BRIEFING_LLM_MODE) { `$env:BRIEFING_LLM_MODE = 'mock' }
if (-not `$env:GOOGLE_APPLICATION_CREDENTIALS -and (Test-Path '$DefaultGcpKey')) {
  `$env:GOOGLE_APPLICATION_CREDENTIALS = '$DefaultGcpKey'
}
if (-not `$env:PRIVATE_OBJECT_DIR) { `$env:PRIVATE_OBJECT_DIR = '/legacy-design-tools-prod-objects/.private' }
if (-not `$env:PUBLIC_OBJECT_SEARCH_PATHS) { `$env:PUBLIC_OBJECT_SEARCH_PATHS = '/legacy-design-tools-prod-objects/public' }
Write-Host 'Starting local api-server (dev:local) on http://localhost:8080' -ForegroundColor Green
Write-Host 'Verify: curl http://localhost:8080/api/canva/connection' -ForegroundColor DarkGray
pnpm --filter @workspace/api-server run dev:local
"@

  Start-Process powershell -ArgumentList @("-NoExit", "-Command", $apiCmd)
  Start-Sleep -Seconds 3
}

# Terminal 2 — Vite (this window)
$env:PORT = "20295"
$env:BASE_PATH = "/"
Write-Host "Starting design-tools at http://localhost:20295 (Vite proxy /api -> local :8080)" -ForegroundColor Cyan
pnpm --filter @workspace/design-tools run dev
