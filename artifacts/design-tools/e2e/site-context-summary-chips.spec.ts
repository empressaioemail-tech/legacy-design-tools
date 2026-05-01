/**
 * End-to-end regression test for the cross-tier Site Context summary
 * chips rendered inside each `briefing-source-<id>` row (Task #214).
 *
 * Why this test exists: federal-tier chips are already pinned by
 * `federal-summary-chips.spec.ts`, and the per-tier formatters in
 * `lib/adapters/src/state/summaries.ts` and
 * `lib/adapters/src/local/summaries.ts` are unit-tested in isolation.
 * What is *not* covered today is the wiring inside
 * `BriefingSourceRow` for the state and local tiers — the
 * `summarizeStatePayload` / `summarizeLocalPayload` switch arms in
 * `EngagementDetail.tsx`. A regression there (e.g. dropping the
 * `adapterSummary` prop, mistyping the `sourceKind` switch, or
 * reverting the `data-testid="briefing-source-summary-*"` element)
 * would ship without catching it because no test walks the wire seam:
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
 * `federal-summary-chips.spec.ts`: it seeds one row per tier
 * (federal + state + local), asserts each tier's chip text exactly,
 * and fails if the chip is dropped from any tier.
 *
 * Strategy:
 *
 *   1. Insert a clean Bastrop TX engagement directly via `@workspace/db`
 *      (Bastrop is one of the three DA-PI-4 pilot jurisdictions and
 *      is the same shape the sibling federal/local seed specs use, so
 *      the engagement seed shape stays consistent).
 *
 *   2. Insert one parent `parcel_briefings` row and three child
 *      `briefing_sources` rows directly in the DB — one per tier
 *      (`federal-adapter` / `state-adapter` / `local-adapter`).
 *      Each row carries the `layerKind` literal the corresponding
 *      adapter emits so the matching summarizer branch runs, plus a
 *      payload whose shape mirrors what the adapter persists AND
 *      what the formatter reads. Going through the DB rather than
 *      `/generate-layers` keeps this spec deterministic and free of
 *      live network calls to FEMA/UGRC/TCEQ/etc.
 *
 *   3. Drive the UI through Playwright: open the engagement on the
 *      Site Context tab and, for each tier, look up its
 *      `briefing-sources-tier-<tier>` group, then assert the
 *      per-source row's `briefing-source-summary-<id>` element
 *      renders the expected chip text. The expected strings are
 *      pinned verbatim — a regression in any single tier's wiring
 *      (e.g. dropping the local-adapter switch arm) fails its own
 *      assertion with a clear diff instead of bleeding past a
 *      permissive matcher.
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
 * One briefing-source row per tier the Site Context tab groups by.
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
 *   - `payload`: the structured shape the matching `summarize*Payload`
 *     formatter reads (mirroring the unit-test fixtures in
 *     `lib/adapters/src/__tests__/`).
 *   - `expectedChip`: the exact human-readable string the chip
 *     should render. Pinned verbatim so a formatter or wiring
 *     regression fails on the right tier, with the right diff,
 *     instead of bleeding past a permissive `toContainText`
 *     matcher.
 */
const TIERED_SEED_ROWS = [
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
    note: "Seeded by site-context-summary-chips.spec.ts",
    expectedChip: "Flood Zone AE · BFE 425.5 ft",
  },
  {
    tier: "state",
    sourceKind: "state-adapter",
    // TCEQ Edwards Aquifer — uniquely state-tier (no equivalent
    // federal/local layer) and produces a chip that exercises the
    // recharge-vs-contributing branch logic in the formatter.
    layerKind: "tceq-edwards-aquifer",
    provider: "TCEQ Edwards Aquifer",
    payload: {
      kind: "edwards-aquifer",
      inRecharge: true,
      inContributing: false,
    },
    note: "Seeded by site-context-summary-chips.spec.ts",
    expectedChip: "In Edwards Aquifer recharge zone",
  },
  {
    tier: "local",
    sourceKind: "local-adapter",
    // Bastrop County zoning — a code+description chip exercises the
    // common-case branch of `summarizeZoningPayload` that prepends
    // "Zoning <code> · <desc>".
    layerKind: "bastrop-tx-zoning",
    provider: "Bastrop County Zoning",
    payload: {
      kind: "zoning",
      zoning: {
        attributes: {
          ZONE_CODE: "R-1",
          ZONE_DESC: "Single-Family Residential",
        },
      },
    },
    note: "Seeded by site-context-summary-chips.spec.ts",
    expectedChip: "Zoning R-1 · Single-Family Residential",
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

  // 3. Seed one briefing_sources row per tier. The `sourceKind`
  //    value is the gate `BriefingSourceRow` reads to enter the
  //    right `summarize*Payload` branch; `layerKind` selects the
  //    formatter inside that branch; `payload` is what the
  //    formatter reads.
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

test("each Site Context tier renders its summary chip with the expected human-readable text", async ({
  page,
}) => {
  await page.goto(`/engagements/${engagementId}?tab=site-context`);

  for (const row of TIERED_SEED_ROWS) {
    const sourceId = sourceIdsByLayerKind.get(row.layerKind);
    if (!sourceId) {
      throw new Error(
        `assert: missing seeded source id for layer ${row.layerKind}`,
      );
    }
    // Wait for the tier group to render so we know the briefing
    // read landed for this tier; without this the per-row
    // assertion could race the initial paint.
    const tierGroup = page.getByTestId(`briefing-sources-tier-${row.tier}`);
    await expect(tierGroup).toBeVisible();

    // Scope the chip lookup to its parent row so a regression that
    // accidentally rendered another tier's chip text under the
    // wrong testid would still fail. We assert exact text equality
    // (vs. `toContainText`) so a formatter that dropped a unit
    // suffix or changed the separator glyph would also fail — the
    // chip text is the entire user-visible contract.
    const rowEl = tierGroup.getByTestId(`briefing-source-${sourceId}`);
    const chip = rowEl.getByTestId(`briefing-source-summary-${sourceId}`);
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(row.expectedChip);
  }
});
