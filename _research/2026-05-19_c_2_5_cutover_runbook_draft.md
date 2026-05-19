---
id: 2026-05-19_c_2_5_cutover_runbook_draft
title: C.2.5 DRAFT — legacy-design-tools Replit → Cloud Run cutover runbook
date: 2026-05-19
agent: cc-agent-C
repo: legacy-design-tools
kind: runbook-draft
related: [_research/2026-05-19_c_2_3_neon_provisioning, _research/2026-05-19_c_2_4_migration_dry_run, _research/2026-05-19_replit_decouple_audit]
---

# DRAFT — legacy-design-tools Replit → Cloud Run cutover runbook

> **Draft status.** Working draft in `legacy-design-tools/_research/`.
> At Lane C.2 close the planner relocates it to
> `doc_repo/90_runbooks/legacy_design_tools_replit_to_cloud_run_cutover.md`
> with canonical frontmatter / section headings per
> `doc_repo/01_doc_conventions.md`.

> **This runbook EXECUTES the cutover.** Unlike C.2.1-C.2.4 (preparation),
> running this shifts production traffic and moves the production
> database. Do not begin until every Stage 0 gate is green. Operator-
> driven, multi-stage, with explicit pause gates — proceed past a gate
> only on an explicit "go".

## Cutover model

- **Compute:** Replit autoscale (`prompt-agent-accelerator.replit.app`)
  → Cloud Run `cortex-api` (smartcity-os project, `us-central1`).
- **Data:** current Replit-side Neon → new `cortex-prod` Neon (Scale).
- **Domain:** `cortex.empressa.io` → `cortex-api`. The old
  `prompt-agent-accelerator.replit.app` URL is **retired**, not
  redirected (it is Replit-owned DNS — un-repointable; Decision 0.20
  Amendment 4).
- **Fallback:** the Replit instance + its Neon stay live and untouched
  through the verification window. Rollback = flip traffic / DNS back.

## Stage 0 — Pre-cutover gate (HARD — all must be green)

Do not start Stage 1 until every box is checked.

- [ ] **All blocking lanes closed:** Lane A.1 + A.2, Lane B, Lane C.1,
      C.3, C.4 landed (per the sprint decision record's cutover
      dependency). Decisions 0.19 + 0.20 closed.
- [ ] **C.2.3 done:** `cortex-api` GCP substrate provisioned in the
      smartcity-os project; `cortex-prod` Neon (Scale + pgvector)
      exists with `main` schema applied; all four C.2.3 §B4 parity
      checks pass; Secret Manager seeded.
- [ ] **C.2.4 done:** migration dry-run completed; diff doc clean (or
      deltas documented known-acceptable); special-handling list final.
- [ ] **Staging Cloud Run revision verified:** a `--no-traffic`
      `deploy-canary` of `cortex-api` ran clean; `https://canary---<host>/api/healthz`
      returns 200.
- [ ] **`cortex.empressa.io` is ready** (Decision 0.20 Amendment 4 —
      the hard domain gate):
  - [ ] DNS record for `cortex.empressa.io` exists and resolves.
  - [ ] It is mapped to the `cortex-api` Cloud Run service
        (`gcloud beta run domain-mappings create --service=cortex-api
        --domain=cortex.empressa.io --region=us-central1`), and the
        mapping reports `Ready`.
  - [ ] TLS certificate for `cortex.empressa.io` is provisioned and
        valid (Cloud Run managed cert — confirm `curl -sI
        https://cortex.empressa.io/api/healthz` negotiates TLS cleanly).
  - [ ] `PUBLIC_BASE_URL=https://cortex.empressa.io` is set on the
        `cortex-api` service env.
- [ ] **Backup tag** on `origin/main`:
      `git tag backup/pre-cutover-$(date +%Y%m%d) origin/main && git push origin --tags`.
- [ ] **Operator availability:** a verification window is scheduled;
      the operator can watch logs + roll back for its duration.
- [ ] **gcloud account** is the smartcity-os admin account, not the
      workstation-default smartcity service account (account-check
      memory).

**GATE 0 — operator "go" to begin the cutover.**

## Stage 1 — Quiesce + final data snapshot

The C.2.4 dry-run rehearsed this; Stage 1 runs it in production-mode
against `cortex-prod`.

1. **Reduce write churn.** legacy-design-tools has no formal
   maintenance mode. Minimize in-flight writes: avoid kicking off
   briefing/finding/IFC runs during the window; if practical, briefly
   pause the Replit instance's background sweepers. A short write-quiet
   window keeps the snapshot consistent and avoids the C.2.4
   "known-acceptable drift" on append-heavy tables.
2. **Snapshot the current prod Neon** (direct endpoint):
   ```bash
   pg_dump "$REPLIT_NEON_DIRECT_URL" --format=custom \
     --no-owner --no-privileges \
     --file=/tmp/cortex-cutover/prod.dump
   ```
3. **Capture source row counts** for the post-load diff (C.2.4 §4b).

**GATE 1 — snapshot captured + counts recorded. Operator "go".**

## Stage 2 — Load data into cortex-prod

1. `cortex-prod` already has the `main` schema (C.2.3 §B3). For a clean
   data load, restore into the schema-only instance:
   ```bash
   psql "$CORTEX_PROD_DIRECT_URL" -c "CREATE EXTENSION IF NOT EXISTS vector;"  # idempotent
   pg_restore --dbname="$CORTEX_PROD_DIRECT_URL" \
     --no-owner --no-privileges --jobs=4 --exit-on-error \
     --data-only \
     /tmp/cortex-cutover/prod.dump
   ```
   `--data-only`: the schema is already present from C.2.3; load rows
   into it. (If a constraint-ordering error surfaces, fall back to a
   full restore into a freshly-reset `cortex-prod` database — the
   C.2.4 dry-run determines which path is needed and the
   special-handling list records it.)
2. **Apply special handling** from the C.2.4 §5 list: `REFRESH
   MATERIALIZED VIEW` for any MVs; sequence-position fixes if any.
3. **Post-load parity diff** — re-run C.2.4 §4 (row counts, FK
   integrity, content md5) source-vs-`cortex-prod`. Must be clean.

**GATE 2 — `cortex-prod` data parity verified. Operator "go".**

## Stage 3 — Deploy + traffic shift to cortex-api

`cortex-prod` now has schema + data and `DEPLOYMENT_DATABASE_URL`
points at it.

1. **Deploy the cutover revision.** Trigger `deploy-canary`
   (workflow_dispatch) with the `main`-SHA image tag. It creates a new
   `cortex-api` revision tagged `canary` at 0% default traffic.
2. **Smoke the canary tag URL** (no production traffic yet):
   `curl -s -o /dev/null -w '%{http_code}' https://canary---<host>/api/healthz`
   → expect `200`.
3. **Traffic shift**, per the smartcity-os canary pattern
   (`doc_repo/90_runbooks/cloud_run_canary_deploy.md`) — staged, with
   the Stage 4 probes between each step:
   ```bash
   gcloud run services update-traffic cortex-api --region=us-central1 \
     --to-revisions=<new-rev>=10      # observe → probes → if clean:
   gcloud run services update-traffic cortex-api --region=us-central1 \
     --to-revisions=<new-rev>=50      # observe → probes → if clean:
   gcloud run services update-traffic cortex-api --region=us-central1 \
     --to-revisions=<new-rev>=100
   ```
4. The `cortex.empressa.io` domain mapping already points at
   `cortex-api` (Stage 0). Once traffic is 100% on the new revision,
   `https://cortex.empressa.io` serves the cutover build end-to-end.

**GATE 3 — 100% traffic on the cutover revision. Operator "go" to
verification.**

## Stage 4 — Six-probe verification

Run after each traffic step in Stage 3, and a full pass at 100%.
Pattern modeled on the BeWith iCal cutover runbook's six-probe
verification. **Any probe failure → halt + roll back (Stage 6).**

1. **Probe 1 — API liveness.** `GET https://cortex.empressa.io/api/healthz`
   → 200.
2. **Probe 2 — DB read path.** `GET /api/engagements` → 200, returns
   the engagement list (proves `cortex-api` ↔ `cortex-prod` Neon).
3. **Probe 3 — SPA serving.** `GET https://cortex.empressa.io/` →
   design-tools index.html; `GET /plan-review/` and `/qa/` → their
   index.html; one deep client-side route each → index.html (proves
   PR #39's `mountSpaStatic`).
4. **Probe 4 — object storage.** Exercise an object read (e.g. load an
   engagement with a stored sheet/GLB) → asset resolves (proves PR
   #38's Cloud Run ADC path + signed URLs; confirms the runtime SA's
   `signBlob` self-grant).
5. **Probe 5 — write path.** A low-risk write (create a test
   engagement, or a reviewer action) commits to `cortex-prod`.
6. **Probe 6 — deferred IFC-import bug gate.** Re-run the IFC import
   that the cortex-track close-out deferred to post-cutover. Re-ingest
   IFC against snapshot **`1e01ae34-8062-4dd9-bbeb-f5219db035e4`**. The
   bet behind deferring this bug was that a clean Cloud Run + fresh
   Neon environment either surfaces the real root cause or
   self-resolves a Replit-induced symptom. Record the outcome:
   - Import succeeds → the bug was Replit-environment-induced; close it.
   - Import still fails → the bug is real + environment-independent;
     file it with the now-clean Cloud Run logs (far better diagnostics
     than Replit autoscale gave). Does NOT block the cutover — the
     import path was already broken pre-cutover; cutover does not
     regress it.

**GATE 4 — all six probes pass (Probe 6: pass OR documented-as-real).
Operator "go" to the verification window.**

## Stage 5 — Verification window

- Hold for an operator-defined window (suggest >= 24-48h of real
  usage) with `cortex-api` at 100%.
- The Replit instance + its Neon stay live and untouched — the
  rollback path stays open the entire window ("Neon stays bilateral
  until verification clears").
- Watch Cloud Run logs + the `cortex-api-runtime` SA audit log for
  errors, latency regressions, object-storage failures.

**GATE 5 — verification window elapsed clean. Operator "go" to
decommission.**

## Stage 6 — Rollback (if any gate fails)

Rollback is fast and non-destructive while the Replit side is live:

1. **Traffic:** flip Cloud Run traffic back to the last-good revision —
   `gcloud run services update-traffic cortex-api --region=us-central1
   --to-revisions=<previous-rev>=100` — or, if the issue is
   `cortex-api`-wide, repoint `cortex.empressa.io`'s DNS / use the
   still-live Replit instance as the serving path.
2. **Data:** the Replit-side Neon was never modified — it stayed live
   and authoritative through Stages 1-5 ("bilateral until verification
   clears"). Rolling back compute automatically rolls back to it. Any
   writes that landed on `cortex-prod` during the failed window are
   forward-only; if rollback happens, reconcile or discard them per the
   operator's call (the verification window is deliberately short to
   keep this set small).
3. Diagnose from Cloud Run logs, fix forward, re-attempt from the
   appropriate stage.

## Stage 7 — Decommission (post-verification, operator-gated)

Only after GATE 5.

1. **Retire the Replit platform config** (folded from C.2.2 PR6 —
   audit items T1.3 / T1.4 / T2.3 / T2.5 / T3.4). These execute **at
   decommission, not before** — they configure the live Replit
   fallback, which must stay functional through Stage 5. As one commit:
   - Delete `.replit`, `replit.nix`, `replit.md`,
     `artifacts/api-server/.replit-artifact/`.
   - Remove the `scripts/post-merge.sh` Replit `[postMerge]` trigger
     coupling (the script's schema-apply + backfills are superseded —
     the backfills are one-shot idempotent and have already run; schema
     apply is now a deliberate operator step). Delete `post-merge.sh`
     or strip it to a no-op; it has no off-Replit trigger.
   - The `SNAPSHOT_SECRET` plaintext dies with `.replit` — confirm the
     rotated value lives only in Secret Manager (C.2.3 §B6).
2. **Stop / delete the Replit deployment** `prompt-agent-accelerator.replit.app`.
   The URL stops resolving — expected (Decision 0.20 Amendment 4; no
   redirect is possible for a `*.replit.app` subdomain).
3. **Replit-side Neon:** keep it as a cold backup for an operator-
   defined retention period, then delete.
4. **`docs/deploy.md` rewrite** (audit T1.6): update for `cortex-api`
   in the smartcity-os project, the `cortex-prod` Neon, and the
   single-service SPA static-serve. (May be done earlier; it is
   documentation, not a live-environment dependency.)
5. **Post-cutover code cleanup** — fast-follow PR: drop the
   `K_SERVICE`-gated Replit branches in `objectStorage.ts` (the sidecar
   path) now that no environment needs them; drop `REPLIT_SIDECAR_ENDPOINT`.

**GATE 7 — decommission complete. Lane C.2 + the cutover close.**

## Open items to confirm before this runbook is executed

- **Object-storage bucket strategy** (C.2.3 §A6): reuse the existing
  GCS bucket (no object-byte migration) vs. a new bucket (needs a
  `gcloud storage rsync` step added to Stage 2). Confirm bucket
  ownership.
- **`--data-only` vs full restore** (Stage 2): the C.2.4 dry-run
  determines which restore path is clean; lock it in the
  special-handling list.
- **Materialized views** (C.2.4 §5): if the dry-run finds any, add the
  explicit `REFRESH` to Stage 2.
- **BeWith iCal six-probe reference:** this draft reconstructs a
  sensible six-probe pattern; align Probe wording/ordering against the
  actual BeWith iCal cutover runbook when the planner relocates this to
  `doc_repo/90_runbooks/`.
