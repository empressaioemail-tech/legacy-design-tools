/**
 * End-to-end regression test for the federal-tier summary chips
 * rendered inside each `briefing-source-<id>` row in the Site Context
 * tab (Task #198).
 *
 * Why this test exists: the four federal summary formatters in
 * `lib/adapters/src/federal/summaries.ts` (FEMA NFHL, USGS NED, EPA
 * EJScreen, FCC Broadband) are unit-tested in
 * `lib/adapters/src/__tests__/federalSummaries.test.ts`, and the FE
 * compiles against the `summarizeFederalPayload` import — but no test
 * walks the wire seam. The seam is:
 *
 *     briefing_sources.payload (jsonb)
 *        → toBriefingSourceWire (parcelBriefings.ts)
 *        → GET /api/engagements/:id/briefing
 *        → useGetEngagementBriefing
 *        → BriefingSourceRow → summarizeFederalPayload(layerKind, payload)
 *        → <div data-testid="briefing-source-summary-<id>">{chip}</div>
 *
 * Any one of those seams could regress quietly:
 *
 *   - if `toBriefingSourceWire` stopped projecting `payload` (or
 *     coerced it to `{}`), the chip would silently disappear;
 *   - if the OpenAPI `payload` field were marked `nullable` and the
 *     generated type changed, the FE call site would type-error
 *     differently but still compile under a `?? null` rescue;
 *   - if `BriefingSourceRow` stopped passing `source.payload` (or
 *     `source.layerKind`) into the summarizer, the chip would render
 *     "EJScreen indicators unavailable"-style fallback text instead
 *     of the actual reading;
 *   - if the federal summary registry dropped a layer-kind branch
 *     (e.g. someone renamed `usgs-ned-elevation` →
 *     `usgs-elevation-point` without updating the switch), the chip
 *     would silently turn `null` and stop rendering.
 *
 * None of those would fail any existing test. This spec pins the
 * round-trip end to end so a CI failure lands instead.
 *
 * Strategy:
 *
 *   1. Insert a clean Bastrop TX engagement directly via `@workspace/db`
 *      (Bastrop is one of the three DA-PI-4 pilot jurisdictions and is
 *      what the sibling `federal-layers-render.spec.ts` uses, so the
 *      seed shape is consistent across the federal e2e specs). The
 *      engagement is removed in `afterAll`, FK-cascading the
 *      parcel_briefings + briefing_sources rows the seed inserts.
 *
 *   2. Insert one parent `parcel_briefings` row and four child
 *      `briefing_sources` rows directly in the DB — one per federal
 *      adapter. Each row carries `sourceKind = "federal-adapter"`
 *      (so `BriefingSourceRow` enters the `summarizeFederalPayload`
 *      branch), the `layerKind` literal the adapter emits, and a
 *      payload whose shape mirrors what the adapter actually persists
 *      AND what the summarizer reads. Going through the DB rather
 *      than `/generate-layers` keeps this spec deterministic and
 *      free of network calls to FEMA/USGS/EPA/FCC.
 *
 *   3. Drive the UI through Playwright: open the engagement on the
 *      Site Context tab and assert that each per-source row's
 *      `briefing-source-summary-<id>` element renders the expected
 *      human-readable chip text. The expected strings are pinned
 *      verbatim — a regression in any single formatter would fail
 *      its own assertion (and not silently bleed past a more
 *      permissive matcher) so the failure points at the broken
 *      adapter.
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
const TEST_PROJECT_NAME = `e2e Federal Summary Chips ${RUN_TAG}`;

let engagementId = "";
let briefingId = "";
const sourceIdsByLayerKind = new Map<string, string>();

/**
 * Federal adapter row catalogue — one entry per adapter under
 * `lib/adapters/src/federal/*`. Each entry pins:
 *
 *   - `layerKind` / `provider`: literal values the corresponding
 *     adapter would emit on a live `/generate-layers` run, so the
 *     seed is an honest stand-in for a production briefing row.
 *   - `payload`: the structured shape `summarizeFederalPayload`
 *     reads (mirroring the unit-test fixtures in
 *     `lib/adapters/src/__tests__/federalSummaries.test.ts`).
 *   - `expectedChip`: the exact human-readable string the chip
 *     should render. Pinned verbatim so a formatter regression
 *     fails on the right row, with the right diff, instead of
 *     bleeding past a permissive `toContainText` matcher.
 *
 * These four rows together cover every federal adapter the
 * registry switches on; if a fifth adapter ships, add it here so
 * the chip seam stays covered.
 */
const FEDERAL_SEED_ROWS = [
  {
    layerKind: "fema-nfhl-flood-zone",
    provider: "FEMA National Flood Hazard Layer (NFHL)",
    payload: {
      kind: "flood-zone",
      inSpecialFloodHazardArea: true,
      floodZone: "AE",
      baseFloodElevation: 425.5,
      features: [],
    },
    note: "Seeded by federal-summary-chips.spec.ts",
    expectedChip: "Flood Zone AE · BFE 425.5 ft",
  },
  {
    layerKind: "usgs-ned-elevation",
    provider: "USGS National Elevation Dataset (NED)",
    payload: {
      kind: "elevation-point",
      elevationFeet: 4033,
      units: "Feet",
    },
    note: "Seeded by federal-summary-chips.spec.ts",
    expectedChip: "Elevation: 4,033 ft",
  },
  {
    layerKind: "epa-ejscreen-blockgroup",
    provider: "EPA EJScreen",
    payload: {
      kind: "ejscreen-blockgroup",
      demographicIndexPercentile: 65,
      pm25Percentile: 72,
    },
    note: "Seeded by federal-summary-chips.spec.ts",
    expectedChip: "EJ Index 65th pctile · PM2.5 72nd pctile",
  },
  {
    layerKind: "fcc-broadband-availability",
    provider: "FCC National Broadband Map",
    payload: {
      kind: "broadband-availability",
      providerCount: 2,
      fastestDownstreamMbps: 1000,
      providers: [],
    },
    note: "Seeded by federal-summary-chips.spec.ts",
    expectedChip: "Up to 1 Gbps · 2 providers",
  },
] as const;

test.beforeAll(async () => {
  // 1. Seed the engagement. Bastrop, TX → resolves to the
  //    `bastrop-tx` / `texas` jurisdiction, one of the three
  //    DA-PI-4 pilots (matches `federal-layers-render.spec.ts`).
  const [eng] = await db
    .insert(engagements)
    .values({
      name: TEST_PROJECT_NAME,
      nameLower: TEST_PROJECT_NAME.toLowerCase(),
      jurisdiction: "Bastrop, TX",
      jurisdictionCity: "Bastrop",
      jurisdictionState: "TX",
      jurisdictionFips: "48021",
      address: "200 E2E Summary St, Bastrop, TX 78602",
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

  // 3. Seed one federal-adapter briefing_sources row per adapter.
  //    `sourceKind = "federal-adapter"` is the gate
  //    `BriefingSourceRow` reads to enter the
  //    `summarizeFederalPayload` branch; `payload` is what the
  //    summarizer reads.
  const inserted = await db
    .insert(briefingSources)
    .values(
      FEDERAL_SEED_ROWS.map((row) => ({
        briefingId,
        layerKind: row.layerKind,
        sourceKind: "federal-adapter",
        provider: row.provider,
        payload: row.payload,
        note: row.note,
      })),
    )
    .returning({ id: briefingSources.id, layerKind: briefingSources.layerKind });
  for (const row of inserted) {
    sourceIdsByLayerKind.set(row.layerKind, row.id);
  }
  if (sourceIdsByLayerKind.size !== FEDERAL_SEED_ROWS.length) {
    throw new Error(
      `seed: expected ${FEDERAL_SEED_ROWS.length} briefing_sources rows, got ${sourceIdsByLayerKind.size}`,
    );
  }
});

test.afterAll(async () => {
  if (engagementId) {
    // FK cascade: engagement → parcel_briefings → briefing_sources.
    await db.delete(engagements).where(eq(engagements.id, engagementId));
  }
});

test("federal-adapter rows render their summary chip with the expected human-readable text", async ({
  page,
}) => {
  await page.goto(`/engagements/${engagementId}?tab=site-context`);

  // Wait for the federal tier group to render so we know the
  // briefing read landed; without this the per-row assertions
  // could race the initial paint.
  const federalGroup = page.getByTestId("briefing-sources-tier-federal");
  await expect(federalGroup).toBeVisible();

  for (const row of FEDERAL_SEED_ROWS) {
    const sourceId = sourceIdsByLayerKind.get(row.layerKind);
    if (!sourceId) {
      throw new Error(
        `assert: missing seeded source id for layer ${row.layerKind}`,
      );
    }
    // Scope the chip lookup to its parent row so a regression that
    // accidentally rendered another row's chip text under the wrong
    // testid would still fail. We assert exact text equality (vs.
    // `toContainText`) so a formatter that dropped a unit suffix or
    // changed the separator glyph would also fail — the chip text
    // is the entire user-visible contract.
    const rowEl = federalGroup.getByTestId(`briefing-source-${sourceId}`);
    const chip = rowEl.getByTestId(`briefing-source-summary-${sourceId}`);
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(row.expectedChip);
  }
});
