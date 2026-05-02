# Wave 1 + Reviewer Parity + AIR + Wave 2 — Read-only ground-truth report

**Branch:** `main` · **HEAD:** `a6e28d7` "Published your App" (2026-05-01 23:57 UTC)
**Generated:** 2026-05-02 (read-only fact-finding sprint, no code changes)

---

## ⚠ Critical caveat upfront — task-ID system mismatch

Before reading anything below: **the `project_tasks` system on this Repl returns only tasks `#1`–`#97`** (76 MERGED, 19 CANCELLED, 2 PROPOSED — `#25` DA-PI-1 still PROPOSED, `#77` DA-PI-1F1 still PROPOSED). Every task ID Empressa's planning agent has been quoting (`#175`, `#293`, `#296–#301`, `#307`, `#316–#415`, etc.) — and that I have been quoting back at you in earlier snapshots — **does not exist as a row in `project_tasks` on this workspace**. They are referenced inside source comments and commit messages, but I cannot look them up, list their dependencies, or report their state through `listProjectTasks`.

Throughout this report, when I say "Task #NNN" I am citing what I can see in code comments / commit subjects / file headers, not in the actual task tracker. **I CANNOT DETERMINE** the canonical "DRAFTS / PROPOSED / MERGED" state of any task numbered above #97 from this side. That is a real ambiguity Empressa needs to resolve before approving anything tonight.

---

## TL;DR

```
Atom registry count          : 14   (sheet, engagement, snapshot, submission,
                                     intent, briefing-source, parcel-briefing,
                                     neighboring-context, materializable-element,
                                     briefing-divergence, bim-model,
                                     reviewer-annotation, viewpoint-render,
                                     render-output)
                                     → expected for "Wave 2 substrate landed
                                       + parity-C landed, AIR-1 NOT landed"
Wave 1 close-out             : GREEN   (PDF export shipped; docs/wave-1/ all 3 files; polish bundle landed via commit-tagged refs)
Reviewer Parity              : YELLOW  (Sprints A/B/C shipped real; Sprint D never landed — no reviewer-request events, no stale-data affordance, no graph nav)
AIR-1 + AIR-2                : YELLOW  (frontend-only: AIR-2 UI fully built against mock; AIR-1 backend never dispatched — no atom, no engine, no routes, no tables)
Wave 2 substrate             : GREEN   (DA-RP-0 atoms registered shape-only; lib/mnml-client present + factory wired at boot; recon doc 36 KB)
```

---

## SECTION 1 — Atom registry ground truth

### 1.1 Boot count today: **14**

`artifacts/api-server/src/atoms/registry.ts:140-178` — every `registerAtom` call:

| # | Atom | Line |
|---|---|---|
| 1 | `sheet` | `registry.ts:140` |
| 2 | `engagement` | `registry.ts:141` |
| 3 | `snapshot` | `registry.ts:142` |
| 4 | `submission` | `registry.ts:143` |
| 5 | `intent` | `registry.ts:147` |
| 6 | `briefing-source` | `registry.ts:148` |
| 7 | `parcel-briefing` | `registry.ts:149` |
| 8 | `neighboring-context` | `registry.ts:150` |
| 9 | `materializable-element` | `registry.ts:158` |
| 10 | `briefing-divergence` | `registry.ts:159` |
| 11 | `bim-model` | `registry.ts:160` |
| 12 | `reviewer-annotation` | `registry.ts:166` |
| 13 | `viewpoint-render` | `registry.ts:172` |
| 14 | `render-output` | `registry.ts:173` |

### 1.2 Per-atom verification

| Atom | Status | Evidence |
|---|---|---|
| sheet | **YES** (full shape, real DB lookup) | `sheet.atom.ts` factory `makeSheetAtom({ db, history })`, registry.ts:140 |
| snapshot | **YES** | registry.ts:142 |
| engagement | **YES** | registry.ts:141; composes snapshot/submission/parcel-briefing/viewpoint-render edges (`engagement.atom.ts:200-220`) |
| submission | **YES** | registry.ts:143; backed by `submissions` table |
| parcel-briefing | **SHAPE-ONLY** | `registry.ts:106` comment: *"DA-PI-1 parcel-intelligence atoms — shape-only, no DB lookup yet."* |
| intent | **SHAPE-ONLY** | same block, `registry.ts:147` |
| briefing-source | **SHAPE-ONLY** | same block, `registry.ts:148` |
| neighboring-context | **SHAPE-ONLY** | same block, `registry.ts:150` |
| bim-model | **YES** | registry.ts:160 — DA-PI-5, real `bim_models` table schema in `lib/db/src/schema/bimModels.ts` |
| materializable-element | **YES** | registry.ts:158 |
| briefing-divergence | **YES** | registry.ts:159 |
| **reviewer-annotation** | **YES** (parity Sprint C) | registry.ts:166; `lib/db/src/schema/reviewerAnnotations.ts` real table; closed enum `REVIEWER_ANNOTATION_TARGET_TYPES = ["submission", "briefing-source", "materializable-element", "briefing-divergence", "sheet", "parcel-briefing"]` |
| **finding** | **NO** | not in `registry.ts`; no `finding.atom.ts` file; `rg "makeFindingAtom\|finding\.atom"` returns zero hits in `artifacts/api-server/src/atoms`. `lib/db/src/schema/findingsCodeAtoms.ts` exists but that's the **code-section atoms** persistence (corpus storage), not a finding-result table. |
| **viewpoint-render** | **SHAPE-ONLY** (Wave 2 DA-RP-0) | registry.ts:172, comment: *"DA-RP-0 mnml.ai render-pipeline atoms — shape-only, no DB lookup yet."* `viewpoint-render.atom.ts` exists with `VIEWPOINT_RENDER_EVENT_TYPES` declared |
| **render-output** | **SHAPE-ONLY** | registry.ts:173 |

---

## SECTION 2 — Push 1 (Wave 1 close-out): GREEN

### 2.1 DA-PI-6 — PDF stakeholder briefing export

| Question | Answer | Evidence |
|---|---|---|
| Endpoint `GET /api/engagements/:id/briefing/export.pdf` exists? | **YES** | Route handler implied; route smoke test exists at `artifacts/api-server/src/__tests__/briefing-export-pdf.test.ts:166-269` exercising the exact path, including `?download=1` query and HTML/PDF content-types. Test header: *"GET /api/engagements/:id/briefing/export.pdf — DA-PI-6 stakeholder"* |
| Export PDF button in design-tools' Site Context tab populated state? | **YES** | `artifacts/design-tools/src/pages/EngagementDetail.tsx:2618` — comment: *"baseUrl keeps the 'Export PDF' anchor mounted"*; e2e spec at `artifacts/design-tools/e2e/briefing-pdf-export.spec.ts` |
| Puppeteer / react-pdf added? | **Puppeteer YES** | `artifacts/api-server/package.json` runtime dep: `"puppeteer": "^24.42.0"` |
| `architect_pdf_header` column? | **YES** | Defined inline (drizzle-kit push, no migration files) at `lib/db/src/schema/users.ts:39` — `architectPdfHeader: text("architect_pdf_header")`. Settings UI hookup at `artifacts/design-tools/src/pages/Settings.tsx:348, 361, 372, 403, 624`; tests in `Settings.test.tsx`. Mirrored in fixture template `lib/db/src/__tests__/__fixtures__/schema.sql.template:336` |
| **End-to-end: can an architect export a briefing as a PDF today?** | **YES** | route + button + dep + Settings header config + e2e spec all present |

### 2.2 Polish bundle (eight sub-tasks)

I cannot map B.1–B.8 to canonical task IDs in this workspace's tracker (see caveat — only #1–#97 are queryable, and the conversation references #293, #296-#301, etc. don't resolve). Mapping by **commit subject + code presence** instead:

| Item | State | Evidence |
|---|---|---|
| **B.1** Align route fakes with real adapter keys | **PARTIAL** | Open-question Q1 in `docs/wave-1/02-open-questions.md` says B.1's recon picks the path; commit `37a5edd` "Task #386: stop briefing-history pruning test from flaking" suggests test-cleanup work landed but I cannot confirm B.1 specifically. **I CANNOT DETERMINE** definitively. |
| **B.2** "Show only in-pilot" filter on engagements list | **MERGED** (likely) | `artifacts/plan-review/src/pages/EngagementsList.tsx` exists; pilot-jurisdiction allow-list at `lib/adapters/src/pilotJurisdictions.ts`. Cannot pin to commit without #293 lookup. |
| **B.3** prior briefing's `generated_by`+`generated_at` inline | **MERGED** | `EngagementContextTab.tsx:300+` renders `generatedAt`; `lib/briefing-prior-snapshot/` lib exists with 28 test cases |
| **B.4** copy-prior-narrative button | **MERGED** | commit `f4334a5` "Task #389 — Cover the shared prior-narrative diff component with its own unit tests" + commit `442512e` "Task #374 — Lift the per-section prior-narrative diff block into the shared lib" |
| **B.5** visual diff prior-vs-current | **MERGED** | `lib/briefing-diff/` lib exists, 8 test cases; commit `8c23e99` "Task #397 — Retire duplicated prior-narrative diff coverage from surface mirror tests" |
| **B.6** plan-review recent-runs URL deep-link parity | **MERGED** | e2e spec `artifacts/design-tools/e2e/recent-runs-deep-link.spec.ts` |
| **B.7** automated coverage for briefing-id backfill script | **I CANNOT DETERMINE** | no commit subject mentions "backfill", `find . -name "*backfill*"` returned only `Backfill 'first ingested'` (#32, unrelated). |
| **B.8** "producing run pruned from history" annotation | **MERGED** | commit `37a5edd` "Task #386: stop briefing-history pruning test from flaking under concurrent ticks" — the pruning surface is there |

### 2.3 Docs handoff: **YES, all three present**

```
docs/wave-1/01-closeout-report.md       10 859 bytes
docs/wave-1/02-open-questions.md         4 615 bytes
docs/wave-1/03-wave-2-entry-notes.md     6 353 bytes
```

---

## SECTION 3 — Push 2 (Reviewer Interface Parity): YELLOW

### 3.1 Sprint A — Briefing context surface

| Item | Answer | Evidence |
|---|---|---|
| "Engagement Context" tab in submission detail modal | **YES** | `artifacts/plan-review/src/components/SubmissionDetailModal.tsx:241-246` — `<TabsTrigger value="engagement-context">Engagement Context</TabsTrigger>` |
| Parcel-briefing card | **YES** | `EngagementContextTab.tsx` → `ParcelInfoCard` (line ~58, `data-testid="engagement-context-parcel-card"`) |
| A–G section narrative | **PARTIAL** | **Section A only.** `EngagementContextTab.tsx:159` and the comment at lines 30-36: *"Section A is intentionally the only section rendered… Sections B–G stay on the design-tools / plan-review engagement page where the full briefing surface lives."* B–G accessible via "View full briefing" deep-link to `/engagements/:id?recentRunsOpen=1#briefing` |
| briefing-source list w/ adapter badges + freshness | **NO (in this tab)** | the EngagementContextTab does NOT render a sources list; only Parcel info + Briefing summary (Section A). The full sources list lives back on the engagement page. |
| briefing run history panel w/ prior-narrative comparison | **NO (in this tab)** | same as above; only deep-link out |
| Cesium overlay map | **NO** | not rendered in EngagementContextTab; Cesium lives on the engagement page (commit `1fa90cc` "Task #317: 2D site context map for reviewers") |
| 3D viewer via portal-ui extraction | **NO (in EngagementContextTab)** | the 3D viewer renders on the **BIM Model tab** instead, see §3.2 |
| Components extracted design-tools → portal-ui | **YES (extensive)** | commits `8f259f1` "Task #316 — extract briefing components into portal-ui", `442512e` "Task #374 — Lift the per-section prior-narrative diff block into the shared lib", `c4996cb` "Untangle portal-ui ↔ briefing-prior-snapshot dep cycle (Task #388)", `c7d02b4` "Task #390: portal-ui sibling tests for the briefing-divergence list-row trio", `8095428` "Task #391 — migrate legacy briefing tests into portal-ui and drop re-exports". `lib/portal-ui` has **20 test files / 262 test cases**. |
| **End-to-end: can a reviewer see the architect's full briefing context?** | **PARTIAL — Section A only inline; B–G via deep-link out of the modal** | by deliberate scoping per the EngagementContextTab header comment |

### 3.2 Sprint B — bim-model + divergence detail

| Item | Answer | Evidence |
|---|---|---|
| "BIM Model" tab in submission detail modal | **YES** | `SubmissionDetailModal.tsx:253-258` — `<TabsTrigger value="bim-model">BIM Model</TabsTrigger>` |
| bim-model card with materialization status + element counts | **YES** | `BimModelTab.tsx:368` `function BimModelSummaryCard({ bimModel })` |
| materializable-element list with elementKind grouping | **YES** | `MaterializableElementsList` rendered at `BimModelTab.tsx:~580` |
| briefing-divergence list (active vs acknowledged) | **YES** | `BimModelTab.tsx` import `BimModelDivergenceListEntry`; `lib/portal-ui` has divergence-list-row trio (commit `c7d02b4`) |
| per-divergence drill-in (locked vs modified side-by-side) | **YES** | `BriefingDivergenceDetailDialog` referenced at `BimModelTab.tsx:501`; e2e `artifacts/design-tools/e2e/architect-divergence-view-details.spec.ts` |
| 3D BIM viewport | **YES** | `BimModelViewport.tsx` mounted at `BimModelTab.tsx:570`; commit `1cb3cc5` "Task #370 — Real three.js BIM viewport that frames the element on jump", `5012dd6` "Task #380 — Let reviewers pan and zoom the BIM viewport", `0db8ba2` "Task #379 — render glb-only elements (terrain, setbacks, neighbor masses)" |
| **End-to-end: BIM model + divergences visible to reviewer?** | **YES** | full surface present, multiple e2e specs (`bim-model-tab.spec.ts`, `bim-viewer-pan-zoom-reset.spec.ts`, `bim-viewer-gesture-hint-tap.spec.ts`, `findings-bim-model-jump.spec.ts`) |

### 3.3 Sprint C — Reviewer annotation surface

| Item | Answer | Evidence |
|---|---|---|
| reviewer-annotation atom registered | **YES** | `registry.ts:166` |
| `reviewer_annotations` table | **YES** (drizzle schema; no per-migration file because this repo uses `drizzle-kit push`, not journaled migrations — `lib/db/migrations/` doesn't exist, only `lib/db/src/schema/`) | `lib/db/src/schema/reviewerAnnotations.ts` — full pgTable with `REVIEWER_ANNOTATION_TARGET_TYPES` enum |
| GET / POST / PATCH / promote endpoints | **YES — all four** | `artifacts/api-server/src/routes/reviewerAnnotations.ts`: `router.get` :239, `router.post` :285, `router.patch` :401, `router.post` (promote) :468. Mounted at `routes/index.ts:23,77`. |
| Annotation panel renders alongside target atoms | **YES** | `ReviewerAnnotationPanel` lives in `lib/portal-ui/src/components/ReviewerAnnotationPanel.tsx` with companion `.test.tsx`; mounted in `artifacts/plan-review/src/pages/EngagementDetail.tsx:551` (also `ReviewerAnnotationAffordance` for the surfacing chip) |
| Promotion to architect-visible | **YES** | promote endpoint + comment in `reviewerAnnotations.ts`: *"Architects only see annotations after promotion via the existing jurisdiction-response inbox flow (no new architect-side rendering — promoted annotations land in the existing inbox surface)"* |
| **End-to-end: reviewer can leave an annotation on a briefing-source today?** | **YES** | atom + table + 4 endpoints + panel + affordance all present, with closed enum target type `briefing-source` |

### 3.4 Sprint D — Graph navigation + reviewer-request events

| Item | Answer | Evidence |
|---|---|---|
| `reviewer-request.*` events in vocabulary | **NO** | `rg "reviewer-request\|reviewer_request\|reviewerRequest"` returns **zero hits** across `artifacts/api-server`, `lib/empressa-atom`, and `lib/db`. Only `viewpoint-render`, `render-output`, and `reviewer-annotation` event-type tuples exist. |
| Stale-data request affordance on stale briefing-source rows | **NO** | `rg "stale.refresh\|requestRefresh\|stale-data"` returns zero hits |
| Architect timeline surfaces reviewer-request via `actorLabel` | **NO (events don't exist to surface)** | `actorLabel` infrastructure exists (`lib/portal-ui/src/lib/actorLabel.ts`, `artifacts/design-tools/src/lib/actorLabel.ts`, server-side actor IDs in `lib/server-actor-ids/`), but no reviewer-request actor is registered |
| Graph navigation drill (finding/divergence/source → related atoms) | **PARTIAL** | The pattern *exists* — `findings/FindingDrillIn.tsx` has "Show in 3D viewer" callback that switches the modal to BIM Model tab + highlights the `elementRef`; e2e `findings-bim-model-jump.spec.ts` proves it. But this is the AIR-2 → BIM jump only. No general-purpose "drill-from-divergence-to-briefing-source" / "drill-from-source-to-parcel-briefing" mechanism exists. |
| docs/wave-2/03-sprint-d-graph-nav-recon.md | **EXISTS** (45 330 bytes, last modified 2026-05-01 21:59) | recon doc — Sprint D was scoped, **not implemented** |
| **End-to-end: reviewer interface has functional graph navigation?** | **NO — recon-only** | the only graph hop in production is finding → BIM viewport via the AIR-2 surface; the broader Sprint D vocabulary never landed |

---

## SECTION 4 — Push 3 (AIR-1 + AIR-2): YELLOW

### 4.1 AIR-1 — Finding atom + compliance checker engine

| Item | Answer | Evidence |
|---|---|---|
| `finding` atom registered | **NO** | not in `registry.ts`; no `finding.atom.ts` file in `artifacts/api-server/src/atoms/` |
| `lib/finding-engine/` package | **NO** | `ls lib/` confirms 18 packages, none named `finding-engine`; `find . -type d -name "*finding*"` returns only `artifacts/plan-review/src/components/findings` |
| `findings` + `finding_runs` tables | **NO** | `lib/db/src/schema/` directory has 17 schema files; `findingsCodeAtoms.ts` is the **code-corpus atoms** table (the rules library), NOT a finding-result table. No `findings.ts` or `findingRuns.ts` schema. |
| `POST /api/submissions/:id/findings/generate` | **NO** | `rg "/findings\|/findings/generate"` in `artifacts/api-server/src/routes` returns zero hits. `routes/index.ts` mounts: adapterCache, atoms, bimModels, briefingSources, chat, codes, devAtoms, engagements, generateLayers, health, localSetbacks, match, me, parcelBriefings, reviewerAnnotations, reviewers, session, settings, sheets, snapshots, storage, users — **no findings router**. |
| `GET /api/submissions/:id/findings/status` | **NO** | same |
| `GET /api/submissions/:id/findings` | **NO** | same |
| `AIR_FINDING_LLM_MODE` env flag | **NO** | `rg "AIR_FINDING\|FINDING_LLM_MODE"` returns zero hits anywhere in repo or docs |
| `[[CODE:atomId]]` citation validation | **PARTIAL — for briefings, not findings** | `[[CODE:` validation exists in `lib/codes/src/promptFormatter.ts:1277,1331` and `artifacts/api-server/src/lib/briefingHtml.ts:171` for the **briefing** narrative; no finding-output validator exists |
| **End-to-end: api-server can produce a finding run in mock mode?** | **NO** | no atom, no engine, no routes, no tables, no env flag — the AIR-1 backend is **completely absent** |

### 4.2 AIR-2 — Reviewer finding display + accept/reject flow

This is the surprise: AIR-2 frontend shipped fully — against an in-process mock backend.

| Item | Answer | Evidence |
|---|---|---|
| "Findings" tab in submission detail modal | **YES** | `SubmissionDetailModal.tsx:247-252` — `<TabsTrigger value="findings">` with `data-testid="submission-tab-findings"`; `FindingsTab` mounted at `:330` |
| Findings list grouped by severity | **YES** | `findings/FindingsTab.tsx:38` — `SEVERITY_GROUP_ORDER: FindingSeverity[] = ["blocker", "concern", "advisory"]` |
| Per-finding drill-in with citations | **YES** | `findings/FindingDrillIn.tsx` + `findings/CodeAtomPill.tsx` with `renderFindingBody` |
| Deep-link to 3D viewer for findings w/ elementRef | **YES** | `FindingDrillIn.tsx:~30` "Show in 3D viewer" callback wired through `SubmissionDetailModal` → `BimModelTab` `highlightToken`; e2e `findings-bim-model-jump.spec.ts` |
| accept/reject/override actions | **YES** | `useAcceptFinding`, `useRejectFinding`, `useOverrideFinding` hooks at `findingsApi.ts`; `OverrideFindingModal` component |
| URL deep-link `?finding=<atomId>` | **YES** | `EngagementDetail.tsx:328` comment: *"`?submission=<id>` param, switching tabs flips `?tab=findings`"*; `findingUrl.ts` + `findingUrl.test.ts` for the well-formed-id allow-list |
| Backend wiring | **MOCK ONLY** | `artifacts/plan-review/src/lib/findingsApi.ts:1-40` opens with: *"This module is the SINGLE SWAP POINT between the AIR-2 reviewer UI and the AIR-1 backend. Today it re-exports the in-memory mock implementation from `./findingsMock` because AIR-1 (the `finding` atom + `/api/submissions/:id/findings*` endpoints + generated React Query hooks) hasn't landed yet — see Task #341 for context."* — the file documents the four-step swap procedure for when AIR-1 ships. |
| **End-to-end: reviewer sees findings, drills in, accepts/rejects/overrides today?** | **YES (against mock data)** — the deterministic 3-finding fixture (1 blocker / 1 concern / 1 advisory) renders, drill-in works, accept/reject/override mutations work in-memory, BIM jump works. **Nothing persists; nothing is generated; AIR-1 must land before this surface has real data.** | `findingsMock.ts` |

### 4.3 Why didn't AIR-1 land?

**I CANNOT DETERMINE definitively from this side.** What I can see:

- `findingsApi.ts:6` cites *"see Task #341 for context"* — that's the AIR-1 dispatch task per Empressa's tracker but is not in this Repl's `project_tasks` (only #1–#97 exist).
- No commit in the recent log (`git log -30`) mentions `finding atom`, `finding-engine`, `compliance checker`, or AIR-1.
- No partial scaffold under `lib/finding-engine`, no abandoned stub under `artifacts/api-server/src/atoms/finding.atom.ts`, no migration file referencing a `findings` table.
- The frontend-side AIR-2 author treated AIR-1 as a **future** swap target, not a stalled-mid-implementation effort.

**Most likely scenario:** AIR-1 was either (a) never dispatched as a Replit task, (b) dispatched to Empressa's planning agent which paused at Phase 1 awaiting approval, or (c) merged-and-reverted before this Repl saw it. Empressa would need to look in **its** task tracker (the one with #341 / #200-range IDs) — that tracker is not visible from this Repl.

---

## SECTION 5 — Push 4 (Wave 2 substrate): GREEN

### 5.1 Was Push 4 dispatched? **YES — and substantial portions landed.**

In `project_tasks`: zero matches for "Wave 2", "DA-RP", "viewpoint-render", "render-output", "mnml-client", "Spec 54" — but as established, `project_tasks` only goes to #97. The **code evidence** is unambiguous: shipped via tasks `#316`, `#370`, `#379`, `#380`, etc. according to commit subjects, and Wave 2 specifically via comments referencing DA-RP-0 throughout `viewpoint-render.atom.ts`, `render-output.atom.ts`, `engagement.atom.ts:190-220`, and `lib/mnml-client/src/index.ts`.

### 5.2 If dispatched: deliverable check

| Item | Answer | Evidence |
|---|---|---|
| `docs/wave-2/01-mnml-integration-recon.md` | **EXISTS — 36 569 bytes** | last modified 2026-05-01 20:41 |
| (bonus) `docs/wave-2/02-mnml-secrets-handoff.md` | **EXISTS — 3 256 bytes** | 2026-05-01 20:58 |
| (bonus) `docs/wave-2/03-sprint-d-graph-nav-recon.md` | **EXISTS — 45 330 bytes** | 2026-05-01 21:59 |
| viewpoint-render atom registered | **YES (shape-only)** | `registry.ts:172` |
| render-output atom registered | **YES (shape-only)** | `registry.ts:173` |
| `lib/mnml-client/` package | **YES** | full lib with `factory.ts`, `httpClient.ts`, `mockClient.ts`, `types.ts`, `__tests__/`, `package.json` (`@workspace/mnml-client`); 3 test files / **44 test cases**. Exports: `MnmlClient`, `MockMnmlClient`, `HttpMnmlClient`, `createMnmlClient`, `getMnmlClient`, `setMnmlClient`, `validateMnmlEnvAtBoot`. **Wired at api-server boot** (`artifacts/api-server/src/index.ts:2,46` — comment: *"wired (lazy singleton in @workspace/mnml-client) but NOT yet [invoked]"*); api-server has `"@workspace/mnml-client": "workspace:*"` as a runtime dep. |
| `engagement.renders` edge | **YES** | `artifacts/api-server/src/atoms/engagement.atom.ts:212-217`: `{ childEntityType: "viewpoint-render", childMode: "card", dataKey: "renders" }`. Comment at lines 190-196: *"`parentData["renders"]` is intentionally left unpopulated until DA-RP-1 wires the renders table — `resolveComposition` produces zero children for an absent / empty `renders` key, the same lazy pattern `activeBriefing` used before DA-PI-3."* |

DA-RP-1 (the actual renders persistence + trigger endpoint) **has not landed** — but that is correctly outside this push's scope per the registry.ts comments and the recon doc.

---

## SECTION 6 — Drafts inventory

### 6.1 What `project_tasks` shows on this Repl

**PROPOSED (the only "draft-equivalent" state visible):**

| Ref | Title | Origin / age |
|---|---|---|
| `#25` | DA-PI-1 — Site Context tab + parcel intelligence atom registrations | Origin: Wave 1 dispatch. Age: stale — work shipped via different IDs (atoms registered at registry.ts:147-150). **This row appears to be orphaned.** |
| `#77` | DA-PI-1F1 — Switch framework-atom token delimiter from `:` to `\|` | Origin: Wave 1 polish. Age: stale; the new delimiter is already in production code (e.g. `briefing-export-pdf.test.ts:150` uses `{{atom\|briefing-source\|...}}`). **Also appears orphaned.** |

**Everything Empressa's planning agent calls "drafts at #392 / #399 / #400 / #407 / #412 / #413 / #414 / #415" is NOT in `project_tasks` on this Repl.** I cannot confirm those rows exist, are PROPOSED, are blocked, or anything else. Earlier snapshots I gave you that named those IDs were quoting Empressa's tracker, not validating against this one.

### 6.2 #400 (engagement-scoped auth on GLB endpoints)

I cannot inspect the row. **What I can confirm about the underlying surface:**

- The GLB endpoints exist via `artifacts/api-server/src/routes/bimModels.ts` and the model files are served from object storage.
- There are no engagement-scope checks in the existing GLB serving path. **Today, anyone with a valid session can fetch any engagement's GLB if they know its URL** (the URLs are signed/object-storage but the api-server route does not cross-check the requesting session against the engagement's tenancy).
- Severity: **medium** — not a public leak, but a tenant-isolation gap. Worth closing.

---

## SECTION 7 — Test infrastructure ground truth

### 7.1 Test cases per package (counted via `it(` / `test(` regex over `*.test.ts(x)`):

| Package | Test files | Test cases |
|---|---:|---:|
| artifacts/api-server | 48 | **546** |
| artifacts/design-tools | 19 | **231** |
| artifacts/plan-review | 10 | **134** |
| lib/empressa-atom | 9 | 51 |
| lib/codes | 8 | 125 |
| lib/adapters | 11 | 178 |
| lib/portal-ui | 20 | **262** |
| lib/briefing-engine | 7 | 44 |
| lib/mnml-client | 3 | **44** |
| lib/briefing-diff | 2 | 8 |
| lib/briefing-prior-snapshot | 3 | 28 |
| lib/briefing-pdf-tokens | 1 | 3 |
| lib/db | (within schema) | 12 |
| lib/site-context | 0 | 0 |
| **TOTAL** | **141** | **~1 666** |

`lib/finding-engine`: **does not exist** (0 / 0).

**Playwright e2e specs: 20 total** (15 in design-tools, 5 in plan-review):

- design-tools: submission-detail, timeline-backfill-filter, engagement-snapshot-timeline, record-submission-response, submit-to-jurisdiction, dxf-upload-3d-render, briefing-citation-pills, federal-summary-chips, federal-layers-render, federal-copy-summary-button, site-context-summary-chips, generate-layers, recent-runs-deep-link, architect-divergence-view-details, briefing-pdf-export
- plan-review: engagement-context-tab, bim-model-tab, findings-bim-model-jump, bim-viewer-pan-zoom-reset, bim-viewer-gesture-hint-tap

### 7.2 Pre-merge gate

**I CANNOT DETERMINE** the canonical gate history from this side; there is no CI log accessible here. What I *can* observe:

- HEAD `a6e28d7` is the deploy checkpoint, 2026-05-01 23:57 UTC.
- All 30 commits before HEAD are task-tagged (`Task #NNN`), so the merge cadence has been "one merged task = one commit" with no `revert` / `WIP` / `fix-CI` noise. That is the strongest available proxy for green-gate health, but it isn't a CI log.
- The `test`, `typecheck`, and `e2e` workflows are configured but **not started** right now (system status). I have not refreshed logs because the user explicitly asked for read-only fact-finding.

---

## SECTION 8 — Workflow + dev environment status

### 8.1 Current workflow status (from system status panel):

| Workflow | State |
|---|---|
| `artifacts/api-server: API Server` | **FAILED** |
| `artifacts/design-tools: web` | **FAILED** |
| `artifacts/plan-review: web` | **FAILED** |
| `artifacts/mockup-sandbox: Component Preview Server` | running |
| `e2e` | not started |
| `test` | not started |
| `typecheck` | not started |

### 8.2 Cause / restart attempts

I have **not** refreshed logs or attempted any restart, per the read-only constraint. The pattern (three artifact servers down, mockup-sandbox up) is consistent with the prior `EADDRINUSE`-from-orphan-puppeteer-children issue we hit after rapid-merge bursts (six BIM-cluster commits landed in a window). **Cannot confirm without a log refresh, which I'm not doing.**

### 8.3 Last production deployment

- **Commit:** `a6e28d7fc7dfa91cd8987161b774713cb9366906`
- **Subject:** "Published your App"
- **Timestamp:** 2026-05-01 23:57:29 +0000

---

## SECTION 9 — Prior open questions (Q1–Q4) progress

Source: `docs/wave-1/02-open-questions.md` (4 615 bytes, 2026-05-01 19:48). Status totals at HEAD `666880c` per the doc itself: **4 carry-forward open, 0 sibling-sprint additions** (the "roll-up" subsections for Tasks A and B are explicit placeholders; nothing was appended).

| Q | Topic | Status since dispatch |
|---|---|---|
| **Q1** | Generate Layers fixture drift — align fakes vs real-adapter integration test | **PARTIAL / I CANNOT DETERMINE definitively.** Doc says "Addressed by polish bundle B.1; B.1 picks the lower-churn path and lands the fix as its first commit." I see test-cleanup commits in the recent log (`bba73e4` "Task #393 — Stop the PDF header preview from drifting from exports", `37a5edd` "Task #386: stop briefing-history pruning test from flaking", `8c23e99` "#397 — Retire duplicated prior-narrative diff coverage", `beff23c` "#398 — Trim duplicate engagement-page mock setup") but **no commit subject explicitly matches "align route fakes with real adapter keys" / "generate-layers fixture"**. The `e2e/generate-layers.spec.ts` exists. The tracker row I'd expect to confirm B.1's path-choice is not in `project_tasks` (#1-#97 only). |
| **Q2** | Bastrop roads adapter | **UNCHANGED.** `lib/adapters/src/local/bastrop-tx.ts` exists and has test coverage in `__tests__/bastropAdapters.test.ts`, but no roads adapter shipped — recommendation in the doc was "stay with OSM-direct." No follow-up commit touches Bastrop roads. |
| **Q3** | Statewide-fallback setback tables (utah-unincorporated, idaho-unincorporated) | **UNCHANGED.** `lib/adapters/src/local/setbacks/utah-unincorporated.json` and `idaho-unincorporated.json` exist and are wired through `setbacks/index.ts`; they're surfaced in the OpenAPI generated types (`lib/api-zod/src/generated/types/localSetbackTable.ts`). No new spec doc promotes them to first-class concept — recommendation in the doc was "fine as discovered." |
| **Q4** | `texas-unincorporated` fallback table | **UNCHANGED.** No `texas-unincorporated.json` in `lib/adapters/src/local/setbacks/`. Recommendation in the doc was "intentional skip — document rationale in adapter README rather than add the table." No README addition I can spot. |

---

## ⚐ Flag list — surprises and contradictions

1. **🔴 The task-tracker mismatch (biggest finding).** Empressa's planning agent and the conversation history reference dozens of task IDs (#175, #293, #296–#301, #307, #316–#415) that **do not exist as rows in the `project_tasks` system on this Repl**. `listProjectTasks` returns exactly 97 rows, max ID `#97`. Either Empressa is using a separate tracker (most likely), or these IDs live in a different workspace / branch I cannot see. Every "draft inventory" I gave in earlier snapshots was repeating Empressa's IDs back to you, **not validating them against this Repl**. That is a real ambiguity that must be resolved before approving "drafts at desktop tonight" — *I cannot tell you what's actually in your drafts queue from this side.*

2. **🔴 AIR-1 is completely absent.** No finding atom, no `lib/finding-engine`, no `findings`/`finding_runs` tables, no `/api/submissions/:id/findings*` endpoints, no `AIR_FINDING_LLM_MODE` env flag, no `[[CODE:]]` validation for finding output. Yet the AIR-2 reviewer UI shipped fully and is in production deploy `a6e28d7`. **Today, every finding any reviewer sees in the published app is the deterministic 3-finding mock fixture** (1 blocker / 1 concern / 1 advisory) loaded from `findingsMock.ts`. If a pilot jurisdiction reviewer believes those are real AI findings on their architect's submission, that is a trust problem.

3. **🟡 Sprint D never landed — only recon.** `docs/wave-2/03-sprint-d-graph-nav-recon.md` is 45 KB, but no `reviewer-request.*` events exist, no stale-data refresh affordance exists, no general-purpose graph-nav drill exists (only the AIR-2 → BIM jump). The only "graph navigation" in production is finding → 3D viewport. Empressa labelling this push as "shipped" would be inaccurate — it's recon-complete, not built.

4. **🟡 EngagementContextTab is narrower than spec.** Sprint A spec calls for parcel-briefing, A–G narrative, briefing-source list, run-history with diff, Cesium overlay, and 3D viewer all in the modal. What actually shipped: parcel info card + Section A only, with "View full briefing" deep-link out of the modal for the rest. This is **deliberate** per the file header comment (Section A is the TL;DR; B–G stays on the engagement page) but it does not match Empressa's checklist as written.

5. **🟡 Three artifact workflows are red.** api-server, design-tools, plan-review all FAILED. I haven't restarted them per the read-only constraint, but until they're back up the local dev preview is broken. Production deploy is fine.

6. **🟢 (positive surprise) Wave 2 substrate is in better shape than the conversation suggests.** `lib/mnml-client` is a 44-test-case fully-implemented client (mock + http + factory + lazy singleton + boot validator), wired into api-server's `index.ts:2`, with secrets-handoff doc and Sprint D recon doc both written. DA-RP-1 is the only unfinished piece. This push genuinely overdelivered relative to the recon-only framing.

7. **🟡 No journaled migrations.** `lib/db/migrations/` does not exist. The repo is using `drizzle-kit push` against the live DB (per `lib/db/drizzle.config.ts`). That's fine for dev, but it means **there is no migration file to "cite"** for any schema. When you ask me "cite the migration that adds reviewer_annotations", the honest answer is "drizzle pushed it from `lib/db/src/schema/reviewerAnnotations.ts` directly; there is no SQL migration artifact." The reproducibility audit trail for production schema changes lives in commits, not in `migrations/`.

8. **🟡 Tracker rows #25 and #77 appear orphaned.** `#25` (DA-PI-1 Site Context tab) is still PROPOSED but the work shipped (atoms registered at registry.ts:147-150, Site Context tab live in design-tools). `#77` (DA-PI-1F1 token delimiter `:` → `|`) is still PROPOSED but the new delimiter is in production code (`{{atom|briefing-source|...}}`). Both could be marked MERGED or CANCELLED to clean up the queue.

9. **🟢 PDF export shipped end-to-end and tested.** Route, button, dep, Settings header column, design-tools header preview, footer watermark preview, e2e spec, shared `@workspace/briefing-pdf-tokens` lib — full surface. Wave 1's marquee deliverable is solid.

---

## Drafts triage recommendation

**Important: every recommendation below is contingent on Empressa pulling the actual draft IDs from its own tracker tonight, since they don't exist on this Repl.** With that caveat, applying the priorities to the *underlying surfaces* I can see in the code:

### Highest priority to approve at desktop

1. **Anything that closes the AIR-1 backend gap** — finding atom + `lib/finding-engine` + `findings` table + `/api/submissions/:id/findings/*` routes + `AIR_FINDING_LLM_MODE` flag + `[[CODE:]]` citation validator. This is the single biggest YELLOW on the report. The frontend is sitting on a mock; until AIR-1 lands, the published app shows fake findings to real users.
2. **The "engagement-scoped auth on GLB endpoints" surface (#400 in Empressa's tracker).** Tenant-isolation gap on a real route. Cheap to close, security-shaped.
3. **Sprint D — at minimum, the `reviewer-request.*` event vocab and the stale-data refresh affordance on stale briefing-source rows.** The recon doc is 45 KB; the implementation footprint is moderate; without it, the "reviewer pings architect to refresh stale data" loop the spec promises does not exist.

### Cancel / defer (over-instrumentation or superseded)

4. **Defer the BIM gesture-hint follow-up cluster** (sync preference cross-device, e2e for persisted preference, second-tap-to-close for keyboard reviewers, and so on — the items the recent BIM cluster spawned). Three-plus follow-ups on the same gesture-legend surface is diminishing returns. Pick at most one (the keyboard a11y one) and shelve the rest.
5. **Cancel `#25` and `#77`** in `project_tasks` — both are orphaned PROPOSED rows where the work has already shipped under different IDs.
6. **The "live preview of PDF page-number marker in Settings" (Empressa's #407)** — Settings already has a header preview and a footer watermark preview; a third preview card is cosmetic crowding. Defer or skip.

### Depend on other work landing first

7. **Anything labelled DA-RP-1 (renders trigger endpoint + persistence)** depends on AIR-1 *not* (different push), but does require the mnml-client `validateMnmlEnvAtBoot` to actually be invoked — which currently it isn't (`api-server/src/index.ts:46` comment confirms "wired but NOT yet invoked"). Approving DA-RP-1 means accepting that boot will start failing fast if mnml secrets are unset.
8. **AIR-2 polish work (severity-grouping refinement, citation rendering, override modal copy)** should wait for AIR-1 to land, otherwise you're polishing UI that shows mock data.
9. **Sprint A B–G inline rendering** (if Empressa wants the EngagementContextTab to match the original spec rather than the deliberate scoped-down version) should wait until you decide whether the deep-link-out-of-modal pattern is the intended end state. It currently *is* the end state per the file header comment.

---

**End of report.** No code changes were made, no tasks were drafted, no follow-ups were proposed, no agents were dispatched. The three failed artifact workflows remain failed.

The single most important thing for tonight: **resolve the task-tracker mismatch before approving anything**. The IDs Empressa is referencing don't resolve on this Repl, which means earlier snapshots naming "drafts #392 / #399 / #400 / #407 / #412–#415" were quoting Empressa's tracker, not validating against this one. Pull the real list from your tracker at desktop and triage against the actual rows.
