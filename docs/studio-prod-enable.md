# Studio production enable — one deploy + env pass

Use this after the Studio code path is on `main` and you are ready to
flip production render kickoffs (mnml + `RENDERS_PROD_ENABLED`).

**You handle:** GCP Secret Manager values, `gcloud run services update`,
traffic shift, and optional Neon migration if the canary DB is behind.

**Already in the image:** Puppeteer + Chrome, render routes, polling
worker, GCS mirror, design-tools Studio UI.

---

## Prerequisites

| Item | Notes |
|------|--------|
| mnml API key | Out-of-band from mnml.ai |
| GCS read on prod bucket | Runtime SA can `storage.objects.get` on `legacy-design-tools-prod-objects` |
| Engagement data | Briefing + bim_model + GLB (Revit sync or DXF→GLB) per project |
| DB migrations | `viewpoint_renders` / `render_outputs` from `lib/db/drizzle/0005` + `0016` |

---

## 1. Secret Manager (once)

Create or confirm secrets in **`legacy-design-tools-prod`** (names are
conventional — match what Cloud Run binds):

| Secret | Example value |
|--------|----------------|
| `MNML_API_URL` | `https://api.mnmlai.dev` |
| `MNML_API_KEY` | (opaque bearer token) |

Existing deploy already binds: `DATABASE_URL`, `SESSION_SECRET`,
`BIM_MODEL_SHARED_SECRET`, etc. (see `docs/deploy.md`).

---

## 2. Cloud Run env — single update

After **`deploy-canary`** lands a revision, run (adjust region/service if
different):

```powershell
gcloud run services update cortex-api `
  --region=us-central1 `
  --project=legacy-design-tools-prod `
  --update-env-vars=RENDERS_PROD_ENABLED=true,MNML_RENDER_MODE=http `
  --update-secrets=MNML_API_URL=MNML_API_URL:latest,MNML_API_KEY=MNML_API_KEY:latest
```

Or use the helper script:

```powershell
cd P:\legacy-design-tools
.\scripts\enable-studio-cloud-run.ps1 -ProjectId legacy-design-tools-prod
```

**Boot check:** api logs must **not** show
`MNML_RENDER_MODE=http requires MNML_API_URL and MNML_API_KEY`.

**Mock smoke (no mnml key yet):** leave `MNML_RENDER_MODE=mock` but set
`RENDERS_PROD_ENABLED=true` — kickoffs complete with placeholder images.

---

## 3. Canary workflow (recap)

1. Push to `main` → image build  
2. `workflow_dispatch` → **deploy-canary** (`image_tag` = sha)  
3. **run-migrations** if needed (`bootstrap` only on first DB)  
4. Apply env block above on the **canary revision** (or service default)  
5. Smoke `https://canary---<host>/api/healthz`  
6. Studio kickoff on a project with GLB (see §4)  
7. **shift-traffic** when green  

Template deploy sets `RENDERS_PROD_ENABLED=false` and
`MNML_RENDER_MODE=mock` so production stays safe until you run §2.

---

## 4. Smoke tests

```powershell
# Gate open (not 503)
curl.exe -s -o NUL -w "%{http_code}" -X POST `
  "https://canary---<HOST>/api/engagements/<ENGAGEMENT_ID>/renders" `
  -H "Content-Type: application/json" `
  -d "{\"kind\":\"still\",\"prompt\":\"smoke test exterior\",\"cameraPosition\":{\"x\":0,\"y\":5,\"z\":10},\"cameraTarget\":{\"x\":0,\"y\":0,\"z\":0}}"

# Expect 202 (glbUrl optional — server resolves engagement GLB)
```

List + poll:

```powershell
curl.exe -s "https://canary---<HOST>/api/engagements/<ENGAGEMENT_ID>/renders"
curl.exe -s "https://canary---<HOST>/api/renders/<RENDER_ID>"
```

Local equivalent: `docs/local-dev-windows.md` + optional
`.\scripts\verify-local-pipeline.ps1 -EngagementId <uuid> -TestRenderKickoff`.

---

## 5. UI path

1. Open engagement → **Studio** → **Rendering**  
2. **Model renders** → **Create** → prompt + **Kick off**  
3. Or **Model** → **Snapshots** → **Render in Studio** (prefills camera + GLB)  
4. Ready still → **Refine** (enhance / upscale / …) or **Use in client materials**

---

## 6. Failure cheatsheet

| Symptom | Likely fix |
|---------|------------|
| 503 `renders_preview_disabled` | `RENDERS_PROD_ENABLED=true` |
| Boot exit / mnml env error | Bind both MNML secrets + `MNML_RENDER_MODE=http` |
| 400 `glb_not_attached` | Revit push or DXF ingest; verify GLB 200 |
| 400 `no_briefing_for_engagement` | Run briefing generation |
| Capture `browser_unavailable` | Cloud Run memory (8Gi in workflow); Chromium deps in image |
| Stuck `queued` | Check api logs for `runRenderPolling`; mnml mock vs http |

---

## Code references

- Kickoff: `artifacts/api-server/src/routes/renders.ts`  
- GLB resolve (V1-5): `artifacts/api-server/src/lib/resolveEngagementGlbUrl.ts`  
- UI: `artifacts/design-tools/src/components/engagement-detail/DesignToolsTab.tsx`  
- mnml handoff: `docs/wave-2/02-mnml-secrets-handoff.md`
