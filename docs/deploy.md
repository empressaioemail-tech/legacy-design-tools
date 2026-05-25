# api-server deploy — Cloud Run (Phase 1A)

## Summary

The `api-server` artifact runs on **Cloud Run** in `us-central1` as service
**`cortex-api`** (see `.github/workflows/cloud-run-deploy.yml`). The monorepo
artifact path is still `artifacts/api-server`. Frontends (`design-tools`,
`mockup-sandbox`) remain on **Replit autoscale** — their migration is a
separate phase. The database stays on the **existing Replit Neon** for Phase
1A; the Empressa Neon swap is Phase 1C and is a Secret Manager value rotation,
not a code change.

GitHub Actions builds and pushes a new image to Artifact Registry on every
push to `main` (`build-and-push` job in
[`.github/workflows/cloud-run-deploy.yml`](../.github/workflows/cloud-run-deploy.yml)).
**Push never deploys.** Every deploy is a deliberate operator action via
`workflow_dispatch` with one of four `action` inputs — `deploy-canary`,
`run-migrations`, `shift-traffic`, `rollback` — runnable end to end from
`gh workflow run` with no local `gcloud`. The canonical canary sequence is
**deploy-canary → run-migrations → smoke → shift-traffic** (four separate
dispatches). See [Operator deploy lifecycle](#operator-deploy-lifecycle-workflow_dispatch-actions)
below and `doc_repo/90_runbooks/cloud_run_canary_deploy.md`.

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

**Do not skip `iamcredentials.googleapis.com`.** GitHub Actions uses
Workload Identity Federation to impersonate the deploy service account when
`docker push` talks to Artifact Registry. If **IAM Service Account Credentials
API** is disabled in the project, the push step fails with
`Unable to acquire impersonated credentials` / `SERVICE_DISABLED` even when
other APIs are enabled. Enable it in **APIs & Services** or re-run the
`gcloud services enable` block above, wait a minute for propagation, then
re-run the failed workflow.

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
# Example for the Neon connection string (Secret Manager id matches workflow).
gcloud secrets create DEPLOYMENT_DATABASE_URL --replication-policy=automatic
echo -n "<current-replit-neon-url>" | gcloud secrets versions add DEPLOYMENT_DATABASE_URL --data-file=-
```

Secrets to create (matching the names referenced in
[`.github/workflows/cloud-run-deploy.yml`](../.github/workflows/cloud-run-deploy.yml)
`--set-secrets`):

- `DEPLOYMENT_DATABASE_URL` — workflow maps it to env var `DATABASE_URL` on Cloud Run. Phase 1A: Replit production Neon connection string. Phase 1C: rotate secret value to Empressa Neon (no code change).
- `AI_INTEGRATIONS_ANTHROPIC_API_KEY`
- `SESSION_SECRET` — required for Express `sessionMiddleware`.
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
| `DATABASE_URL` | secret | hard required at boot | Secret Manager (aliased from `DEPLOYMENT_DATABASE_URL`) | Phase 1A value = Replit production Neon connection string. Phase 1C swaps to Empressa Neon (no code change, secret value rotation only). |
| `PORT` | config | yes | `artifacts/api-server/src/index.ts` | Cloud Run injects automatically (8080). Hard-fails at boot if unset. |
| `NODE_ENV` | config | yes | `lib/logger.ts`, multiple | Set to `production` by the workflow. |
| `LOG_LEVEL` | config | optional | `lib/logger.ts` | Default `info`. Workflow sets `info` explicitly. |
| `AI_INTEGRATIONS_ANTHROPIC_API_KEY` | secret | hard required at boot | `lib/integrations-anthropic-ai/src/client.ts` | Throws at module import if unset. |
| `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` | config | hard required at boot | `lib/integrations-anthropic-ai/src/client.ts` | Workflow sets `https://api.anthropic.com` — confirm before first deploy. |
| `SESSION_SECRET` | secret | yes | Secret Manager | Required by `sessionMiddleware`. Recon's `process.env.*` grep missed this — surfaced post-deploy-doc-authoring. |
| `BIM_MODEL_SHARED_SECRET` | secret | required for upload flow | `routes/bimModels.ts` | HMAC secret for BIM model uploads. Generated fresh during Phase 1A setup (no value existed in Replit). Same value will need to be configured on the Revit Connector side when BIM upload integration is wired end-to-end. |
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
| `PUBLIC_OBJECT_SEARCH_PATHS` | config | required for object reads | `artifacts/api-server/src/lib/objectStorage.ts` | Comma-separated `/<bucket>/<prefix>` paths. Each prefix must **not** end with `/` (the service joins `${path}/${filePath}`). Canary deploy sets `/legacy-design-tools-prod-objects/public`. |
| `PRIVATE_OBJECT_DIR` | config | required for object writes | `artifacts/api-server/src/lib/objectStorage.ts` | `/<bucket>/<prefix>`; the API appends `/uploads/<uuid>` itself — use `/legacy-design-tools-prod-objects/.private` so objects live under `.private/uploads/…`, not `…/.private/uploads/uploads/…`. Canary deploy sets that value. |
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

## Troubleshooting: GitHub Actions ↔ GCP

### `Push image` fails: IAM Service Account Credentials API / `SERVICE_DISABLED`

Symptom: `gcloud.auth.docker-helper` logs `Unable to acquire impersonated
credentials` mentioning **`iamcredentials.googleapis.com`**, then
`docker push` returns **`denied: Unauthenticated`**.

Cause: **IAM Service Account Credentials API** is not enabled (or not yet
propagated) in the GCP project used by `GCP_PROJECT_ID`.

Fix:

```bash
gcloud services enable iamcredentials.googleapis.com --project="<your-project-id>"
```

Wait 1–2 minutes, then **Re-run failed jobs** on the workflow run in GitHub
Actions, or push any commit to `main` to trigger **build-and-push** again.

### `Validate required secrets` fails on the first step

The **build-and-push** job requires repository secrets **`GCP_PROJECT_ID`**,
**`GCP_WORKLOAD_IDENTITY_PROVIDER`**, and **`GCP_SERVICE_ACCOUNT`**
([§7](#7-github-actions-repo-secrets)). **deploy-canary** also requires
**`GCP_RUNTIME_SERVICE_ACCOUNT`**. If any are unset, the `: "${VAR:?...}"`
checks fail before checkout — set all values in **Settings → Secrets and
variables → Actions**, then re-run.

### `deploy-canary` fails: `--no-traffic` not supported when creating a new service

**Cloud Run** rejects **`--no-traffic`** on the **first** `gcloud run deploy`
that **creates** the service — the flag only applies when a service already
exists. The workflow omits `--no-traffic` on that first run (see the job log
`::warning::`) and adds it on every later deploy so new revisions stay at 0%
default-route traffic while you smoke the **`canary`** tag URL.

After the **first** successful deploy, confirm traffic in the console or with
`gcloud run services describe api-server --region=us-central1 --format=yaml`
and adjust with `gcloud run services update-traffic` per the canary runbook
if the default URL routed 100% to the new revision.

### `deploy-canary` fails or hangs: `Allow unauthenticated invocations (y/N)?`

`gcloud run deploy` prompts interactively when invoker IAM is ambiguous. In
GitHub Actions there is no TTY, so the deploy step fails. The workflow passes
**`--allow-unauthenticated`** so Phase 1A **`curl …/api/healthz`** smoke works
without an identity token. Before sending real production traffic, switch
to **`--no-allow-unauthenticated`** (or front the service with IAP / API
Gateway) and document how callers authenticate.

### `deploy-canary` fails: Cloud Run Admin API disabled

Same pattern as **IAM Credentials** above: enable **`run.googleapis.com`** on
the project, wait briefly, re-run **deploy-canary**.

```bash
gcloud services enable run.googleapis.com --project="<your-project-id>"
```

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
6. Confirm the new revision exists at 0% **default** traffic and is tagged
   **`canary`** (the workflow passes `--tag=canary` with `--no-traffic`):
   ```bash
   gcloud run services describe api-server \
     --region=us-central1 \
     --format='value(status.traffic)'
   ```
7. Smoke-probe the **canary tag URL** (printed at the end of the
   **deploy-canary** job log). It follows
   `https://canary---<same-host-as-default-service-URL>/api/healthz`, e.g.:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" "https://canary---<host>/api/healthz"
   # expect: 200
   ```
   You can also resolve the host from the default service URL:
   `https://<host>` → `https://canary---<host>/api/healthz`.
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

## Operator deploy lifecycle (workflow_dispatch actions)

Phase 2 (`2026-05-22_cc-agent-C_cortex_qa_build` P2-1 + P2-2) makes the
**cortex-api** Cloud Run deploy fully runnable as an operator-supervised agent
dispatch: the workflow exposes an `action` input that gates exactly one job per
dispatch. All four are unreachable from `push` — push only runs
`build-and-push` (image only).

**Deploy discipline (no races):** wait for green **Build & push image** on the
merge SHA, then run **`deploy-canary`** with `image_tag=<full-sha>`, smoke the
canary URL (`/api/healthz`, `POST /api/engagements` → 201,
`POST /api/engagements/{id}/packages` → 201), **`run-migrations`** only when new
SQL landed, then **`shift-traffic`**. Never chain these on `push`.

| `action` input | Job | What it does |
|---|---|---|
| `deploy-canary` (default) | Deploy 0% canary | Creates a new revision tagged `canary` (with `--no-traffic` when the service already exists). Reads `image_tag` (sha preferred; `latest` = the most recent build-and-push). |
| `run-migrations` | Apply pending DB migrations | Applies pending `lib/db/drizzle/*.sql` files via `lib/db/scripts/migrate-prod.mjs`. Tracks applied filenames in `_schema_migrations`. **First run requires `bootstrap: true`** to seed the tracker against a DB that is already at the head (after the Phase 1 P0-1 manual apply). |
| `shift-traffic` | Shift 100% to canary | Runs `gcloud run services update-traffic cortex-api --to-tags=canary=100`, echoes the resulting traffic split, then smoke-probes the **production** URL's `/api/healthz`. Fails the job if the probe is not 200. |
| `rollback` | Roll traffic back | Runs `gcloud run services update-traffic cortex-api --to-revisions=<rollback_revision>=100`. Requires the `rollback_revision` input (e.g. `cortex-api-00017-gex`). |

### Canonical canary sequence

Four separate dispatches, in order:

1. **`deploy-canary`** — `gh workflow run "Cloud Run Deploy (cortex-api)" -f action=deploy-canary -f image_tag=<sha>` (or `latest`).
2. **`run-migrations`** — `gh workflow run "Cloud Run Deploy (cortex-api)" -f action=run-migrations`. On the very first ever execution against a given DB, add `-f bootstrap=true` to seed `_schema_migrations` with everything already at the head; subsequent runs default `bootstrap=false`.
3. **Smoke probe** — `curl -s -o /dev/null -w "%{http_code}\n" "https://canary---<service-host>/api/healthz"` (the canary URL is printed at the end of the `deploy-canary` job log).
4. **`shift-traffic`** — `gh workflow run "Cloud Run Deploy (cortex-api)" -f action=shift-traffic`. This also smoke-probes the production URL.

This sequence is mirrored in `doc_repo/90_runbooks/cloud_run_canary_deploy.md` so the runbook and the workflow agree on the canary discipline.

### Migration model — `lib/db/scripts/migrate-prod.mjs`

The `run-migrations` job applies the numbered `lib/db/drizzle/*.sql`
files in filename order, tracked by a `_schema_migrations` table
(columns: `name text PRIMARY KEY`, `applied_at timestamptz`). Each file
runs in its own transaction; an exception inside a file rolls back that
transaction and fails the job with the file name. This is intentionally
**not** `drizzle-kit push` — push diffs the live DB against the TS schema
and can perform destructive operations (drop column, drop table) without
a named, reviewable artifact. The numbered SQL files in `lib/db/drizzle/`
are the prod-apply sequence (0009–0014 were applied that way during the
QA-04 cutover; 0015 the same way during the Phase 1 P0-1 pass), and the
script just continues that pattern in CI.

`lib/db/scripts/track-b-ifc-ingest.sql` (the QA-04 IFC-ingest add) is
intentionally NOT in the tracked set — it was hand-applied during the
cutover and is treated as part of the bootstrap baseline. Future schema
changes go into `lib/db/drizzle/NNNN_*.sql`.

The script's other env vars (for use outside the workflow):
- `BOOTSTRAP=true` — first-run only (see above).
- `PLAN_ONLY=true` — echo the pending list and exit 0 without applying. Useful for previewing in a separate workflow run by hand (the `action=run-migrations` job does not currently set this; set it locally if you want to dry-run from a workstation).

### Hard constraints — do not relax

- Traffic shifts and DB migrations are **never coupled to `push`.**
  `shift-traffic`, `rollback`, and `run-migrations` are
  `workflow_dispatch`-only and gate on `inputs.action`; they are
  unreachable from a push event.
- `build-and-push` stays push-triggered and image-only. It does not
  deploy, does not migrate, and does not shift traffic.
- The four canary-sequence actions are separate deliberate operator
  dispatches; the workflow never chains them together.
- `deploy-canary`'s deploy flags / env vars / secrets are unchanged by
  Phase 2 — only the gating `if:` condition was added.

---

## Rollback

The previous revision stays warm. Use the **`rollback`** action — it is
the operator-runnable equivalent of the manual `gcloud` rollback below
and avoids needing a local `gcloud`:

```bash
gh workflow run "Cloud Run Deploy (cortex-api)" \
  -f action=rollback \
  -f rollback_revision=<previous-revision>
```

If a workstation `gcloud` is available, the manual form is unchanged:

```bash
gcloud run services update-traffic cortex-api \
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
- **Drizzle migrate adoption.** Phase 2 (2026-05-22) added a numbered-SQL migration runner (`lib/db/scripts/migrate-prod.mjs`) wired to the `run-migrations` workflow_dispatch action — see [Operator deploy lifecycle](#operator-deploy-lifecycle-workflow_dispatch-actions). The runner intentionally does NOT use `drizzle-kit push` (destructive without named artifacts); it applies the numbered `lib/db/drizzle/*.sql` files in order, tracked by `_schema_migrations`.
- **No puppeteer-as-separate-service split** — image carries Chrome runtime
  libs for now (see follow-up below).
- **No automatic traffic shifting in the GHA workflow** — every traffic
  change is a manual `gcloud` per the canary runbook.

---

## Follow-up items surfaced during scaffold

- **Revit Connector ↔ api-server `BIM_MODEL_SHARED_SECRET` sync.** The
  connector side needs the value loaded into the `BIM_MODEL_SHARED_SECRET`
  Secret Manager entry's latest version when the BIM upload flow is exercised.
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
