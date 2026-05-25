# Start local api-server (dev:local) + design-tools Vite. Kills stale :8080/:20295 listeners first.
param(
  [switch]$ApiOnly,
  [switch]$ViteOnly
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$EnvLocal = Join-Path $Root ".env.local"
if (Test-Path $EnvLocal) {
  Get-Content $EnvLocal | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { return }
    Set-Item -Path "env:$($Matches[1])" -Value $Matches[2].Trim().Trim('"').Trim("'")
  }
}

if (-not $env:SNAPSHOT_SECRET) { $env:SNAPSHOT_SECRET = "dev-local-snapshot-secret" }
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
if (-not $env:AI_INTEGRATIONS_ANTHROPIC_BASE_URL) {
  $env:AI_INTEGRATIONS_ANTHROPIC_BASE_URL = "http://127.0.0.1:9"
}
if (-not $env:AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
  $env:AI_INTEGRATIONS_ANTHROPIC_API_KEY = "dev-key-not-real"
}

function Stop-PortListener([int]$Port) {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}

if (-not $ViteOnly) {
  if (-not $env:DATABASE_URL) {
    Write-Host "DATABASE_URL missing. Copy .env.local.example to .env.local and set your Neon URL." -ForegroundColor Red
    exit 1
  }
  Stop-PortListener 8080
  $env:PORT = "8080"
  $env:NODE_ENV = "development"
  Write-Host "Starting api-server dev:local on http://localhost:8080 ..." -ForegroundColor Green
  pnpm --filter @workspace/api-server run dev:local
  exit $LASTEXITCODE
}

if (-not $ApiOnly) {
  Stop-PortListener 20295
  $env:PORT = "20295"
  $env:BASE_PATH = "/"
  Write-Host "Starting design-tools on http://localhost:20295 ..." -ForegroundColor Cyan
  pnpm --filter @workspace/design-tools run dev
}
