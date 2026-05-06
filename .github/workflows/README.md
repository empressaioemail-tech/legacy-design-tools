# GitHub Actions workflows

## `pr-checks.yml`

Runs on every pull request and on every push to `main`. Two jobs: `typecheck`
(pnpm `typecheck`) and `test` (pgvector-backed Postgres service, schema fixture
drift guard, full vitest run). Toolchain: pnpm 10, Node 20. Source of truth for
the toolchain versions every other workflow should mirror.

## `cloud-run-deploy.yml`

Phase 1A scaffold for the api-server Cloud Run deploy. Two jobs:

- **`build-and-push`** — runs on every push to `main`. Builds the
  repo-root [`Dockerfile`](../../Dockerfile) and pushes the image to
  Artifact Registry tagged with both `${{ github.sha }}` and `latest`.
  Does **not** deploy.
- **`deploy-canary`** — `workflow_dispatch` only. Deploys a new Cloud
  Run revision with `--no-traffic` (0% canary). Traffic shifts are
  manual via `gcloud` per
  [`doc_repo/90_runbooks/cloud_run_canary_deploy.md`](../../doc_repo/90_runbooks/cloud_run_canary_deploy.md);
  this workflow never shifts traffic.

Required GHA secrets: `GCP_PROJECT_ID`, `GCP_WORKLOAD_IDENTITY_PROVIDER`,
`GCP_SERVICE_ACCOUNT`, `GCP_RUNTIME_SERVICE_ACCOUNT`. Each job validates
these up front and fails loudly if any are missing.

See [`docs/deploy.md`](../../docs/deploy.md) for GCP-side prerequisites,
the env-var inventory, and the first-deploy procedure.
