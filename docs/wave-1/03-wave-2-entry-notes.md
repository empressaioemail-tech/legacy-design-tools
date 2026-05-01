# Wave 2 Entry Notes

Notes for the Wave 1 → Wave 2 transition, the prerequisites Empressa owes at
the desktop session before Wave 2 sprints dispatch, the Wave 2 sprint
sequence outline, the explicit out-of-scope list for the first Wave 2 sprint
family, and the mnml.ai design-portal vision the wave is delivering toward.

---

## A. Wave 1 → Wave 2 transition gates

Before any Wave 2 sprint dispatches, the following must hold green:

1. **Pre-merge validation gate green.** `typecheck`, `test`, and `e2e`
   workflows all green at HEAD. Reference wall clock: ~56 s when run in
   parallel.
2. **All dev workflows green.** `artifacts/api-server`, `artifacts/design-
   tools`, `artifacts/plan-review`, and `artifacts/mockup-sandbox` start
   cleanly without `EADDRINUSE` on ports 8080 / 20295 / 19591 / mockup-
   sandbox port. Restart procedure per
   `01-closeout-report.md` §E if a port is wedged on first start.
3. **All 11 atom contract tests green.** One contract test per atom in
   `artifacts/api-server/src/__tests__/*-atom.test.ts`:
   `sheet`, `snapshot`, `engagement`, `submission`, `parcel-briefing`,
   `intent`, `briefing-source`, `neighboring-context`, `bim-model`,
   `materializable-element`, `briefing-divergence`. Boot count `11`
   logged by `bootstrapAtomRegistry()`.
4. **Full e2e suite green.** All 13 Playwright specs in
   `artifacts/design-tools/e2e/` plus any specs the polish bundle adds
   (B.6 — recent-runs deep-link parity on plan-review).

If any gate is red, escalate to Empressa rather than dispatching Wave 2.

---

## B. Wave 2 prerequisites Empressa owes

Empressa owes one thing at the desktop session before Wave 2 dispatches:

- **Spec 54 — viewpoint-render atom + mnml.ai integration architecture.**
  Drafted at desktop. Sub-agents do not draft Spec 54 — this docs sprint
  only points at it as a Wave 2 prerequisite. Once Spec 54 lands in
  `/mnt/project/`, DA-RP-1 has the contract it needs to register the
  `viewpoint-render` atom and stand up the `mnml.ai` client.

The pluggable mock-by-default pattern (env flag `MNML_RENDER_MODE = mock |
http`) is the locked default and does not need to be re-litigated in
Spec 54 — Spec 54 covers the wire contract, capability shape, and
viewpoint metadata schema.

---

## C. Wave 2 sprint sequence outline

The Wave 2 sprint family delivers the mnml.ai design-portal vision
incrementally:

- **DA-RP-1 — viewpoint-render atom registration + mnml.ai client +
  render-trigger endpoint.** Registers `viewpoint-render` in the api-server
  atom registry, lands the mnml.ai client behind a pluggable interface
  (mock by default; env flag `MNML_RENDER_MODE = mock | http`), and adds
  `POST /api/engagements/:id/renders` (or the endpoint Spec 54 names) as
  the trigger surface. Mock generator returns a fixture image; HTTP
  generator round-trips against mnml.ai. Atom contract tests follow the
  Wave 1 atom-contract precedent.
- **DA-RP-2 — render trigger UI in engagement.** UI surface in
  design-tools' engagement detail page that fires DA-RP-1's trigger
  endpoint and shows an in-flight state. Mirrors the Generate Layers /
  Re-run surface conventions from Wave 1.
- **DA-RP-3 — render gallery + history + per-render viewpoint metadata.**
  Gallery view of the renders attached to an engagement, history of prior
  triggers, per-render metadata (camera position, viewpoint name, time of
  day, etc.). Builds on DA-RP-2's trigger surface; reuses the recent-runs
  disclosure pattern shipped in Wave 1 (Tasks #230 / #261 / #275 / #290).
- **DA-RP-4 — video generation surface.** Adds the mnml.ai video-render
  capability behind the same pluggable client. Same atom (`viewpoint-
  render`) with a `kind` discriminator, or a sibling atom (`viewpoint-
  video-render`) — Spec 54 decides which.
- **DA-RP-5 — customer-portal render exposure (Wave 4 timing).** Exposes
  selected renders to the customer-review portal. **Lands during Wave 4**,
  not within the Wave 2 family — listed here for sequence visibility only.

Sprints DA-RP-1 through DA-RP-4 are the **Wave 2 milestone** (full
mnml.ai design-portal capability). DA-RP-5 is the Wave 4 follow-on
that exposes the capability outward to customers.

---

## D. Out of scope for the Wave 2 first sprint family

Explicitly **not** in scope for DA-RP-1 → DA-RP-4:

- **Compliance checker.** Wave 3 milestone, not Wave 2.
- **Customer-review portal write surface.** Wave 4 milestone (read surface
  exposure is DA-RP-5; writes come later).
- **Custom architect-authored adapters.** No Wave 2 sprint exposes a
  surface for an architect to author new site-context adapters. This is
  potential Wave 5 territory, not Wave 2.
- **Multi-parcel / assemblage briefings.** Wave 5 milestone. Wave 2's
  `viewpoint-render` operates on a single existing `parcel-briefing` per
  trigger.
- **Real-time collaboration on briefings.** Wave 5 milestone.
- **Real Cloud Run DXF→glb converter.** Tracked separately as **Task
  #160**; the mock client + pluggable interface in `lib/adapters` is the
  Wave 2 contract surface; the real Cloud Run service ships under Task
  #160 outside of any sprint family.
- **C# side of DA-PI-5 (Revit add-in materialization).** Tracked as
  **Claude Code work on the `legacy-revit-sensor` repo**, not within any
  Replit-side wave. The api-server side is already shipped in Wave 1.

---

## E. The mnml.ai design-portal vision

Quoting Empressa: _"design portal with the ability to render interior,
exterior elevations, make videos, everything that company has to offer."_

The Wave 2 sprint family (DA-RP-1 → DA-RP-4) delivers this vision
incrementally:

- DA-RP-1 stands up the contract (atom + client + endpoint) so any
  surface can fire a render.
- DA-RP-2 puts the trigger in the architect's hand on the engagement
  detail page.
- DA-RP-3 turns one-shot renders into an inspectable gallery with
  per-render viewpoint metadata, so the architect can iterate on the
  same parcel-briefing.
- DA-RP-4 adds the video-generation capability so the surface covers the
  full mnml.ai feature set ("interior, exterior elevations, make videos").

The Wave 2 milestone is reached when DA-RP-4 ships green. DA-RP-5 then
exposes the same capability through the customer-review portal during
Wave 4, completing the mnml.ai-design-portal-as-stakeholder-deliverable
arc.
