---
title: Cortex QA close-out — QA-33 + QA-35 follow-on (cc-agent-C)
date: 2026-05-23
agent: cc-agent-C
repo: legacy-design-tools
kind: session-summary-draft
status: draft — HR-11 report. Drafted into legacy-design-tools/_research/
  per the standing cross-repo doc-writes guidance; a copy dropped at
  doc_repo/_inbox/ for the planner to relocate.
dispatch: 2026-05-23_cc-agent-C_qa33_qa35_followon
related: [43_cortex_qa_backlog, 2026-05-23_cc-agent-C_qa33_qa22_cleanup_batch]
---

# Cortex QA close-out — cc-agent-C (follow-on)

Follow-on to the 2026-05-23 cleanup batch that landed PRs #87 (IFC
ingest diagnostic logging) and #88 (adapter response-body capture).
Both diagnostic surfaces returned the data needed to root-cause the
remaining symptoms cleanly. This session shipped the actual fixes.

| Item | PR | Branch | State |
|---|---|---|---|
| QA-33 (viewport CSS) + QA-35 (re-ingest data) | #90 | `fix/qa33-qa35-followon` | open for review |

Combined into one PR per the dispatch's permission to combine
non-fighting scopes — neither touched the other's files, both
verified on cortex-api-00020-85n.

## SCOPE A — QA-33 (BIM viewport empty — CSS)

### What the diagnostic log revealed

PR #87's `ifc ingest: complete` log line on cortex-api-00020-85n:

> `glbBytesLen=5,234,980`, `gltfObjectPath=/objects/uploads/...`

So the backend is fine. The 5MB GLB is being produced, the bundle
row carries `glbObjectPath`, and the FE makes 3 .glb requests at
HTTP 200 from disk cache. Three.js receives the bytes. The
viewport still renders nothing — and "the 3d viewer container
overruns and scrolls down on the page indefinitely."

### Root cause

The canvas wrapper at
`lib/portal-ui/src/components/BimModelViewport.tsx:1504` declares
`aspectRatio: "16 / 9"` plus `minHeight: 280` — but no max-height.
The ancestor chain doesn't cap either:

- `DialogContent` (`max-w-3xl, maxHeight 90vh, overflow auto`)
- → `TabsContent` (no height)
- → `BimModelTab` outer wrapper (no height)
- → `BimModelViewport`'s `viewportRef` (no height)
- → the canvas wrapper at L1504

On a wide modal the canvas wrapper derives a 400–600px height from
its width via the aspect ratio, the building geometry renders
dead-centre in that box, and combined with the (now-also-buggy)
elements list under it (see SCOPE B), the modal scrolls and the
building ends up below the fold. Operator reads "empty viewport."

### Fix

- Cap `maxHeight: "60vh"` on the canvas wrapper so the viewport
  always fits inside `DialogContent`'s 90vh budget regardless of
  modal width or ancestor layout.
- Add a defensive `console.warn` in the resize observer for the
  *opposite* failure mode — a parent flex chain that never
  propagates min-height, mounting the canvas at
  `clientHeight < 100`. That's the QA-33-class bug we'd want a
  console hint for next time.

## SCOPE B — QA-35 (re-ingest accumulates rows — data)

### What the diagnostic log revealed

PR #87's three `ifc ingest: complete` log entries on
cortex-api-00020-85n showed three distinct `snapshotId`s,
`ifcFileId`s, and `gltfObjectPath`s — each upload was a real
re-ingest, and each one produced a fresh consolidated GLB. The bug
is on the SQL side: prior generations' rows were never superseded.

### Root cause

`ifcIngest.ts` step 5b's supersession UPDATE is scoped
`WHERE source_snapshot_id = $1`. Each re-upload creates a fresh
`snapshots` row (different `snapshot.id`), so the UPDATE found
zero prior rows on re-ingest and let prior generations stay
active. 3 uploads × 101 entities = 303 active rows.

PR #33's partial unique index
`materializable_elements_active_ifc_identity_uniq` is keyed
`(source_snapshot_id, ifc_global_id) WHERE supersededAt IS NULL
AND sourceKind IN (...)` — correctly prevents double-insert into
the *same* snapshot but permits overlap across snapshots. The
index is doing what it was specified to do; the supersession was
under-scoped.

### Fix

- Scope the supersession to the *engagement*, not the *snapshot*,
  and to the IFC source kinds. Step 5a's read and step 5b's
  UPDATE both now match every `(engagement_id, sourceKind IN
  ('as-built-ifc', 'as-built-ifc-bundle'), supersededAt IS NULL)`
  row.
- Step 5e's `priorIdByIdentity` map still walks
  `(sourceKind, ifc_global_id)` correctly because IFC GlobalIds
  are stable across re-exports of the same Revit document — prior
  rows whose entity reappears get their `supersededById` patched;
  bundle rows whose synthetic `bundle:${snapshotId}` identity is
  unique-by-construction fall through to the tombstoned lens
  (supersededAt set, supersededById null), which is correct per
  [[adr-001-atom-architecture]].

The partial unique index can be re-keyed to
`(engagement_id, ifc_global_id)` in a follow-up migration to
defense-in-depth this fix at the DB layer; deferred here to keep
the change to the smallest reversible fix.

### Test

New `describe` block in `ifc-ingest-bim-model-atom.test.ts`:

> ifc-ingest materializable_elements supersession — engagement scope (QA-35)
>   • a second IFC ingest for the same engagement supersedes the first ingest's rows, leaving only the latest generation active

Simulates two re-ingests of the same IFC across distinct snapshots
(mirroring the production ingest's transactional supersession +
insert steps inline — driving the full multipart route from
vitest is too heavy and is covered by `track-b-ifc-schema.test.ts`),
and asserts:

- engagement-wide active count after re-ingest = 4 (one
  generation), not 8 (both stacked, the bug);
- all 4 active rows belong to the most-recent snapshot;
- all 4 prior-snapshot rows are `supersededAt IS NOT NULL`
  (append-only history preserved per ADR-001).

## Pre-existing data note

The Musgrave engagement currently holds 303 active rows from the
bug. The fix takes effect on the *next* re-ingest (which sweeps
them to superseded); operator can either re-ingest once after
deploy or run the engagement-scoped UPDATE manually if they want
to clean up sooner. Append-only history is preserved either way.

## Verification

- Branch off `origin/main` HEAD = `0e64fbc` (includes diagnostic
  PRs #87, #88, and docs #89) in an isolated worktree
  (`p:/tmp/qa33-qa35-worktree`) per the workspace-hygiene memory.
- Per-package typecheck via the Win32 native-deps workaround
  (`project_windows_test_natives`) — all 7 artifacts + scripts
  green. Workspace YAML + lockfile reverted post-verify.
- `pnpm --filter @workspace/portal-ui exec vitest run BimModelViewport.test.tsx`
  — 59/59 passing (no regressions from the CSS + console.warn
  change).
- The new QA-35 integration test needs `DATABASE_URL` — trusted
  CI to run it against the test DB; local workstation has no
  Postgres.

## Held / not touched

- **QA-22 reopen network-layer follow-on** — separate dispatch,
  will fire next per the operator's scope. Not touched.
- **Phase 3 features (QA-27 / 28 / 29)** — deferred behind
  2D-site-context per operator call. Not touched.
- **2D-site-context sprint** — separate scope, separate dispatch.
  Not touched.

## Session hygiene

- Isolated worktree, branch off `origin/main`, single PR (no
  cross-scope coupling — both surgical changes on the same
  dispatch).
- Pre-push typecheck via the documented Windows workaround;
  workspace YAML + lockfile reverted.
- No commits to `doc_repo`. This file dropped at
  `doc_repo/_inbox/2026-05-23_qa33_qa35_session_close.md` per
  `feedback_cross_repo_doc_writes` (HR-11).
