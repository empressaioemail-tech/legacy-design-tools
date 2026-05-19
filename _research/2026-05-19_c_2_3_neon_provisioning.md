---
id: 2026-05-19_c_2_3_neon_provisioning
title: C.2.3 — cortex-api GCP + Neon prod provisioning recipe
date: 2026-05-19
agent: cc-agent-C
repo: legacy-design-tools
kind: runbook-draft
related: [_research/2026-05-19_replit_decouple_audit, _research/2026-05-19_c_2_4_migration_dry_run, _research/2026-05-19_c_2_5_cutover_runbook_draft, docs/deploy.md]
---

# C.2.3 — cortex-api GCP + Neon prod provisioning recipe

Operator-facing recipe for provisioning the Cloud Run + Neon production
substrate the Replit → Cloud Run cutover lands on. **Preparation only** —
nothing here shifts production traffic; that is the C.2.5 cutover
runbook. Every step is operator-executed (cc-agent-C has no cloud
credentials); cc-agent-C's deliverable is this exact recipe.

Supersedes the project/service assumptions in [`docs/deploy.md`](../docs/deploy.md)
(Phase 1A targeted a standalone `legacy-design-tools-prod` project +
`api-server` service — both abandoned per Decision 0.20 ① and audit Q1).

## Decision 0.20 specs this recipe implements

- **Cloud Run:** net-new service `cortex-api` in the **same GCP project
  as smartcity-os production**, region `us-central1`.
- **Neon prod:** a **separate Neon project** from the hauska-engine
  substrate stack, region closest to `us-central1`, **Scale** plan tier
  (autoscaling compute + branching + PITR).
- **Domain:** `cortex.empressa.io` → the `cortex-api` Cloud Run service
  (DNS + mapping covered in the C.2.5 cutover runbook; not provisioned
  here).

## Pre-flight

- [ ] `gcloud config get-value account` is an account with Owner / the
      relevant admin roles on the **smartcity-os production project**.
      The workstation default is a smartcity *service account* from a
      different project — switch to the right account first, or every
      step below silently no-ops or 403s. (See the gcloud-account-check
      memory.)
- [ ] `gcloud config set project <SMARTCITY_OS_PROJECT_ID>` — confirm
      the exact project id from the existing smartcity-os Cloud Run
      service (`gcloud run services list` should show `smartcity-api`).
- [ ] A Neon account/org with room for a new Scale-tier project.

Throughout: `SMARTCITY_PROJECT` = the smartcity-os production project
id; `PROJECT_NUMBER` = its numeric id
(`gcloud projects describe "$SMARTCITY_PROJECT" --format='value(projectNumber)'`).

---

## Part A — Cloud Run side (cortex-api in the smartcity-os project)

### A1. Enable APIs (idempotent — smartcity-os likely has most)

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iamcredentials.googleapis.com \
  iam.googleapis.com \
  --project="$SMARTCITY_PROJECT"
```

Do not skip `iamcredentials.googleapis.com` — GitHub Actions' Workload
Identity Federation impersonation fails without it.

### A2. Artifact Registry

Reuse an existing Docker repo if smartcity-os already has one in
`us-central1`; otherwise create `apps` (the value
`cloud-run-deploy.yml` uses for `ARTIFACT_REGISTRY_REPO`):

```bash
gcloud artifacts repositories create apps \
  --repository-format=docker \
  --location=us-central1 \
  --project="$SMARTCITY_PROJECT" \
  --description="legacy-design-tools / cortex-api container images"
```

If smartcity-os already has a differently-named repo you want to reuse,
update `ARTIFACT_REGISTRY_REPO` in `.github/workflows/cloud-run-deploy.yml`
to match instead.

### A3. Workload Identity Federation for GitHub Actions

If the smartcity-os project already has a `github-actions` WIF pool,
add a provider/binding scoped to this repo rather than creating a new
pool. Fresh setup:

```bash
gcloud iam workload-identity-pools create github-actions \
  --location=global --project="$SMARTCITY_PROJECT" \
  --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github \
  --location=global --project="$SMARTCITY_PROJECT" \
  --workload-identity-pool=github-actions \
  --display-name="GitHub" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="attribute.repository == 'empressaioemail-tech/legacy-design-tools'"
```

Provider resource name (the `GCP_WORKLOAD_IDENTITY_PROVIDER` repo secret):
`projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions/providers/github`

### A4. Deploy service account (used by GitHub Actions)

```bash
gcloud iam service-accounts create gha-deployer-cortex \
  --project="$SMARTCITY_PROJECT" \
  --display-name="GitHub Actions deploy SA (cortex-api)"

DEPLOYER_SA="gha-deployer-cortex@${SMARTCITY_PROJECT}.iam.gserviceaccount.com"

for ROLE in roles/run.admin roles/artifactregistry.writer \
            roles/iam.serviceAccountUser roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "$SMARTCITY_PROJECT" \
    --member="serviceAccount:${DEPLOYER_SA}" --role="${ROLE}"
done

gcloud iam service-accounts add-iam-policy-binding "${DEPLOYER_SA}" \
  --project="$SMARTCITY_PROJECT" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-actions/attribute.repository/empressaioemail-tech/legacy-design-tools"
```

### A5. Cloud Run runtime service account

```bash
gcloud iam service-accounts create cortex-api-runtime \
  --project="$SMARTCITY_PROJECT" \
  --display-name="cortex-api Cloud Run runtime SA"

RUNTIME_SA="cortex-api-runtime@${SMARTCITY_PROJECT}.iam.gserviceaccount.com"

# Secret Manager: read cortex-api's secrets.
gcloud projects add-iam-policy-binding "$SMARTCITY_PROJECT" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/secretmanager.secretAccessor

# GCS: object access for PUBLIC_OBJECT_SEARCH_PATHS / PRIVATE_OBJECT_DIR.
gcloud projects add-iam-policy-binding "$SMARTCITY_PROJECT" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/storage.objectAdmin

# CRITICAL for object-storage signed URLs (audit T1.1 / PR #38):
# V4 signing on Cloud Run has no local key file — the GCS SDK
# delegates to the IAM signBlob API, so the runtime SA must be able
# to sign as ITSELF.
gcloud iam service-accounts add-iam-policy-binding "${RUNTIME_SA}" \
  --project="$SMARTCITY_PROJECT" \
  --role=roles/iam.serviceAccountTokenCreator \
  --member="serviceAccount:${RUNTIME_SA}"

# Allow the deploy SA to actAs the runtime SA.
gcloud iam service-accounts add-iam-policy-binding "${RUNTIME_SA}" \
  --project="$SMARTCITY_PROJECT" \
  --role=roles/iam.serviceAccountUser \
  --member="serviceAccount:${DEPLOYER_SA}"
```

### A6. GCS object-storage bucket

`cloud-run-deploy.yml` ships `PUBLIC_OBJECT_SEARCH_PATHS` /
`PRIVATE_OBJECT_DIR` pointing at a bucket named
`legacy-design-tools-prod-objects`. Either create that bucket in the
smartcity-os project, or create a new one and update both env-var
values in the workflow:

```bash
gcloud storage buckets create gs://<cortex-objects-bucket> \
  --project="$SMARTCITY_PROJECT" --location=us-central1 \
  --uniform-bucket-level-access
```

The migration of existing object bytes from the current
(Replit-side) bucket is **out of scope for C.2.3** — covered in C.2.4's
dry-run and the C.2.5 runbook. If the current GCS bucket is already in
a GCP project the operator controls, the simplest path is to grant the
new `cortex-api-runtime` SA access to the *existing* bucket and not
migrate object bytes at all (only the Neon DB moves). Confirm bucket
ownership before deciding — flagged for operator.

### A7. GitHub Actions repo secrets

`Settings → Secrets and variables → Actions` for
`empressaioemail-tech/legacy-design-tools` — set/repoint:

| Secret | Value |
|---|---|
| `GCP_PROJECT_ID` | `$SMARTCITY_PROJECT` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions/providers/github` |
| `GCP_SERVICE_ACCOUNT` | `gha-deployer-cortex@$SMARTCITY_PROJECT.iam.gserviceaccount.com` |
| `GCP_RUNTIME_SERVICE_ACCOUNT` | `cortex-api-runtime@$SMARTCITY_PROJECT.iam.gserviceaccount.com` |

Re-pointing `GCP_PROJECT_ID` is the switch that moves `build-and-push`
to the smartcity-os project. Do this **after** A1-A6 so the first
post-repoint push has a project ready to receive the image.

---

## Part B — Neon prod instance

### B1. Provision

In the Neon console (or `neonctl`):

- New **project**, separate from the hauska-engine substrate project.
  Name e.g. `cortex-prod`.
- Region: the Neon region closest to GCP `us-central1` — **AWS
  `us-east-2` (Ohio)** is Neon's standard closest-to-us-central1
  option; pick whatever the Neon console lists nearest if that is
  unavailable.
- Plan: **Scale** tier.
- Enable **PITR** (point-in-time restore) — included in Scale; confirm
  the retention window is set (7 days is the Scale default).
- One database, one role. Capture the **pooled** connection string
  (Neon's pgBouncer endpoint) for the app, and the **direct**
  (non-pooled) string for schema operations (`drizzle-kit push`,
  `pg_dump`/`pg_restore` need the direct endpoint).

### B2. Enable pgvector

The schema uses `vector` columns. Against the **direct** connection:

```bash
psql "$CORTEX_PROD_DIRECT_URL" -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

(`psql` install is a Phase-1B prereq still flagged as outstanding —
install the Postgres client tools on the workstation first; see the
Phase 1A/1B status memory.)

### B3. Apply schema from `main`

```bash
DATABASE_URL="$CORTEX_PROD_DIRECT_URL" \
  pnpm --filter @workspace/db run push
```

`push` (non-force) is the supervised pattern. It applies the current
`main` schema to the empty instance. Review the diff it prints before
confirming.

### B4. Schema parity verification

The new instance must match what `main` expects. Verify every table
resolves and the two recently-migrated columns are correct.

```bash
# Every table present (extend the list from lib/db/src/schema/index.ts):
psql "$CORTEX_PROD_DIRECT_URL" -tAc "
  SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1;"

# C.1.5 — materializable_elements supersession columns (PR #33).
psql "$CORTEX_PROD_DIRECT_URL" -tAc "
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_name='materializable_elements'
    AND column_name IN ('superseded_at','superseded_by_id')
  ORDER BY 1;"
# expect: superseded_at | timestamp with time zone
#         superseded_by_id | uuid

# C.1.5 — the partial unique index.
psql "$CORTEX_PROD_DIRECT_URL" -tAc "
  SELECT indexname FROM pg_indexes
  WHERE tablename='materializable_elements'
    AND indexname='materializable_elements_active_ifc_identity_uniq';"
# expect: one row

# PR #29 — reviewer_requests.triggered_action_event_id MUST be text,
# not uuid (ULID-shaped atom-event ids do not satisfy uuid).
psql "$CORTEX_PROD_DIRECT_URL" -tAc "
  SELECT data_type FROM information_schema.columns
  WHERE table_name='reviewer_requests'
    AND column_name='triggered_action_event_id';"
# expect: text
```

A fresh `drizzle-kit push` from current `main` produces all three
correctly by construction (they are in the schema source) — these
checks confirm it rather than discover it. If any check fails, the
`push` did not fully apply; do not proceed to C.2.4.

### B5. Capture the connection string in Secret Manager

`cloud-run-deploy.yml` maps the env var `DATABASE_URL` from a secret
named `DEPLOYMENT_DATABASE_URL`. Seed it with the new Neon prod
**pooled** URL:

```bash
gcloud secrets create DEPLOYMENT_DATABASE_URL \
  --project="$SMARTCITY_PROJECT" --replication-policy=automatic
printf '%s' "$CORTEX_PROD_POOLED_URL" | \
  gcloud secrets versions add DEPLOYMENT_DATABASE_URL \
  --project="$SMARTCITY_PROJECT" --data-file=-
```

> **Cutover sequencing note.** B3-B5 stand up the new instance with the
> *schema only*. The new instance does not receive production *data*
> until the C.2.5 cutover replays the C.2.4 dry-run against it. If you
> seed `DEPLOYMENT_DATABASE_URL` with the new (empty-of-data) Neon URL
> before cutover, any pre-cutover `cortex-api` deploy boots against an
> empty database. Acceptable for a `--no-traffic` canary smoke; not for
> traffic. The C.2.5 runbook gates the data load + traffic shift.

### B6. Other Secret Manager entries

Per the `cloud-run-deploy.yml` `--set-secrets` list, also create in
`$SMARTCITY_PROJECT`: `AI_INTEGRATIONS_ANTHROPIC_API_KEY`,
`SESSION_SECRET`, `BIM_MODEL_SHARED_SECRET`, `SNAPSHOT_SECRET`. Seed
each from the current Replit Secrets values.

**`SNAPSHOT_SECRET` security note:** the value is currently committed
in plaintext in `.replit` (`[userenv.shared]`). Treat it as compromised
— **rotate it** and seed Secret Manager with the new value, not the
committed one. (`SNAPSHOT_SECRET`'s runtime consumer was unconfirmed in
the audit; if grep still finds no consumer, drop it instead of
carrying a secret nobody reads.)

`PUBLIC_BASE_URL` (introduced in PR #37 for QA-triage / autopilot deep
links) is a **config** env var, not a secret. Add it to the
`cloud-run-deploy.yml` `--set-env-vars` list with value
`https://cortex.empressa.io`, OR set it post-deploy via
`gcloud run services update cortex-api --update-env-vars=PUBLIC_BASE_URL=https://cortex.empressa.io`.
Until DNS is live the deep links resolve to a not-yet-live host —
non-critical; the operator can set it at/after the DNS step in C.2.5.

## Exit criteria (C.2.3 done)

- [ ] A1-A7: smartcity-os project has the APIs, Artifact Registry repo,
      WIF provider, deploy SA, runtime SA (incl. the `signBlob`
      self-grant), object bucket; repo secrets re-pointed.
- [ ] B1-B6: Neon `cortex-prod` (Scale, pgvector) exists; `main` schema
      applied; all four B4 parity checks pass; `DEPLOYMENT_DATABASE_URL`
      + the four app secrets seeded.
- [ ] A `--no-traffic` `deploy-canary` of `cortex-api` runs clean and
      `https://canary---<host>/api/healthz` returns 200 (proves the
      image runs in the new project; data load is still pending C.2.5).

Hand the readiness signal to the planner; C.2.4's dry-run is next.
