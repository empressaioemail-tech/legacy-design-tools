# cc-agent-C close note — EngineEnvelope honesty + pre-freeze Cortex hardening
**Date:** 2026-06-16  
**Branch:** `cortex/engine-envelope-honesty` → merged **PR #183**  
**Merge SHA (main):** `e470adbebe980128eabc2b1b520112f60895a441`  
**Workstation:** cente / `p:\legacy-design-tools`  
**Status:** **MERGED + canary deployed; traffic NOT shifted** (deploy-gated smokes not clean)

---

## PR + CI

| Item | Link / SHA |
|------|------------|
| PR | https://github.com/empressaioemail-tech/legacy-design-tools/pull/183 |
| PR CI (green) | https://github.com/empressaioemail-tech/legacy-design-tools/actions/runs/27625310699 |
| Main image build (green) | https://github.com/empressaioemail-tech/legacy-design-tools/actions/runs/27625746663 |
| deploy-canary run | https://github.com/empressaioemail-tech/legacy-design-tools/actions/runs/27625949517 |
| run-migrations run | https://github.com/empressaioemail-tech/legacy-design-tools/actions/runs/27626169384 |

### 8-commit split (branch `cortex/engine-envelope-honesty`)

| # | SHA | Message |
|---|-----|---------|
| 1 | `6e9dd9e4` | feat(engine-core): add EngineEnvelope unwrap aligned to E schema |
| 2 | `382cce2f` | chore(db): migration 0040 engine_honesty jsonb on run tables |
| 3 | `650cb11d` | feat(api-server): spine honesty passthrough and persist on runs |
| 4 | `8e2a8ca1` | feat(api-spec): EngineHonesty wire schema and codegen |
| 5 | `67d637a5` | feat(portal-ui): render engine honesty on finding detail |
| 6 | `c3e2f0ca` | feat(api-server): signed-URL path for large plan PDF uploads |
| 7 | `9e6432ee` | feat(design-tools): presign upload for large plan PDFs |
| 8 | `5125d9f5` | ci(deploy): bake CLASSIFICATION_LLM_MODE=anthropic on deploy-canary |

---

## Contract reconciliation (E schema PR #72)

`unwrapEngineEnvelope()` paths match hauska-engine `packages/engine-core/src/envelope/schema.ts`:
`payload`, `confidence{value,kind}`, `dataVintage`, `coverage{degraded,reason?}`, `source{adapter,citationIds?}`.

### Test output (verbatim)

```
pnpm --filter @workspace/engine-core test -- src/__tests__/envelope.test.ts

 RUN  v3.2.4 P:/legacy-design-tools/lib/engine-core

 ✓ src/__tests__/envelope.test.ts (4 tests) 3ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
```

E-shaped guard test asserts `degraded`/`dataVintage`/`confidence.kind`/`source.adapter` are **populated**, not conservative fallback defaults.

---

## Migration 0040

**Local prod apply (earlier this session):** `ok  0040_engine_honesty_on_runs.sql applied` — head 41/41.

**Workflow `run-migrations` (2026-06-16, run 27626169384):**

```
migrate-prod: connected to ***ep-lucky-truth-apodo8hr.c-7.us-east-1.aws.neon.tech/neondb
migrate-prod: 41 migration file(s) in lib/db/drizzle/
migrate-prod: 41 migration(s) already tracked as applied

migrate-prod: pending migrations:
  (none — DB is at the head)
```

---

## Deploy

| Item | Value |
|------|-------|
| Canary revision | `cortex-api-00173-tet` |
| Canary URL | `https://canary---cortex-api-tds7av26va-uc.a.run.app` |
| Default-route revision (unchanged) | `cortex-api-00171-wek` @ 100% |
| `shift-traffic` | **NOT RUN** — smokes below not clean |

---

## CLASSIFICATION_LLM_MODE on canary (`cortex-api-00173-tet`)

```
AIR_FINDING_LLM_MODE=anthropic
BRIEFING_LLM_MODE=anthropic
CLASSIFICATION_LLM_MODE=anthropic
MNML_RENDER_MODE=mock
DXF_CONVERTER_MODE=mock
```

No `*_LLM_MODE=mock`. `MNML_RENDER_MODE` / `DXF_CONVERTER_MODE` mock are expected (non-LLM).

---

## Deploy-gated smokes (canary) — raw output

### 1. GET /api/engagements → [] (unauthenticated leak guard)

```
curl.exe -sk "https://canary---cortex-api-tds7av26va-uc.a.run.app/api/healthz"
{"status":"ok"}

curl.exe -sk "https://canary---cortex-api-tds7av26va-uc.a.run.app/api/engagements"
[]
```

### 2. Cotality in-app flip — San Marcos parcel (`6d9cd127…` / 613 Sturgeon Dr)

`POST /api/engagements/{id}/generate-layers?adapterKey=…&forceRefresh=true` (internal `pr_session` cookie)

```
--- adapterKey=cotality:property forceRefresh=true ---
{
  "http": 200,
  "outcomes": [
    {
      "adapterKey": "cotality:property",
      "tier": "federal",
      "sourceKind": "federal-adapter",
      "layerKind": "cotality-property",
      "status": "failed",
      "error": {
        "code": "upstream-error",
        "message": "Cotality property-geocode responded HTTP 404. Use Force refresh to retry."
      },
      "sourceId": null,
      "fromCache": false,
      "cachedAt": null,
      "upstreamFreshness": null
    }
  ]
}

--- adapterKey=cotality:climate forceRefresh=true ---
{
  "http": 200,
  "outcomes": [
    {
      "adapterKey": "cotality:climate",
      "status": "failed",
      "error": {
        "code": "upstream-error",
        "message": "Cotality property-geocode responded HTTP 404. Use Force refresh to retry."
      }
    }
  ]
}

--- adapterKey=cotality:hazards forceRefresh=true ---
{
  "http": 200,
  "outcomes": [
    {
      "adapterKey": "cotality:hazards",
      "status": "failed",
      "error": {
        "code": "upstream-error",
        "message": "Cotality property-geocode responded HTTP 404. Use Force refresh to retry."
      }
    }
  ]
}
```

**Verdict:** FAIL — upstream Cotality geocode 404 (not 401; demo keys still valid until 2026-07-06). RiskMeter/SpatialTile never reached because property-geocode step fails first.

### 3. 413 — large (>4 MiB) PDF presign E2E

`POST /api/engagements/6d9cd127…/attached-documents/request-upload-url` body `{"name":"smoke-large-plan.pdf","size":5242880,"contentType":"application/pdf"}`

```
HTTP:500
{"error":"presign_failed"}
```

Cloud Run log (`cortex-api-00173-tet`):

```
"msg": "attached-document presign failed",
"err": {
  "message": "Permission 'iam.serviceAccounts.signBlob' denied on resource (or it may not exist).",
  "name": "SigningError"
}
```

Control: legacy `POST /api/storage/uploads/request-url` on default URL correctly returns **413** for 5 MiB (proves >4 MiB needs presign path):

```
{"error":"Upload too large: 5242880 bytes exceeds the 2097152-byte cap for this endpoint."}
HTTP:413
```

**Verdict:** FAIL — presign route wired in code but runtime SA lacks `iam.serviceAccounts.signBlob` for GCS signed PUT URLs.

### 4. Keystone — full plan review 404 Remodel_B

Engagement `15d1d314-c2fa-42d1-81f9-24eb06d94e3d`, submission `ba5b5ae5-468c-40df-90b2-7c04b88ccef4`, four plan-set pieces (building/mechanical/electrical/plumbing).

```
POST /api/submissions/ba5b5ae5-468c-40df-90b2-7c04b88ccef4/findings/generate
Cookie: pr_session=<internal-signed-token>
HTTP:202
{"generationId":"2cc3c4ff-edfd-4bef-8f78-8bc826b2591e","state":"pending"}

GET /api/submissions/ba5b5ae5-468c-40df-90b2-7c04b88ccef4/findings/status
HTTP:200
{
  "generationId": "2cc3c4ff-edfd-4bef-8f78-8bc826b2591e",
  "state": "failed",
  "startedAt": "2026-06-16T14:55:14.694Z",
  "completedAt": "2026-06-16T14:56:29.540Z",
  "error": "finding engine failed (engine_api_unknown): Timed out after 30000 ms while waiting for the WS endpoint URL to appear in stdout!",
  "invalidCitationCount": null,
  "invalidCitations": null,
  "discardedFindingCount": null,
  "engineHonesty": null
}

GET /api/submissions/ba5b5ae5-468c-40df-90b2-7c04b88ccef4/findings/runs
{
  "runs": [
    {
      "generationId": "2cc3c4ff-edfd-4bef-8f78-8bc826b2591e",
      "state": "failed",
      "error": "finding engine failed (engine_api_unknown): Timed out after 30000 ms while waiting for the WS endpoint URL to appear in stdout!",
      "engineHonesty": null
    }
  ]
}
```

**Verdict:** FAIL — no 409 (kickoff accepted), but engine-api call failed before envelope/honesty could populate. `finding_runs.engine_honesty` has **zero rows** in prod Neon (column exists post-0040).

### 5. engineHonesty passthrough (E canary envelope)

**Not proven live** — blocked by keystone failure above. Contract + unit test green; DB column ready.

---

## Go-for-traffic-shift to cc-agent-E

**HOLD — no timestamp issued.**

Reason: cannot verify cortex-api canary reads engine-api CANARY envelope with **populated** `engineHonesty` (degraded/vintage/confidence.kind/source) on a completed plan-review run. Engine-api spine call failed (`WS endpoint URL` timeout). E should not shift engine-api traffic based on this canary until keystone + honesty render are green.

---

## Operator next steps

1. **IAM:** Grant `roles/iam.serviceAccountTokenCreator` (signBlob) to `api-server-runtime` SA (or whichever SA cortex-api uses) for GCS presign on attached-documents path.
2. **Cotality:** Investigate property-geocode 404 for `613 Sturgeon Dr, San Marcos, TX 78666` (coords present: 29.870188, -97.927538). Flag if demo keys expire 2026-07-06 → expect 401, not workaround.
3. **Engine-api:** Fix WS-endpoint timeout on `/v1/findings/generate` (direct probe also returned HTTP 500). Re-run keystone smoke on canary; confirm `engineHonesty` populated on status/runs.
4. After smokes green: `gh workflow run cloud-run-deploy.yml -f action=shift-traffic`, then issue go-to-E timestamp.

---

## Serving revision

- **Production default route:** `cortex-api-00171-wek` @ `https://cortex-api-tds7av26va-uc.a.run.app`
- **Canary tag (0% default traffic):** `cortex-api-00173-tet` @ `https://canary---cortex-api-tds7av26va-uc.a.run.app`
