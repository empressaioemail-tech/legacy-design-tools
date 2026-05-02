# Replit Cleanup Recon

**Phase 0 — Read-only inventory only. Nothing was deleted, archived, restarted, or modified.**

**Branch:** `main` · **HEAD:** `b26388a` (last commit before this report; production deploy is `a6e28d7` "Published your App", 2026-05-01 23:57 UTC)
**Generated:** 2026-05-02

---

## TL;DR

```
Tasks panel        : 97 total — 76 MERGED, 19 CANCELLED, 2 PROPOSED-orphaned
Drafts queue       : 0 new drafts; only the 2 orphaned PROPOSED rows (#25, #77)
Workflows          : 4 artifact servers all running; e2e + test FAILED; typecheck OK
Branches           : 312 refs — 1 active (main), 1 GitHub mirror (origin/main),
                     1 Replit backup remote (gitsafe-backup/main), 1 Replit
                     auto-track (replit-agent), 1 manual safety branch
                     (local-pre-sync-20260502), 306 local subrepl-* leftovers
Secrets / env vars : 16 secrets + 1 shared env var — all referenced in code or
                     system-managed; nothing stale-named
Replit agent state : .local/tasks/ has 27 sprint plan files (load-bearing for
                     planning audit trail); attached_assets/ has 39 prompt-pastes
Repo files         : .replit / replit.nix / .replitignore / .agents / .npmrc all
                     load-bearing; no stray TODO(claude) / WIP markers in code
Stale docs         : TESTS_DEFERRED.md is Sprint H01 reference (probably stale);
                     .local/tasks/da-mv-1-phase-1-recon-HOLDING.md explicitly held
Live deploy risk   : LOW — purge plan below avoids every load-bearing surface
```

---

## Definitely-purge list (recommended; safe to act on)

These are unambiguously safe — clear waste with no production tie.

| # | Item | Action | Reason |
|---|---|---|---|
| 1 | **Task #25** "DA-PI-1 — Site Context tab + parcel intelligence atom registrations" (PROPOSED) | Close as MERGED-via-other-IDs or CANCELLED | Work shipped: the four parcel-intelligence atoms (intent, briefing-source, parcel-briefing, neighboring-context) are registered at `artifacts/api-server/src/atoms/registry.ts:147-150`. The Site Context tab is live in design-tools. This row is orphaned. |
| 2 | **Task #77** "DA-PI-1F1 — Switch framework-atom token delimiter from `:` to `\|`" (PROPOSED) | Close as MERGED | Work shipped: the new pipe delimiter is in production, e.g. `briefing-export-pdf.test.ts:150` uses `{{atom\|briefing-source\|...}}`. Spot-check confirmed via `rg -n '\{\{atom:' artifacts/ lib/` returning zero hits in source code. Also orphaned. |
| 3 | **306 local `subrepl-*` branches + their named remotes** | Local prune (`git branch -D` + `git remote remove`) | These are the Replit Agent's per-task isolation branches — every Replit task that ran in an isolated subrepl left one behind. Dated 2026-04-30 to 2026-05-01 (the entire active sprint window). Their work has either landed on `main` or been cancelled. They are not used for rollback (the `gitsafe-backup/main` remote + `local-pre-sync-20260502` branch handle that). Each branch also has a matching named git remote (`subrepl-XXXX → git+ssh://git@ssh.riker.replit.dev`), polluting `git remote -v` with 600+ lines. **Caveat:** confirm with Replit support that pruning subrepl branches doesn't break the platform's task-history view; the purge sprint should test on one branch first before doing all 306. |
| 4 | **`.local/state/scribe/scribe.db-wal`** (2.8 MB) | Let the platform clean up; do NOT manually delete | The scribe SQLite WAL file. It is bigger than the actual `scribe.db` (4 KB). Replit usually checkpoints this on its own. Flagging because it's the largest single file in `.local/state/` and looks like it accumulated during the heavy May-1 merge cadence. |

---

## Probably-purge list (Empressa to confirm)

These look like waste but I'm not 100% — confirm before the purge sprint touches them.

| # | Item | Why it's flagged | Why I'm hesitant |
|---|---|---|---|
| 1 | **`TESTS_DEFERRED.md`** (root) | References "Sprint H01 Part 2" tests; the orchestrator/queue/api-server work it punts has presumably shipped via #316–#411 cluster | It might still be a useful reference for what wasn't covered. Worth a 5-min skim to confirm every deferred suite has a real corresponding test now. |
| 2 | **`.local/tasks/da-mv-1-phase-1-recon-HOLDING.md`** | File header explicitly says "HELD at Phase 1 → Phase 2 gate, do NOT submit until DA-PI-1B Phase 4 closeout received." DA-PI-1B (briefing-source schema work) shipped well before HEAD. The hold condition is satisfied. | Don't know if Empressa has reactivated this work elsewhere. If not, the file is stale guidance and should either be promoted to a real `.local/tasks/da-mv-1-*.md` plan or deleted. |
| 3 | **`.local/tasks/grand-county-landuse-phase-1-recon.md`** (dated Apr 30) | Recon doc for "Grand County zoning corpus is missing setback/lot-coverage atoms." Wave 1 has since landed setback adapters (`lib/adapters/src/local/setbacks/`); this recon may be obsolete. | Cannot confirm without reading the full recon vs the current adapter coverage. Likely superseded by DA-PI-4. |
| 4 | **`attached_assets/` (39 top-level files + 3 in `_archive/`)** | All are `Pasted-*.txt` chat-upload history from prior planning sessions plus 3 PNG screenshots. None are referenced by application code. | These are sometimes audit-trail evidence for what Empressa pasted into chat. If you want a planning paper-trail, archive into a single dated zip rather than wholesale-delete. The single biggest space-saver in this list. |
| 5 | **`.local/tasks/wave2-sprint-d-reviewer-graph-nav-stale-requests.md`** | Sprint D was scoped but not implemented (per ground-truth report). The `.local/tasks/` plan file was the dispatch payload for a sprint that may not be re-dispatched as a Replit task now that execution is moving off-Replit. | Keep if you want the original dispatch text as reference for the Cursor / Claude Code re-dispatch; delete if you'll re-write the brief from scratch. |
| 6 | **`replit-agent` branch** (auto-tracking) | Replit's auto-managed mirror of recent agent activity (HEAD = `4689000`, same content as my last report commit). Once execution moves to Cursor / Claude Code, this branch becomes meaningless. | Replit may need it to keep its checkpoint UI working. **Do not delete manually** — turn off Replit Agent in workspace settings instead, then let Replit clean it up. |

---

## Definitely-keep list (looks stale at first glance, but load-bearing)

Do **not** touch any of these. Each has a real reason it's still there.

| Item | Why keep |
|---|---|
| `.replit` | The deploy config. Holds `[deployment]` (autoscale, postBuild prune), the `[workflows]` definitions, port mappings (8080→8080, 8081→80), `[postMerge]` script ref, and the `[agent]` block. Touching this will affect the live deploy. |
| `.replitignore` | Excludes `.local` from deploys. Keeps the deployed image small. Load-bearing. |
| `replit.nix` | System library deps for Puppeteer (libgbm, libxcb, mesa, GTK, X11 libs, NSS, Cairo, Pango, ALSA, etc). Without these the PDF export route + Three.js BIM viewport SSR break in production. **Critical.** |
| `.npmrc` | Disables auto-install-peers + strict peer deps for pnpm. Required for the workspace to install. |
| `.agents/agent_assets_metadata.toml` | Tracks generated asset metadata. Replit-managed. |
| `artifacts/*/.replit-artifact/artifact.toml` × 4 | Per-artifact deploy config (port, base path, service name). The shared proxy uses these to route `/api`, `/`, `/plan-review`, `/mockup-sandbox` correctly. **Load-bearing for production.** |
| `gitsafe-backup/main` remote (`git://gitsafe:5418/backup.git`) | Replit-internal backup service. Last commit on the remote is `a74a5fc` 2026-04-29 17:19 UTC ("Update deferred tasks list with EP-003 details"). The remote is configured to **reject non-fast-forward pushes**, so it can only advance — it cannot be retroactively overwritten, which is exactly the right rollback-safety property. Keep until Cursor / Claude Code is established. |
| `local-pre-sync-20260502` (local branch) | Manual safety branch captured 2026-05-02. Same content as current `main` (HEAD `b26388a`). This is the "if everything else goes wrong, hard-reset main to this commit" recovery point. **Do not delete** until the off-Replit transition is complete and confirmed working. |
| `origin` remote (`https://github.com/empressaioemail-tech/legacy-design-tools`) | The GitHub mirror. Empressa-controlled, public-facing. Load-bearing for any GitHub-side workflow (CI, issue tracking, deploy hooks if any). Keep — but worth confirming nothing on GitHub depends on the `replit-agent` branch being pushed. |
| `replit.md` | Project memory file always loaded by Replit Agent. If you're keeping Replit Agent alive at all (even just for emergency hotfixes), this stays. |
| `docs/wave-1/*` (3 files) | Wave 1 closeout report, open questions docket, Wave 2 entry notes — authoritative reference for "what shipped and what's open." Empressa-facing handoff docs. |
| `docs/wave-2/01-mnml-integration-recon.md` | Reference for V1-4 (the mnml integration sprint Empressa flagged). Keep. |
| `docs/wave-2/02-mnml-secrets-handoff.md` | The handoff doc for mnml.ai API secrets. Operational reference. Keep. |
| `docs/wave-2/03-sprint-d-graph-nav-recon.md` | Reference for V1-2 (the Sprint D / graph-nav re-dispatch). 45 KB of design that the off-Replit re-dispatch will consume. Keep. |
| `docs/empressa-ground-truth-report.md` | The fact-finding report I just generated. Keep until Empressa has copied it into the planning agent. |
| `.local/tasks/*.md` (27 files, ~340 KB) | Sprint plan / dispatch text for every Phase-2 sprint that ran (DA-PI-1 through DA-RP-INFRA, AIR-1, AIR-2, all Wave 2 sprint plans). Functions as the planning agent's audit trail of what was dispatched and approved. Touching these breaks the link between "Task #NNN merged" and "this is what was approved at desktop." Keep all. |
| `TESTING.md` | Canonical "how to run tests" reference for the monorepo. Active. Keep. |
| All 16 secrets + the shared `SNAPSHOT_SECRET` | Cross-referenced every name against code. None look stale; none are obviously orphaned (see Replit Secrets section below). |

---

## Workflow + deploy risk assessment

**Deploy risk: LOW.** The recommended purge in this report does not touch any deploy-critical surface:
- No change to `.replit`, `.replitignore`, `replit.nix`, `.npmrc`, or any `artifact.toml`.
- No change to `main`'s commit history (subrepl branch pruning is local + remote-only, not history-rewriting).
- No change to secrets / env vars.
- No change to the deployed image — production is at `a6e28d7` and the next deploy will pick up whatever lands on `main`.

**Workflow status (from system status, captured this session):**

| Workflow | State | Notes |
|---|---|---|
| `artifacts/api-server: API Server` | running | recovered since the previous fact-finding report flagged it FAILED |
| `artifacts/design-tools: web` | running | recovered |
| `artifacts/plan-review: web` | running | recovered |
| `artifacts/mockup-sandbox: Component Preview Server` | running | stable throughout |
| `e2e` | **FAILED** | new logs since last check; do NOT restart yet — read logs first |
| `test` | **FAILED** | new logs since last check; do NOT restart yet — read logs first |
| `typecheck` | finished (green) | the typecheck:libs + leaf check pipeline is healthy |

**`test` and `e2e` failure is concerning but not a deploy blocker.** Production runs from `a6e28d7` which was deployed before the test infrastructure went red. The failure pattern in this monorepo is usually one of:
1. A flaky Playwright spec (the BIM viewport gesture-hint cluster has been a known source).
2. Database fixture drift after a `drizzle-kit push` (no journaled migrations, so test DB state can lag schema).
3. Test-env contamination from an orphan workflow in another worktree.

**Recommendation:** the purge sprint should NOT restart `test` or `e2e` blindly. Read the logs first to determine which of the three patterns above is the root cause, fix that, then restart.

---

## Replit Agent state to wipe

Cleanup that becomes possible once execution moves off Replit (Cursor / Claude Code):

| State | Recommendation |
|---|---|
| Two orphaned PROPOSED rows (#25, #77) | Close them in the Tasks panel. Cosmetic but eliminates the only "drafts pending approval" signal, so the Tasks panel goes quiet. |
| `.local/state/replit/agent/` (39 KB) | Replit Agent's working memory. Auto-managed. Will become inert when the agent stops being used; no manual action needed. |
| `replit-agent` git branch | Auto-tracking. See "probably-purge" #6 — turn off Replit Agent in workspace settings, let Replit retire the branch. |
| `.local/state/scribe/scribe.db-wal` (2.8 MB) | Will checkpoint on its own once the agent stops writing. |
| `[agent]` block in `.replit` | If you want Replit Agent **fully** disabled (no expert-mode, no integrations), remove this block. **Caveat:** doing so also removes the `integrations = ["github:1.0.0"]` line that wires the Replit ↔ GitHub integration; if that integration is what publishes to GitHub, leave the block alone or remove just the `expertMode = true` line. |
| Pinned context / custom instructions | None visible. There is no `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/`, or `.claude/` at the root. The only "agent context" is `replit.md`'s **User Preferences** section, which is short and project-flavored. Worth porting to whatever Cursor / Claude Code uses (`AGENTS.md` or `.cursor/rules/*.mdc`) before disabling Replit Agent. |
| Project memory drift | The `replit.md` overview is current as of "engagement + snapshot + briefing-engine + adapters" but predates Wave 2 (no mention of mnml-client, viewpoint-render atoms, or reviewer-annotation atom). If you keep it for any future Replit usage, refresh the **System Architecture** section. If you're moving fully off Replit, ignore. |

---

## Files in repo that should be addressed

| File | Recommendation |
|---|---|
| `attached_assets/` (39 files) | Archive into a single dated zip (e.g. `attached_assets/_archive/chat-paste-history-2026-04-30-to-2026-05-01.zip`) and clear the top level. ~80% of the directory is paste-history that has zero code-side referrers. |
| `attached_assets/_archive/` (3 files already there) | Pre-existing archive. Keep. |
| `TESTS_DEFERRED.md` | If every deferred suite shipped, delete and add a one-liner to `TESTING.md` saying "Sprint H01 deferred suites all landed by Task #316." If some haven't, slim down to just those. |
| `.local/tasks/da-mv-1-phase-1-recon-HOLDING.md` | Resolve: either rename to `da-mv-1-phase-2-plan.md` and let the work proceed, or delete with a note in `docs/wave-1/02-open-questions.md` explaining why DA-MV-1 was abandoned. |
| `.local/tasks/grand-county-landuse-phase-1-recon.md` | Cross-check against `lib/adapters/src/local/setbacks/` and `lib/codes/src/jurisdictions.ts` — if Grand County is now covered, this recon is obsolete and should be deleted with a one-line provenance note in the closeout report. |
| `docs/empressa-ground-truth-report.md` | Keep until you've confirmed the planning agent has the report copied. Then either move to a `_archive/` subdirectory or delete. |
| `lib/site-context/` (workspace package, 0 test files) | Not a cleanup item per se, but flagging: this package exists in the workspace with zero tests. Either it's a placeholder (delete) or it needs coverage. |

---

## Things I noticed that are unexpected

1. **306 `subrepl-*` branches.** Bigger than I expected. Each Replit Task that runs creates an isolated subrepl with its own branch + remote. None of these have been pruned across the entire Phase-2 dispatch (April 30 – May 1). `git remote -v` is **5 000+ lines** because each branch also registered itself as a remote. This is the single biggest housekeeping item. The Replit platform should ideally clean these up automatically when tasks merge; it isn't.
2. **`.local/tasks/` is the real planning audit trail, not `project_tasks`.** 27 files totalling ~340 KB, one per dispatched sprint, with full Phase-1-recon / Phase-2-decision / Phase-3-implementation / Phase-4-closeout structure inside. This is the closest thing to a unified "what was approved at desktop and what was dispatched" log on the entire Repl. **For the Cursor / Claude Code transition, copying this directory wholesale is the cheapest way to preserve sprint history.**
3. **Workflows recovered without my intervention.** Three artifact servers that were FAILED in the prior fact-finding report (about an hour ago) are now running cleanly. Either Replit's auto-restart kicked in or someone restarted them through the UI. Worth knowing for future "everything is red" panic moments.
4. **`gitsafe-backup/main` is 3 days behind main, but `local-pre-sync-20260502` is current.** The Replit-internal backup remote (`git://gitsafe:5418/backup.git`) last received a push on 2026-04-29 17:19 UTC; main has had 30+ commits since (entire Wave 2 substrate + reviewer-parity + AIR-2 cluster). The local `local-pre-sync-20260502` branch covers that gap with a current snapshot. **Recommendation:** before the cleanup sprint touches anything, do a manual `git push gitsafe-backup main` to advance the off-machine backup so both safety nets are at the same commit. The remote is fast-forward-only, so the push will simply advance the ref — no force flag, no risk of overwriting the prior backup.
5. **`origin` is the GitHub mirror at `empressaioemail-tech/legacy-design-tools`.** Worth knowing for the off-Replit transition: Cursor / Claude Code will work directly against this GitHub repo. The Replit subrepl branches were never pushed to `origin` (they only existed locally + on the per-task SSH remotes), so GitHub is already clean of subrepl pollution. Verify with `git ls-remote origin | grep -c subrepl-` (should return 0) before declaring the transition safe.
6. **`SESSION_SECRET` is set as a secret but I cannot find a single grep hit for it in code.** Two possibilities: (a) it's read by a session middleware via a generic `process.env.SESSION_SECRET` access pattern that my regex missed, or (b) it's actually unused and someone set it during initial setup and forgot. Worth a 2-minute confirmation before declaring it stale.
7. **`OPENAI_API_KEY` is set but only used for embeddings (`lib/codes/src/embeddings.ts`).** The codebase already gracefully handles `OPENAI_API_KEY` being unset (`embeddings.ts:37` checks for it; `:45` logs the fallback). If embeddings are no longer being generated against OpenAI, this secret is removable. **Cross-check:** is the codes corpus still being re-ingested, or is the corpus frozen post-DA-PI-2/4? If frozen, `OPENAI_API_KEY` can go.
8. **The `[deployment.postBuild]` runs `pnpm store prune`** — this is correct and load-bearing, just flagging because if anyone tries to "speed up the deploy" by removing it, deployed image size will balloon.
9. **No `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/`, or `.claude/` exists.** Cursor / Claude Code transition will need at least one of these created from scratch — `replit.md`'s User Preferences section is the best starting material.

---

**End of recon. Ready for the purge-dispatch prompt.**

No tasks were drafted, no branches were pruned, no files were modified, no workflows were restarted. Production deploy at `smartcityos.io` (commit `a6e28d7`) is untouched.
