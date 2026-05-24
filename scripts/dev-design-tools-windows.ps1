# Design Tools (Cockpit shell) — Style Probe chrome preview
# Worktree: P:\ldt-replit-ui  |  Branch: replit/ui-cockpit-ia-consolidation
#
# Usage:
#   .\scripts\dev-design-tools-windows.ps1
#
# Style Probe: http://localhost:20296/style-probe

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$env:PORT = "20296"
$env:BASE_PATH = "/"
$env:VITE_DEMO_SEED = "1"

Write-Host ""
Write-Host "  Design Tools (Cockpit shell)" -ForegroundColor Cyan
Write-Host "  Worktree: $Root" -ForegroundColor DarkGray
Write-Host "  Branch:   replit/ui-cockpit-ia-consolidation" -ForegroundColor DarkGray
Write-Host "  Style Probe: http://localhost:20296/style-probe" -ForegroundColor Green
Write-Host "  (NOT :20297 plan-review — old DashboardLayout shell)" -ForegroundColor DarkGray
Write-Host ""

pnpm --filter @workspace/portal-ui exec tsc -p tsconfig.json 2>$null | Out-Null
pnpm --filter @workspace/design-tools run dev
