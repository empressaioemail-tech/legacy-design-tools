# Wave 2 Sprint D — Phase 1 Recon: Reviewer Graph Navigation + Stale-Data Requests

**Status:** Read-only recon. No code changes in this phase.
**Owner of follow-up:** Empressa, to approve the Phase 2 entry plan below.
**Phase 2 gate:** Held until **Sprints A and B are merged on origin/main**
(per task §2). The recon report itself can land independently for review.
**Date of recon sweep:** May 1, 2026 — citations are file:line against
the working tree as of this sweep.

---

## 0. TL;DR (read this first)

1. **There is no architect-side "atom-graph navigator" today.** Drill-through
   from one atom render to a related one is implemented ad hoc on three
   separate surfaces (DevAtoms inline aside, snapshot focus chips → compare
   route, code atom pills → Code Library route). All three are deep-linkable
   but use different URL shapes. Nothing is a reusable navigation primitive.
   Citations: §1.

2. **The "side panel stack" mechanism referenced by Spec 20 §5 does not exist
   on origin/main.** Closest analogues are `DashboardLayout`'s single
   optional right panel (no stack), `ReviewerAnnotationPanel`'s right
   side-sheet, and `BriefingDivergenceDetailDialog`'s centered modal — all
   single-frame, no push/pop. **Recommendation:** ship a small portal-ui
   `AtomDrillStack` primitive — one right side-sheet whose visible content
   is the top of a URL-encoded stack of atom references, rather than the
   multi-pane / multi-window stack Spec 20 §5 implies. Citations and
   rationale: §2.

3. **There is no unified "engagement events timeline" component on either
   the architect or reviewer side.** The architect surface has three
   parallel surfaces (snapshots timeline, submissions list, BriefingRecentRunsPanel)
   keyed off domain shape rather than a generic `event.type` switch.
   This contradicts the task's "Architect's UI picks up the request events
   via existing timeline rendering — no new architect-side component code"
   line and is the **single biggest recon flag for Empressa**. Phase 2
   either ships one small new component (a "Reviewer requests" strip on
   the engagement detail page) or shoehorns the new event rows into the
   BriefingRecentRunsPanel. Recon recommends the small new strip.
   Citations and rationale: §6.

4. **Six new event types, scoped to a new `reviewer-request` atom**
   (parallel to `reviewer-annotation`). Three `*.requested` types named in
   the task spec, three `*.dismissed` (also named in the spec), plus three
   `*.honored` recommended by recon for timeline symmetry. The action that
   honor fires (e.g. `briefing-source.refreshed`) emits its own existing
   event as a third linked row. Endpoint shape: three per-target POSTs
   plus `POST /api/reviewer-requests/:id/{honor,dismiss}`. Citations and
   rationale: §3, §4.

5. **No new server actor IDs strictly required.** Reviewer request,
   architect honor, and architect dismiss all attribute to
   `actor.kind = "user"` via `actorFromRequest()`, matching the
   reviewer-annotations precedent. Two optional fallback actor IDs
   recommended for system-attributed honor/dismiss queue jobs in a
   future sprint. Citations: §5.

6. **The Phase 2 plan ships ~9 new code units** (one new atom, one new
   table + migration, six new endpoints, one OpenAPI block, one portal-ui
   navigation primitive, two reviewer-side dialogs, one architect timeline
   strip, two e2e specs). Estimated work: small-to-medium for an LLM-driven
   sprint. Citations: §8.

---

## 1. Architect-side atom-graph navigation — current state

Recon goal (task step §1): inventory how the architect's UI walks from
one atom render to a related atom. URL pattern, hook patterns, deep-link
conventions. Cite file:line.

### 1.1 Findings

There is **no single navigation primitive**. Three independent patterns coexist:

#### Pattern A — Inline aside on a single route
Used by `DevAtoms` (`/dev/atoms`).

- Row-click sets `activeAtomId` (React state).
  - `artifacts/design-tools/src/pages/DevAtoms.tsx` — `<tr onClick={() => setActiveAtomId(a.id)}>`.
- Right-hand `<aside>` re-renders against `activeAtomId`; no route transition.
- URL state is **list filters only** (jurisdictionKey, embedded, q, offset);
  the selected detail atom is **not** in the URL.
- Updates URL via `window.history.replaceState` to avoid polluting back-button
  history (`writeFiltersToUrl` in the same file).

`DevAtomsProbe.tsx` is similar — probe inputs in URL, results not
clickable into atom detail.

**Implication for Sprint D:** Pattern A is unsuitable for reviewer
graph nav because it is not URL-deep-linkable and does not generalize
across pages.

#### Pattern B — Full-route deep-link via query string
Used by snapshot focus chips and code atom pills (the only existing
"go to a related atom view" affordances on the architect side).

- **Snapshot focus chip** (`{{atom|snapshot|<id>|focus}}` token):
  - Token regex: `SNAPSHOT_FOCUS_TOKEN_RE` —
    `artifacts/design-tools/src/components/atomChips.tsx:26-35`.
  - URL builder: `buildSnapshotChipHref()` —
    `artifacts/design-tools/src/components/atomChips.tsx:69-87`.
  - Shape: `/engagements/<engagementId>/compare?a=<snapshotId>&b=<otherSnapshotId>`
    (when comparing) or `/engagements/<engagementId>` (otherwise).
  - Click target: `<a href=…>` inside `SnapshotFocusChip` —
    `artifacts/design-tools/src/components/atomChips.tsx:110-154`.

- **Code atom pill** (`[[CODE:<atomId>]]` token):
  - Token regex: `ATOM_TOKEN_RE` —
    `artifacts/design-tools/src/components/atomChips.tsx:18-23`.
  - URL builder lives in portal-ui: `${codeLibraryBase}?atom=<atomId>` —
    `lib/portal-ui/src/components/CodeAtomPill.tsx:24-31`.
  - Reader: `readAtomFromHash()` (despite the name, reads `?atom=` from
    `window.location.search`) — `artifacts/design-tools/src/pages/CodeLibrary.tsx:29-32, 60-62`.
  - Reader hooks `useGetCodeAtom(activeAtomId, …)` to fetch the atom
    body — `artifacts/design-tools/src/pages/CodeLibrary.tsx:81-89`.

**Implication for Sprint D:** Pattern B is the only existing
URL-deep-linkable pattern, but it requires a destination route per atom
type. Reviewer nav needs to address ~7 atom types from the engagement
page; building 7 new routes plus a router glue per type is heavy.

#### Pattern C — Same-page jump-and-scroll
Used by briefing-source citation pills inside narrative text.

- `EngagementDetail` passes `onJumpToSource` into the shared renderer —
  `artifacts/design-tools/src/pages/EngagementDetail.tsx:3130-3134, 4430-4445`.
- Pill `<button onClick={() => onJump(sourceId)}>` —
  `lib/portal-ui/src/components/briefingCitations.tsx:44-83`.
- Helper: `scrollToBriefingSource(id)` looks up
  `[data-testid="briefing-source-${sourceId}"]` and `scrollIntoView()` —
  `lib/portal-ui/src/components/briefingCitations.tsx:238-246`.

**Implication for Sprint D:** Pattern C works inside one page, no URL
state, no cross-page nav. Useful for reviewer nav within the
SubmissionDetailModal but not for the full chain.

#### Pattern D — Modal/side-sheet with URL deep-link state (closest to "navigation")
Used by `ReviewerAnnotationPanel` (Sprint C output, in working tree).

- Hash-format deep-link: `#annotation=<id>&submission=<id>&targetType=<type>&target=<id>` —
  `artifacts/plan-review/src/pages/EngagementDetail.tsx:198-222`.
- Closed enum of target types matches the atom types Sprint D needs to
  walk: `submission`, `briefing-source`, `materializable-element`,
  `briefing-divergence`, `sheet`, `parcel-briefing` —
  `artifacts/plan-review/src/pages/EngagementDetail.tsx:140-147`.
- Side-sheet panel itself: `lib/portal-ui/src/components/ReviewerAnnotationPanel.tsx:55-74, 94-103, 227-271`.

**Implication for Sprint D:** Pattern D is the **closest existing
analogue** to what Sprint D needs. The hash-format already addresses a
target tuple `(submissionId, targetType, targetEntityId)`. Sprint D's
"AtomDrillStack" can extend this convention to a stack of tuples.

### 1.2 URL convention summary

All four patterns share these conventions where they touch the URL:

- `URLSearchParams` over `window.location.search` for query state.
- `URLSearchParams` over `window.location.hash` (after stripping `#`)
  for in-page anchors and cross-modal target tuples (Pattern D, plus
  divergence row anchors in `BriefingDivergenceRow.tsx:65-70, 182-187`).
- `window.history.replaceState` rather than `pushState` to avoid
  polluting the back button on tab switches and filter toggles.
- SSR-safe guards (`if (typeof window === "undefined") return …`) and
  closed-enum allow-lists for any value the URL feeds back into state
  (so a hand-edited `?tab=…` cannot crash the page).

These are the conventions the Phase 2 navigation primitive will mirror.

### 1.3 Hook patterns
None of the patterns above are wrapped in a reusable hook today. The
URL read/write is inline in each page (e.g., `readTabFromUrl` /
`writeTabToUrl` in `artifacts/design-tools/src/pages/EngagementDetail.tsx:205-242`,
mirrored verbatim in plan-review's `EngagementDetail.tsx`). Sprint D
will introduce the first reusable navigation hook in portal-ui.

---

## 2. "Side panel stack" mechanism — Spec 20 §5

Recon goal (task step §1): verify the implementation status of the
"open in side panel" stack mechanism referenced in Spec 20 §5. If it
does not exist on origin/main, propose either a lighter wrapper or a
portal-ui home for it.

### 2.1 Finding: it does not exist

A repo-wide search for `side panel stack`, `side-panel stack`,
`SidePanelStack`, `AtomStack`, `panel.push` returned zero hits. Spec 20
itself is not in this repo (the only Spec 20 reference encountered was
in `lib/empressa-atom/README.md` discussing render modes, which §5 is
about — not navigation).

The closest existing primitives are:

| Primitive                                    | What it does                                                              | Stackable? |
|----------------------------------------------|---------------------------------------------------------------------------|------------|
| `DashboardLayout` right panel                | Single optional right column; collapse via zustand `rightCollapsed`       | No         |
| `ReviewerAnnotationPanel`                    | Right side-sheet for one (submission, target tuple); URL-hash deep-link   | No         |
| `BriefingDivergenceDetailDialog`             | Centered backdrop dialog for one divergence                               | No         |
| `SubmitToJurisdictionDialog`                 | Centered backdrop dialog                                                  | No         |
| `SubmissionDetailModal`                      | Centered modal with `?submission=&tab=&finding=` deep-link                | No         |
| `useSidebarState` (zustand)                  | Persisted left/right collapse only                                        | n/a        |

Citations:
- `lib/portal-ui/src/components/DashboardLayout.tsx:6-87, 25-27, 66-84`.
- `lib/portal-ui/src/components/ReviewerAnnotationPanel.tsx:55-74, 94-103, 227-271`.
- `lib/portal-ui/src/components/BriefingDivergenceDetailDialog.tsx:11-18, 72-103, 322-375`.
- `lib/portal-ui/src/components/SubmitToJurisdictionDialog.tsx:13-28, 75-76, 90-118`.
- `lib/portal-ui/src/lib/sidebar-state.ts:4-34`.

### 2.2 Recommendation: ship `AtomDrillStack` in portal-ui

Rather than building the full multi-pane stack Spec 20 §5 implies (which
would require a new layout system, a panel-manager context, focus rings,
and width tokens that don't exist today), recon recommends a **single
right side-sheet whose visible body is the head of a URL-encoded stack of
atom references.** Push/pop via "Open" / "Back" buttons inside the
side-sheet header. The full stack is encoded in the URL query so a
deep-link round-trips the entire breadcrumb.

**Shape:**

```
GET /engagements/<id>?atomStack=<encoded-stack>

encoded-stack ::= "<atomRef>;<atomRef>;…"
atomRef       ::= "<entityType>:<entityId>"
                  // matches the canonical AtomReference shape used by
                  // the atom registry (see lib/empressa-atom/src/registration.ts).
```

`encodeURIComponent` on each segment so colons in entity IDs (none today,
but this is the registry's contract) survive. The visible side-sheet
renders the **last** segment; "Back" pops the last segment and
`replaceState`s the URL; clicking a child reference inside the visible
atom view pushes a new segment via `replaceState`.

**Why a stack rather than just one segment:**
- The task's concrete navigation paths walk up to seven hops
  (submission → bim-model → divergence → materializable-element →
  briefing-source → parcel-briefing → engagement). A single-segment
  side-sheet forces a chain of "open new panel + close old" calls that
  loses breadcrumb context.
- A stack matches the architect's mental model of "I came from there,
  let me jump back."
- URL-encoding the stack means a reviewer can drop the link in chat and
  the recipient lands on the same view with the same breadcrumb.

**Why one side-sheet (not multi-pane):**
- The existing portal-ui idiom is single side-sheet + dashboard chrome
  (`ReviewerAnnotationPanel`, `BriefingDivergenceDetailDialog`). Adding a
  second co-resident panel would force a layout reflow for the
  underlying page that nothing else needs today.
- A multi-pane stack would also require new design tokens (panel
  widths, gutter, focus order, collapse rules) that are out of scope
  for a navigation sprint.
- Phase 2 can ship the single side-sheet now; multi-pane can land later
  without breaking the URL contract because the URL only encodes the
  stack contents, not the pane layout.

**Where it lives:**
- `lib/portal-ui/src/components/AtomDrillStack.tsx` (new component,
  modeled on `ReviewerAnnotationPanel`'s right-side-sheet structure
  with header / scrollable body / Close).
- `lib/portal-ui/src/lib/atom-stack-url.ts` (new helpers — encode,
  decode, push, pop, top, length — pure functions, fully unit-testable).
- `lib/portal-ui/src/lib/use-atom-drill-stack.ts` (new hook — wraps
  the URL helpers behind `useState` + `useEffect` mirroring the
  `useTabState`-style pattern already used inline in `EngagementDetail`).

**Re-export from the design-tools side:** the existing snapshot focus
chip and code atom pill stay on Pattern B (full route deep-link); they
do not need to switch to the stack. The architect picks up the new
primitive only in places where reviewer nav needs it (per the task,
"isomorphic with architect navigation where the action is symmetrical"
— the code atom pill's destination is a separate "/code-library" route
and there is no symmetrical reviewer action there).

### 2.3 What the side-sheet renders

The body of the side-sheet renders the atom by entity type, looked up
through a small per-type registry (modeled on the API server's atom
registry, but client-side and render-only):

```ts
const ATOM_VIEW_REGISTRY: Record<string, AtomViewComponent> = {
  "submission": SubmissionAtomView,
  "bim-model": BimModelAtomView,
  "briefing-divergence": BriefingDivergenceAtomView,
  "materializable-element": MaterializableElementAtomView,
  "briefing-source": BriefingSourceAtomView,
  "parcel-briefing": ParcelBriefingAtomView,
  "engagement": EngagementAtomView,
};
```

Most of these views already exist in pieces today (
`BriefingSourceDetails`, `BriefingDivergenceRow` / `…DetailDialog`,
the materializable elements list inside `BimModelTab`, etc.). The
Sprint D scope is to thin-wrap them so each accepts `(entityType, entityId)`,
fetches the atom via the existing per-type hooks
(`useGetEngagementBimModel`, `useGetEngagement`, etc.), and renders
the same body the parent surface already renders, plus a strip of
"Drill into" buttons for each composed child / known ancestor.

Composed children to render as drill targets come from the atom
registry's composition declaration
(`lib/empressa-atom/src/composition.ts:14-63` and the per-atom
registrations in `artifacts/api-server/src/atoms/*.atom.ts`). A few
ancestors that aren't in the composition map (e.g., "this
briefing-source is used by these materializable-elements") need a new
read-only API endpoint — see §4.4.

---

## 3. Reviewer-request event vocabulary plan

Recon goal (task step §1): plan the three reviewer-request event
types in the event vocabulary, plan the three dismissal event types.

### 3.1 Existing event-vocabulary pattern

Event vocab lives **per atom** as a `*_EVENT_TYPES` `as const` array,
re-exported and registered into the atom in `registry.ts`. Existing
event vocabularies inventoried (cited file:line in §3.2):

- `engagement.*`: created, address-updated, jurisdiction-resolved,
  snapshot-received, submitted (5 types).
- `submission.*`: see `submission.atom.ts`.
- `snapshot.*`: created, sheets_attached, replaced (3 types).
- `sheet.*`: created, updated, removed (3 types).
- `parcel-briefing.*`: requested, generated, materialized-revit,
  regenerated, exported (5 types).
- `briefing-source.*`: fetched, refreshed (2 types).
- `materializable-element.*`: identified, materialized, emitted,
  refreshed (4 types).
- `briefing-divergence.*`: recorded, resolved (2 types).
- `bim-model.*`: materialized, refreshed, diverged, divergence-resolved (4 types).
- `reviewer-annotation.*`: created, replied, promoted (3 types).
- `intent.*`, `neighboring-context.*`, `viewpoint-render.*`,
  `render-output.*`: each declared in their own `*.atom.ts`.

A repo-wide search for `reviewer-request` returned **zero existing
hits** — this is a brand-new vocabulary and a brand-new entity type.

### 3.2 Recommendation: new `reviewer-request` atom (parallel to `reviewer-annotation`)

The cleanest fit is a new top-level atom type, modeled directly on
`reviewer-annotation`:

- `artifacts/api-server/src/atoms/reviewer-request.atom.ts` (new).
- `lib/db/src/schema/reviewerRequests.ts` (new — see §3.3).
- Registered in `artifacts/api-server/src/atoms/registry.ts` after the
  reviewer-annotation registration (`registry.ts:175`), so the boot-log
  tail surfaces both reviewer-side atoms together.

Reasons not to bolt this onto an existing atom:

- The request is **not** scoped to one target atom — three target kinds
  (briefing-source, bim-model, parcel-briefing) need uniform shape.
- The request has its own lifecycle (pending → honored / dismissed)
  that doesn't fit any existing atom's payload.
- Reviewer-annotation's polymorphic-target pattern is the closest
  precedent — and it shipped as its own atom rather than as a column on
  another atom. Consistency wins here.

### 3.3 Event types — final list

Six required by the spec; three additional `*.honored` recommended by
recon for symmetry (so the timeline can render "request → honor →
action" as three linked rows instead of "request → action" with
implicit honor).

```ts
// artifacts/api-server/src/atoms/reviewer-request.atom.ts
export const REVIEWER_REQUEST_EVENT_TYPES = [
  // Spec-named (3): reviewer fires
  "reviewer-request.refresh-briefing-source.requested",
  "reviewer-request.refresh-bim-model.requested",
  "reviewer-request.regenerate-briefing.requested",

  // Recon-recommended (3): architect honors → emits this *first*,
  // then fires the existing action (briefing-source.refreshed,
  // bim-model.refreshed, parcel-briefing.regenerated) which emits
  // its own existing event as the third linked row.
  "reviewer-request.refresh-briefing-source.honored",
  "reviewer-request.refresh-bim-model.honored",
  "reviewer-request.regenerate-briefing.honored",

  // Spec-named (3): architect dismisses with reason
  "reviewer-request.refresh-briefing-source.dismissed",
  "reviewer-request.refresh-bim-model.dismissed",
  "reviewer-request.regenerate-briefing.dismissed",
] as const;
```

**Decision recon flags for Empressa:** the task spec says "Honor fires
the corresponding action ... and emits a follow-up event linking back
to the originating request." It does NOT explicitly name the follow-up
event. Two readable interpretations:

- **Recon's preferred reading (above):** emit a dedicated `*.honored`
  event so the linkage is explicit and the timeline always shows
  "honored" as a distinct row.
- **Alternative reading:** the existing action event (e.g.,
  `briefing-source.refreshed`) carries `reviewerRequestId` in its
  payload; no new `*.honored` events. This is leaner (3 fewer types)
  but couples the action emitters to the reviewer-request schema and
  hides the honor moment from queries that filter by event-type prefix.

Recon recommends the explicit `*.honored` shape. Empressa to confirm
before Phase 2.

### 3.4 Event payload shape

Per `EventAnchoringService.appendEvent` precedent
(`artifacts/api-server/src/routes/reviewerAnnotations.ts:189-228`),
each event carries `entityType: "reviewer-request"`, `entityId: <id>`,
`eventType`, `actor`, and a typed `payload`.

```ts
// .requested payload
{
  engagementId: string;
  requestKind: "refresh-briefing-source" | "refresh-bim-model" | "regenerate-briefing";
  targetEntityType: string;   // "briefing-source" | "bim-model" | "parcel-briefing"
  targetEntityId: string;
  reason: string;             // free text, server-validated, length-capped
}

// .honored payload (mirrors .requested + adds resolution attribution)
{
  engagementId: string;
  requestKind: …;
  targetEntityType: string;
  targetEntityId: string;
  honoredAt: string;          // ISO
  // Optional: id of the action event the architect's honor fired
  // (e.g. the briefing-source.refreshed event id), for traceability.
  triggeredActionEventId?: string;
}

// .dismissed payload
{
  engagementId: string;
  requestKind: …;
  targetEntityType: string;
  targetEntityId: string;
  dismissedAt: string;        // ISO
  dismissalReason: string;    // free text, server-validated, length-capped
}
```

### 3.5 DB schema — new table

```ts
// lib/db/src/schema/reviewerRequests.ts
reviewer_requests {
  id: uuid PK
  engagement_id: uuid FK → engagements(id)
  request_kind: text NOT NULL
                CHECK request_kind IN ('refresh-briefing-source',
                                       'refresh-bim-model',
                                       'regenerate-briefing')
  target_entity_type: text NOT NULL
  target_entity_id: text NOT NULL
  reason: text NOT NULL                 -- length cap enforced in route
  status: text NOT NULL DEFAULT 'pending'
          CHECK status IN ('pending','honored','dismissed')
  requested_by_id: text NOT NULL        -- session.requestor.id
  resolved_by_id: text NULL             -- set on honor or dismiss
  resolved_at: timestamptz NULL
  dismissal_reason: text NULL           -- only set on .dismissed
  triggered_action_event_id: text NULL  -- only set on .honored
  created_at: timestamptz DEFAULT now()
  updated_at: timestamptz DEFAULT now()
}
```

Indexes:
- `(engagement_id, status)` so the architect-side strip can
  list-pending in O(log n).
- `(target_entity_type, target_entity_id)` so the reviewer-side
  affordance can ask "is there already an open request against this
  target?" (avoids spam).
- `(requested_by_id, created_at desc)` — optional; useful for a
  future "my open requests" screen, polish-later.

The migration follows the same shape as
`lib/db/src/schema/reviewerAnnotations.ts` (the closest precedent —
it has the same enum-over-text pattern, the same `*_at` timestamps,
the same FK to engagements via the join target).

---

## 4. Endpoint shape plan

Recon goal (task step §5 plan + §1 "recon recommends shape"): plan the
endpoint surface for reviewer-request creation and architect resolution.

### 4.1 Recommendation: per-target POST, plus per-id resolve

Five endpoints total:

```
POST /api/engagements/:id/reviewer-requests/refresh-briefing-source
  body:    { briefingSourceId: string, reason: string }
  emits:   reviewer-request.refresh-briefing-source.requested
  returns: { request: ReviewerRequest }

POST /api/engagements/:id/reviewer-requests/refresh-bim-model
  body:    { bimModelId: string, reason: string }
  emits:   reviewer-request.refresh-bim-model.requested
  returns: { request: ReviewerRequest }

POST /api/engagements/:id/reviewer-requests/regenerate-briefing
  body:    { briefingId: string, reason: string }
  emits:   reviewer-request.regenerate-briefing.requested
  returns: { request: ReviewerRequest }

POST /api/reviewer-requests/:id/honor
  body:    {}
  emits:   reviewer-request.<kind>.honored, then fires the existing
           refresh/regenerate action which emits its own existing event
  returns: { request: ReviewerRequest, triggeredActionEventId: string }

POST /api/reviewer-requests/:id/dismiss
  body:    { dismissalReason: string }
  emits:   reviewer-request.<kind>.dismissed
  returns: { request: ReviewerRequest }

GET /api/engagements/:id/reviewer-requests
  query:   ?status=pending|honored|dismissed (optional)
  returns: { requests: ReviewerRequest[] }
```

### 4.2 Why three POSTs instead of one polymorphic

The spec leaves this to recon ("a `POST /api/engagements/:id/reviewer-requests`
endpoint (or per-target equivalents — recon recommends shape)").

Recon recommends per-target because:

- **OpenAPI schema clarity.** A polymorphic body needs a discriminated
  union (`requestKind` + `targetEntityId` shaped per-kind), which
  Orval emits as a less-ergonomic union type. Three named bodies
  (`RequestRefreshBriefingSourceBody`, `RequestRefreshBimModelBody`,
  `RequestRegenerateBriefingBody`) generate three crisp React Query
  hooks the FE can dial into directly.
- **Validation locality.** Each route can validate its target id
  against its target table (`briefing_sources`, `bim_models`,
  `parcel_briefings`) without a server-side `switch (requestKind)`.
- **Telemetry / log readability.** Per-route logging shows which
  request kind is being created without parsing the body.
- **Cost.** Three small route handlers vs. one larger one — same
  total lines of code.

### 4.3 Auth pattern

- Create endpoints: `requireReviewerAudience(req, res)` (mirrors
  `artifacts/api-server/src/routes/reviewerAnnotations.ts:108-114, 285-289`).
- Honor / dismiss endpoints: `requireArchitectAudience(req, res)`
  (mirrors `artifacts/api-server/src/routes/bimModels.ts:466-472, 1163-1167`).
- List endpoint: open to both audiences (reviewer wants to see their
  open requests; architect wants the pending queue).

Both audience helpers gate on `req.session.audience`. There is no new
permission gate to add.

### 4.4 Read endpoint for "ancestors" — separate concern

The "briefing-source → all materializable-elements that use it"
navigation path (task §"Done looks like" bullet 3) needs a server
read endpoint that doesn't exist today. A briefing-source row in
`materializable_elements` is referenced only as a foreign key — the
reverse query (given a briefing-source id, list elements) is what's
needed.

```
GET /api/briefing-sources/:id/materializable-elements
  returns: { elements: MaterializableElementSummary[] }
```

This is **not** a reviewer-request endpoint — it's part of Phase 2's
graph-nav wiring (task step §4 "Wire reviewer-side navigation"). Recon
flags it here so it's not forgotten when Phase 2 lands. Adding it is
straightforward: select on `materializable_elements.briefing_source_id`
filtered by an engagement scope guard, return the existing
`MaterializableElementSummary` wire shape. No new schema.

### 4.5 OpenAPI placement

All five new endpoints + the read endpoint go into
`lib/api-spec/openapi.yaml` under `paths:` (the file's `paths:` block
starts at line 33 per recon). Request/response schemas go under
`#/components/schemas/*`, mirroring the precedents:

- `CreateReviewerAnnotationBody` at `lib/api-spec/openapi.yaml:5485-5512`.
- `ResolveBimModelDivergenceResponse` at `lib/api-spec/openapi.yaml:5379-5391`.

Codegen runs via `pnpm --filter @workspace/api-spec run codegen` and
emits typed React Query hooks the FE will use directly. No follow-up
`typecheck:libs` needed (per pnpm-workspace skill).

---

## 5. actorLabel — friendly labelling plan

Recon goal (task step §1): plan the architect-side timeline rendering
using the existing actorLabel infrastructure (no new architect-side
components — see §6 for the recon flag on this).

### 5.1 No new server actor IDs strictly required

`actorFromRequest()` resolves to `{ kind: requestor.kind, id: requestor.id }`
when a session-bound requestor exists, and falls back to a system
actor otherwise — `artifacts/api-server/src/routes/reviewerAnnotations.ts:136-145`.

For reviewer-request endpoints:

- **Reviewer-fired request:** session always has a requestor (audience
  gate is `internal`); attribution is `actor.kind = "user"` with the
  reviewer's profile id.
- **Architect honor / dismiss:** same — `actor.kind = "user"` with
  the architect's profile id.

No new `SERVER_ACTOR_IDS` entry is required for the routes themselves.
The `formatActorLabel` helper at
`lib/portal-ui/src/lib/actorLabel.ts:91-111` already handles the
`user` case (uses `displayName` with a fallback to raw `id`).

### 5.2 Optional fallback actor IDs (recommended for symmetry only)

Two optional new server actor IDs would mirror the reviewer-annotation
fallback pattern (so a future queue-job or admin tool that resolves a
request without a session has a stable system attribution):

- `REVIEWER_REQUEST_HONOR_ACTOR_ID = "reviewer-request-honor"`
  → friendly: "Reviewer request honor"
- `REVIEWER_REQUEST_DISMISS_ACTOR_ID = "reviewer-request-dismiss"`
  → friendly: "Reviewer request dismissal"

Both would land in:
- `lib/server-actor-ids/src/index.ts` (new constants + add to
  `SERVER_ACTOR_IDS`).
- `lib/portal-ui/src/lib/actorLabel.ts:43-66` (new `FRIENDLY_AGENT_LABELS`
  entries — the test at
  `artifacts/design-tools/src/lib/__tests__/actorLabel.test.ts:96-111`
  is a tripwire that fails if a `SERVER_ACTOR_IDS` entry is missing
  from the friendly-label map, so both files must be updated together).

Empressa to confirm whether the optional fallback IDs are wanted in
this sprint or deferred (recon's preference is to ship them now since
they cost almost nothing and the symmetry with reviewer-annotation
keeps the contributor mental model clean).

### 5.3 Where the labels surface

The label appears as `by {formatActorLabel(matched.actor)}` next to
each timeline row, mirroring
`artifacts/design-tools/src/components/SubmissionDetailModal.tsx:543-590`.
This is the existing "no new architect-side component code" promise
the task makes — provided §6 lands.

---

## 6. Architect-side engagement timeline — the critical recon flag

Recon goal (task step §1): plan the architect-side timeline rendering
using the existing actorLabel infrastructure (no new architect-side
components).

### 6.1 Finding: there is no unified engagement-events timeline today

The architect surface (`artifacts/design-tools/src/pages/EngagementDetail.tsx`)
splits "history-like" content across three independent surfaces, each
with its own row component and none keyed off a generic `event.type`:

- **Snapshots timeline** — `data-testid="engagement-snapshot-timeline"`
  at `artifacts/design-tools/src/pages/EngagementDetail.tsx:6320-6322`.
  Inline `snapshots.map(s => …)`; rows are `snapshot-row-${s.id}`.
  Renders snapshot ingest rows only.
- **Submissions list** — `<SubmissionsTab .../>` at
  `artifacts/design-tools/src/pages/EngagementDetail.tsx:6425-6432`.
  Renders submission rows only.
- **Briefing recent runs** — `<BriefingRecentRunsPanel .../>`
  (`lib/portal-ui/src/components/BriefingRecentRunsPanel.tsx`).
  Renders briefing-generation runs keyed by `run.generationId` and
  `run.state` (failed / completed / pending), not by `event.type`.

There is no place a `reviewer-request.refresh-briefing-source.requested`
event row would surface today. There is no per-engagement
`useListEngagementEvents` hook. The `useGetSnapshot` /
`useListEngagementSubmissions` / `useListEngagementBriefingGenerationRuns`
hooks each scope to their domain.

### 6.2 The contradiction with the task spec

The task says:

> Architect's UI picks up the request events via existing timeline
> rendering — no new architect-side component code, just friendly
> labels via the actorLabel system from #283.

But there is no such timeline rendering surface to pick the events up.

### 6.3 Recommendation: ship one small new architect strip

Recon recommends shipping a **single small new component** on the
architect's `EngagementDetail`: `ReviewerRequestsStrip`. It lives
above the briefing recent runs panel (or wherever Empressa thinks is
most reviewer-architect-handoff-shaped), fetches via the new
`GET /api/engagements/:id/reviewer-requests?status=pending` endpoint,
and renders one row per pending request with two buttons:
"Honor" (POSTs `/honor`, no further input) and "Dismiss"
(opens a small dialog to capture `dismissalReason`, then POSTs
`/dismiss`). Honored / dismissed requests then surface in the
existing `BriefingRecentRunsPanel`-style disclosure under "Resolved
requests" (or in the engagement event history once that's built).

Estimated size: ~150 lines of new TSX + tests, comparable to
`SubmissionRecordedBanner` or the in-page snapshot row.

### 6.4 Why not shoehorn into BriefingRecentRunsPanel

- That panel keys off `briefing_generation_runs`, not
  `reviewer_requests` — the data shape doesn't match.
- A reviewer request to refresh a `bim-model` does not belong inside
  a "briefing runs" panel.
- The panel's filter chips ("All / Failed / Has invalid citations")
  are about briefing-run state, not reviewer-request state.

### 6.5 Why not block the sprint on building a unified timeline

A unified per-engagement event timeline (one component that
generically renders `briefing-source.refreshed`, `submission.created`,
`reviewer-annotation.created`, `reviewer-request.*`, etc.) is a much
larger sprint that would require:

- A new `GET /api/engagements/:id/events` endpoint that joins across
  engagement-scoped events from every atom.
- A generic event-row renderer with per-`eventType` body components.
- A scrolling / pagination story.
- A test plan for ~30+ event types.

Sprint D's task spec does not ask for this. Recon recommends
delivering the small strip now and writing a follow-up for Empressa
proposing a unified timeline as Wave 3 polish.

### 6.6 Empressa decision points captured

1. Is "ship the small `ReviewerRequestsStrip` and explicitly violate
   the 'no new architect-side component code' line" the right call?
2. If not, where in the existing surfaces should the event rows
   surface?
3. Is the unified-timeline follow-up worth proposing now?

---

## 7. portal-ui inventory and re-exports

Recon goal: identify navigation-pattern components to extract and the
target portal-ui files.

### 7.1 What exists today

(See `lib/portal-ui/src/index.ts` for the canonical export list; full
inventory:)

- **Layout:** `DashboardLayout`, `Sidebar`, `Header`.
- **Reviewer:** `ReviewerComment`, `ReviewerAnnotationAffordance`,
  `ReviewerAnnotationPanel`.
- **Briefing:** `BriefingDivergenceRow` / `…Group` / `…Panel` /
  `…DetailDialog`, `BriefingSourceDetails`, `BriefingRecentRunsPanel`,
  `EngagementContextPanel`, `BriefingSourceCitationPill`,
  `BriefingCodeAtomPill`, `BriefingInvalidCitationPill`,
  `renderBriefingBody`, `scrollToBriefingSource`.
- **Atoms / pills:** `CodeAtomPill`, `CODE_SECTION_TOKEN_RE`,
  `splitOnCodeAtomTokens`.
- **Submissions:** `SubmitToJurisdictionDialog`,
  `SubmissionRecordedBanner`.
- **Site context:** `SiteContextViewer`.
- **Helpers:** `useSidebarState`, `initTheme` / `setTheme` / `getTheme`
  / `toggleTheme`, `relativeTime`, `actorLabel`,
  `briefing-divergences` (formatters + DOM-id helpers),
  `formatRelativeMaterializedAt`.

### 7.2 What Phase 2 adds to portal-ui

Per §2 and §6 above:

- `lib/portal-ui/src/components/AtomDrillStack.tsx` — single right
  side-sheet hosting the head of a URL-encoded stack of atom refs.
- `lib/portal-ui/src/components/AtomDrillStack/views/*.tsx` — one
  thin view per atom type: `SubmissionAtomView`, `BimModelAtomView`,
  `BriefingDivergenceAtomView`, `MaterializableElementAtomView`,
  `BriefingSourceAtomView`, `ParcelBriefingAtomView`,
  `EngagementAtomView`. Each ~50 lines, mostly composing existing
  portal-ui primitives.
- `lib/portal-ui/src/lib/atom-stack-url.ts` — pure helpers (encode,
  decode, push, pop, top, length) with full unit-test coverage.
- `lib/portal-ui/src/lib/use-atom-drill-stack.ts` — React hook.
- `lib/portal-ui/src/components/RequestRefreshDialog.tsx` — the
  shared "free-text reason" dialog used by the three reviewer-side
  affordances. Modeled on `SubmitToJurisdictionDialog`.
- `lib/portal-ui/src/components/RequestRefreshAffordance.tsx` — a
  small "Request refresh" button used inline on briefing-source
  rows, bim-model card, parcel-briefing card. Opens
  `RequestRefreshDialog`.
- `lib/portal-ui/src/components/ReviewerRequestsStrip.tsx` — the
  architect-side honored/dismissed strip described in §6.

### 7.3 What stays in design-tools / plan-review

Adapters only. Each artifact passes its own router, BASE_URL prefix,
and audience-gating into the portal-ui primitives. No domain logic
moves out of the artifacts.

---

## 8. e2e test plan

Recon goal (task step §1): plan the e2e tests.

### 8.1 Test (a): graph navigation across the full chain

`artifacts/plan-review/e2e/reviewer-graph-navigation.spec.ts` (new).

Seeds an engagement with one submission whose linked bim-model has
one materializable-element with a recorded divergence and a
briefing-source citation that traces back to a parcel-briefing on the
engagement.

Walks:

```
submission (open via ?submission=<id>)
  → click "BIM model" tab in the modal
  → push bim-model atom into AtomDrillStack
  → URL becomes …?atomStack=submission:<id>;bim-model:<id>
  → click divergence row in the bim-model view
  → URL becomes …;briefing-divergence:<id>
  → click materializable-element link in the divergence view
  → URL becomes …;materializable-element:<id>
  → click briefing-source citation in the element view
  → URL becomes …;briefing-source:<id>
  → click parcel-briefing link in the source view
  → URL becomes …;parcel-briefing:<id>
  → click engagement link in the parcel-briefing view
  → URL becomes …;engagement:<id>
  → "Back" 6 times pops the stack to empty
  → URL has no atomStack param
```

At every hop, asserts:
1. The visible side-sheet body matches the atom at the top of the stack
   (data-testid = `atom-view-${entityType}-${entityId}`).
2. `window.location.search` round-trips through a fresh
   `page.reload()` to land on the same view (URL-deep-link contract).

### 8.2 Test (b): stale-data request flow

`artifacts/plan-review/e2e/reviewer-stale-request.spec.ts` (new).

Seeds an engagement with one briefing-source whose freshness verdict
is `warn`.

Reviewer steps (audience=internal):
1. Open `/engagements/:id`.
2. Find the briefing-source row showing "Request refresh" affordance.
3. Click → dialog opens.
4. Fill reason "Source PDF appears outdated" → submit.
5. Assert the dialog closes and a confirmation pill appears.
6. Assert (via API) that
   `reviewer-request.refresh-briefing-source.requested` event is on
   the engagement timeline.

Architect steps (audience=architect, same browser context with
session swap or second context):
1. Open the architect `/engagements/:id`.
2. Assert the new `ReviewerRequestsStrip` lists the pending request.
3. Click "Honor".
4. Assert the strip moves the request to "Resolved" and a
   `reviewer-request.refresh-briefing-source.honored` event lands on
   the timeline, plus the existing `briefing-source.refreshed` event.

Reviewer steps (back to internal audience):
1. Reload `/engagements/:id`.
2. Assert the linked follow-up event surfaces (the strip shows
   "Honored by <architect>" and the briefing-source row no longer
   shows the "Request refresh" affordance because the freshness
   verdict is now `ok`).

### 8.3 Validation gate

Both specs run via the existing `e2e` workflow. Run `pnpm run typecheck`
and `pnpm test` first; only proceed to e2e after the unit tier is
green. Mirror Wave 1's pre-merge validation gate.

### 8.4 Pre-existing convention to mirror

The closest precedent is the reviewer-annotation deep-link e2e at
`artifacts/plan-review/e2e/` (Sprint C — read for the URL-hash
deep-link assertion idiom; same shape applies to `?atomStack=` query
deep-links).

---

## 9. Phase 2 entry plan (for Empressa to approve)

Once Sprints A and B are merged on origin/main, Phase 2 lands in this
order. Each step is sized "small for a well-prepared LLM session."

1. **OpenAPI spec edits** — add the six new endpoints and their
   request/response schemas to `lib/api-spec/openapi.yaml`. Run
   `pnpm --filter @workspace/api-spec run codegen`.
2. **DB schema + migration** — add
   `lib/db/src/schema/reviewerRequests.ts`, write the migration via
   the existing migration tooling, run it locally.
3. **New atom registration** —
   `artifacts/api-server/src/atoms/reviewer-request.atom.ts` plus its
   `registry.ts` line.
4. **Six route handlers** — three per-target POSTs + honor + dismiss
   + list, in
   `artifacts/api-server/src/routes/reviewerRequests.ts` (new file).
   Mirror `reviewerAnnotations.ts` for create-event idioms and
   `bimModels.ts:1163-1353` for honor/dismiss idioms.
5. **One new ancestor read endpoint** — §4.4
   `GET /api/briefing-sources/:id/materializable-elements`.
6. **portal-ui navigation primitives** — `AtomDrillStack`,
   `atom-stack-url.ts`, `use-atom-drill-stack.ts`, the seven thin atom
   views.
7. **portal-ui request UI** — `RequestRefreshDialog`,
   `RequestRefreshAffordance`.
8. **portal-ui architect strip** — `ReviewerRequestsStrip`.
9. **Wire reviewer-side surfaces** — drop `RequestRefreshAffordance`
   onto the briefing-source row when the freshness verdict is `warn`,
   onto the bim-model card, onto the parcel-briefing card. Drop
   `AtomDrillStack` into both `EngagementDetail` pages with the
   reviewer-side citations / pills opening it.
10. **Wire architect-side strip** — drop `ReviewerRequestsStrip` onto
    `artifacts/design-tools/src/pages/EngagementDetail.tsx` above the
    briefing recent runs panel.
11. **e2e specs** — §8.1 + §8.2.
12. **Pre-merge validation** — typecheck + unit + e2e.

Decision points still open for Empressa (recon recommendations in
parens):

- Three vs. nine total event types (recommend **nine** — explicit
  `*.honored` for symmetry).
- `ReviewerRequestsStrip` as new architect component vs. shoehorn
  (recommend **strip**).
- `AtomDrillStack` single side-sheet vs. multi-pane (recommend
  **single side-sheet** for v1; URL contract supports later
  multi-pane upgrade).
- Optional fallback server actor IDs `reviewer-request-honor` /
  `reviewer-request-dismiss` (recommend **ship now** for symmetry).
- Per-target POSTs vs. polymorphic single POST (recommend
  **per-target** for OpenAPI clarity).

---

## 10. Coordination check (snapshot at recon time, May 1, 2026)

- **Sprint A** (Task #305 — Reviewer Briefing Context): in flight or
  in review per the task slate. Hosts the briefing-source freshness
  verdict the affordance gates on.
- **Sprint B** (Task #306 — Reviewer BIM + Divergences): in flight
  or in review per the task slate. Hosts the bim-model card and the
  divergences panel that this sprint's nav walks through.
- **Sprint C** (Task #307 — Reviewer Annotations): code is in the
  working tree (`ReviewerAnnotationPanel`, `ReviewerAnnotationAffordance`).
  Sprint D's URL-hash convention deliberately extends Sprint C's
  hash-format for target-tuple addressing.
- **Task #283** (actorLabel system): merged. Files:
  `lib/portal-ui/src/lib/actorLabel.ts`,
  `artifacts/design-tools/src/lib/actorLabel.ts` (re-export shim).
- **No active task touches** `reviewerRequests` table,
  `AtomDrillStack`, `ReviewerRequestsStrip`, or the new endpoints.
  Phase 2 is collision-free with the active sprint slate at recon
  time. **Re-run the coordination check at unblock time** — the slate
  will have moved.

---

## 11. Out-of-scope reaffirmed

Per task §"Out of scope":

- Reviewer-side push notifications.
- Cross-engagement search.
- Saved navigation paths or bookmarks.
- Multi-hop graph queries.
- AI-produced finding navigation paths beyond the atom graph
  (Wave 3).
- Reviewer-triggered briefing/bim-model **actions** (only request
  events, never direct mutations).

The `AtomDrillStack` recommendation in §2 deliberately ships a
single-pane side-sheet rather than the full multi-pane Spec 20 §5
implication; multi-pane is explicitly out of scope and is captured
as a follow-up for Empressa.

---

## 12. Recommendation (one-line)

**Proceed with Phase 2 as planned in §9 once Sprints A and B merge,
ship `AtomDrillStack` as a single URL-encoded-stack side-sheet in
portal-ui, ship a small new `ReviewerRequestsStrip` on the architect
side (flagged as a deliberate violation of the spec's "no new
architect-side component code" line), and emit nine total event types
with `*.honored` for timeline symmetry.**
