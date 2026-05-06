# api-server deploy — Cloud Run (Phase 1A)

## Summary

The `api-server` artifact runs on **Cloud Run** in `us-central1` as a single
service named `api-server`. The frontends (`design-tools`, `plan-review`,
`mockup-sandbox`) remain on **Replit autoscale** — their migration is a
separate phase. The database stays on the **existing Replit Neon** for Phase
1A; the Empressa Neon swap is Phase 1C and is a Secret Manager value rotation,
not a code change.

GitHub Actions builds and pushes a new image to Artifact Registry on every
push to `main` (`build-and-push` job in
[`.github/workflows/cloud-run-deploy.yml`](../.github/workflows/cloud-run-deploy.yml)).
Deploys are **manual**: trigger the `deploy-canary` job via
`workflow_dispatch` and a new Cloud Run revision is created with
`--no-traffic` (0% canary). Traffic shifts are manual via `gcloud` per
`doc_repo/90_runbooks/cloud_run_canary_deploy.md` — typically 10% → 50% →
100% with smoke probes between each step.

---

## GCP-side prerequisites

Run once, before the first deploy. Replace `<PROJECT_NUMBER>` with the actual
numeric project ID printed by `gcloud projects describe ...
--format='value(projectNumber)'`.

### 1. Project + APIs

```bash
gcloud projects create legacy-design-tools-prod --name="legacy-design-tools (prod)"
gcloud config set project legacy-design-tools-prod

gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iamcredentials.googleapis.com \
  iam.googleapis.com
```

### 2. Artifact Registry

```bash
gcloud artifacts repositories create apps \
  --repository-format=docker \
  --location=us-central1 \
  --description="legacy-design-tools container images"
```

### 3. Workload Identity Federation for GitHub Actions

Pool + provider scoped to the single repo `empressaioemail-tech/legacy-design-tools`:

```bash
gcloud iam workload-identity-pools create github-actions \
  --location=global \
  --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github \
  --location=global \
  --workload-identity-pool=github-actions \
  --display-name="GitHub" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="attribute.repository == 'empressaioemail-tech/legacy-design-tools'"
```

The full provider resource name (used as the GHA `GCP_WORKLOAD_IDENTITY_PROVIDER`
secret) is:

```
projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/github-actions/providers/github
```

### 4. Deploy service account (used by GHA)

```bash
gcloud iam service-accounts create gha-deployer \
  --display-name="GitHub Actions deploy SA"

DEPLOYER_SA=gha-deployer@legacy-design-tools-prod.iam.gserviceaccount.com

for ROLE in \
  roles/run.admin \
  roles/artifactregistry.writer \
  roles/iam.serviceAccountUser \
  roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding legacy-design-tools-prod \
    --member="serviceAccount:${DEPLOYER_SA}" \
    --role="${ROLE}"
done

# Allow the GitHub repo (via WIF) to impersonate the deploy SA.
gcloud iam service-accounts add-iam-policy-binding "${DEPLOYER_SA}" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/github-actions/attribute.repository/empressaioemail-tech/legacy-design-tools"
```

### 5. Cloud Run runtime service account

The deploy SA above is for GHA. The runtime SA is what the Cloud Run
container itself uses (Application Default Credentials for GCS, Secret
Manager access).

```bash
gcloud iam service-accounts create api-server-runtime \
  --display-name="api-server Cloud Run runtime SA"

RUNTIME_SA=api-server-runtime@legacy-design-tools-prod.iam.gserviceaccount.com

# Secret Manager: read all api-server secrets.
gcloud projects add-iam-policy-binding legacy-design-tools-prod \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/secretmanager.secretAccessor

# GCS: object access for PUBLIC_OBJECT_SEARCH_PATHS / PRIVATE_OBJECT_DIR
# targets. Prefer bucket-scoped roles in production; project-wide is the
# quick path for the canary.
gcloud projects add-iam-policy-binding legacy-design-tools-prod \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/storage.objectAdmin

# Allow the deploy SA to "actAs" the runtime SA (required for
# `gcloud run deploy --service-account=...`).
gcloud iam service-accounts add-iam-policy-binding "${RUNTIME_SA}" \
  --role=roles/iam.serviceAccountUser \
  --member="serviceAccount:${DEPLOYER_SA}"
```

### 6. Secret Manager entries

For each `secret`-class entry in the env inventory below, create a Secret
Manager secret and seed it with the current Replit production value
(export from Replit Secrets manually — these are not in the repo).

```bash
# Example for DATABASE_URL. Repeat for each secret-class env var.
gcloud secrets create DATABASE_URL --replication-policy=automatic
echo -n "<current-replit-neon-url>" | gcloud secrets versions add DATABASE_URL --data-file=-
```

Secrets to create (matching the names referenced in
[`.github/workflows/cloud-run-deploy.yml`](../.github/workflows/cloud-run-deploy.yml)
`--set-secrets`):

- `DATABASE_URL` (Phase 1A: current Replit Neon URL; Phase 1C: Empressa Neon)
- `AI_INTEGRATIONS_ANTHROPIC_API_KEY`
- `BIM_MODEL_SHARED_SECRET`

Add as needed per the inventory: `MNML_API_KEY`, `OPENAI_API_KEY`,
`CONVERTER_SHARED_SECRET`. These are only required when their corresponding
`*_MODE=http` env var is set; the canary launches with all of these in `mock`
mode so they can be added incrementally.

### 7. GitHub Actions repo secrets

Set in `Settings → Secrets and variables → Actions` for
`empressaioemail-tech/legacy-design-tools`:

| Secret | Value |
|---|---|
| `GCP_PROJECT_ID` | `legacy-design-tools-prod` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/github-actions/providers/github` |
| `GCP_SERVICE_ACCOUNT` | `gha-deployer@legacy-design-tools-prod.iam.gserviceaccount.com` |
| `GCP_RUNTIME_SERVICE_ACCOUNT` | `api-server-runtime@legacy-design-tools-prod.iam.gserviceaccount.com` |

### 8. Backup tag on origin/main

Before the first deploy:

```bash
DATE=$(date +%Y%m%d)
git tag "backup/pre-migration-sprint-${DATE}" origin/main
git push origin "backup/pre-migration-sprint-${DATE}"
```

---

## Env var inventory

Derived from `process.env.*` in `artifacts/api-server/src/` plus the
transitive workspace deps it imports at boot. `Class = secret` → Secret
Manager. `Class = config` → Cloud Run env var.

| Var | Class | Required | Source | Notes |
|---|---|---|---|---|
| `DATABASE_URL` | secret | hard required at boot | `lib/db/src/index.ts` | Phase 1A value = current Replit Neon URL. Phase 1C swaps to Empressa Neon (Secret Manager value rotation, no code change). |
| `PORT` | config | yes | `artifacts/api-server/src/index.ts` | Cloud Run injects automatically (8080). Hard-fails at boot if unset. |
| `NODE_ENV` | config | yes | `lib/logger.ts`, multiple | Set to `production` by the workflow. |
| `LOG_LEVEL` | config | optional | `lib/logger.ts` | Default `info`. Workflow sets `info` explicitly. |
| `AI_INTEGRATIONS_ANTHROPIC_API_KEY` | secret | hard required at boot | `lib/integrations-anthropic-ai/src/client.ts` | Throws at module import if unset. |
| `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` | config | hard required at boot | `lib/integrations-anthropic-ai/src/client.ts` | Workflow sets `https://api.anthropic.com` — confirm before first deploy. |
| `BIM_MODEL_SHARED_SECRET` | secret | required for upload flow | `routes/bimModels.ts` | HMAC secret for BIM model uploads. |
| `AIR_FINDING_LLM_MODE` | config | optional | `lib/finding-engine/src/engine.ts` | Default `mock`. `anthropic` requires the AI Integrations env. |
| `BRIEFING_LLM_MODE` | config | optional | `lib/briefing-engine/src/engine.ts` | Default `mock`. |
| `MNML_RENDER_MODE` | config | optional | `lib/mnml-client/src/factory.ts` | Default `mock`. `http` requires `MNML_API_URL` + `MNML_API_KEY`. |
| `MNML_API_URL` | config | conditional | `lib/mnml-client/src/factory.ts` | Required when `MNML_RENDER_MODE=http`. |
| `MNML_API_KEY` | secret | conditional | `lib/mnml-client/src/factory.ts` | Required when `MNML_RENDER_MODE=http`. |
| `DXF_CONVERTER_MODE` | config | optional | `lib/converterClient.ts` | Default `mock`. `http` requires `CONVERTER_URL` + `CONVERTER_SHARED_SECRET`. |
| `CONVERTER_URL` | config | conditional | `lib/converterClient.ts` | Required when `DXF_CONVERTER_MODE=http`. |
| `CONVERTER_SHARED_SECRET` | secret | conditional | `lib/converterClient.ts` | Required when `DXF_CONVERTER_MODE=http`. |
| `OPENAI_API_KEY` | secret | optional (gates embeddings) | `lib/codes/src/embeddings.ts` | Without it, embedding-dependent code paths skip. |
| `OPENAI_BASE_URL` | config | optional | `lib/codes/src/embeddings.ts` | Default `https://api.openai.com/v1`. |
| `PUBLIC_OBJECT_SEARCH_PATHS` | config | required for object reads | `lib/objectStorage.ts` | Comma-separated paths under the GCS bucket. |
| `PRIVATE_OBJECT_DIR` | config | required for object writes | `lib/objectStorage.ts` | Path prefix for private uploads. |
| `ADAPTER_CACHE_TTL_MS` | config | optional | `lib/adapterCache.ts` | Has internal default. |
| `ADAPTER_CACHE_SWEEP_INTERVAL_MS` | config | optional | `lib/adapterCache.ts` | `0` disables the sweeper. |
| `ADAPTER_CACHE_SWEEP_GRACE_MS` | config | optional | `lib/adapterCache.ts` | |
| `ADAPTER_CACHE_SWEEP_BATCH_SIZE` | config | optional | `lib/adapterCache.ts` | |
| `ADAPTER_CACHE_SWEEP_SKIP_WARN_MS` | config | optional | `lib/adapterCache.ts` | |
| `CODE_ATOM_QUEUE_TICK_MS` | config | optional | `lib/codes/src/queue.ts` | Default 10000. |
| `CODE_ATOM_QUEUE_BATCH_SIZE` | config | optional | `lib/codes/src/queue.ts` | Default 3. |
| `FINDING_RUNS_KEEP_PER_SUBMISSION` | config | optional | `routes/findings.ts`, `routes/findingsRuns.ts` | |
| `FINDING_RUNS_CONSOLE_LIMIT` | config | optional | `routes/findingsRuns.ts` | |
| `SNAPSHOT_SECRET` | (unknown) | unknown | declared in `.replit` `[userenv.shared]`; not found in `artifacts/api-server/src/` grep | Excluded from the runtime env in the canary. If a production code path references it (likely via a workspace lib not yet audited) and starts failing, add it as a Secret Manager binding. Flagged for Nick. |

The canary deploy in
[`.github/workflows/cloud-run-deploy.yml`](../.github/workflows/cloud-run-deploy.yml)
boots with all `*_MODE` vars set to `mock`. Promote to real backends one var
at a time via `gcloud run services update --update-env-vars=...` after the
canary is stable.

---

## First deploy procedure

1. Confirm all GCP-side prerequisites (sections 1–7 above) are complete.
2. Tag the current `origin/main` for rollback:
   ```bash
   DATE=$(date +%Y%m%d)
   git tag "backup/pre-migration-sprint-${DATE}" origin/main
   git push origin "backup/pre-migration-sprint-${DATE}"
   ```
3. Trigger the `build-and-push` job. Either push or merge a small change
   to `main`, or re-run the workflow on the existing main commit via the
   Actions UI.
4. Confirm the image landed in Artifact Registry:
   ```bash
   gcloud artifacts docker images list \
     us-central1-docker.pkg.dev/legacy-design-tools-prod/apps/api-server \
     --limit=5 --sort-by=~CREATE_TIME
   ```
5. Run the `deploy-canary` workflow via `workflow_dispatch`. Use the SHA
   of the just-built image as `image_tag` (preferred) or `latest`.
6. Confirm the new revision exists at 0% traffic:
   ```bash
   gcloud run services describe api-server \
     --region=us-central1 \
     --format='value(status.traffic)'
   ```
7. Smoke-probe the canary URL. Cloud Run gives each `--no-traffic`
   revision its own URL; grab it from `gcloud run revisions describe
   <revision> --format='value(status.url)'`:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" "<canary-url>/api/healthz"
   # expect: 200
   ```
8. Shift traffic per `doc_repo/90_runbooks/cloud_run_canary_deploy.md`.
   Typical pattern: 10% → observe → 50% → observe → 100%.
   ```bash
   gcloud run services update-traffic api-server \
     --region=us-central1 \
     --to-revisions=<new-revision>=10
   ```
9. Verify production traffic in Cloud Run logs and the
   `api-server-runtime` SA's audit log.

---

## Rollback

The previous revision stays warm. Instant rollback:

```bash
gcloud run services update-traffic api-server \
  --region=us-central1 \
  --to-revisions=<previous-revision>=100
```

Replit autoscale also remains live as a parallel fallback during the
verification window. If Cloud Run misbehaves badly, point DNS back to the
Replit endpoint while the Cloud Run revision is being investigated.

---

## What this phase does NOT do

- **No Neon swap** — Phase 1C handles the move from Replit Neon to Empressa
  Neon. Phase 1A runs against the existing Replit Neon (just from a new
  compute environment).
- **No `scripts/post-merge.sh` change** — Fire 3 (the cleanup of the
  Replit-only post-merge hook) is a separate one-file PR.
- **No removal of Replit autoscale or `.replit` cleanup** — the existing
  Replit deploy stays running as the rollback fallback.
- **No frontend migration** — `design-tools`, `plan-review`,
  `mockup-sandbox`, `qa` artifacts continue running on Replit. A separate
  phase handles their migration.
- **No Drizzle migrate adoption** — Phase 3.
- **No puppeteer-as-separate-service split** — image carries Chrome runtime
  libs for now (see follow-up below).
- **No automatic traffic shifting in the GHA workflow** — every traffic
  change is a manual `gcloud` per the canary runbook.

---

## Follow-up items surfaced during scaffold

- **Frontend hosting decision.** Replit autoscale stays for now, but the
  long-term home (Cloud Run, Cloudflare Pages, Vercel, …) is undecided.
- **Puppeteer service split.** Including Chrome runtime libs roughly
  doubles the image size. A follow-up phase should extract puppeteer-using
  endpoints (BIM viewport capture, briefing PDF rendering) into a separate
  Cloud Run service so the main api-server image can drop the X11/cairo
  package set.
- **`SNAPSHOT_SECRET` runtime usage.** Declared in `.replit`
  `[userenv.shared]` but no production grep hit in
  `artifacts/api-server/src/`. Confirm whether it's referenced via a
  workspace lib not yet audited (likely `@workspace/empressa-atom` or
  `@workspace/codes`) before declaring it test-only.
- **SIGTERM signal handling.** Cloud Run sends SIGTERM with a 10s grace
  period before SIGKILL. `artifacts/api-server/src/app.ts` does not
  install a SIGTERM handler — the listening Express server exits abruptly,
  in-flight requests are dropped. Add a graceful-shutdown handler before
  the canary takes meaningful production traffic.
- **`AI_INTEGRATIONS_ANTHROPIC_BASE_URL`.** Workflow ships with
  `https://api.anthropic.com` as the placeholder. Confirm the prod target
  before the first deploy — it may be a regional or proxy URL today.
- **`PUBLIC_OBJECT_SEARCH_PATHS` / `PRIVATE_OBJECT_DIR`.** These name
  paths inside a GCS bucket the runtime SA needs to read/write. The
  bucket itself is not provisioned by this scaffold — Nick should confirm
  whether to reuse an existing bucket or create a new one for prod.
