# Wave 1 Closeout Report

_Snapshot taken at HEAD `666880c` (May 1, 2026)._

This report summarises what shipped in Wave 1, the registry / test-infra final
state, the production deployment posture, and the dev-env / coordination
patterns that worked. It is the canonical hand-off into Empressa's weekend QA
+ hardening pass.

---

## A. Wave 1 sprints shipped

Anchor commit for Wave 1 is `4e73ad5` (_A0: Build the empressa-atom framework
foundation library_). Commit-range references below are taken from `git log`
between that anchor and HEAD `666880c`.

- **DA-PI-1 — Site Context tab + parcel-intelligence atom registrations.**
  Registered the four shape-only DA-PI-1 atoms (`parcel-briefing`, `intent`,
  `briefing-source`, `neighboring-context`) and stood up the Site Context tab
  scaffold. Atom data engines were left for DA-PI-3. Anchor commit:
  `d936f2d` (_Add new parcel intelligence features and improve engagement
  detail tab functionality_).
- **DA-PI-1F1 — Switch framework-atom token delimiter from `:` to `|`.**
  Follow-up that swapped the registry token delimiter so jurisdiction keys
  containing `:` would parse cleanly. Carried no schema change; pure framework
  fix.
- **DA-PI-1B — Manual-QGIS upload path for briefing sources (Task #120).**
  Commit `749804b` (_DA-PI-1B: manual-QGIS upload path for briefing sources_).
  Architects can now hand-upload a QGIS-prepared briefing-source artifact when
  no automated adapter exists for the parcel.
- **DA-MV-1 — Spec 52 §2 Three.js + glb viewer (Task #159).**
  Commit `f13d5fb` (_DA-MV-1 (Task #159) — Spec 52 §2 Three.js + glb viewer
  end-to-end_). End-to-end glb playback in design-tools, mock-by-default
  upstream so no Cloud Run dependency for local dev.
- **DA-PI-2 — Federal site-context adapters (Task #118).**
  Commit `9e6398d` (_DA-PI-2: Federal site-context adapters (FEMA, USGS, EPA,
  FCC)_). FEMA flood, USGS topo, EPA layers, FCC siting brought online behind
  the federal-adapters surface in `lib/adapters`.
- **DA-PI-3 — Briefing engine for A–G site briefings.**
  Commit `b3851c1` (_DA-PI-3: Briefing engine for A–G site briefings_). The
  Anthropic-backed generator with a mock fallback that produces the seven-
  section narrative consumed by `parcel-briefing`. Lives in
  `lib/briefing-engine`.
- **DA-PI-4 — State + local adapters + Generate Layers endpoint/UI.**
  Commit `de7c677` (_DA-PI-4 — state + local adapters + Generate Layers
  endpoint/UI_). Brought UT/ID state and Grand / Lemhi local adapters online,
  added the `POST /api/engagements/:id/site-context/generate-layers` endpoint,
  and wired the Generate Layers button into the Site Context tab. Surfaced
  the four open questions tracked in `02-open-questions.md`.
- **DA-PI-5 (api-server side) — Revit sensor materialization.**
  Commit `816c15c` (_DA-PI-5: Revit sensor materialization (design-tools
  side)_) plus `8489655` (_Register materializable-element atom and turn on
  briefing emission_). Registered `bim-model`, `materializable-element`, and
  `briefing-divergence`; added `materializable-element.identified` emission
  from the briefing-generate route (Task #175). The C# side of DA-PI-5 is
  out of scope here and is hand-shaken to Claude Code on the
  `legacy-revit-sensor` repo.
- **Briefing-source history + restore (Task #139).**
  Commit `624c796` (_Task #139: Let users see and roll back superseded
  briefing source uploads_). Adds visible supersession history and an
  architect-driven rollback path for briefing-source uploads.

In addition to the headline sprints above, ~130 polish / coverage / UX
follow-ups landed across the wave (range `4e73ad5..HEAD`). Highlights
relevant to Wave 2 entry: per-engagement empty-pilot pill (Task #235 / #278),
recent-runs disclosure (Task #230 / #261), shareable filter URLs (Task #275
/ #290), per-row "Refresh this layer" (Task #228), federal stale-cache
warnings (Task #227), parcel-briefing → producing-run FK (Task #281), and
cluster-wide sweep-lock helper (Task #260).

---

## B. Atom registry final state

Eleven atoms registered at boot. Source of truth:
`artifacts/api-server/src/atoms/registry.ts`.

| # | `entityType` | `entityId` pattern | Level | Sprint that registered it |
|---|---|---|---|---|
| 1 | `sheet` | sheet UUID | data-level | A1 (pre-DA-PI-1; commit `19fc85c`) |
| 2 | `snapshot` | snapshot UUID | data-level | A2 (Task #21; commit `10d7288`) |
| 3 | `engagement` | engagement UUID | app-level | A3 (commit `7a060cd`) |
| 4 | `submission` | submission UUID | data-level | A4 / Task #63 (commit `0cc3ebc`) |
| 5 | `parcel-briefing` | parcel-briefing UUID | app-level | DA-PI-1 (commit `d936f2d`) |
| 6 | `intent` | intent UUID | data-level | DA-PI-1 (commit `d936f2d`) |
| 7 | `briefing-source` | briefing-source UUID | data-level | DA-PI-1 (commit `d936f2d`) |
| 8 | `neighboring-context` | neighboring-context UUID | data-level | DA-PI-1 (commit `d936f2d`) |
| 9 | `materializable-element` | materializable-element UUID | data-level | DA-PI-5 (commit `816c15c`) |
| 10 | `briefing-divergence` | briefing-divergence UUID | data-level | DA-PI-5 (commit `816c15c`) |
| 11 | `bim-model` | bim-model UUID | app-level | DA-PI-5 (commit `816c15c`) |

Boot count: **11**. `bootstrapAtomRegistry()` logs each registration with its
`entityType`, `domain`, `defaultMode`, and declared `eventTypes` so the boot
log is the operator surface for verifying registry shape.

App-level vs data-level classification follows the convention that an
app-level atom is the one a user-facing surface treats as the unit of
interaction (`engagement`, `parcel-briefing`, `bim-model`); data-level atoms
are the leaves and edges those surfaces compose over.

---

## C. Test infrastructure final state

Suite counts (test-file inventory at HEAD; run via `pnpm -r test`):

| Package | Test files | Notes |
|---|---|---|
| `artifacts/api-server` | 41 | Unit + route + atom-contract tests under `src/__tests__`. |
| `artifacts/design-tools` | 23 | Component + page tests under `src/{components,pages,lib}/__tests__`. |
| `artifacts/plan-review` | 6 | Component + page tests under `src/{components,pages}/__tests__`. |
| `lib/adapters` | 11 | Federal / state / local adapter coverage + cache, eligibility, runner. |
| `lib/codes` | 8 | Bootstrap, embeddings, retrieval, jurisdictions, content-hash, queue, prompt formatter, orchestrator. |
| `lib/briefing-engine` | 7 | Engine, mock + Anthropic generators, prompt, citation validator, source categories, materializable elements. |
| `lib/empressa-atom` | 9 | Composition, registry, scope, render, context, vda, inline-reference, integration, types. |
| `lib/db` | 3 | Schema integration tests. |
| `lib/codes-sources` | 4 | Municode, Grand-County HTML / PDF, codePublishingHtml. |

End-to-end coverage lives in `artifacts/design-tools/e2e/` (Playwright):
13 specs covering snapshot timeline, submission round-trip, federal layer
render + summary chips + copy-summary button, generate-layers, briefing
citation pills, recent-runs deep link, dxf upload + 3D render, site-context
summary chips, submit-to-jurisdiction, record-submission-response, and
timeline-backfill-filter.

**Pre-merge gate composition.** Three workflows run in parallel — `typecheck`,
`test`, `e2e` — for a wall clock of approximately ~56 seconds at present.
Parallelisation was introduced specifically to keep the gate fast as the
suite grew across DA-PI-3 / DA-PI-4. The gate must run green before any
Wave 1 → Wave 2 transition is declared (see `03-wave-2-entry-notes.md` §A).

---

## D. Production deployment state

Last published deployment commit: **`666880c`** (`Published your App`,
May 1 2026 18:52 UTC). This is HEAD as of this report. Confirmed against
the recent summary reference; no drift.

Mode posture in production:

- **Mock mode.** Briefing-engine generator (default `mock`; `ANTHROPIC_*`
  env opts into real LLM); DXF→glb converter (Task #160 still in flight on
  the Cloud Run side); any external adapter fetch the env hasn't opted into.
- **Real-service mode.** Federal adapters (FEMA / USGS / EPA / FCC)
  configured against live upstream feeds with cache + freshness warnings;
  state + local adapters (Grand / Lemhi / Bastrop, statewide UT / ID
  fallbacks) against live upstream feeds; Postgres event-anchoring + atom
  registry; Replit Auth on the user surfaces; object storage for sheet +
  snapshot + briefing-source uploads.

The MockClient → HttpClient pluggable interface (see §F) means a single env
flag flips any adapter from mock to real without code changes — the
production flip for Wave 2 (`MNML_RENDER_MODE=mock|http`) follows the same
pattern.

---

## E. Workflow / dev-env known issues

The recurring orphan-process pattern that appeared throughout Wave 1:

- **Symptom.** A workflow restart fails with `EADDRINUSE` on **`8080`** (api-
  server), **`20295`** (design-tools dev server), or **`19591`** (plan-review
  dev server). The previous server process is still bound to the port; the
  new process refuses to start.
- **Restart procedure.** Use the workflow control to restart the affected
  workflow. The platform-managed shutdown sends `SIGTERM` followed by
  `SIGKILL`; that is sufficient in every case observed during Wave 1.
- **Standing rule.** _Do not investigate `EADDRINUSE` on these ports as a
  code or schema issue unless restarting the workflow fails to clear it._
  Every Wave 1 occurrence has been an orphan listener; investigating it as a
  code regression is wasted effort.

If a restart genuinely fails to clear the bind (no instance observed in
Wave 1), the next escalation is to flag the workflow as stuck — do not
patch ports or shuffle env vars to work around it.

---

## F. Coordination patterns that worked

Three patterns proved robust across Wave 1 and should carry into Wave 2:

1. **Parallel sprint dispatch.** DA-PI-1 through DA-PI-5 ran with overlapping
   sprint families. The atom catalog's "register early, validate at boot"
   contract let later sprints declare forward-ref edges to atoms that hadn't
   landed yet, so sprints could merge in any order without re-coordination.
2. **MockClient → HttpClient pluggable interfaces.** Every external surface
   (briefing-engine generator, federal/state/local adapters, DXF→glb
   converter) ships a structurally typed mock first and flips to a real
   client behind an env flag. Tests run offline by construction; production
   flips are single-flag changes, not refactors.
3. **The polish-bundle pattern.** Eight loosely-related follow-ups grouped
   into one ordered sprint with a single pre-merge gate run, instead of
   eight independent sprints with eight independent gate runs. Wave 1 used
   this twice; the second instance is the in-flight Wave 1 polish bundle
   sibling sprint to this report. Recommended default for Wave 2 cleanup.
