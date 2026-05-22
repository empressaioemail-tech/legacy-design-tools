---
title: Phase 2 — Cortex / Design Tools deploy workflow — cc-agent-C session summary
date: 2026-05-22
agent: cc-agent-C
repo: legacy-design-tools
kind: session-summary
status: Phase 2 complete — held for operator before Phase 3
dispatch: 2026-05-22_cc-agent-C_cortex_qa_build
related: [42_design_accelerator_program_plan, 90_runbooks/cloud_run_canary_deploy, 90_runbooks/neon_schema_migration_via_cloud_shell, 20_agent_operating_rules]
---

# Phase 2 — the deploy workflow — cc-agent-C

P2-1 and P2-2 of the 2026-05-22 QA-build dispatch. Makes the cortex-api
Cloud Run deploy runnable end to end as an operator-supervised
`workflow_dispatch` agent action — no local `gcloud` needed — and closes
the schema-drift loop the Phase 1 P0-1 IFC 500 surfaced.

One PR (#81 on branch `feat/p2-deploy-workflow-v2`). Held for the
operator before Phase 3.

## What landed

**`.github/workflows/cloud-run-deploy.yml`** — a `workflow_dispatch`
`action` choice input gating exactly one of four operator-triggered
jobs:

| `action` | Job | What it does |
|---|---|---|
| `deploy-canary` (default) | existing, now gated on `action == 'deploy-canary'` | unchanged behaviour |
| `run-migrations` | new | applies pending `lib/db/drizzle/*.sql` via `migrate-prod.mjs`; fetches `DEPLOYMENT_DATABASE_URL` from Secret Manager; passes the `bootstrap` input through for the first ever execution |
| `shift-traffic` | new | `gcloud run services update-traffic cortex-api --to-tags=canary=100`, echoes the resulting split, then smoke-probes `/api/healthz` on production (fails the job if not 200) |
| `rollback` | new | takes a `rollback_revision` input and routes 100% there |

**`lib/db/scripts/migrate-prod.mjs`** — hand-written numbered-SQL runner
backed by a `_schema_migrations` tracker table. Each pending file runs
in its own transaction. First execution requires `BOOTSTRAP=true`
(aborts with explicit instructions otherwise). Intentionally NOT
`drizzle-kit push` — push diffs the TS schema against the live DB and
can drop columns without a named, reviewable artifact; the numbered
files in `lib/db/drizzle/` are this repo's prod-apply sequence already
(0009-0014 + 0015 were applied that way by hand) and the runner just
continues that pattern in CI. `lib/db/scripts/track-b-ifc-ingest.sql`
is intentionally NOT in the tracked set (hand-applied during the QA-04
cutover, part of the bootstrap baseline).

**Hard constraints honoured.** `build-and-push` stays push-triggered and
image-only. `shift-traffic`, `rollback`, `run-migrations` are
`workflow_dispatch`-only and `if`-gated on `inputs.action` — none is
reachable from a push event. The canonical canary sequence is four
separate dispatches (deploy-canary → run-migrations → smoke →
shift-traffic). `deploy-canary`'s deploy flags / env vars / secrets are
unchanged; only the gating `if:` condition was added.

**`docs/deploy.md`** — new "Operator deploy lifecycle (workflow_dispatch
actions)" section documenting the `action` input, the four jobs, the
canonical canary sequence, the migration model, and the hard
constraints. The Rollback section now points at the `rollback` action;
the "What this phase does NOT do" line on drizzle migrate adoption is
updated.

## Operator action — first `run-migrations` dispatch

cortex-prod is at the migration head as of 2026-05-22 (the Phase 1 P0-1
operator-supervised apply of `0015`). The first time the new job runs,
the tracker table is empty and the script aborts with instructions — to
seed it without re-running anything:

```
gh workflow run "Cloud Run Deploy (cortex-api)" \
  -f action=run-migrations \
  -f bootstrap=true
```

That seeds `_schema_migrations` with every existing file in
`lib/db/drizzle/` marked applied. **Every subsequent `run-migrations`
dispatch defaults `bootstrap=false`** and is purely "apply whatever is
new since the last run." After bootstrap, the canary sequence becomes:

```
gh workflow run "Cloud Run Deploy (cortex-api)" -f action=deploy-canary -f image_tag=<sha>
gh workflow run "Cloud Run Deploy (cortex-api)" -f action=run-migrations
curl -s -o /dev/null -w "%{http_code}\n" "https://canary---<host>/api/healthz"   # expect 200
gh workflow run "Cloud Run Deploy (cortex-api)" -f action=shift-traffic
```

## Runbook update for the planner (`90_runbooks/cloud_run_canary_deploy.md`)

Per the cross-repo doc-writes convention this is drafted here rather
than written into `doc_repo/` directly. **Apply the following changes**
to `doc_repo/90_runbooks/cloud_run_canary_deploy.md`:

### A. Replace the top "Deploy sequence" framing

Current (before Step 1) currently says: build → canary at 0% → smoke
probe → shift traffic → backup tag → observation.

Replace the bullet list under `## Deploy sequence` with:

> Substitute `$SERVICE_NAME` (e.g. `cortex-api`), `$PROJECT_ID` (e.g.
> `legacy-design-tools-prod`), `$REGION` (e.g. `us-central1`),
> `$IMAGE_PATH` (the Artifact Registry path), and `$CANARY_TAG` (a short
> identifier for this deploy, e.g. `w1-c-4a-auth-fix`).
>
> For `legacy-design-tools` / `cortex-api`, every step in this sequence
> is a separate `workflow_dispatch` against
> `.github/workflows/cloud-run-deploy.yml`'s `action` input — no local
> `gcloud` required. See `docs/deploy.md` for the workflow form. The
> sections below give the equivalent direct-`gcloud` form for use
> against other services or when the workflow is unavailable.
>
> **Canonical sequence**: deploy-canary → **run-migrations** → smoke
> probe → shift traffic → backup tag → observation. Each is a
> deliberate operator-triggered step; never chain them. `run-migrations`
> is mandatory between deploy-canary and the smoke probe — it applies
> any pending `lib/db/drizzle/*.sql` files so the canary's smoke probe
> hits the right schema.

### B. Insert a new step between Step 3 (deploy canary) and Step 4 (get canary URL)

The current step ordering is: 3 deploy canary at 0% → 4 get canary URL →
5 smoke probe → 6 shift traffic. **Insert a new step between 3 and 4**
(renumber 4-7 to 5-8):

> ### Step 4 — Run pending DB migrations (mandatory)
>
> The cortex-api deploy ships code; migrations are a separate deliberate
> step so a schema-touching PR cannot drift the prod DB behind the code
> it deploys (the failure mode the 2026-05-22 P0-1 IFC 500 surfaced).
>
> Workflow form (preferred — operator-runnable with no local `gcloud`):
>
> ```bash
> gh workflow run "Cloud Run Deploy (cortex-api)" \
>   -f action=run-migrations
> # First execution against a given DB also passes `-f bootstrap=true`
> # (one-time, seeds _schema_migrations with every existing file marked
> # applied — use when the DB is already at the head).
> ```
>
> The job authenticates via the same Workload Identity Federation the
> deploy job uses, fetches `DEPLOYMENT_DATABASE_URL` from Secret
> Manager, echoes the pending list, applies each pending file in its
> own transaction, and echoes the applied state on success. A failure
> rolls the offending file and fails the job with the file name —
> production is left at the prior schema, not half-migrated.
>
> Direct form (for services not yet on the workflow, or when the
> workflow is unavailable): per
> `90_runbooks/neon_schema_migration_via_cloud_shell.md`, applying the
> pending SQL files by hand via `psql -f` in Cloud Shell. The runner
> script is `lib/db/scripts/migrate-prod.mjs` in
> `empressaioemail-tech/legacy-design-tools`.
>
> If `run-migrations` reports zero pending, the canary code does not
> require new schema and the step is a no-op — continue to smoke probe.
> If migrations apply, re-run smoke probe **against the canary URL**
> (the next step) so the smoke verifies the post-migration behaviour.

### C. Update the surrounding step numbering

Renumber Step 4 → Step 5 ("Get the canary URL"), Step 5 → Step 6
("Smoke probe against canary URL"), Step 6 → Step 7 ("Shift 100%
traffic to the canary tag"), Step 7 → Step 8 ("Verify production URL"),
Step 8 → Step 9 ("Tag the deployed revision in git"), Step 9 → Step 10
("Observation window"). Update internal cross-references ("Step 5
returns ...", "Step 7 production URL response differs from canary
post-shift" in the Stop conditions section, etc.).

### D. Add a workflow-form note to the Step 6 shift-traffic section

Append to the renumbered Step 7 (was Step 6) the workflow form:

> Workflow form for legacy-design-tools / cortex-api (preferred):
>
> ```bash
> gh workflow run "Cloud Run Deploy (cortex-api)" -f action=shift-traffic
> ```
>
> The job runs the same `gcloud run services update-traffic --to-tags`
> command below, plus a `/api/healthz` smoke probe on the production
> URL that fails the job if the post-shift response is not 200 (HR-3
> enforcement at the workflow layer).

### E. Add a workflow-form note to the Rollback section

In the "Rollback / Failure detected after traffic shift" sub-section,
prepend the workflow form:

> Workflow form for legacy-design-tools / cortex-api (preferred —
> operator-runnable with no local `gcloud`):
>
> ```bash
> gh workflow run "Cloud Run Deploy (cortex-api)" \
>   -f action=rollback \
>   -f rollback_revision=<previous-revision>
> ```

## Workspace-conflict incident (process flag for the operator)

The first push of Phase 2 was contaminated. **cc-agent-R, despite being
on "its own clone", made local commits in this clone's git directory**
— two commits (`aa35f9d`, `233cf82`) appeared on my local `main`
unsolicited, and `aa35f9d` (commit message: "fix(renders): type-only
import of expert/style enums in RenderKickoffDialog") **bundled all
four of my Phase 2 files** alongside cc-agent-R's `RenderKickoffDialog`
edit:

```
.github/workflows/cloud-run-deploy.yml             | 246 ++++++++++++++++++++-
docs/deploy.md                                     |  94 +++++++-
lib/db/package.json                                |   1 +
lib/db/scripts/migrate-prod.mjs                    | 187 ++++++++++++++++
.../src/components/RenderKickoffDialog.tsx         |  19 +-
```

After staging my files and before my `git commit` could run, cc-agent-R
appears to have run `git add . && git commit`, capturing my staged
files into their commit. cc-agent-R also at some point ran
`git checkout feat/cortex-render-gap-fill-ui` in the shared working
tree, switching the branch out from under me.

**Recovery.** I extracted my four files from `aa35f9d` using `git show`
into an isolated `git worktree` at `p:/tmp/p2-worktree` (so cc-agent-R's
ongoing activity in the main working tree could not interfere),
committed a clean Phase 2 from there, and pushed to a new branch
`feat/p2-deploy-workflow-v2`. The contaminated remote branch
`feat/p2-deploy-workflow-actions` was deleted from origin. cc-agent-R's
work is preserved in `aa35f9d`/`233cf82` via the local reflog and
remains recoverable by them on their end.

**Recommendation for the operator.** Either confirm cc-agent-R is
genuinely on a separate clone (and audit why their commits surfaced in
this clone), or have concurrent agents work in isolated `git worktree`
roots from the start. The current state is the latter — Phase 2's PR
came out of `p:/tmp/p2-worktree` and that should remain the cc-agent-C
working tree until the conflict is resolved at the workspace level.

## Verification posture

Workflow YAML structure verified by grep — all five jobs present
(`build-and-push`, `deploy-canary`, `run-migrations`, `shift-traffic`,
`rollback`), each properly gated. The migration runner's logic was
desk-checked, not executed against a live DB — the operator's first
`run-migrations` dispatch (with `bootstrap=true`) is the first real
exercise. The dispatch posture is "operator-supervised throughout";
the canary sequence is what verifies behavioural correctness.

## Recommended operator sequence

1. Merge PR #81 (this phase).
2. First `run-migrations` dispatch: `gh workflow run "Cloud Run Deploy (cortex-api)" -f action=run-migrations -f bootstrap=true`. Confirm the log shows every file in `lib/db/drizzle/` (currently 0000-0015) marked bootstrapped.
3. From the next deploy onward, the canonical sequence is four separate dispatches: deploy-canary → run-migrations → smoke → shift-traffic.
4. Have the planner apply the runbook update above so `90_runbooks/cloud_run_canary_deploy.md` matches the new reality.
5. Address the workspace-conflict process gap before Phase 3 (which has a much larger blast radius — three feature streams across api-server + design-tools).

**Held for the operator before Phase 3.**
