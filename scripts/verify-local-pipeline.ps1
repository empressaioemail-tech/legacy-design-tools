# Smoke-test local Cortex pipeline: env, healthz, engagements, optional BIM GLB.
param(
  [string]$EngagementId = "",
  [string]$ApiBase = "http://127.0.0.1:8080",
  [string]$UiBase = "http://127.0.0.1:20295",
  [switch]$TestRenderKickoff
)

$ErrorActionPreference = "Continue"
$fail = 0

function Test-Step {
  param([string]$Label, [bool]$Ok, [string]$Detail = "")
  if ($Ok) {
    Write-Host "[ok] $Label" -ForegroundColor Green
    if ($Detail) { Write-Host "     $Detail" -ForegroundColor DarkGray }
  } else {
    Write-Host "[FAIL] $Label" -ForegroundColor Red
    if ($Detail) { Write-Host "     $Detail" -ForegroundColor Yellow }
    $script:fail++
  }
}

Write-Host "`nCortex local pipeline verify" -ForegroundColor Cyan
Write-Host "  API: $ApiBase   UI proxy: $UiBase`n"

Test-Step "DATABASE_URL set" ([bool]$env:DATABASE_URL) $env:DATABASE_URL

$gcpKey = $env:GOOGLE_APPLICATION_CREDENTIALS
if (-not $gcpKey) {
  $defaultKey = "C:\Users\cente\google-cloud-sdk\smartcity-agent-key.json"
  if (Test-Path $defaultKey) { $gcpKey = $defaultKey }
}
Test-Step "GOOGLE_APPLICATION_CREDENTIALS" ([bool]$gcpKey -and (Test-Path $gcpKey)) $gcpKey
Test-Step "PRIVATE_OBJECT_DIR" ([bool]$env:PRIVATE_OBJECT_DIR) $env:PRIVATE_OBJECT_DIR
Test-Step "PUBLIC_OBJECT_SEARCH_PATHS" ([bool]$env:PUBLIC_OBJECT_SEARCH_PATHS) $env:PUBLIC_OBJECT_SEARCH_PATHS

try {
  $health = Invoke-WebRequest -Uri "$ApiBase/api/healthz" -UseBasicParsing -TimeoutSec 10
  Test-Step "API healthz" ($health.StatusCode -eq 200) "HTTP $($health.StatusCode)"
} catch {
  Test-Step "API healthz" $false $_.Exception.Message
}

try {
  $proxyHealth = Invoke-WebRequest -Uri "$UiBase/api/healthz" -UseBasicParsing -TimeoutSec 10
  Test-Step "Vite /api proxy" ($proxyHealth.StatusCode -eq 200) "HTTP $($proxyHealth.StatusCode)"
} catch {
  Test-Step "Vite /api proxy" $false "Is design-tools dev running on 20295? $($_.Exception.Message)"
}

try {
  $eng = Invoke-WebRequest -Uri "$ApiBase/api/engagements" -UseBasicParsing -TimeoutSec 30
  Test-Step "GET /api/engagements" ($eng.StatusCode -eq 200) "HTTP $($eng.StatusCode)"
} catch {
  Test-Step "GET /api/engagements" $false $_.Exception.Message
}

if ($EngagementId) {
  try {
    $bim = Invoke-WebRequest -Uri "$ApiBase/api/engagements/$EngagementId/bim-model" -UseBasicParsing -TimeoutSec 30
    Test-Step "GET bim-model" ($bim.StatusCode -eq 200) "HTTP $($bim.StatusCode)"
    if ($bim.StatusCode -eq 200) {
      $parsed = $bim.Content | ConvertFrom-Json
      $elements = @($parsed.bimModel.elements)
      $glbEl = $elements | Where-Object {
        ($null -ne $_.glbObjectPath -and $_.glbObjectPath -ne "") -or
        ($null -ne $_.briefingSourceId -and $_.briefingSourceId -ne "")
      } | Select-Object -First 1
      if ($glbEl) {
        $glbPath = if ($glbEl.glbObjectPath) {
          "/api/materializable-elements/$($glbEl.id)/glb"
        } else {
          "/api/briefing-sources/$($glbEl.briefingSourceId)/glb"
        }
        try {
          $glb = Invoke-WebRequest -Uri "$ApiBase$glbPath" -UseBasicParsing -TimeoutSec 60
          Test-Step "GET GLB bytes" ($glb.StatusCode -eq 200) "HTTP $($glb.StatusCode) $glbPath"
        } catch {
          $status = $_.Exception.Response.StatusCode.value__
          $hint = switch ($status) {
            403 { "GCS forbidden — service account lacks storage.objects.get on legacy-design-tools-prod-objects" }
            500 { "api-server/GCS error — see api-server logs" }
            404 { "object missing in bucket" }
            default { "HTTP $status" }
          }
          Test-Step "GET GLB bytes" $false "$glbPath — $hint"
        }
      } else {
        Test-Step "GLB element on model" $false "No element with glbObjectPath or briefingSourceId"
      }
    }
  } catch {
    $status = try { $_.Exception.Response.StatusCode.value__ } catch { "?" }
    Test-Step "GET bim-model" $false "HTTP $status — wrong id or DATABASE_URL points at empty DB"
  }

  if ($TestRenderKickoff) {
    $body = @{
      kind = "still"
      prompt = "local pipeline smoke still"
      cameraPosition = @{ x = 0; y = 5; z = 10 }
      cameraTarget = @{ x = 0; y = 0; z = 0 }
    } | ConvertTo-Json -Compress
    try {
      $kick = Invoke-WebRequest -Uri "$ApiBase/api/engagements/$EngagementId/renders" `
        -Method POST -ContentType "application/json" -Body $body -UseBasicParsing -TimeoutSec 30
      Test-Step "POST render kickoff (no glbUrl)" ($kick.StatusCode -eq 202) "HTTP $($kick.StatusCode) renderId=$($kick.Content | ConvertFrom-Json | Select-Object -ExpandProperty renderId)"
    } catch {
      $status = try { $_.Exception.Response.StatusCode.value__ } catch { "?" }
      Test-Step "POST render kickoff" $false "HTTP $status — need briefing+bim+GLB; api on dev:local with mock mnml"
    }
  }
}

Write-Host ""
if ($fail -eq 0) {
  Write-Host "Pipeline checks passed. Open $UiBase and hard-refresh (Ctrl+Shift+R)." -ForegroundColor Green
  exit 0
}
Write-Host "$fail check(s) failed. See docs/local-dev-windows.md" -ForegroundColor Red
exit 1
