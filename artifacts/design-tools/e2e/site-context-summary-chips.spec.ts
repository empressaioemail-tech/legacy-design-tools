/**
 * End-to-end regression test for the cross-tier Site Context summary
 * chips rendered inside each `briefing-source-<id>` row (Task #214,
 * expanded by Task #231).
 *
 * Why this test exists: federal-tier chips are already pinned by
 * `federal-summary-chips.spec.ts` (one row per federal adapter), and
 * the per-tier formatters in `lib/adapters/src/state/summaries.ts` and
 * `lib/adapters/src/local/summaries.ts` are unit-tested in isolation.
 * What is *not* covered today is the wiring inside `BriefingSourceRow`
 * for the state and local tiers — the `summarizeStatePayload` /
 * `summarizeLocalPayload` switch arms and, *inside* each of them, the
 * per-`layerKind` arms in the dispatcher. A regression in any single
 * arm (e.g. someone renamed `tceq-edwards-aquifer` →
 * `tceq-aquifer` in only the dispatcher, or dropped the
 * `bastrop-tx-floodplain` arm) would silently turn that row into a
 * no-chip render and ship without catching it because no test walks
 * the wire seam:
 *
 *     briefing_sources.payload (jsonb)
 *        → toBriefingSourceWire (parcelBriefings.ts)
 *        → GET /api/engagements/:id/briefing
 *        → useGetEngagementBriefing
 *        → BriefingSourceRow → summarizeStatePayload(layerKind, payload)
 *                            / summarizeLocalPayload(layerKind, payload)
 *                            / summarizeFederalPayload(layerKind, payload)
 *        → <div data-testid="briefing-source-summary-<id>">{chip}</div>
 *
 * This spec is the cross-tier complement to
 * `federal-summary-chips.spec.ts`: it seeds **one row per state-tier
 * layer kind** (`ugrc-dem`, `ugrc-parcels`, `ugrc-address-points`,
 * `inside-idaho-dem`, `inside-idaho-parcels`, `tceq-edwards-aquifer`),
 * **one row per local-tier layer kind** (`grand-county-ut-parcels`/
 * `zoning`/`roads`, `lemhi-county-id-parcels`/`zoning`/`roads`,
 * `bastrop-tx-parcels`/`zoning`/`floodplain`), plus a single
 * federal-tier row to keep the cross-tier wire-seam check honest. It
 * asserts each chip text exactly, and fails if the chip is dropped or
 * mis-formatted for any individual layer kind.
 *
 * Strategy:
 *
 *   1. Insert a clean Bastrop TX engagement directly via `@workspace/db`
 *      (Bastrop is one of the three DA-PI-4 pilot jurisdictions and
 *      is the same shape the sibling federal/local seed specs use, so
 *      the engagement seed shape stays consistent).
 *
 *   2. Insert one parent `parcel_briefings` row and one child
 *      `briefing_sources` row per (tier, layerKind) pair directly in
 *      the DB. Each row carries the `sourceKind` literal that gates
 *      `BriefingSourceRow`'s tier dispatch (`federal-adapter` /
 *      `state-adapter` / `local-adapter`), the `layerKind` literal
 *      the corresponding adapter emits (so the matching switch arm
 *      runs inside `summarizeStatePayload` / `summarizeLocalPayload`),
 *      and a payload whose shape mirrors what the adapter persists
 *      AND what the formatter reads. Going through the DB rather than
 *      `/generate-layers` keeps this spec deterministic and free of
 *      live network calls to FEMA / UGRC / TCEQ / county GIS / etc.
 *
 *   3. Drive the UI through Playwright: open the engagement on the
 *      Site Context tab and, for each seeded row, look up its
 *      `briefing-sources-tier-<tier>` group, then assert the
 *      per-source row's `briefing-source-summary-<id>` element
 *      renders the expected chip text. The expected strings are
 *      pinned verbatim and chosen to be unique across all seeded
 *      rows — a regression in any single layer-kind switch arm
 *      fails its own assertion with a clear text diff instead of
 *      bleeding past a permissive matcher or another row's text.
 */

import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  db,
  engagements,
  parcelBriefings,
  briefingSources,
} from "@workspace/db";

const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PROJECT_NAME = `e2e Site Context Summary Chips ${RUN_TAG}`;

let engagementId = "";
let briefingId = "";
const sourceIdsByLayerKind = new Map<string, string>();

/**
 * One briefing-source row per (tier, layerKind) pair the Site Context
 * tab can render.
 *
 * Each entry pins:
 *
 *   - `tier` / `sourceKind`: the discriminator
 *     `BriefingSourceRow` reads to decide which `summarize*Payload`
 *     branch to enter; also the testid bucket
 *     (`briefing-sources-tier-<tier>`) the row is rendered under.
 *   - `layerKind` / `provider`: literal values the corresponding
 *     adapter would emit on a live `/generate-layers` run, so the
 *     seed is an honest stand-in for a production briefing row.
 *     The `layerKind` is what selects the per-arm formatter inside
 *     each tier dispatcher — covering every arm is the point of
 *     this spec.
 *   - `payload`: the structured shape the matching `summarize*Payload`
 *     formatter reads (mirroring the unit-test fixtures in
 *     `lib/adapters/src/__tests__/`).
 *   - `expectedChip`: the exact human-readable string the chip
 *     should render. Pinned verbatim **and unique across the entire
 *     seed set** so that a regression which accidentally rendered
 *     another row's text under the wrong testid still fails with a
 *     clear diff, instead of bleeding past a permissive
 *     `toContainText` matcher or a coincidentally-equal sibling
 *     chip.
 */
const TIERED_SEED_ROWS = [
  // ----- Federal tier (single row; full federal coverage lives in
  //       federal-summary-chips.spec.ts). Kept here to preserve the
  //       cross-tier wire-seam check this spec was originally about. -----
  {
    tier: "federal",
    sourceKind: "federal-adapter",
    layerKind: "fema-nfhl-flood-zone",
    provider: "FEMA National Flood Hazard Layer (NFHL)",
    payload: {
      kind: "flood-zone",
      inSpecialFloodHazardArea: true,
      floodZone: "AE",
      baseFloodElevation: 425.5,
      features: [],
    },
    note: "Seeded by site-context-summary-chips.spec.ts (federal cross-tier check)",
    expectedChip: "Flood Zone AE · BFE 425.5 ft",
  },

  // ----- State tier: one row per layerKind in summarizeStatePayload -----
  // UGRC DEM (Utah) — elevation contours, exercises the singular noun
  // path so a regression in the singular/plural branch fails here.
  {
    tier: "state",
    sourceKind: "state-adapter",
    layerKind: "ugrc-dem",
    provider: "UGRC Statewide DEM",
    payload: {
      kind: "elevation-contours",
      featureCount: 1,
      features: [{}],
    },
    note: "Seeded by site-context-summary-chips.spec.ts (ugrc-dem)",
    expectedChip: "1 elevation contour nearby",
  },
  // UGRC parcels — id + acres, exercises the canonical id+acres
  // branch of summarizeParcelPayload.
  {
    tier: "state",
    sourceKind: "state-adapter",
    layerKind: "ugrc-parcels",
    provider: "UGRC Statewide Parcels",
    payload: {
      kind: "parcel",
      parcel: {
        attributes: { PARCEL_ID: "U-101", ACRES: 0.42 },
      },
    },
    note: "Seeded by site-context-summary-chips.spec.ts (ugrc-parcels)",
    expectedChip: "Parcel U-101 · 0.42 ac",
  },
  // UGRC address points — full-address column present.
  {
    tier: "state",
    sourceKind: "state-adapter",
    layerKind: "ugrc-address-points",
    provider: "UGRC Statewide Address Points",
    payload: {
      kind: "address-point",
      feature: { attributes: { FullAdd: "100 Main St" } },
    },
    note: "Seeded by site-context-summary-chips.spec.ts (ugrc-address-points)",
    expectedChip: "Address: 100 Main St",
  },
  // INSIDE Idaho DEM — elevation contours, plural-noun path with a
  // distinct count from the UGRC DEM row so a regression that
  // accidentally swapped the two layer kinds would fail here.
  {
    tier: "state",
    sourceKind: "state-adapter",
    layerKind: "inside-idaho-dem",
    provider: "INSIDE Idaho DEM",
    payload: {
      kind: "elevation-contours",
      featureCount: 8,
      features: [],
    },
    note: "Seeded by site-context-summary-chips.spec.ts (inside-idaho-dem)",
    expectedChip: "8 elevation contours nearby",
  },
  // INSIDE Idaho parcels — id only (no acres), exercises the
  // id-without-acres branch of summarizeParcelPayload.
  {
    tier: "state",
    sourceKind: "state-adapter",
    layerKind: "inside-idaho-parcels",
    provider: "INSIDE Idaho Parcels",
    payload: {
      kind: "parcel",
      parcel: { attributes: { PARCEL_ID: "I-202" } },
    },
    note: "Seeded by site-context-summary-chips.spec.ts (inside-idaho-parcels)",
    expectedChip: "Parcel I-202",
  },
  // TCEQ Edwards Aquifer — uniquely state-tier (no equivalent
  // federal/local layer) and produces a chip that exercises the
  // recharge-vs-contributing branch logic in the formatter.
  {
    tier: "state",
    sourceKind: "state-adapter",
    layerKind: "tceq-edwards-aquifer",
    provider: "TCEQ Edwards Aquifer",
    payload: {
      kind: "edwards-aquifer",
      inRecharge: true,
      inContributing: false,
    },
    note: "Seeded by site-context-summary-chips.spec.ts (tceq-edwards-aquifer)",
    expectedChip: "In Edwards Aquifer recharge zone",
  },

  // ----- Local tier: one row per layerKind in summarizeLocalPayload -----
  // Grand County, UT parcels — id + acres distinct from the UGRC
  // parcel chip so a regression that swapped the two switch arms
  // surfaces a text diff.
  {
    tier: "local",
    sourceKind: "local-adapter",
    layerKind: "grand-county-ut-parcels",
    provider: "Grand County, UT Parcels",
    payload: {
      kind: "parcel",
      parcel: { attributes: { PARCEL_ID: "G-301", ACRES: 0.5 } },
    },
    note: "Seeded by site-context-summary-chips.spec.ts (grand-county-ut-parcels)",
    expectedChip: "Parcel G-301 · 0.5 ac",
  },
  // Grand County, UT zoning — code + description, exercises the
  // canonical "Zoning <code> · <desc>" branch of summarizeZoningPayload.
  {
    tier: "local",
    sourceKind: "local-adapter",
    layerKind: "grand-county-ut-zoning",
    provider: "Grand County, UT Zoning",
    payload: {
      kind: "zoning",
      zoning: {
        attributes: {
          ZONE_CODE: "R-1",
          ZONE_DESC: "Single-Family Residential",
        },
      },
    },
    note: "Seeded by site-context-summary-chips.spec.ts (grand-county-ut-zoning)",
    expectedChip: "Zoning R-1 · Single-Family Residential",
  },
  // Grand County, UT roads — OSM fallback path, surfaces the search
  // radius. Exercises the OSM branch of summarizeRoadsPayload.
  {
    tier: "local",
    sourceKind: "local-adapter",
    layerKind: "grand-county-ut-roads",
    provider: "OpenStreetMap (via Overpass)",
    payload: {
      kind: "roads",
      source: "osm",
      radiusMeters: 100,
      elements: [{}, {}],
    },
    note: "Seeded by site-context-summary-chips.spec.ts (grand-county-ut-roads)",
    expectedChip: "2 road segments within 100m (OSM)",
  },
  // Lemhi County, ID parcels — id only, distinct id from the
  // INSIDE-Idaho parcels row so a swap of the two switch arms
  // surfaces a text diff.
  {
    tier: "local",
    sourceKind: "local-adapter",
    layerKind: "lemhi-county-id-parcels",
    provider: "Lemhi County, ID Parcels",
    payload: {
      kind: "parcel",
      parcel: { attributes: { PARCEL_ID: "L-403" } },
    },
    note: "Seeded by site-context-summary-chips.spec.ts (lemhi-county-id-parcels)",
    expectedChip: "Parcel L-403",
  },
  // Lemhi County, ID zoning — code only, exercises the
  // code-without-description branch of summarizeZoningPayload.
  {
    tier: "local",
    sourceKind: "local-adapter",
    layerKind: "lemhi-county-id-zoning",
    provider: "Lemhi County, ID Zoning",
    payload: {
      kind: "zoning",
      zoning: { attributes: { ZONE_CODE: "AG-1" } },
    },
    note: "Seeded by site-context-summary-chips.spec.ts (lemhi-county-id-zoning)",
    expectedChip: "Zoning AG-1",
  },
  // Lemhi County, ID roads — county-GIS path, exercises the
  // county-gis branch of summarizeRoadsPayload (and the plural noun).
  {
    tier: "local",
    sourceKind: "local-adapter",
    layerKind: "lemhi-county-id-roads",
    provider: "Lemhi County, ID Roads",
    payload: {
      kind: "roads",
      source: "county-gis",
      features: [{}, {}, {}],
    },
    note: "Seeded by site-context-summary-chips.spec.ts (lemhi-county-id-roads)",
    expectedChip: "3 road segments (county GIS)",
  },
  // Bastrop County, TX parcels — acres only (no id column),
  // exercises the acres-without-id branch of summarizeParcelPayload.
  {
    tier: "local",
    sourceKind: "local-adapter",
    layerKind: "bastrop-tx-parcels",
    provider: "Bastrop County, TX Parcels",
    payload: {
      kind: "parcel",
      parcel: { attributes: { ACRES: 12.34 } },
    },
    note: "Seeded by site-context-summary-chips.spec.ts (bastrop-tx-parcels)",
    expectedChip: "Parcel · 12.34 ac",
  },
  // Bastrop County, TX zoning — code + description distinct from the
  // Grand-County zoning chip so a regression that swapped the two
  // switch arms surfaces a text diff.
  {
    tier: "local",
    sourceKind: "local-adapter",
    layerKind: "bastrop-tx-zoning",
    provider: "Bastrop County, TX Zoning",
    payload: {
      kind: "zoning",
      zoning: {
        attributes: { ZONE_CODE: "MF-2", ZONE_DESC: "Multi-Family" },
      },
    },
    note: "Seeded by site-context-summary-chips.spec.ts (bastrop-tx-zoning)",
    expectedChip: "Zoning MF-2 · Multi-Family",
  },
  // Bastrop County, TX floodplain — uniquely local-tier (no
  // equivalent state/federal-tier layer in the registry); exercises
  // the in-floodplain-with-zone branch of summarizeFloodplainPayload.
  {
    tier: "local",
    sourceKind: "local-adapter",
    layerKind: "bastrop-tx-floodplain",
    provider: "Bastrop County, TX Floodplain",
    payload: {
      kind: "floodplain",
      inMappedFloodplain: true,
      features: [{ attributes: { FLD_ZONE: "AE" } }],
    },
    note: "Seeded by site-context-summary-chips.spec.ts (bastrop-tx-floodplain)",
    expectedChip: "In mapped floodplain (Zone AE)",
  },
] as const;

test.beforeAll(async () => {
  // 1. Seed the engagement. Bastrop, TX → resolves to the
  //    `bastrop-tx` / `texas` jurisdiction, one of the three
  //    DA-PI-4 pilots (matches the sibling federal/local seed
  //    specs).
  const [eng] = await db
    .insert(engagements)
    .values({
      name: TEST_PROJECT_NAME,
      nameLower: TEST_PROJECT_NAME.toLowerCase(),
      jurisdiction: "Bastrop, TX",
      jurisdictionCity: "Bastrop",
      jurisdictionState: "TX",
      jurisdictionFips: "48021",
      address: "214 E2E Summary St, Bastrop, TX 78602",
      latitude: "30.110500",
      longitude: "-97.318600",
      status: "active",
    })
    .returning();
  if (!eng) throw new Error("seed: engagement insert returned no row");
  engagementId = eng.id;

  // 2. Seed the parent parcel_briefings row. Engagement_id is
  //    uniquely indexed so we don't need to clear anything first.
  const [briefing] = await db
    .insert(parcelBriefings)
    .values({
      engagementId,
    })
    .returning();
  if (!briefing) throw new Error("seed: parcel_briefings insert returned no row");
  briefingId = briefing.id;

  // 3. Seed one briefing_sources row per (tier, layerKind) pair. The
  //    `sourceKind` value is the gate `BriefingSourceRow` reads to
  //    enter the right `summarize*Payload` branch; `layerKind`
  //    selects the per-arm formatter inside that branch (the thing
  //    this spec exists to cover); `payload` is what the formatter
  //    reads.
  //
  //    Sanity-check that every seed row is unique on `layerKind` —
  //    `sourceIdsByLayerKind` keys on it below, so a duplicate would
  //    silently drop coverage of one of the layer kinds without
  //    failing the spec. Catching it here points at the seed table
  //    instead of letting the loop "succeed" with a collapsed map.
  {
    const seen = new Set<string>();
    for (const row of TIERED_SEED_ROWS) {
      if (seen.has(row.layerKind)) {
        throw new Error(
          `seed: duplicate layerKind ${row.layerKind} in TIERED_SEED_ROWS — every seed row must cover a distinct switch arm`,
        );
      }
      seen.add(row.layerKind);
    }
  }
  // Likewise sanity-check that every expected chip text is unique —
  // duplicate chips would let a regression that rendered a sibling
  // row's text under the wrong testid still pass.
  {
    const seenChips = new Set<string>();
    for (const row of TIERED_SEED_ROWS) {
      if (seenChips.has(row.expectedChip)) {
        throw new Error(
          `seed: duplicate expectedChip "${row.expectedChip}" in TIERED_SEED_ROWS — chips must be unique so a wrong-row regression fails the right assertion`,
        );
      }
      seenChips.add(row.expectedChip);
    }
  }
  const inserted = await db
    .insert(briefingSources)
    .values(
      TIERED_SEED_ROWS.map((row) => ({
        briefingId,
        layerKind: row.layerKind,
        sourceKind: row.sourceKind,
        provider: row.provider,
        payload: row.payload,
        note: row.note,
      })),
    )
    .returning({ id: briefingSources.id, layerKind: briefingSources.layerKind });
  for (const row of inserted) {
    sourceIdsByLayerKind.set(row.layerKind, row.id);
  }
  if (sourceIdsByLayerKind.size !== TIERED_SEED_ROWS.length) {
    throw new Error(
      `seed: expected ${TIERED_SEED_ROWS.length} briefing_sources rows, got ${sourceIdsByLayerKind.size}`,
    );
  }
});

test.afterAll(async () => {
  if (engagementId) {
    // FK cascade: engagement → parcel_briefings → briefing_sources.
    await db.delete(engagements).where(eq(engagements.id, engagementId));
  }
});

test("each Site Context state and local layer renders its summary chip with the expected human-readable text", async ({
  page,
}) => {
  await page.goto(`/engagements/${engagementId}?tab=site-context`);

  // Wait for each tier group present in the seed set to render so we
  // know the briefing read landed for that tier; without this the
  // per-row assertions could race the initial paint.
  const tiersInSeed = Array.from(
    new Set(TIERED_SEED_ROWS.map((row) => row.tier)),
  );
  for (const tier of tiersInSeed) {
    await expect(page.getByTestId(`briefing-sources-tier-${tier}`)).toBeVisible();
  }

  for (const row of TIERED_SEED_ROWS) {
    const sourceId = sourceIdsByLayerKind.get(row.layerKind);
    if (!sourceId) {
      throw new Error(
        `assert: missing seeded source id for layer ${row.layerKind}`,
      );
    }
    // Scope the chip lookup to its parent tier group + per-row
    // testid so a regression that accidentally rendered another
    // tier's chip text under the wrong testid would still fail. We
    // assert exact text equality (vs. `toContainText`) so a
    // formatter that dropped a unit suffix or changed the separator
    // glyph would also fail — the chip text is the entire
    // user-visible contract.
    const tierGroup = page.getByTestId(`briefing-sources-tier-${row.tier}`);
    const rowEl = tierGroup.getByTestId(`briefing-source-${sourceId}`);
    const chip = rowEl.getByTestId(`briefing-source-summary-${sourceId}`);
    await expect(
      chip,
      `chip for layerKind=${row.layerKind} (tier=${row.tier})`,
    ).toBeVisible();
    await expect(
      chip,
      `chip text for layerKind=${row.layerKind} (tier=${row.tier})`,
    ).toHaveText(row.expectedChip);
  }
});
