/**
 * End-to-end regression test for the federal-tier briefing-source group
 * in the Site Context tab (Task #181).
 *
 * Why this test exists: the federal adapters in
 * `lib/adapters/src/federal/*` have per-adapter unit tests, and the
 * `/api/engagements/:id/generate-layers` route has an integration test
 * that stubs `@workspace/adapters` and asserts persistence. Nothing,
 * however, walks the federal-adapter rows through the wire and asserts
 * that the Site Context tab actually renders them under the "Federal
 * layers" tier heading. A regression that
 *
 *   - dropped `federal-adapter` from the `tierForSource` map,
 *   - removed `federal` from `TIER_ORDER` / `TIER_LABELS`,
 *   - or changed the `briefing-sources-tier-federal` testid the rest
 *     of the suite (and the API integration test indirectly) wires
 *     off of,
 *
 * would currently slip past CI. This spec pins the rendering contract.
 *
 * Strategy:
 *
 *   1. Insert a clean Bastrop TX engagement directly via `@workspace/db`
 *      (Bastrop is one of the three DA-PI-4 pilot jurisdictions; the
 *      `tierForSource` map is jurisdiction-agnostic but we use the
 *      pilot the federal adapters are most exercised against). The
 *      engagement is removed in `afterAll`, FK-cascading the
 *      parcel_briefings + briefing_sources rows the seed inserts.
 *
 *   2. Insert a parent `parcel_briefings` row and four child
 *      `briefing_sources` rows directly in the DB — one per federal
 *      adapter (FEMA NFHL, USGS NED, EPA EJScreen, FCC Broadband).
 *      Each row carries `sourceKind = "federal-adapter"` so the
 *      `tierForSource` map buckets it into the `federal` tier, plus
 *      a `layerKind` matching the corresponding adapter's
 *      `layerKind` and a small payload that mirrors the wire shape
 *      the briefing engine reads. Going through the DB rather than
 *      the live `/generate-layers` route keeps this spec
 *      deterministic and free of network calls to FEMA/USGS/EPA/FCC.
 *
 *   3. Drive the UI through Playwright: open the engagement on the
 *      Site Context tab, assert that the
 *      `briefing-sources-tier-federal` group renders with the four
 *      seeded sources, that the tier heading reads "Federal layers",
 *      that the count badge shows `(4)`, and that each per-source
 *      row exposes its own `briefing-source-<id>` testid with the
 *      "Federal adapter" tier pill. We also assert that the
 *      non-federal tier groups do NOT render — the seed only
 *      inserted federal-adapter rows, so any other group appearing
 *      would mean the bucketing leaked.
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
const TEST_PROJECT_NAME = `e2e Federal Layers ${RUN_TAG}`;

let engagementId = "";
let briefingId = "";
const sourceIdsByLayerKind = new Map<string, string>();

/**
 * Federal adapter row catalogue — one entry per adapter under
 * `lib/adapters/src/federal/*`. The `layerKind` and `provider` here
 * mirror the literal values the corresponding adapter emits via
 * `AdapterResult` so this seed is an honest stand-in for what the
 * `/generate-layers` route would persist on a live run. The payload
 * is intentionally minimal: the briefing-source row component does
 * not key off these fields for the tier-group rendering this test
 * pins, and the briefing engine treats `payload` as opaque.
 */
const FEDERAL_SEED_ROWS = [
  {
    layerKind: "fema-nfhl-flood-zone",
    provider: "FEMA National Flood Hazard Layer (NFHL)",
    payload: {
      kind: "flood-zone",
      inSpecialFloodHazardArea: false,
      floodZone: "X",
      features: [],
    },
    note: "Seeded by federal-layers-render.spec.ts",
  },
  {
    layerKind: "usgs-ned-elevation",
    provider: "USGS National Elevation Dataset (NED)",
    payload: {
      kind: "elevation",
      elevationMeters: 142.5,
      resolutionMeters: 10,
    },
    note: "Seeded by federal-layers-render.spec.ts",
  },
  {
    layerKind: "epa-ejscreen-blockgroup",
    provider: "EPA EJScreen",
    payload: {
      kind: "ejscreen-blockgroup",
      blockgroupId: "480219501001",
      indices: {},
    },
    note: "Seeded by federal-layers-render.spec.ts",
  },
  {
    layerKind: "fcc-broadband-availability",
    provider: "FCC National Broadband Map",
    payload: {
      kind: "broadband-availability",
      maxAdvertisedDownloadMbps: 1000,
      providers: [],
    },
    note: "Seeded by federal-layers-render.spec.ts",
  },
] as const;

test.beforeAll(async () => {
  // 1. Seed the engagement. Bastrop, TX → resolves to the
  //    `bastrop-tx` / `texas` jurisdiction (see
  //    `jurisdictionResolver.test.ts`), one of the three DA-PI-4
  //    pilots. Coordinates are stamped so the briefing read shape
  //    matches what production would produce, even though the
  //    federal-adapter rows are seeded directly.
  const [eng] = await db
    .insert(engagements)
    .values({
      name: TEST_PROJECT_NAME,
      nameLower: TEST_PROJECT_NAME.toLowerCase(),
      jurisdiction: "Bastrop, TX",
      jurisdictionCity: "Bastrop",
      jurisdictionState: "TX",
      jurisdictionFips: "48021",
      address: "100 E2E Federal St, Bastrop, TX 78602",
      latitude: "30.110500",
      longitude: "-97.318600",
      status: "active",
    })
    .returning();
  if (!eng) throw new Error("seed: engagement insert returned no row");
  engagementId = eng.id;

  // 2. Seed the parent parcel_briefings row. The route reads at most
  //    one briefing per engagement (enforced by the unique index on
  //    engagement_id) so we do not need to clear anything first.
  const [briefing] = await db
    .insert(parcelBriefings)
    .values({
      engagementId,
    })
    .returning();
  if (!briefing) throw new Error("seed: parcel_briefings insert returned no row");
  briefingId = briefing.id;

  // 3. Seed one federal-adapter briefing_sources row per adapter.
  //    `sourceKind = "federal-adapter"` is the bucket key the
  //    `tierForSource` map reads; the per-layer unique index lets
  //    each (briefing, layerKind) pair coexist because every
  //    layerKind is distinct.
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

test("federal-adapter briefing sources render under the Federal layers tier group", async ({
  page,
}) => {
  await page.goto(`/engagements/${engagementId}?tab=site-context`);

  // The federal tier group renders, with its heading reading
  // "Federal layers" and a (4) count badge — proves that the four
  // seeded `federal-adapter` rows landed in the `federal` bucket
  // (vs. e.g. silently falling through to `manual`).
  const federalGroup = page.getByTestId("briefing-sources-tier-federal");
  await expect(federalGroup).toBeVisible();
  await expect(federalGroup).toContainText("Federal layers");
  await expect(federalGroup).toContainText("(4)");

  // Each per-source row renders inside the federal group with its
  // own testid. Scoping the per-row assertion to the group locator
  // (rather than the page) means a future bucketing regression that
  // routes a federal-adapter row to a different tier would fail
  // here even if it still rendered the row somewhere on the page.
  for (const row of FEDERAL_SEED_ROWS) {
    const sourceId = sourceIdsByLayerKind.get(row.layerKind);
    if (!sourceId) {
      throw new Error(
        `assert: missing seeded source id for layer ${row.layerKind}`,
      );
    }
    const rowEl = federalGroup.getByTestId(`briefing-source-${sourceId}`);
    await expect(rowEl).toBeVisible();
    // The adapter-tier pill must read "Federal adapter" — the
    // `sourceKindLabel` switch in BriefingSourceRow is what would
    // regress if a future refactor collapsed the federal/state/local
    // labels back onto a single string.
    await expect(rowEl).toContainText("Federal adapter");
  }

  // Negative guard: the seed only inserted federal-adapter rows, so
  // none of the other tier groups should render. A failure here
  // would mean the `tierForSource` map mis-bucketed at least one of
  // the seeded `federal-adapter` rows into a sibling tier.
  await expect(page.getByTestId("briefing-sources-tier-state")).toHaveCount(0);
  await expect(page.getByTestId("briefing-sources-tier-local")).toHaveCount(0);
  await expect(page.getByTestId("briefing-sources-tier-manual")).toHaveCount(0);
});
