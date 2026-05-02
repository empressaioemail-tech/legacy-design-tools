# Wave 1 Open Questions Docket

Carried forward from DA-PI-4 plus any new questions surfaced by the sibling
Wave 1 sprints (DA-PI-6 PDF stakeholder export and the Wave 1 polish bundle).
Each entry: **statement** → **recommended answer** →
**Empressa to confirm Y/N at desktop session**.

---

## DA-PI-4 carry-forward

### Q1. Generate Layers test fixture drift

The `generate-layers.test.ts` route test currently uses fake adapter keys
(`utah:ugrc-parcels`, `texas:tceq-floodplain`, `bastrop-tx:roads`) that don't
exist in the real `ALL_ADAPTERS` registry. Should we align the route test
fakes with real registry keys, or replace the route test with a thin
integration test that runs the real `ALL_ADAPTERS` against fixture-backed
fetch?

- **Recommended answer.** Addressed by the Wave 1 polish bundle, sub-task
  B.1 (sibling sprint). B.1's recon picks the lower-churn path between the
  two options and lands the fix as its first commit so the broader test
  surface is clean before later polish sub-tasks run.
- **Empressa to confirm Y/N at desktop session:** confirm the chosen path
  matches preference once the polish bundle's Phase 4 report lands.

### Q2. Bastrop roads adapter

Should we add a Bastrop, TX roads adapter for parity with Grand County and
Lemhi County, or stay with the standing comment that SmartCity-OS uses OSM
directly for Bastrop roads?

- **Recommended answer.** Stay with OSM-direct for now. Adding a Bastrop
  roads adapter is net-new adapter maintenance burden for a jurisdiction
  whose road data is already adequately served by the existing OSM path.
  Revisit if the OSM path proves insufficient under real architect use.
- **Empressa to confirm Y/N at desktop session.**

### Q3. Statewide-fallback setback tables

Statewide-fallback setback tables exist for `utah-unincorporated` and
`idaho-unincorporated`. Should these be reflected in the spec docs as a
named first-class concept, or is it fine to leave them as discovered
implementation detail?

- **Recommended answer.** Fine as discovered. The fallback tables already
  have honest per-row provenance and are clearly labelled in the adapter
  output; promoting them to spec-level concepts adds doc surface without
  changing behaviour. Revisit if a third statewide-fallback table appears.
- **Empressa to confirm Y/N at desktop session.**

### Q4. `texas-unincorporated` fallback table

There is no `texas-unincorporated` setback fallback table. Was this an
intentional skip, or a follow-up to add?

- **Recommended answer.** Intentional skip — Texas unincorporated zoning is
  effectively non-existent at the state level (counties have no zoning
  authority absent special charter), so a statewide fallback table would
  produce more confusion than signal. Document the rationale in the
  adapter README rather than adding the table.
- **Empressa to confirm Y/N at desktop session.**

---

## New questions from sibling Wave 1 sprints

The sibling sprints to this docs sprint are **DA-PI-6 — PDF Stakeholder
Briefing Export** (Task A) and the **Wave 1 Polish Bundle** (Task B). Per
the sprint brief, sub-agent C polls their Phase 4 reports and appends any
new open questions before declaring this docket complete.

### Status at time of writing

No Phase 4 reports from Tasks A or B were on file in this isolated agent
environment when this docket was first drafted. The roll-up section below
is the placeholder; Empressa (or the next agent picking up the docket) is
the merge point for the sibling-sprint additions when their Phase 4
reports land.

### Roll-up from Task A (DA-PI-6 PDF stakeholder export)

_Append entries here when Task A's Phase 4 report is on file. Expected
candidate areas, based on the sprint brief: Puppeteer image footprint
trade-off, print-only Cesium / Three.js viewport route conventions,
`users.architect_pdf_header` editor-UI follow-up, and any sync-vs-async
re-evaluation if real-world generation exceeds the 5 s wall-clock budget._

### Roll-up from Task B (Wave 1 polish bundle)

_Append entries here when Task B's Phase 4 report is on file. Expected
candidate areas, based on the sprint brief: B.1 chosen-path confirmation
(see Q1 above; cross-link rather than duplicate), B.2 plan-review/​
design-tools chip-component lift decision, B.5 diff-library choice, B.7
post-merge.sh integration check, B.8 pruned-run annotation copy._

---

## Docket totals

- **Carry-forward questions:** 4
- **Sibling-sprint additions:** 0 (pending Task A + Task B Phase 4 roll-up)
- **Total open at HEAD `666880c`:** 4

When the sibling-sprint roll-up completes, update the totals and the date.

---

## Resolved (V1-5, 2026-05-02)

The four DA-PI-4 carry-forward questions above (Q1-Q4) were resolved per
the recommended answers and documented at the closest meaningful
location in the codebase rather than expanding spec docs:

- **Q1.** Annotated in
  `artifacts/api-server/src/__tests__/generate-layers.test.ts`
  (file-header JSDoc) — keep route fakes.
- **Q2.** Annotated in `lib/adapters/src/local/bastrop-tx.ts`
  (file-header JSDoc) — stay with OSM-direct.
- **Q3.** Documented in `lib/adapters/src/local/setbacks/README.md` —
  new "Statewide fallback tables" section.
- **Q4.** Documented in `lib/adapters/src/local/setbacks/README.md` —
  subsection "Why no texas-unincorporated table".

Sibling-sprint roll-up sections above remain placeholders pending Task A
+ Task B Phase 4 reports.
