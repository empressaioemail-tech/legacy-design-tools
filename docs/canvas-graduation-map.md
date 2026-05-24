# Canvas → SmartCity OS — Graduation Map

A comprehensive record of the mockup-graduation sessions where canvas
designs were promoted into the real `design-tools` app, including the
original requests, the mockups that fed them, the destination
components, and how the platform's tab surface now lays out.

---

## 1. The original requests (in your words)

Across this session and the prior ones, the requests were short and
visual — typically just the name of a canvas mockup, with the implicit
ask "graduate this into the real app". The full sequence:

| # | Your request | What it meant in practice |
|---|---|---|
| 1 | "viewer as hero" | Graduate `snapshot-page/ViewerHero` into the Snapshots tab |
| 2 | "layered cockpit" | Graduate `site-workspace/LayeredCockpit` into the Site tab |
| 3 | "triage inbox" filter chip styling | Restyle the filter-chip rail in `FindingsTab` to match Triage Inbox |
| 4 | "split inbox" | Graduate `review-workspace/SplitInbox` into Findings tab |
| 5 | "launchpad + canvas studio" | Blend two production-workspace mockups into Publish Prep tab |
| 6 | "spec catalog" | Graduate `deliverables-workspace/SpecCatalog` into Product Spec References tab |
| 7 | "showroom" | Graduate `client-portal/Showroom` into Presentations tab |
| 8 | "activity stream" | Graduate `inbox/ActivityStream` into Response Tasks tab |
| 9 | "match the thumbnail closer … follow our token colors" | Tighten the Activity Stream layering using only design-system tokens |

Two additional non-functional guardrails appeared throughout:

- **Tokens only.** Every color must come from `lib/portal-ui/src/styles/smartcity-themes.css` (e.g. `var(--bg-elevated)`, `var(--cyan-text)`, `var(--danger-dim)`). No raw `#hex` or `rgba(...)` literals — even in comments. The architect review enforces this.
- **Preserve the testid contract.** Each destination tab has a Vitest
  + Playwright suite. All existing `data-testid` values, data hooks,
  and behaviour have to keep working bit-for-bit.

---

## 2. What got built — graduation-by-graduation

Each row below summarises the source mockup, the destination tab in
`design-tools`, and the structural moves made.

### 2.1 Snapshots tab ← `snapshot-page/ViewerHero`

- **Destination:** `artifacts/design-tools/src/components/engagement-detail/SnapshotsTab.tsx` (new component; replaced ~138 lines of inline JSX in `EngagementDetail.tsx`).
- **Layout adopted:** KPI strip on top → full-bleed BIM viewport as
  the canvas → collapsible snapshot-detail drawer floating over the
  canvas → bottom horizontal timeline strip of snapshot pills with a
  cyan-glowing selected state.
- **Preserved:** `engagement-snapshot-timeline`, `snapshot-row-{id}`,
  `raw-json-card`, `engagement-kpi-{sheets|rooms|levels|walls}`,
  `snapshots-bim-viewer`, the `useGetEngagement` / `useGetSnapshot` /
  `useEngagementsStore` wiring, and the existing raw-JSON expand
  behaviour.

### 2.2 Site tab ← `site-workspace/LayeredCockpit`

- **Destination:** `engagement-detail/SiteTab.tsx`.
- **Layout adopted:** Three-column cockpit.
  - **Left (280px)** — Layer palette grouped by Base / Local & State
    / Federal / Manual Overlays / Proposed; rows derived from
    `briefing.sources` plus static entries; eye/eye-off toggles are
    local state.
  - **Center** — Full-bleed `SiteMap` with a floating top bar
    (location chip, Generate layers, Refresh, Push to Revit) and
    decorative compass + zoom chrome.
  - **Right (340px)** — Inspector: APN/address identity header, Lot
    Area + Type stat tiles, embedded `ParcelZoningCard`, Active
    Context list (FEMA / USGS / EPA / FCC from `briefing.sources`),
    "Building on this site" Revit Model card linking to Snapshots.
- **Preserved:** `site-tab`, `parcel-zoning-card`,
  `parcel-zoning-card-site-context-link`,
  `parcel-zoning-card-provenance`; new testids added for the new
  surfaces (`site-tab-layer-palette`, `site-tab-inspector`,
  `site-tab-add-layer`, `site-tab-upload-qgis`,
  `site-tab-generate-layers`, `site-tab-refresh`,
  `site-tab-push-revit`).
- **Routed out:** "Add Layer" / "Upload QGIS" / "Push to Revit" /
  "Generate layers" all jump to the existing Site Context tab where
  the real machinery lives — they don't re-implement it.

### 2.3 Findings tab ← `review-workspace/SplitInbox`

- **Destination:** `engagement-detail/FindingsTab.tsx`.
- **Layout adopted:** Split-inbox shell — sticky filter-chip rail
  along the top, finding list on the left, focused finding detail on
  the right. Later (request #3) the filter-chip rail itself was
  restyled to match the Triage Inbox pill design.

### 2.4 Publish Prep tab ← `production-workspace/Launchpad` + `CanvasStudio`

- **Destination:** `engagement-detail/PublishPrepTab.tsx`.
- **Layout adopted:** Blended dashboard.
  - Readiness banner at the top.
  - **2×2 mission deck** (the Launchpad's four tiles) showing
    submission, letters, deliverables, and finalisation status.
  - Right-hand **Mission Control rail** with Canvas-Studio-style
    asset previews so an architect can scrub through the publishable
    artifacts before submitting.
- **Preserved:** Existing readiness/blocker checks, all testids, and
  the publish-trigger mutation.

### 2.5 Product Spec References tab ← `deliverables-workspace/SpecCatalog`

- **Destination:** `engagement-detail/ProductSpecReferencesTab.tsx`.
- **Layout adopted:** Catalog shell — filter bar across the top, AI
  suggestions strip, then the spec catalog table with manufacturer /
  product / detail-usage columns.
- **Preserved:** All data hooks, the spec mutation surface, every
  spec-row and create-dialog testid.

### 2.6 Presentations tab ← `client-portal/Showroom`

- **Destination:** `engagement-detail/PresentationsTab.tsx`.
- **Layout adopted:** Showroom layout.
  - View-mode strip (**Tour / Sheets / Renderings**) with an
    "N new" badge.
  - **Hero pane** with floating view pills and the cyan
    "Generate draft PDF" CTA.
  - Horizontal **Sections rail** with "IN DECK" pins.
  - Vertical **Slide preview list**.
  - Collapsible right-side **Versions drawer** that condenses to
    numbered avatars with an unread dot.
- **Preserved:** All testids, the section-toggle behaviour, the mock
  generate flow.

### 2.7 Response Tasks tab ← `inbox/ActivityStream` (most recent)

- **Destination:** `engagement-detail/ResponseTasksTab.tsx`.
- **Layout adopted:** Channel-style activity feed.
  - **Channel header strip** (sits on `var(--bg-chrome)` after the
    layering refinement) with `#` icon, "Activity" title, a cyan
    "N needs you" unread pill, and the New Response Task primary
    button.
  - **Sub-tab rail** (Activity active with count badge;
    Submissions / Findings / Letters visible but disabled — visual
    only).
  - **Today / Yesterday / Older date dividers** grouping rows by
    `createdAt`.
  - **Feed-card rows** with:
    - Left accent bar coloured by state — `open → danger`,
      `in-progress → cyan`, `done → success`, `cancelled → muted`.
      AI-drafted overrides to cyan.
    - 40px avatar / icon circle — `Sparkles` for AI-drafted, state
      icon (`AlertCircle` / `Clock` / `CheckCircle2` / `XCircle`)
      otherwise.
    - Header line: title + AI-drafted badge + state badge + relative
      time.
    - Description quote-block when present.
    - Meta chip row — Due / Completed / Finding.
    - Action bar — first transition primary, rest ghost.
    - "Reply to this thread…" composer affordance for open /
      in-progress tasks.
- **Preserved:** Every existing testid (`response-tasks-tab-shell`,
  `response-tasks-list`, `response-tasks-loading`,
  `response-tasks-empty`, `response-tasks-new`,
  `response-task-row-{id}`, `response-task-state-badge-{state}`,
  `response-task-{id}-to-{state}`,
  `response-task-{id}-link-toggle`,
  `response-task-{id}-link-input`,
  `response-task-{id}-link-save`,
  `response-task-ai-badge-{id}`, `response-task-due-{id}`,
  `response-task-finding-{id}`, `response-task-{id}-error`, and the
  full `create-response-task-*` family), every data hook
  (`useListResponseTasks`, `useCreateResponseTask`,
  `useUpdateResponseTaskState`, `useLinkResponseTaskFinding`).

### 2.8 Layering refinement (request #9)

After the initial Activity Stream graduation, the row cards looked
flat because they sat inside an outer `sc-card` — card-in-card.
Three token-only adjustments fixed it:

| Surface | Before | After | Token |
|---|---|---|---|
| Outer list container | `sc-card` (`bg-elevated`) | Plain panel | `var(--bg-base)` |
| Channel header strip | `bg-base` | Distinct toolbar | `var(--bg-chrome)` |
| Each task card | `bg-surface` | Floats with shadow | `var(--bg-elevated)` + `var(--depth-inset)` + `var(--depth-shadow-md)` |
| Quote-block & chips (unchanged) | — | — | `var(--bg-base)` + `var(--border-default)` |

The result is the three-layer depth the mockup shows (page → channel
panel → row cards), built entirely from existing tokens.

---

## 3. The mockup ↔ tab map (current state)

```
Canvas mockup                                  Production destination
────────────────────────────────────────────  ──────────────────────────────
snapshot-page/ViewerHero               ───▶  Snapshots tab
site-workspace/LayeredCockpit          ───▶  Site tab
review-workspace/SplitInbox            ───▶  Findings tab
inbox/TriageInbox  (filter chips)      ───▶  Findings tab (filter rail only)
production-workspace/Launchpad     ┐
production-workspace/CanvasStudio  ┴───▶  Publish Prep tab
deliverables-workspace/SpecCatalog     ───▶  Product Spec References tab
client-portal/Showroom                 ───▶  Presentations tab
inbox/ActivityStream                   ───▶  Response Tasks tab
```

Mockups still on the canvas, not yet graduated:

- `design-tools-cockpit/Cockpit` — Command Cockpit shell concept
- `design-tools-workbench/Workbench` — Studio Workbench concept
- `snapshot-page/SummarySplit`, `snapshot-page/StackedFeed`
- `site-workspace/NarrativeBrief`, `site-workspace/StagedFlow`
- `review-workspace/FindingTimeline`, `review-workspace/KanbanBoard`
- `inbox/ActionQueue`
- `production-workspace/StagePipeline`
- `deliverables-workspace/LetterThread`, `PackageBuilder`
- `client-portal/MarkupStudio`, `ReviewStream`

---

## 4. How the engagement page maps now

The engagement-detail shell hasn't moved — the same left views-rail
toggles between tabs, the same right-side Claude chat panel,
the same top-of-page action toolbar (Projects / Edit details /
Archive / Submit to jurisdiction). What's changed is the **body of
each tab**.

```
Engagement detail (Musgrave_Residence_B, Redd, …)
│
├── MODEL & SOURCE
│   ├── Snapshots         ← ViewerHero (KPI strip + full-bleed viewer + timeline)
│   ├── Sheets
│   └── 3D model
│
├── SITE
│   ├── Site              ← LayeredCockpit (palette + map + inspector)
│   └── Site context
│
├── REVIEW
│   ├── Submissions
│   ├── Findings          ← SplitInbox (chip rail + list + detail)
│   └── Response tasks    ← ActivityStream (channel + Today/Older feed cards)
│
├── DELIVERABLES
│   ├── Deliverable letters
│   ├── Detail callouts
│   ├── Product specs     ← SpecCatalog (filter + AI suggestions + table)
│   ├── Design Tools
│   ├── Presentations     ← Showroom (view modes + hero + versions drawer)
│   └── Publish prep      ← Launchpad + CanvasStudio (mission deck + control rail)
│
└── CONFIG
    └── Settings
```

The visual language is now consistent across these tabs:

- **Three-surface depth** — `bg-chrome` for toolbars / headers,
  `bg-base` for panel bodies, `bg-elevated` for floating cards.
- **Coloured left-accent bar** for state-keyed rows (findings,
  response tasks).
- **Cyan accent** (`var(--cyan)` / `var(--cyan-accent-bg)` /
  `var(--cyan-text)`) for primary CTAs, "unread / needs you"
  pills, and AI-drafted markers.
- **State palette**: `danger` → needs attention, `cyan` →
  in-progress, `success` → done, `muted` → cancelled / inert.
- **Today / Yesterday / Older grouping** and **feed-card rows** for
  any time-ordered surface (Response Tasks; pattern reusable for
  future tabs).

---

## 5. Quality gates that ran each turn

For every graduation the same gates were applied:

1. `pnpm --filter @workspace/design-tools run typecheck` — clean.
2. The tab's Vitest spec (e.g. `ResponseTasksTab.test.tsx`,
   9/9 pass) — green.
3. `rg "rgba\(|#[0-9A-Fa-f]{3,8}\b"` against the touched file — no
   new colour literals.
4. App-preview screenshot at 1600×1100 to eyeball the result against
   the source mockup.
5. Architect (code review) pass with `includeGitDiff: true` —
   approved (only flag was a pre-existing dialog scrim rgba in
   `CreateResponseTaskDialog`, untouched per scope).

---

## 6. Open follow-ups (still on the inbox)

- **#534 / #535** — Rails QA cleanup for the views-rail alignment
  and sheets tab; unrelated to the graduation work itself but
  parked in the agent inbox.
- **Dialog scrim token** — `CreateResponseTaskDialog` still uses
  `rgba(0,0,0,0.5)` as its overlay; no scrim token exists in
  `smartcity-themes.css` yet, so adding one is the right unblock.
- **Remaining mockups** — the list in §3 above. The Cockpit and
  Workbench shell mockups are the biggest unshipped pieces; they'd
  reshape the whole engagement-detail chrome rather than a single
  tab, so they're a separate decision.
