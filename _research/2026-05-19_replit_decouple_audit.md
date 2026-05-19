---
id: 2026-05-19_replit_decouple_audit
title: Audit — Replit-specific code paths (Lane C.2.1)
date: 2026-05-19
agent: cc-agent-C
repo: legacy-design-tools
kind: audit
related: [_dispatches/2026-05-19_cc-agent-C_replit_decouple (C.2.1), docs/deploy.md]
---

# Replit decouple — code-path audit (C.2.1)

Enumerates every Replit-specific code path in the `legacy-design-tools`
source tree, with file/line refs and a proposed removal/generalization
plan per item. Input to C.2.2 (removal). Research only — no code changed
by this sub-task.

Scan method: `replit` / `REPL_` / `REPLIT` / `/home/runner` content grep
across `artifacts/**` + `lib/**` + root config, plus filename glob for
`.replit*`. `.claude/worktrees/**` matches excluded (stale worktrees, not
source).

## Two open questions that must be resolved before C.2.2

### Q1 — GCP project conflict with the confirmed 0.20 spec

Phase 1A's [`docs/deploy.md`](../docs/deploy.md) and
[`.github/workflows/cloud-run-deploy.yml`](../.github/workflows/cloud-run-deploy.yml)
provision everything into a **standalone GCP project `legacy-design-tools-prod`**
with Cloud Run service **`api-server`**.

The confirmed Decision 0.20 says: **same GCP project as smartcity-os
production**, **net-new service `cortex-api`**, `us-central1`.

These disagree. The Phase 1A scaffold (project + Artifact Registry repo
`apps` + WIF pool + 2 service accounts + Secret Manager entries) all live
in `legacy-design-tools-prod`. Per 0.20, `cortex-api` belongs in the
smartcity-os project instead.

**Resolution needed:** confirm the Phase 1A `legacy-design-tools-prod`
project + `api-server` service are abandoned, and C.2.3's provisioning is
redone fresh in the smartcity-os project. If a partial Phase 1A deploy is
already live in `legacy-design-tools-prod`, decommission it as part of
cutover. (Operator memory says Phase 1A reached canary=100 on
`api-server-00003-wix` — so there IS a live Phase 1A service to retire.)

### Q2 — Frontend hosting is undecided

Phase 1A explicitly left the four Vite SPAs (`design-tools`,
`plan-review`, `qa`, `mockup-sandbox`) on Replit
([`docs/deploy.md`](../docs/deploy.md) "What this phase does NOT do" +
"Follow-up items"). The `Dockerfile` builds **only** `api-server`. C.2 is
the *Replit decouple* — the SPAs cannot stay on Replit.

**Resolution needed:** where do the SPAs go? Options:
- **a)** api-server serves them as static assets (one Cloud Run service;
  extend the Dockerfile to `pnpm -r build` the SPAs + an Express static
  mount). Simplest single-service story; matches the current
  single-origin `/api` + SPA routing.
- **b)** Separate Cloud Run service(s) for the static frontends.
- **c)** A static host (Cloudflare Pages / Firebase Hosting / GCS+CDN).

This is an architecture decision, not a mechanical removal. It blocks the
C.2.5 cutover runbook (the runbook must say what serves `cortex.empressa.io`).
Recommend **(a)** for a solo-operator footprint — fewest moving parts —
but flagging for the planner/operator to confirm.

---

## Tier 1 — Functional runtime coupling (blocks Cloud Run)

### T1.1 — Object storage authenticates via the Replit sidecar

**File:** [`artifacts/api-server/src/lib/objectStorage.ts`](../artifacts/api-server/src/lib/objectStorage.ts)

- L12: `const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";`
- L14-30: `objectStorageClient` constructed with `external_account`
  credentials whose `token_url` / `credential_source.url` point at the
  Replit sidecar (`audience: "replit"`).
- L487-516: `getObjectSignedUrl` POSTs to
  `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`; throws
  `"make sure you're running on Replit"` on failure.

**Why it's coupling:** the data layer is already GCS (`@google-cloud/storage`),
but *authentication* is brokered by Replit's localhost sidecar. Off Replit,
`127.0.0.1:1106` does not exist — every object read/write/sign fails.

**Removal plan (highest-risk item in this audit):**
- Replace the `external_account` credential block with bare
  `new Storage()` — on Cloud Run the runtime service account supplies
  Application Default Credentials automatically.
- Replace `getObjectSignedUrl`'s sidecar POST with the SDK's native
  `bucket.file(objectName).getSignedUrl({ action, expires })`.
- **Precondition:** V4 signed-URL generation on Cloud Run (no local key
  file) uses the IAM `signBlob` API — the `cortex-api` runtime SA needs
  `roles/iam.serviceAccountTokenCreator` on itself. Add to the C.2.3
  IAM setup.
- Object storage is load-bearing (IFC blobs, GLBs, briefing PDFs). Treat
  this as its own commit and verify against a real GCS bucket before
  cutover. Strongly recommend a standalone PR for this item, not bundled
  with the cosmetic removals.

### T1.2 — `REPLIT_DOMAINS` env var for deep-link base URLs

**Files:**
- [`artifacts/api-server/src/routes/qa.ts:813`](../artifacts/api-server/src/routes/qa.ts#L813) — `process.env["REPLIT_DOMAINS"]`
- [`artifacts/api-server/src/lib/qa/autopilot.ts:763`](../artifacts/api-server/src/lib/qa/autopilot.ts#L763) — `process.env["REPLIT_DOMAINS"]`

Both parse `REPLIT_DOMAINS` (Replit-injected, comma-separated host list)
to build a `https://<host>` base URL for QA-triage / autopilot deep links.
Off Replit the var is unset → `baseUrl` / deep link silently becomes `null`.

**Removal plan:** introduce a single `PUBLIC_BASE_URL` config env var
(value `https://cortex.empressa.io` post-cutover). Replace both
`REPLIT_DOMAINS`-parsing blocks with a read of `PUBLIC_BASE_URL`. Add
`PUBLIC_BASE_URL` to the `cloud-run-deploy.yml` `--set-env-vars` list and
to the `docs/deploy.md` env inventory.

### T1.3 — `.replit` deployment config

**File:** [`.replit`](../.replit)

- L3-13: `[deployment]` autoscale target + build/postBuild args.
- L73-75: `[postMerge] path = "scripts/post-merge.sh"` — Replit-only
  merge hook (see T1.4).
- L77-82: `[userenv.shared] SNAPSHOT_SECRET = "sc_6d53f…"` — **a
  plaintext secret committed to the repo.** Security exposure (see
  "Security note" below).
- L87-110: `[[ports]]` mappings — Replit's port-forwarding model.
- L15-71: `[workflows]` — Replit's run/validation workflow definitions.

**Removal plan:** the file is wholly Replit-platform config. Cloud Run's
equivalents already exist (`Dockerfile`, `cloud-run-deploy.yml`). Per the
dispatch, **do not delete** — mark superseded and keep for git-history
audit, OR delete (coordinate with planner). Either way the
`SNAPSHOT_SECRET` plaintext must not survive into an active config —
rotate the secret value and store the new one only in GCP Secret Manager.

### T1.4 — `scripts/post-merge.sh` orphaned off Replit

**File:** [`scripts/post-merge.sh`](../scripts/post-merge.sh) (invoked by `.replit` `[postMerge]`)

Runs on every Replit merge: `pnpm --filter @workspace/db run push-force`
(schema apply) + two idempotent backfill scripts
(`backfill:briefing-generation-ids`, `backfill:prior-generated-at`).

**Why it's coupling:** the trigger (`.replit [postMerge]`) is
Replit-specific. Off Replit nothing invokes this script — schema changes
would silently never apply to prod.

**Removal plan:** the schema-apply must move to a deliberate, supervised
step (it is **not** safe to auto-`push-force` on every merge against a
production Neon — drizzle `push-force` can drop columns). Options:
- Fold schema apply into the C.2.5 cutover runbook + future per-release
  runbook as an explicit operator step, OR
- A `workflow_dispatch`-gated GitHub Action (never auto-on-push).
The two backfill scripts are idempotent one-shots — once they have run
against the new Neon prod (C.2.3), they need no recurring home; document
them as completed in the migration record.

### T1.5 — `cloud-run-deploy.yml` service identity + project

**File:** [`.github/workflows/cloud-run-deploy.yml`](../.github/workflows/cloud-run-deploy.yml)

- L29-30: `IMAGE_NAME: api-server`, `CLOUD_RUN_SERVICE: api-server` —
  must become `cortex-api` per 0.20.
- L43-49, L91-99: `GCP_PROJECT_ID` secret — points at whatever project
  the operator set; per 0.20 this becomes the smartcity-os project.
- L158: `--set-secrets` includes `SNAPSHOT_SECRET=SNAPSHOT_SECRET:latest`
  — confirm the secret exists in the new project.
- L157: `PUBLIC_OBJECT_SEARCH_PATHS` / `PRIVATE_OBJECT_DIR` name a GCS
  bucket `legacy-design-tools-prod-objects` — confirm the bucket's
  project/name in the new GCP project.

**Removal plan:** rename `IMAGE_NAME` + `CLOUD_RUN_SERVICE` →
`cortex-api`; re-point `GCP_*` repo secrets at the smartcity-os project
after C.2.3 provisioning; add `PUBLIC_BASE_URL` to `--set-env-vars`
(T1.2). Gated on Q1.

### T1.6 — `docs/deploy.md` describes the wrong project + service name

**File:** [`docs/deploy.md`](../docs/deploy.md)

Entire doc is written for project `legacy-design-tools-prod` + service
`api-server` + "frontends stay on Replit" + "Neon swap is Phase 1C".
After 0.20 + C.2 all four premises change.

**Removal plan:** rewrite for `cortex-api` in the smartcity-os project,
the C.2.3 Neon swap, and the chosen frontend-hosting answer (Q2). Largely
a C.2.2/C.2.5 documentation deliverable.

---

## Tier 2 — Build-config coupling

### T2.1 — `@replit/vite-plugin-*` in 4 Vite configs

**Files:** `artifacts/{design-tools,plan-review,qa,mockup-sandbox}/vite.config.ts`

Each imports `@replit/vite-plugin-runtime-error-modal` (applied
unconditionally), `@replit/vite-plugin-cartographer`,
`@replit/vite-plugin-dev-banner` (the latter two gated behind
`process.env.NODE_ENV !== "production" && process.env.REPL_ID !== undefined`
— already inert off Replit, but the imports + deps remain).

**Removal plan:** drop all three imports + the `REPL_ID`-gated plugin
block from each config. `runtimeErrorOverlay` is the only one applied
unconditionally — it's a dev-only error overlay; removing it loses
nothing in production. (mockup-sandbox imports only 2 of the 3 — confirm
per-file.)

### T2.2 — `@replit/vite-plugin-*` devDependencies

**Files:** `artifacts/{design-tools,plan-review,qa,mockup-sandbox}/package.json`

`@replit/vite-plugin-cartographer`, `@replit/vite-plugin-dev-banner`,
`@replit/vite-plugin-runtime-error-modal` listed as `catalog:` devDeps.

**Removal plan:** remove the three entries from each `package.json`,
remove the corresponding `catalog:` entries from `pnpm-workspace.yaml`,
`pnpm install` to refresh the lockfile. Sequence after T2.1 so the
imports are gone first.

### T2.3 — `replit.nix`

**File:** [`replit.nix`](../replit.nix)

Nix system-dependency manifest (libgbm, gtk3, X11 libs, cairo, etc.) for
Replit's NixOS sandbox — all for headless-Chrome (puppeteer / Playwright).

**Removal plan:** fully superseded by the `Dockerfile`'s `apt-get` runtime
package set (L67-107). Delete with `.replit` (T1.3) — same coordinate-with-
planner decision on keep-superseded vs delete.

### T2.4 — Adapter `User-Agent` strings hardcode the Replit URL

**Files:**
- [`lib/adapters/src/arcgis.ts:36`](../lib/adapters/src/arcgis.ts#L36)
- [`lib/adapters/src/local/grand-county-ut.ts:61`](../lib/adapters/src/local/grand-county-ut.ts#L61)
- [`lib/adapters/src/federal/epa-ejscreen.ts:38`](../lib/adapters/src/federal/epa-ejscreen.ts#L38)
- [`lib/adapters/src/federal/fcc-broadband.ts:36`](../lib/adapters/src/federal/fcc-broadband.ts#L36)

All four set the outbound `User-Agent` to
`smartcity-plan-review/1.0 (+https://prompt-agent-accelerator.replit.app)`.
Functionally harmless (it's a UA courtesy string), but it advertises a
URL that dies at cutover.

**Removal plan:** update all four to
`(+https://cortex.empressa.io)`. Trivial; consider extracting the shared
UA string to one constant in `lib/adapters` while touching it.

### T2.5 — `.replit-artifact/artifact.toml`

**File:** [`artifacts/api-server/.replit-artifact/artifact.toml`](../artifacts/api-server/.replit-artifact/artifact.toml)

Replit "artifact" service descriptor — build/run commands, port 8080,
health path `/api/healthz`. The `Dockerfile` already copied the CMD from
here (its header cites this file for parity).

**Removal plan:** retire alongside `.replit` — fully superseded by the
`Dockerfile` + `cloud-run-deploy.yml`. The `/api/healthz` path is still
the canary smoke target; just no longer sourced from this file.

---

## Tier 3 — Cosmetic / comments (low priority, optional)

These have **zero functional coupling** — they are comments or doc text
that merely mention Replit. Cleaning them is hygiene, not a cutover
blocker. Recommend a single sweep commit, or skip if scope-constrained.

### T3.1 — `// @replit` shadcn customization markers

`artifacts/{design-tools,plan-review,qa}/src/components/ui/{button,badge}.tsx`
— `// @replit …` comments left by Replit's component generator marking
shadcn tweaks. Harmless. Optional cleanup.

### T3.2 — Replit-mentioning code comments

- [`artifacts/api-server/src/lib/objectStorage.ts:508`](../artifacts/api-server/src/lib/objectStorage.ts#L508) — error string `"make sure you're running on Replit"` (rewrite as part of T1.1 anyway).
- [`artifacts/api-server/src/lib/briefingPdf.ts:70`](../artifacts/api-server/src/lib/briefingPdf.ts#L70) — `--no-sandbox` comment cites "Replit's Linux container"; still true in the Docker container, just reword.
- [`artifacts/api-server/src/lib/bimViewportCapture.ts:135`](../artifacts/api-server/src/lib/bimViewportCapture.ts#L135) — same `--no-sandbox` Replit comment.
- [`artifacts/api-server/src/lib/ifcParser/index.ts:7-8`](../artifacts/api-server/src/lib/ifcParser/index.ts#L7-L8) + [`ifcIngest.ts:34`](../artifacts/api-server/src/lib/ifcIngest.ts#L34) — "Replit's 1-2 GB process budget" / "Replit ceiling" memory comments; reword for Cloud Run's `--memory` budget.
- [`artifacts/api-server/src/routes/storage.ts:138`](../artifacts/api-server/src/routes/storage.ts#L138) — `replit-auth` commented-out example; delete the dead comment.
- [`artifacts/api-server/src/routes/renders.ts:1448`](../artifacts/api-server/src/routes/renders.ts#L1448) — "Cloud Scheduler / Replit cron / k8s CronJob" comment; drop "Replit cron".
- [`lib/db/src/schema/users.ts:12`](../lib/db/src/schema/users.ts#L12) — "Clerk/Replit Auth subject id" comment.
- `artifacts/api-server/src/__tests__/{me,users}.test.ts` — test comments referencing the Replit object-storage sidecar.
- `lib/api-spec/openapi.yaml` + generated `lib/api-zod` / `lib/api-client-react` — "Cloud Scheduler / Replit" in a doc string. The generated files regenerate from the spec; edit `openapi.yaml` only.

### T3.3 — `playwright.config.ts` Replit-Nix hacks

**File:** [`artifacts/design-tools/playwright.config.ts`](../artifacts/design-tools/playwright.config.ts)

Extensive comments (L11-59, L112-123) about the Replit environment, plus
runtime `LD_LIBRARY_PATH` augmentation to locate `libgbm.so.1` in Replit's
Nix store. In a normal Docker/CI image the libs are on the standard path —
the augmentation is unnecessary and the comments are stale.

**Removal plan:** e2e-only, runs in CI. Simplify the `LD_LIBRARY_PATH`
block once e2e runs against the Docker image / standard CI runner; reword
the comments. Low urgency — e2e isn't on the cutover critical path.

### T3.4 — `replit.md`

**File:** [`replit.md`](../replit.md)

Replit project-description doc. Retire alongside `.replit` / `replit.nix`.

---

## Security note

[`.replit:80`](../.replit#L80) commits a plaintext secret:
`SNAPSHOT_SECRET = "sc_6d53f8f17946d466cb20a5f8a0d815aa4dfbcd6aaa6c295759240463733053a8"`.
It is in git history regardless of what C.2.2 does to the file. Recommend:
(1) treat the value as compromised, **rotate it**, (2) store the new value
only in GCP Secret Manager, (3) confirm `SNAPSHOT_SECRET`'s actual runtime
consumer — `docs/deploy.md` flags it as not found in the api-server grep;
it may be referenced via a workspace lib. If genuinely unused, drop it
entirely rather than carrying a secret nobody reads.

## Proposed C.2.2 sequencing

1. **T1.1 objectStorage** — standalone PR, verified against a real GCS
   bucket. Highest risk; isolate it.
2. **T1.2 + T1.5 + T2.4** — env-var generalization (`PUBLIC_BASE_URL`),
   workflow rename, adapter UA strings. One PR.
3. **T2.1 + T2.2** — Vite plugin + devDep removal. One PR (build-only
   surface; `pnpm build` + typecheck + test verify it).
4. **T1.3 + T1.4 + T2.3 + T2.5 + T3.4** — retire `.replit`,
   `scripts/post-merge.sh` trigger, `replit.nix`, `.replit-artifact/`,
   `replit.md`. One PR. Gated on Q1 (project decision) + the
   keep-superseded-vs-delete call.
5. **T1.6 docs/deploy.md rewrite** — folds into C.2.5.
6. **T3.1 + T3.2 + T3.3** — optional comment sweep. One PR or skip.

Gate everything behind the two open questions (Q1 project, Q2 frontend
hosting) — both change what C.2.2/C.2.3 actually build.
