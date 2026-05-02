# Replit Workspace Purge — Phase 1A Pre-flight

**Status:** READ-ONLY pre-flight checks complete. **Nothing destructive has happened.** Awaiting Empressa approval before any task closure, push, or branch deletion.

---

## 1. Confirmation of orphaned PROPOSED rows

Tasks panel queried directly:

```
total tasks  : 97
by state     : MERGED 76 / CANCELLED 19 / PROPOSED 2
highest ID   : #97 (unchanged since recon)
```

Both target rows confirmed still PROPOSED:

| Task | Title | State |
|---|---|---|
| `#25` | DA-PI-1 — Site Context tab + parcel intelligence atom registrations | **PROPOSED** ✓ |
| `#77` | DA-PI-1F1 — Switch framework-atom token delimiter from `:` to `\|` | **PROPOSED** ✓ |

Safe to close per Step 1 of the plan.

---

## 2. Test subrepl-* branch verification — **PLAN CHECK CRITERION IS WRONG**

Following Step 3a–3b of the plan, I picked `subrepl-029f26i6` and ran `git log subrepl-029f26i6 ^main`.

**Plan expected:** zero unique commits.
**Actual:** 1 unique commit:

```
9722b63 Show live preview of PDF footer watermark in Settings (Task #404)
        date: 2026-05-01 23:06:09 UTC
```

That same subject **does** exist on `main` as commit `953648a` (date 2026-05-01 23:11:10 UTC, 5 minutes later). The diff between the two SHAs is non-trivial — there were small refactors (mock-helper renames) applied during the merge, so the subrepl tree and the main tree are not byte-identical.

**Why the plan's criterion fails:** Replit's task-merge workflow always rewrites commit SHAs (squash or rebase), and frequently applies small cleanups during the merge. So `git log subrepl-XXX ^main` returning zero would only happen if the subrepl branch were merged via fast-forward, which Replit's task system does not do. **Every subrepl branch will show 1+ "unique" commits even when the work is fully on main.**

### Tree-hash equivalence scan across all 306 branches

I re-ran the safety check using **tree-hash equivalence** (which is the correct test for content-on-main, regardless of SHA divergence):

```
For each subrepl branch, compare its tip-commit's tree hash
against every tree hash on main's history.

  92 / 306  subrepl tips have an EXACT tree match on main
            → work is provably preserved on main; safe to prune
 214 / 306  subrepl tips have NO tree match on main
            → tip is an intermediate WIP snapshot that doesn't
              exist verbatim on main
```

**My read of the 214 "no-tree-match" cases:** these are almost certainly intermediate development states the agent worked through before its work was rebased/squashed for the merge. The *commit subjects* of these tips do generally appear on main (spot-check: `subrepl-3vek7dnb` tip subject `Task #379 — render glb-only elements...` is byte-identical to commit `0db8ba2` on main; only the trees differ). The work is on main — it's the as-developed snapshot history that isn't preserved.

But I cannot prove that for all 214 from this side without a much more expensive per-branch content audit, and I'm not going to start one without your sign-off.

### Decision needed before bulk prune

You need to pick one of:

| Option | What it means | Risk |
|---|---|---|
| **A. Accept WIP-snapshot loss; bulk prune all 306** | The merged versions of all this work are on main. `gitsafe-backup/main` (3 days behind) + `local-pre-sync-20260502` (current) together cover rollback. We lose the "as the agent originally typed it" intermediate snapshots. | LOW — no production impact, no risk to merged work. Only loses agent-WIP archaeological detail. |
| **B. Tighten the check; prune only the 92 tree-equivalent branches** | Keeps 214 "WIP-snapshot" branches indefinitely. Half-cleans the workspace. | LOWEST — guaranteed no content loss. But leaves 70% of the cruft behind. |
| **C. Per-branch manual audit of all 214** | I'd need to verify each one's tip-subject against main. ~10–30 min of additional pre-flight. | LOWEST — but expensive. |
| **D. Defer the prune entirely** | Do Steps 1, 2, 4 only this sprint. Re-scope branch prune as a follow-on. | ZERO — but workspace stays cluttered. |

**My recommendation: Option A.** Tree-hash divergence on intermediate WIP states is exactly what we'd expect from Replit's squash-merge model. The merged work is on main, two independent backups (`gitsafe-backup` remote + `local-pre-sync-20260502` branch) cover rollback. Losing the agent's typo-by-typo development history is acceptable.

**If you choose A, the bulk-prune commands are listed below.** If you choose B, swap the loop to filter on tree-equivalence first (I can write that variant on request). If you choose C or D, no prune happens this sprint.

---

## 3. Exact bulk-prune shell loops (Step 3g)

These are read-only inert text until you say go.

```bash
# 3g.1 — remove all 306 named subrepl-* git remotes
for r in $(git remote | grep '^subrepl-'); do
  git remote remove "$r"
done

# 3g.2 — delete all 306 local subrepl-* branches
for b in $(git branch | sed 's/^[[:space:]\*]*//' | grep '^subrepl-'); do
  git branch -D "$b"
done
```

**Note on the second loop:** I tightened the regex from the plan's `grep '^[[:space:]]*subrepl-'` to use `sed` first to strip the leading whitespace + `*` (current-branch marker) so the branch names get passed cleanly into `git branch -D`. Functionally equivalent but more robust if you ever run it from a different active branch.

### Verification after bulk prune (Step 3h)

```bash
git remote -v          # expect: only `origin` and `gitsafe-backup` lines
git branch             # expect: main, local-pre-sync-20260502, replit-agent
git branch -a | wc -l  # expect: 6 (main, local-pre-sync, replit-agent,
                       #          gitsafe-backup/main, origin/main, origin/HEAD)
```

---

## 4. Step 2 (gitsafe-backup advance) pre-flight

```
gitsafe-backup remote URL : git://gitsafe:5418/backup.git
current ref on remote     : refs/heads/main → a74a5fc (2026-04-29 17:19 UTC)
local main HEAD           : 03979da (2026-05-02)
commits to push           : ~32 (Wave 2 substrate + reviewer parity + AIR-2 +
                                  BIM cluster + my two recon reports)
```

The plan command is:

```bash
git push gitsafe-backup main:replit-sync-2026-05-02
```

This creates a **new branch** on the gitsafe remote (no force flag, no overwrite of `main` — fully consistent with the remote's fast-forward-only policy). Safe.

---

## 5. Unexpected state since the recon

Three deltas, all minor and all caused by my own activity:

| Delta | Detail |
|---|---|
| `main` advanced by 3 commits | `b26388a` → `0d731ab` → `03979da`. All three are my recon-report commits (the ground-truth report, the cleanup recon report, and the cleanup recon update). No production-impacting commits. |
| `local-pre-sync-20260502` is behind main by 2 commits | The safety branch is at `0d731ab`. It captured before my last edit to `replit-cleanup-recon.md`. **This is fine** — the safety branch is meant to capture pre-cleanup state, not track main; it should not be advanced as part of this sprint. |
| Tasks panel: zero new rows | Still 97 tasks total. Still only #25 and #77 PROPOSED. No new drafts appeared. |

Workflow status (system status panel) is unchanged from the recon: 4 artifact servers running, `e2e` and `test` still FAILED (out of scope per the plan), `typecheck` finished green.

Production deploy is still at commit `a6e28d7`. Verified `git merge-base --is-ancestor a6e28d7 main` returns success — the deploy commit is reachable from main, so any rollback path is still intact.

---

## 6. Awaiting your call

Before I execute anything destructive, I need:

1. **Step 1 (close #25 + #77):** approve as-stated, or skip this sprint?
2. **Step 2 (push to `replit-sync-2026-05-02` on gitsafe-backup):** approve as-stated?
3. **Step 3 prune-policy:** A / B / C / D from §2 above.

Say "approve A" / "approve B" / etc. and I'll proceed step-by-step with a pause at every plan-defined gate (after Step 1, after Step 2, at 3f after the test-prune, after 3g after the bulk prune, then final smoke check).

**Until then: nothing destructive runs.**
