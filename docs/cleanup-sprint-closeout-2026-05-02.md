# Cleanup Sprint Closeout — 2026-05-02

**Sprint:** Replit workspace purge, Phase 0 (recon) + Phase 1 (execution).
**Status:** Closed. Production untouched throughout.
**Companion docs:** `docs/replit-cleanup-recon.md` (Phase 0 spec), `docs/replit-purge-phase-1a-preflight.md` (Phase 1 dispatch's pre-flight verification + the findings that reshaped Phase 1 mid-execution).

---

## 1. Sprint scope and outcome

**Done:**

- 306 `subrepl-*` local branches deleted.
- 306 `subrepl-*` named git remotes removed.
- Tasks `#25` and `#77` (the two PROPOSED orphans) dismissed in the Tasks panel.
- Production URL references in the recon corrected from `smartcityos.io` to `prompt-agent-accelerator.replit.app/` (architect surface) and `prompt-agent-accelerator.replit.app/plan-review/` (reviewer surface).
- Replit Publish executed; both URLs serving post-deploy.
- Production smoke check passed: deploy commit `a6e28d7` remains reachable from current `main`, and from `origin/main` at `b5c316b`.

**Deferred (intentional — see §3):** the `attached_assets/` archive review, `TESTS_DEFERRED.md` disposition, the `.local/tasks/*` HOLDING files, the `replit-agent` branch, the `[agent]` block in `.replit`, restarting the `e2e` and `test` workflows, and any secret triage (`SESSION_SECRET`, `OPENAI_API_KEY`).

**Not attempted (blocked):** advancing `gitsafe-backup/main` to current `main`. The remote's pre-receive hook rejects all non-fast-forward pushes AND all non-`main` branch names; the histories don't fast-forward. See finding §2.b.

---

## 2. Findings preserved for the record

### a) Tasks panel reality check

`listProjectTasks()` silently paginates. The default response capped at 97 rows; the recon and the early Phase-1A pre-flight both took that count at face value and reported "97 tasks total." Individual probing across the `#1`–`#500` range later revealed the **actual task count is 415** (306 MERGED, 107 CANCELLED, 2 PROPOSED at sprint start).

Lesson: future workspace audits that need a true task count should iterate `getProjectTask({taskRef: "#N"})` across the suspected range rather than trust the list endpoint's row count. Or, equivalently, treat the list count as a *minimum* unless paginated explicitly.

### b) `gitsafe-backup` is a divergent legacy snapshot, not a current rollback target

Recon claimed `gitsafe-backup/main` was "3 days behind." It is not. The histories diverged at common ancestor `87b21bb`:

- `gitsafe-backup/main` carries 10 commits NOT on current `main`, including a `Published your App` commit and a series of Revit-binding development commits (`Add a system for matching engagements using Revit GUID and document path`, `Add ability to link Revit files to existing projects automatically`, etc.) that were abandoned without being merged.
- Current `main` has **328 commits** NOT on `gitsafe-backup/main`.

The Replit gitsafe hook policy compounds this: it accepts pushes only to `main`, only fast-forward. A new-branch push (the recon's planned workaround) is rejected by name; a force push to `main` is rejected by hook. There is no agent-side path to advance `gitsafe-backup` without admin access to the hook.

**Real rollback nets going forward:**

| Backup | Status | Useful as a rollback? |
|---|---|---|
| `local-pre-sync-20260502` (local branch) | Snapshot just before this sprint began | **YES** — primary local net |
| `origin/main` on GitHub (`empressaioemail-tech/legacy-design-tools`) | Live, receives normal pushes | **YES** — primary off-machine net |
| `gitsafe-backup/main` | 328 commits behind, divergent line | **NO** — would lose 328 commits AND revive abandoned Revit-binding work |

`gitsafe-backup` should be treated as a historical curiosity, not a backup. Removing it from the remotes list is a legitimate follow-up.

### c) Mass-cancel of 81 PROPOSED tasks was draft-cleanup, not abandoned work

Mid-sprint, 81 PROPOSED rows (IDs spanning `#141`–`#415`) were dismissed in a single panel action. To verify nothing in-flight was killed, 8 IDs spanning the full range (`#141`, `#142`, `#167`, `#187`, `#243`, `#299`, `#356`, `#415`) were spot-checked with `git log --all --grep "Task #N\b" --oneline`. Result: **all 8 returned zero commits across every ref in the repo** (main, all 306 subrepl branches at the time, all remote-tracking branches). These were never-dispatched draft suggestions. The cancellation was correct.

### d) Production URLs

The recon's `smartcityos.io` references were a copy-paste error from a sibling project (SmartCity OS). This repo (`legacy-design-tools`) deploys to:

- **Architect surface:** `prompt-agent-accelerator.replit.app/`
- **Reviewer surface:** `prompt-agent-accelerator.replit.app/plan-review/`

Corrected in `docs/replit-cleanup-recon.md` and pushed as commit `b5c316b` on `origin/main`.

---

## 3. What was NOT done this sprint (deferred)

All explicitly out-of-scope per the Phase 1 dispatch. Listed here so they don't get forgotten:

- `attached_assets/` archive triage.
- `TESTS_DEFERRED.md` disposition.
- `.local/tasks/da-mv-1-phase-1-recon-HOLDING.md` and `.local/tasks/grand-county-landuse-phase-1-recon.md`.
- `replit-agent` branch removal.
- `[agent]` block in `.replit` edits.
- Restarting the `e2e` and `test` workflows (both red at recon time; root cause was deferred to a separate sprint).
- Secret triage: `SESSION_SECRET` (no grep hit found in code) and `OPENAI_API_KEY` (only used by `lib/codes/src/embeddings.ts`, with graceful fallback).

---

## 4. Lessons for future multi-window git work

This sprint exposed three reconcilable patterns worth keeping for next time:

1. **Always run `git fetch origin --prune && git status` before any commit on a shared origin's `main`.** Reconcile divergence *before* you commit, not after. When the user is editing in Cursor and the agent is editing in Replit shell against the same `origin`, divergence is the default state.
2. **When a `git push origin main` is rejected with non-fast-forward, the standard recovery is `git pull --rebase origin main`, then push.** Force-pushing to `main` is never the right answer on a shared origin.
3. **Trust your recon less than your fresh probes.** Two of this recon's headline numbers were wrong: `97 tasks` (actual: 415, paginated query) and `gitsafe-backup 3 days behind` (actual: divergent by 328 commits with 10 orphan commits). When a recon-derived number drives a destructive action, re-verify it at execution time.

---

## 5. Final state inventory

```
Branches:
  main                                ← current
  local-pre-sync-20260502             ← snapshot from sprint start (rollback target)
  replit-agent                        ← Replit agent-managed; left alone

Remotes:
  origin                              ← github.com/empressaioemail-tech/legacy-design-tools
  gitsafe-backup                      ← legacy/divergent, retained for record

Tasks panel:
  total = 415; PROPOSED = 0; MERGED = 306; CANCELLED = 109

Production:
  origin/main HEAD          : b5c316b (URL fix)
  most recent published deploy : a6e28d7 (reachable from origin/main and from local main)
  architect surface         : https://prompt-agent-accelerator.replit.app/
  reviewer surface          : https://prompt-agent-accelerator.replit.app/plan-review/

Subrepl pollution:
  local subrepl-* branches  : 0  (was 306)
  named subrepl-* remotes   : 0  (was 306)
```

Sprint closed.
