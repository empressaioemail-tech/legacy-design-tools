/**
 * Williamson tx_wcad_ag_valuation reconciliation tests (F-01).
 *
 * Pure-logic tests (guard, record-building) run everywhere. The DB
 * integration test additionally exercises the real aggregation query
 * and the full reconcile path against a real Postgres via
 * @workspace/db/testing's withTestSchema — skipped when no
 * DATABASE_URL / TEST_DATABASE_URL is available locally; CI always
 * provides one.
 *
 * tx_wcad_ag_valuation is NOT part of this repo's own migrations (it's
 * acquired by a separate pipeline; this repo only reads it — see
 * williamsonAgValuation.ts's own module doc). The integration test
 * therefore creates a schema-matching temp table itself as fixture
 * setup, rather than asserting migration ownership this repo doesn't
 * have.
 */

import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { withTestSchema } from "@workspace/db/testing";
import { cadProperty } from "@workspace/db/schema";
import {
  aggregateAgValuationByPropId,
  buildReconciliationRecords,
  findWilliamsonReconciliationTargets,
  reconcileLandFieldsFromAgValuation,
  reconcileWilliamsonAgValuation,
  WILLIAMSON_ACRES_SANITY_CEILING,
  WILLIAMSON_COUNTY_FIPS,
  type AgValuationTotals,
} from "../williamsonAgValuation";

const hasDb =
  process.env.TEST_DATABASE_URL !== undefined ||
  process.env.DATABASE_URL !== undefined;

describe("reconcileLandFieldsFromAgValuation (sanity-guarded conversion)", () => {
  it("resolves a real present value and acres pair (real WCAD land-segment example)", () => {
    expect(
      reconcileLandFieldsFromAgValuation({ totalValue: "306", totalAcres: "1.021" }),
    ).toEqual({ landValue: 306, landAcres: "1.0210" });
  });

  it("resolves land_value even when acres is genuinely null (the dominant Residential shape)", () => {
    expect(
      reconcileLandFieldsFromAgValuation({ totalValue: "48500", totalAcres: null }),
    ).toEqual({ landValue: 48500, landAcres: null });
  });

  it("rounds a fractional SUM(value) to the whole dollar cad_property.land_value wants", () => {
    expect(
      reconcileLandFieldsFromAgValuation({ totalValue: "12345.67", totalAcres: null }),
    ).toEqual({ landValue: 12346, landAcres: null });
  });

  it("allows a real $0 total value (a real, if unusual, land-segment value — never conflated with absent)", () => {
    expect(
      reconcileLandFieldsFromAgValuation({ totalValue: "0", totalAcres: null }),
    ).toEqual({ landValue: 0, landAcres: null });
  });

  it("FALSIFIER: refuses a negative aggregated value (guard, not a real WCAD shape but must never write one)", () => {
    expect(
      reconcileLandFieldsFromAgValuation({ totalValue: "-100", totalAcres: null }),
    ).toEqual({ landValue: null, landAcres: null });
  });

  it("FALSIFIER: refuses acreage exceeding the sanity ceiling (decimal-shift / unit-mixup corruption guard)", () => {
    const result = reconcileLandFieldsFromAgValuation({
      totalValue: null,
      totalAcres: String(WILLIAMSON_ACRES_SANITY_CEILING + 1),
    });
    expect(result.landAcres).toBeNull();
  });

  it("accepts the real measured max acreage (26,981, a genuine large ranch) comfortably under the ceiling", () => {
    const result = reconcileLandFieldsFromAgValuation({ totalValue: null, totalAcres: "26981" });
    expect(result.landAcres).toBe("26981.0000");
  });

  it("FALSIFIER: refuses negative acreage", () => {
    expect(
      reconcileLandFieldsFromAgValuation({ totalValue: null, totalAcres: "-1.5" }).landAcres,
    ).toBeNull();
  });

  it("refuses both fields when neither total is present (no aggregation match should reach this at all — belt and suspenders)", () => {
    expect(reconcileLandFieldsFromAgValuation({ totalValue: null, totalAcres: null })).toEqual({
      landValue: null,
      landAcres: null,
    });
  });
});

describe("buildReconciliationRecords (join + honest summary counts)", () => {
  const targets = [
    { propId: "349307", taxYear: 2025 }, // resolves both fields (real WCAD example)
    { propId: "500001", taxYear: 2025 }, // resolves value only (acres genuinely null)
    { propId: "500002", taxYear: 2025 }, // no tx_wcad_ag_valuation match at all
    { propId: "500003", taxYear: 2025 }, // aggregation present but guard refuses (corrupt acreage)
  ];
  const aggregated = new Map<string, AgValuationTotals>([
    ["349307", { totalValue: "306", totalAcres: "1.021" }],
    ["500001", { totalValue: "48500", totalAcres: null }],
    ["500003", { totalValue: "9000", totalAcres: String(WILLIAMSON_ACRES_SANITY_CEILING * 10) }],
  ]);

  it("FALSIFIER: distinguishes 'no match' from 'genuinely absent acres' from 'guard refused' -- never collapses these into one count", () => {
    const { summary } = buildReconciliationRecords(WILLIAMSON_COUNTY_FIPS, targets, aggregated);
    expect(summary.targetsConsidered).toBe(4);
    expect(summary.noAgValuationMatch).toBe(1); // 500002
    expect(summary.landValueResolved).toBe(3); // 349307, 500001, 500003
    expect(summary.landAcresResolved).toBe(1); // 349307 only
    expect(summary.landAcresGenuinelyAbsent).toBe(1); // 500001
    expect(summary.guardRefusedAcres).toBe(1); // 500003
    expect(summary.guardRefusedValue).toBe(0);
  });

  it("emits exactly one record per target that resolved at least one field, with the other fields null so COALESCE preserves existing values", () => {
    const { records } = buildReconciliationRecords(WILLIAMSON_COUNTY_FIPS, targets, aggregated);
    // 500002 (no match) is dropped entirely -- never upserted as a no-op row.
    expect(records.map((r) => r.propId).sort()).toEqual(["349307", "500001", "500003"]);

    const r1 = records.find((r) => r.propId === "349307")!;
    expect(r1.landValue).toBe(306);
    expect(r1.landAcres).toBe("1.0210");
    expect(r1.countyFips).toBe(WILLIAMSON_COUNTY_FIPS);
    expect(r1.taxYear).toBe(2025);
    // Every other field stays null so the COALESCE-preferring-incoming
    // upsert leaves the row's existing owner/situs/etc. untouched.
    expect(r1.ownerName).toBeNull();
    expect(r1.situsAddress).toBeNull();
    expect(r1.legalDescription).toBeNull();
    expect(r1.improvementValue).toBeNull();
    expect(r1.marketValue).toBeNull();

    const r2 = records.find((r) => r.propId === "500001")!;
    expect(r2.landValue).toBe(48500);
    expect(r2.landAcres).toBeNull();

    const r3 = records.find((r) => r.propId === "500003")!;
    expect(r3.landValue).toBe(9000);
    expect(r3.landAcres).toBeNull(); // guard refused, not a fabricated figure
  });

  it("drops a target entirely when the guard refuses every field it could have resolved (both a real negative value and real negative acres)", () => {
    const { records, summary } = buildReconciliationRecords(
      WILLIAMSON_COUNTY_FIPS,
      [{ propId: "999999", taxYear: 2025 }],
      new Map([["999999", { totalValue: "-5", totalAcres: "-1" }]]),
    );
    expect(records).toEqual([]);
    expect(summary.guardRefusedValue).toBe(1);
    expect(summary.guardRefusedAcres).toBe(1); // a real (invalid) figure, distinct from a genuinely-absent null
    expect(summary.landAcresGenuinelyAbsent).toBe(0);
  });

  it("counts a genuinely-absent acres (null in the source) separately from a guard-refused one (a real but invalid figure)", () => {
    const { summary } = buildReconciliationRecords(
      WILLIAMSON_COUNTY_FIPS,
      [{ propId: "1", taxYear: 2025 }],
      new Map([["1", { totalValue: null, totalAcres: null }]]),
    );
    expect(summary.landAcresGenuinelyAbsent).toBe(1);
    expect(summary.guardRefusedAcres).toBe(0);
  });
});

describe.skipIf(!hasDb)("Williamson ag-valuation reconciliation (DB integration)", () => {
  // tx_wcad_ag_valuation is created by this repo's own migration
  // (lib/db/drizzle/0098_tx_wcad_ag_valuation.sql) even though the repo
  // does not own the table's real production lifecycle -- see that
  // migration's own header. withTestSchema applies it like any other
  // migration, so no ad-hoc fixture table is needed here; every NOT NULL
  // column (ag_flag, source, source_vintage, source_citation) must be
  // supplied explicitly since the real schema carries no defaults.
  const REQ = "false, 'test-fixture', 'test-fixture', 'test-fixture'"; // ag_flag, source, source_vintage, source_citation

  it("aggregates multiple additive land segments for the same cad_property prop_id, joined on wcad_property_id NOT prop_id (F-01, live-verified 2026-09-05)", async () => {
    await withTestSchema(async ({ db }) => {
      // Deliberately DISTINCT prop_id (WCAD's own internal record id, a
      // different id space) vs wcad_property_id (the real join key,
      // matching cad_property.prop_id) on every row -- a coincidentally
      // equal fixture is exactly what let the wrong join pass before.
      await db.execute(sql.raw(`
        INSERT INTO tx_wcad_ag_valuation (id, prop_id, wcad_property_id, land_type, acres, value, curr_value, county_fips, ag_flag, source, source_vintage, source_citation)
        VALUES
          (1, 'R000091', '163031', 'L', 1.021, 306, 250, '48491', ${REQ}),
          (2, 'R000092', '163031', 'D1', 5.5, 1200, 900, '48491', ${REQ}),
          (3, 'R000093', '200002', 'R', NULL, 48500, 48500, '48491', ${REQ}),
          (4, 'R000094', '900009', 'L', 2.0, 500, 500, '48209', ${REQ});
      `));

      const aggregated = await aggregateAgValuationByPropId(db, WILLIAMSON_COUNTY_FIPS);
      // Keyed by wcad_property_id's value -- never by prop_id.
      expect(aggregated.get("163031")).toEqual({ totalValue: "1506", totalAcres: "6.521" });
      expect(aggregated.get("200002")).toEqual({ totalValue: "48500", totalAcres: null });
      // Neither WCAD-internal prop_id value must appear as a map key.
      expect(aggregated.has("R000091")).toBe(false);
      expect(aggregated.has("R000093")).toBe(false);
      // A different county's row must never leak into Williamson's aggregation.
      expect(aggregated.has("900009")).toBe(false);
    });
  });

  it("FALSIFIER: a row with a null wcad_property_id (unjoinable) is excluded, never aggregated under a null key", async () => {
    await withTestSchema(async ({ db }) => {
      await db.execute(sql.raw(`
        INSERT INTO tx_wcad_ag_valuation (id, prop_id, wcad_property_id, land_type, value, county_fips, ag_flag, source, source_vintage, source_citation)
        VALUES (1, 'R000095', NULL, 'L', 999, '48491', ${REQ});
      `));
      const aggregated = await aggregateAgValuationByPropId(db, WILLIAMSON_COUNTY_FIPS);
      expect(aggregated.size).toBe(0);
    });
  });

  it("full reconcile: targets missing land_value/land_acres get filled via COALESCE, existing correct rows are untouched", async () => {
    await withTestSchema(async ({ db }) => {
      // Williamson's DECLARED vintage (DECLARED_CAD_VINTAGES["48491"] in
      // vintage.ts) is tax_year 2026 -- this reconciliation must only
      // ever touch that year's rows, never a stale prior-vintage one.
      await db.insert(cadProperty).values([
        {
          countyFips: WILLIAMSON_COUNTY_FIPS,
          propId: "163031",
          taxYear: 2026,
          ownerName: "REAL OWNER ON FILE",
          landValue: null,
          landAcres: "0.0000",
          sourceFile: "stratmap25-landparcels_48491_lp.zip",
          sourceVintage: "2026-08-25",
        },
        {
          // Already correct -- must not be touched by this reconciliation at all.
          countyFips: WILLIAMSON_COUNTY_FIPS,
          propId: "ALREADY-GOOD",
          taxYear: 2026,
          landValue: 999_000,
          landAcres: "12.3400",
          sourceFile: "property.csv",
          sourceVintage: "2026-08-20",
        },
        {
          // FALSIFIER: same prop_id family, but a STALE non-declared
          // vintage (2025, not 2026) -- must be excluded entirely, even
          // though it also has null land fields and a real ag-valuation
          // match exists for its prop_id below.
          countyFips: WILLIAMSON_COUNTY_FIPS,
          propId: "163031",
          taxYear: 2025,
          landValue: null,
          landAcres: null,
          sourceFile: "stratmap25-landparcels_48491_lp.zip",
          sourceVintage: "2025-legacy",
        },
      ]);
      // prop_id ('R000091') is WCAD's own internal id, deliberately
      // DIFFERENT from wcad_property_id ('163031', the real join key
      // matching cad_property.prop_id above) -- proves the reconciliation
      // does not accidentally key off prop_id.
      await db.execute(sql.raw(`
        INSERT INTO tx_wcad_ag_valuation (id, prop_id, wcad_property_id, land_type, acres, value, county_fips, ag_flag, source, source_vintage, source_citation)
        VALUES (1, 'R000091', '163031', 'L', 1.021, 306, '48491', ${REQ});
      `));

      const summary = await reconcileWilliamsonAgValuation(db, "2026-09-05-test");
      // Only the declared-vintage (2026) 163031 row is a target -- the
      // stale 2025 row for the same prop_id is correctly out of scope.
      expect(summary.targetsConsidered).toBe(1);
      expect(summary.landValueResolved).toBe(1);
      expect(summary.landAcresResolved).toBe(1);
      expect(summary.upsert.rowsUpserted).toBe(1);

      const [reconciled] = await db
        .select()
        .from(cadProperty)
        .where(sql`prop_id = '163031' AND tax_year = 2026`);
      expect(reconciled.landValue).toBe(306);
      expect(reconciled.landAcres).toBe("1.0210");
      // COALESCE preserved the existing owner name -- this reconciliation
      // never touches fields it didn't set.
      expect(reconciled.ownerName).toBe("REAL OWNER ON FILE");

      // FALSIFIER: the stale 2025 vintage row for the SAME prop_id, with
      // the SAME real ag-valuation match available, must stay exactly as
      // it was -- the declared-vintage scoping is a hard boundary, not a
      // best-effort preference.
      const [staleVintage] = await db
        .select()
        .from(cadProperty)
        .where(sql`prop_id = '163031' AND tax_year = 2025`);
      expect(staleVintage.landValue).toBeNull();
      expect(staleVintage.landAcres).toBeNull();

      const [untouched] = await db
        .select()
        .from(cadProperty)
        .where(sql`prop_id = 'ALREADY-GOOD'`);
      expect(untouched.landValue).toBe(999_000);
      expect(untouched.landAcres).toBe("12.3400");
    });
  });
});
