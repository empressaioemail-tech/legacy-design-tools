# Agent Operating Rules — legacy-design-tools

**Repo:** `empressaioemail-tech/legacy-design-tools`
**Purpose:** Constraints, conventions, and known-quirk register for AI agents (Claude Code in Cursor, Replit Agent, others) doing work in this monorepo.
**Status:** Living document. Append to it when a new pattern surfaces; don't rewrite history.

---

## Repo identity

This is the Design Accelerator + AI Plan Review monorepo. Architect-side product portfolio. **Not** the SmartCity OS production app.

| Surface | URL |
|---|---|
| Architect | `https://prompt-agent-accelerator.replit.app/` |
| Reviewer | `https://prompt-agent-accelerator.replit.app/plan-review/` |

The separate SmartCity OS repo is `empressaioemail-tech/smartcity-os` at `smartcityos.io`. If a task mentions Bastrop, municipal data, the Operations Dashboard, or `tenant_id`, you are in the wrong repo. Stop.

---

## Workstation register

Always confirm which workstation before running tooling — paths differ.

| Box | gcloud path | Notes |
|---|---|---|
| `cente` | `C:\Users\cente\google-cloud-sdk\bin\gcloud.cmd` | Service account key at `C:\Users\cente\google-cloud-sdk\smartcity-agent-key.json` |
| `Nick` | `C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd` | No service account key; uses active identity `empressaioemail@gmail.com` |

Cursor work is on Windows; workspace root is `p:\legacy-design-tools`. Per-sprint worktrees follow the convention `p:\ldt-<sprint-name>`.

---

## Tooling baseline

- **Package manager:** pnpm. Local `10.27.0`, CI `10.33.2`. Workspace defined at `pnpm-workspace.yaml`; `lib/*` glob picks up new packages automatically.
- **Test runner:** Vitest + happy-dom + msw.
- **Database:** PostgreSQL with pgvector. Test DB schema fixture lives at `lib/db/src/__tests__/__fixtures__/schema.sql.template`. CI's drift-detection test compares this template to `pg_dump` output of the live test DB.
- **Codegen:** orval. Config at `lib/api-spec/orval.config.ts`. Run via `pnpm --filter @workspace/api-spec codegen`. Critical: orval is configured with `clean: true` — every generated directory is wiped and re-emitted on each run. Never hand-merge generated files.
- **CI:** GitHub Actions, `.github/workflows/pr-checks.yml`. Two jobs: Typecheck (~1 min) and Test (~3-5 min). The Typecheck job runs **per-artifact** `tsc -p X --noEmit` for each artifact, which is stricter than workspace-wide `tsc --build`. Always run `pnpm run typecheck` (the exact CI command) before pushing.
- **`gh` CLI is not available** anywhere. PRs are created via the URL printed by `git push -u origin <branch>`. CI logs are downloaded from GitHub UI (Checks → Failed job → gear icon → Download log archive) and uploaded to the orchestrating chat. Agents cannot fetch CI logs themselves.
- **Replit OAuth lacks `workflow` scope.** Workflow file edits (`.github/workflows/*`) must come from Cursor agents, not Replit Agent.

---

## Worktree discipline

One agent per worktree. Each sprint has its own worktree; agents must not modify branches outside their assigned worktree. Verify before assuming any path:

```
cd p:\legacy-design-tools
git worktree list
```

Single-commit fixups on existing branches. When fixing CI failures, agents add fixup commits on top of the sprint branch (don't squash). The merge cascade later subsumes the history into main.

Don't merge PRs yourself. The orchestrating user (typically Empressa) coordinates merges via GitHub UI. Agents push commits and idle.

---

## Recon-pause-execute-pause-report

Default workflow for any non-trivial task:

1. Agent investigates and reports findings (read-only, no commits, no edits)
2. Orchestrator approves and writes the patch
3. Agent executes
4. Agent pauses at internal checkpoints
5. Final deliverables report before idling

When in doubt, paste raw and idle. **Never guess on conflicts** — if `str_replace`'s `old_str` doesn't match exactly, paste the actual file content and stop. Don't try to fix by re-reading and guessing the right anchor.

---

## Known quirks

### Replit Agent does not auto-push to GitHub origin

Verified false assumption from prior work. Always run `git fetch origin --prune` and `git log --oneline origin/<branch>` before reasoning about the remote state of any branch Replit has touched. Replit commits land in its local sandbox; the push is a separate manual step.

### Windows rollup native binary

Vitest on Windows pnpm workspaces sometimes refuses to load until `@rollup/rollup-win32-x64-msvc` is installed. Agents may install it temporarily to run tests locally, but **must revert `package.json` and `pnpm-lock.yaml` before committing**. CI runs on Linux and never sees this. If this binary appears in a diff, reject the commit and have the agent revert.

### CRLF line endings on `lib/api-spec/openapi.yaml`

The spec file is checked out as CRLF on Windows. Node scripts that splice content into it must:
1. Detect the existing line-ending convention before parsing anchors
2. Operate on LF-normalized content in memory
3. Re-encode to CRLF on write

LF anchors won't match against CRLF-on-disk content; this will silently fail with "anchor not found" errors that look like the YAML structure changed when it didn't.

### `pnpm install` after rebasing onto a main with new workspace packages

When a rebase target introduces a new `lib/<package>/`, the worktree's `node_modules` symlink chain is stale. Symptom: `Cannot find module '@workspace/<package>'` typecheck errors against files that import the new package. Resolution: run `pnpm install` once. The lockfile is usually already correct — install just re-links the workspace symlinks.

This is a predictable post-rebase step whenever main has gained workspace packages since the branch last fetched.

### Fake timers vs real DB I/O

`vi.useFakeTimers()` and Postgres-backed test ops don't compose cleanly. Two failure modes seen:

- Faking `setImmediate` (default in vitest's fake-timer set) breaks postgres-js internal batching.
- `vi.advanceTimersByTimeAsync(N)` returns immediately if no fake timer is pending. If called before the production code under test has registered its first `setTimeout`, the test's manual cadence drops on the floor and the production code hangs forever on a never-fired timer.

For tests with real DB I/O inside the production path, prefer real timers entirely. Cost is wall-clock time per test; benefit is no race conditions. If real wall-clock per test is unacceptable, narrow `toFake: ['setTimeout', 'clearTimeout']` AND wait for the fake timer to register before advancing (use `vi.getTimerCount()` polled via `setImmediate` yields).

### Cross-branch atom registry coupling

When a sprint adds a new concrete atom edge (i.e., adds an entry to a parent atom's `composition` array as concrete, not `forwardRef: true`), every contract test whose `alsoRegister` array transitively reaches the parent must also register the new atom.

Validator walks `composition` edges transitively. Missing one node anywhere in the reachable graph fails the test with `composition references resolve in the registry — expected true to be false`.

When auditing for this:
1. Identify the new atom's parents (atoms that compose it concretely).
2. For each parent, identify ITS parents (atoms that compose the parent concretely).
3. Continue transitively until you've enumerated every atom that can reach the new one.
4. Every contract test that registers any atom in that reachable set needs the new atom in its alsoRegister.

In practice the choke point is the `engagement` atom — it sits near the root of the composition graph, so any new atom reachable through engagement will surface this issue across most contract tests.

### Codegen + spec merges

Conflicts inside `lib/api-zod/src/generated/` or `lib/api-client-react/src/generated/` are not real merge conflicts. Those files are wiped by orval's `clean: true` and regenerated from `lib/api-spec/openapi.yaml` on every codegen run.

Resolution procedure for spec-related rebase conflicts:
1. `git checkout --ours <each generated file>` — content doesn't matter, will be wiped
2. Hand-merge `lib/api-spec/openapi.yaml` only (the source of truth)
3. `pnpm --filter @workspace/api-spec codegen` (orval re-emits + the chained `pnpm -w run typecheck:libs` validates)
4. `git add -A && git rebase --continue`

When extracting schema blocks from a pre-rebase spec for hand-merge, include any **section comment headers** that introduce the schema family. Section headers (`# Renders (V1-4 / DA-RP-1, Spec 54 v2)` etc.) are part of the spec's structure and may shadow shared types like `Vec3` that sit under them.

### Schema fixture template conflicts

`lib/db/src/__tests__/__fixtures__/schema.sql.template` is the canonical fixture. CI's drift-detection test compares it to `pg_dump` output of the live test DB.

When two branches both add tables and their fixture refreshes conflict, **do not hand-merge the fixture**. Regenerate it:

```
cd lib/db
pnpm db:push:test
pnpm db:dump:test-fixture
```

Hand-merging a `pg_dump`-style file risks drift between the schema source (Drizzle TS files) and the fixture, which CI will then fail on the next run.

The fixture conflict is the predicted blocker on any rebase where both sides introduced tables. If the rebase completes without surfacing it, the two refreshes happened to edit disjoint regions and git auto-merged — verify by running the fixture drift test locally before push.

---

## Tenant discipline

Not relevant in this repo. The tenant-isolation rules (`tenant_id=2` is Bastrop production; `tenant_id=1` is demo) belong to SmartCity OS. Some shared lib code may surface tenant logic — if you encounter it in this repo, treat it as a leak and report rather than attempting to honor or update the rule here.

---

## Sprint cascade conventions

When a multi-sprint suite (V1, future Vn) lands as a coordinated set:

**Merge order is mandatory:** smallest-blast-radius first; schema-introducing PRs in dependency order; the PR with the keystone change (e.g., audience guard, shared schema type) merges before any branch that stacks on it.

**Re-rebase wave after the keystone merges.** Branches that pre-dated the keystone need `git rebase origin/main` to inherit it. Stacked branches drop their duplicated commits cleanly during this rebase.

**The branch that owns "final fixture refresh"** is whichever PR merges last among the schema-introducing ones. After all earlier schema branches land, the last one's fixture template won't reflect the live schema until regenerated. Plan for this as a known step.

**V1-7-style stack-on-top.** When branch B stacks on branch A's schema, B carries A's commits with different SHAs (A and B were both created from the same base, but A's commits have been amended through fixups). Git's rebase detects these as already-applied (same patch, different SHA) and drops them automatically. Don't hand-resolve duplicated stacked commits — let rebase do it.

---

## Critical bugs / locked decisions

(To be appended as decisions accumulate. Empty for now since this doc was created post-V1 close.)

---

## Append history

- **2026-05-02** — Initial draft. Distilled from the V1 sprint cascade (V1-1 through V1-7, six PRs across two parallel rebase chains). Documents the openapi.yaml hand-merge procedure, the cross-branch atom registry coupling pattern, the fake-timer + real-DB-I/O race, and the Windows rollup native-binary quirk.
