---
title: cc-agent-C WS-B session summary (Cortex QA UI/UX cleanup)
date: 2026-05-20
agent: cc-agent-C
repo: legacy-design-tools
kind: session-summary-draft
status: draft (planner relocates to doc_repo _sessions/ with canonical frontmatter)
dispatch: _dispatches/2026-05-20_cc-agent-C_cortex_qa_wsb_ui_cleanup.md
related: [43_cortex_qa_backlog, 2026-05-20_cc-agent-C_wsa_session_summary, 40_design_accelerator]
---

# WS-B session summary — UI and UX cleanup batch

cc-agent-C, `legacy-design-tools`. Covers QA-01, QA-02, QA-11 (page-glitch
portion), QA-12, QA-14. Work is on branch `feat/cortex-qa-wsb`, cut from
`origin/main` `d8f3bef`.

## Stale-checkout correction (read first)

WS-B surfaced that the local checkout was 12 commits behind `origin/main` —
the WS-A turn never ran `git fetch` (an AGENTS.md miss). The missing commits
include PR #43 (the EngagementDetail split WS-B is built on) and PRs #44-46/#51
(the L-surface tabs). The operator directed: re-verify WS-A against
`origin/main`, correct the audit, then do WS-B from `origin/main`.

Done. A fresh branch `feat/cortex-qa-wsb` was cut from `origin/main` `d8f3bef`.
The WS-A `_research` docs were corrected (the WSA.1 "zero MCP integration"
headline was wrong against `origin/main`, which carries the L-surface inbound
service-token bearer path; see the revised audit doc). The WSA.4 `utah.ts` fix
carried over unchanged and still applies. The two pre-existing un-attributed
working-tree changes (`findings.ts`, `track-b-ifc-schema.test.ts`) that were
not WS-A/WS-B work are set aside in `git stash` (`stash@{0}`) and are not on
this branch.

## State per sub-task

| Sub-task | QA item | State |
|---|---|---|
| WSB.1 engagement-detail tab reorg | QA-01 | Fixed |
| WSB.2 archive + collapsible sidebar | QA-02 | Fixed |
| WSB.3 Snapshots tab cleanup | QA-12 | Fixed |
| WSB.4 Deliverable-letters render glitch | QA-11 | Fixed |
| WSB.5 header alert bell | QA-14 | Fixed (wired) + cross-artifact flag |

## WSB.1 — Engagement-detail tab reorganization (FIXED)

A dedicated "3D model" tab was added (`TabId` gains `model-3d` in
`components/engagement-detail/urlState.ts`; deep-link `?tab=model-3d` resolves).
It renders the `BimModelViewport` full-height. The Sheets-tab "View in 3D"
button now opens that tab instead of jumping to Snapshots.

Tab-row crowding: the 13-tab row is grouped into five visual sections with a
thin separator at each boundary, and the row scrolls horizontally rather than
clipping if it cannot fit. The grouping (a single `tabs` config array in
`TabBar`, easy to re-order):

- Model and source: Snapshots, Sheets, 3D model
- Site: Site, Site context
- Review: Submissions, Findings, Response tasks
- Deliverables: Deliverable letters, Detail callouts, Product specs, Renders
- Config: Settings

For operator review (the dispatch asked for this): the lighter-touch grouping
the dispatch recommended was taken, not a heavier merge into ~5 sub-navigated
tabs. If the grouped, horizontally-scrolling 13-tab row still reads as too
long, the next step is an overflow menu for the least-used tabs (Detail
callouts, Product specs are the candidates) — flagged, not done, since the
dispatch said the heavier change is not required.

Files: `components/engagement-detail/urlState.ts`, `pages/EngagementDetail.tsx`.

## WSB.2 — Project archive and sidebar collapse (FIXED)

Archive. The backend already supports it: `PATCH /api/engagements/:id` accepts
`status`, and `UpdateEngagementBody` already enumerates `archived` — so this is
a pure frontend change, no schema, no migration, no codegen. The
archive/unarchive action is an "Archive" / "Unarchive" button on the
EngagementDetail page header (next to "Edit details"), wired to
`useUpdateEngagement`. It is on the detail page rather than the list cards
deliberately: each list card is a single `<Link>`, and nesting an interactive
`<button>` inside an `<a>` is invalid HTML. The EngagementList gained a "Show
archived" filter checkbox mirroring the existing "Show only in-pilot" pattern;
archived projects are hidden by default, with an "N archived hidden" tally in
the header summary.

Sidebar collapse. The left-sidebar nav sections (Workspace, Projects, Dev) are
now collapsible — each group header is a button with a chevron that toggles
its items. Per-group collapsed state is persisted in the existing
`useSidebarState` zustand store (localStorage key `portal-ui:sidebars`),
alongside the width and whole-sidebar-collapsed state, via a new
`collapsedGroups` map plus a `toggleGroup` action. Per-group collapse applies
only while the sidebar is expanded; the icon-rail mode is unchanged.

Files: `pages/EngagementDetail.tsx`, `pages/EngagementList.tsx`,
`lib/portal-ui/src/lib/sidebar-state.ts`,
`lib/portal-ui/src/components/Sidebar.tsx`.

## WSB.3 — Snapshots tab cleanup (FIXED)

Raw snapshot JSON is now collapsed by default (`jsonExpanded` initial state
`false`) and demoted to a secondary card below the model — it was a prominent,
expanded-by-default panel taking the whole right column. The BIM model viewer
is promoted up into that primary column beside the snapshot timeline (it was
at the bottom of the tab, under the JSON). The Snapshots tab now leads with
KPI stats, then [timeline | 3D model], with raw JSON a collapsed card at the
bottom.

Interaction with WSB.1: the BIM viewer appears both on the Snapshots tab
(moved up — QA-12) and on the dedicated 3D model tab (QA-01). It is one shared
JSX panel; tabs render conditionally so only one instance mounts. The
`data-testid="snapshots-bim-viewer"` is retained so the finding-citation
deep-link regression test (`EngagementDetail.test.tsx`) still resolves.

Files: `pages/EngagementDetail.tsx`.

## WSB.4 — Deliverable-letters render glitch (FIXED)

Root cause found. `CreateLetterDialog` — the "New letter" form, a
`position: fixed` modal — was rendered as a DOM child of the tab's
`.sc-card`. `.sc-card` (in `lib/portal-ui/src/styles/smartcity-components.css`)
is `position: relative; overflow: hidden;` and `.sc-card:hover` applies
`transform: translateY(-1px)`. A transformed ancestor becomes the containing
block for `position: fixed` descendants, so on hover the modal stopped being
viewport-positioned and jumped to cover only the card box, clipped by the
card's `overflow: hidden`. That is the "overlapping / clipped" glitch.

Fix. `CreateLetterDialog` now renders through `createPortal(..., document.body)`,
escaping the card's containing block entirely.

Sibling check. The other three L-surface tabs (Response tasks, Detail callouts,
Product specs) use the same `position: fixed` dialog pattern but already render
the dialog as a sibling of the card (fragment return), so they are unaffected.
`DeliverableLettersTab` was the lone outlier; no other tab needed the fix.

Files: `components/engagement-detail/DeliverableLettersTab.tsx`.

## WSB.5 — Header alert bell (FIXED — wired; cross-artifact flag)

A notifications system exists: the `/notifications` Inbox page,
`useListMyNotifications`, and the sidebar Inbox item with an unread badge. The
header bell was a dead `<button>` with no handler.

Fix. The shared `Header` (portal-ui) bell is now prop-driven. `Header` gained
an optional `notifications: { href, unreadCount }` prop, threaded through
`DashboardLayout` as `headerNotifications`. When supplied the bell is a
`wouter` link to that route with an unread-count badge; when not supplied the
bell is not rendered, so there is never a dead control. The design-tools
`AppShell` passes `headerNotifications={{ href: "/notifications", unreadCount }}`
— the bell now opens the Inbox and shows the unread count.

Cross-artifact flag for the planner. `DashboardLayout` / `Header` are also used
by the plan-review artifact (19 direct call sites; plan-review has no shared
AppShell). plan-review does not pass `headerNotifications`, so its header bell
— which was equally dead — no longer renders. Removing a dead control is
consistent with the dispatch ("do not leave a dead control"), but it is a
visible change to the reviewer surface, which is outside WS-B's architect-QA
scope. If plan-review wants a working bell (e.g. pointed at the reviewer
queue), it passes `headerNotifications` on its `DashboardLayout` calls. This is
a small, separate scoping decision — flagged, not actioned here.

Files: `lib/portal-ui/src/components/Header.tsx`,
`lib/portal-ui/src/components/DashboardLayout.tsx`,
`components/AppShell.tsx`.

## Verification

`pnpm run typecheck` (the CI Typecheck-job command — per-artifact
`tsc -p X --noEmit` plus `tsc --build` for libs) passes clean across all six
artifacts and the lib graph.

The Windows vitest suite was not run locally: it requires the lockfile-mutation
native-deps workaround, which risks contaminating this change set. Instead all
five affected test files were traced by hand against the changes —
`EngagementDetail.test.tsx`, `EngagementList.test.tsx`, `Header.test.tsx`,
`sidebar-state.test.ts`, `DeliverableLettersTab.test.tsx` — and every asserted
behavior is preserved: tab order (Submissions→Findings adjacency, Renders and
Settings after) survives the new `model-3d` tab and the non-button group
separators; the `snapshots-bim-viewer` deep-link target stays on the Snapshots
tab; the EngagementList fixtures are all `status: "active"` so the new
"Show archived" filter hides nothing; the `Header` test renders without the
`notifications` prop so the bell is absent; the `sidebar-state` additions are
purely additive; the portaled `CreateLetterDialog` is still found by
`screen.getByTestId` (testing-library queries all of `document.body`). CI
(Linux) runs the full suite on the PR.

## Branch and commit state

Branch `feat/cortex-qa-wsb` off `origin/main` `d8f3bef`. Carries the WS-A
deliverables (the `utah.ts` ugrc:dem fix, the two corrected `_research` docs)
plus all WS-B changes. Not pushed — the operator coordinates push / PR per
AGENTS.md. The pre-existing un-attributed `findings.ts` /
`track-b-ifc-schema.test.ts` working-tree changes are preserved in
`git stash@{0}` and are deliberately not on this branch.

## Backlog status the planner should set

- QA-01: dedicated 3D model tab added; tab row grouped + scrollable. Overflow
  menu for least-used tabs is an optional follow-up if the row still reads long.
- QA-02: archive (detail-page action + list filter, FE-only) and collapsible
  persisted sidebar sections both shipped.
- QA-11 (page-glitch portion): Deliverable-letters New-letter modal fixed
  (portal). The push-to-response-task / push-from-chat portion remains WS-C.
- QA-12: Snapshots tab — JSON collapsed/demoted, model promoted.
- QA-14: header bell wired to the Inbox on the architect surface; plan-review's
  dead bell is now hidden, with a flagged opt-in path.
