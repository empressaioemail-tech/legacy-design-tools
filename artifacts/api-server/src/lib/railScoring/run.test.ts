/**
 * RUN TESTS — the idempotency and fail-closed claims, at the level where they
 * are actually made.
 *
 * These use an in-memory double for both stores rather than a live database:
 * the claims under test are about the RUN's arithmetic and control flow, and
 * DEV_PROCESS 1.5 is explicit that measuring the code and measuring the
 * system are different measurements. The system-level check is the read-only
 * dry run against the deployment store, recorded in the lane close.
 */

import { describe, it, expect } from "vitest";
import { runRailScore } from "./run";
import type { MeasureContext, RailScoreQueryable } from "./measure";

interface StoredCell {
  values: Record<string, unknown>;
  writes: number;
}

/**
 * A deliberately dumb fake: it recognises the handful of statement shapes the
 * measurers and the runner issue, and it counts writes so a dry run's claim
 * of "wrote nothing" is checked against the store rather than against the
 * runner's own report.
 */
function makeFakeStores(options: {
  counties: string[];
  features: Record<string, number>;
  atoms: Record<string, number>;
  districts?: Record<string, number>;
  seed?: Record<string, Record<string, unknown>>;
}): {
  ctx: MeasureContext;
  cells: Map<string, StoredCell>;
  totalWrites: () => number;
} {
  const cells = new Map<string, StoredCell>();
  for (const [key, values] of Object.entries(options.seed ?? {})) {
    cells.set(key, { values, writes: 0 });
  }

  const deployment: RailScoreQueryable = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async query(text: string, params?: unknown[]): Promise<any> {
      const sql = text.replace(/\s+/g, " ").trim();
      if (sql.startsWith("SELECT to_regclass")) {
        const table = String(params?.[0]);
        const known = table === "txgio_parcel" || table === "tx_special_district";
        return { rows: [{ r: known ? table : null }] };
      }
      if (sql.includes("FROM county_manifest")) {
        return {
          rows: options.counties.map((c) => ({ county_fips: c, county_name: c })),
        };
      }
      if (sql.includes("count(DISTINCT feature_index)")) {
        const fips = String(params?.[0]);
        return { rows: [{ features: String(options.features[fips] ?? 0) }] };
      }
      if (sql.includes("FROM tx_special_district")) {
        const fips = String(params?.[0]);
        return { rows: [{ n: String(options.districts?.[fips] ?? 1) }] };
      }
      if (sql.startsWith("SELECT county_fips, facet")) {
        const key = `${params?.[0]}|${params?.[1]}`;
        const hit = cells.get(key);
        return { rows: hit ? [hit.values] : [] };
      }
      if (sql.startsWith("INSERT INTO county_facet_coverage")) {
        const p = params ?? [];
        const key = `${p[0]}|${p[1]}`;
        const prior = cells.get(key);
        cells.set(key, {
          writes: (prior?.writes ?? 0) + 1,
          values: {
            county_fips: p[0],
            facet: p[1],
            honest_coverage_pct: p[2],
            integrity_verdict: p[3],
            owner_match_rate: p[4],
            source: p[5],
            source_vintage: p[6],
            sampled: p[7],
            classification: p[8],
            rail_state: p[9],
            threshold_pct: p[10],
            absence_basis: p[11],
            verification_method: p[12],
            verified_by_instrument: p[13],
            artifact_path: p[14],
          },
        });
        return { rows: [] };
      }
      throw new Error(`fake deployment store got an unexpected statement: ${sql}`);
    },
  };

  const atoms: RailScoreQueryable = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async query(text: string, params?: unknown[]): Promise<any> {
      const sql = text.replace(/\s+/g, " ").trim();
      if (sql.includes("entity_id = $2") && sql.includes("SELECT body")) {
        return { rows: [] };
      }
      const fips = String(params?.[1]);
      return { rows: [{ n: String(options.atoms[fips] ?? 0) }] };
    },
  };

  return {
    ctx: { deployment, atoms },
    cells,
    totalWrites: () =>
      Array.from(cells.values()).reduce((a, c) => a + c.writes, 0),
  };
}

const COUNTIES = ["48021", "48029"];
const BASE = {
  counties: COUNTIES,
  features: { "48021": 1000, "48029": 2000 },
  atoms: { "48021": 990, "48029": 100 },
};

describe("a dry run writes nothing and still reports the delta", () => {
  it("reports cellsChanged from the store while cellsWritten stays 0", async () => {
    const { ctx, totalWrites } = makeFakeStores(BASE);
    const report = await runRailScore(ctx, { railKeys: ["flood"], dryRun: true });
    expect(report.totals.cellsWritten).toBe(0);
    // Checked against the STORE, not against the runner's own accounting —
    // a report that audits itself can never report a lost or stray write.
    expect(totalWrites()).toBe(0);
    expect(report.totals.cellsChanged).toBe(2);
    expect(report.rails[0]?.byRailState).toEqual({
      "satisfied-present": 1,
      "not-yet": 1,
    });
  });
});

describe("re-runnability", () => {
  it("a second run over unchanged sources reports ZERO cells changed", async () => {
    // The whole claim of the lane: scoring is something you can do again.
    // checked_at moves on every write, so row counts would say everything
    // moved; the value diff says nothing did.
    const stores = makeFakeStores(BASE);
    const first = await runRailScore(stores.ctx, { railKeys: ["flood"], dryRun: false });
    expect(first.totals.cellsChanged).toBe(2);
    expect(first.totals.cellsWritten).toBe(2);

    const second = await runRailScore(stores.ctx, { railKeys: ["flood"], dryRun: false });
    expect(second.totals.cellsChanged).toBe(0);
    expect(second.totals.cellsUnchanged).toBe(2);
    // It DID write again (upserts are unconditional); it simply reports
    // honestly that nothing moved.
    expect(second.totals.cellsWritten).toBe(2);
    expect(stores.totalWrites()).toBe(4);
  });

  it("a moved source is reported as changed on the next run", async () => {
    // The negative case: proves the zero above is a measurement, not a
    // gate stuck closed (DEV_PROCESS 2.2).
    const stores = makeFakeStores(BASE);
    await runRailScore(stores.ctx, { railKeys: ["flood"], dryRun: false });
    const moved = makeFakeStores({
      ...BASE,
      atoms: { "48021": 990, "48029": 1990 },
      seed: Object.fromEntries(
        Array.from(stores.cells.entries()).map(([k, v]) => [k, v.values]),
      ),
    });
    const after = await runRailScore(moved.ctx, { railKeys: ["flood"], dryRun: false });
    expect(after.totals.cellsChanged).toBe(1);
    expect(after.totals.cellsUnchanged).toBe(1);
  });
});

describe("fail closed and NAMED", () => {
  it("an atom-count rail with no ATOMS store is UNAVAILABLE, never scored as zero", async () => {
    // Scoring it as zero would publish "no coverage in Texas" on the
    // strength of a missing connection string.
    const { ctx, totalWrites } = makeFakeStores(BASE);
    const report = await runRailScore(
      { deployment: ctx.deployment, atoms: null },
      { railKeys: ["flood"], dryRun: false },
    );
    expect(report.rails).toEqual([]);
    expect(report.railsUnavailable).toHaveLength(1);
    expect(report.railsUnavailable[0]?.reason).toBe("atoms_store_not_configured");
    expect(totalWrites()).toBe(0);
  });

  it("mud is scoreable and runs when stores are configured", async () => {
    const { ctx } = makeFakeStores({
      ...BASE,
      atoms: { "48021": 983, "48029": 100 },
    });
    const report = await runRailScore(ctx, { railKeys: ["mud"], dryRun: true });
    expect(report.railsUnavailable).toEqual([]);
    expect(report.rails).toHaveLength(1);
    expect(report.rails[0]?.railKey).toBe("mud");
    expect(report.rails[0]?.byRailState["satisfied-present"]).toBe(1);
    expect(report.rails[0]?.byRailState["not-yet"]).toBe(1);
  });

  it("an unknown rail key is UNAVAILABLE rather than silently dropped", async () => {
    const { ctx } = makeFakeStores(BASE);
    const report = await runRailScore(ctx, { railKeys: ["not-a-rail"], dryRun: true });
    expect(report.railsUnavailable[0]?.reason).toBe("unknown_rail");
  });
});

describe("the run report carries its counting rules", () => {
  it("every scored rail names its denominator kind and prose basis", async () => {
    const { ctx } = makeFakeStores(BASE);
    const report = await runRailScore(ctx, { railKeys: ["flood"], dryRun: true });
    expect(report.rails[0]?.denominator.kind).toBe(
      "txgio-parcel-distinct-feature-index",
    );
    expect(report.rails[0]?.denominator.basis).toMatch(/count\(DISTINCT feature_index\)/);
  });

  it("names the county target basis, so a percentage cannot escape its denominator", async () => {
    const { ctx } = makeFakeStores(BASE);
    const all = await runRailScore(ctx, { railKeys: ["flood"], dryRun: true });
    expect(all.countyTargetBasis).toMatch(/county_manifest/);
    expect(all.countyTargetCount).toBe(2);

    const one = await runRailScore(ctx, {
      railKeys: ["flood"],
      countyFips: ["48021"],
      dryRun: true,
    });
    expect(one.countyTargetBasis).toMatch(/explicit --county selection/);
    expect(one.countyTargetCount).toBe(1);
  });
});

describe("a county with no parcel denominator", () => {
  it("is not-yet with coverage 0, and is not invented as an absence", async () => {
    const { ctx } = makeFakeStores({
      counties: ["48129"],
      features: {},
      atoms: { "48129": 0 },
    });
    const report = await runRailScore(ctx, { railKeys: ["flood"], dryRun: true });
    expect(report.rails[0]?.byRailState).toEqual({ "not-yet": 1 });
  });
});

describe("an established absence is not overturned by a scorer that cannot see it", () => {
  // TRACED TO AN INCIDENT IN THIS LANE. The first version of this runner was
  // dry-run against the live ledger and DEMOTED Donley 48129's geometry cell
  // from satisfied-absent (basis: stratmap TxGIO parcel universe 404,
  // county-confirmed; evidence in a decision doc) to not-yet, purely because
  // the county has no parcel denominator. The `geometry` rail declares no
  // absence probe, so it had no instrument capable of contradicting that
  // finding. It was predicted before the run and confirmed by it.
  const donleySeed = {
    "48129|flood": {
      county_fips: "48129",
      facet: "flood",
      honest_coverage_pct: "0.00",
      integrity_verdict: "n/a",
      owner_match_rate: null,
      source: "honest-absence-determination",
      source_vintage: null,
      sampled: 0,
      classification: "true-source-gap",
      rail_state: "satisfied-absent",
      threshold_pct: "95.00",
      absence_basis: "stratmap-txgio-parcel-universe-404-county-confirmed",
      verification_method: "sweep",
      verified_by_instrument: "countyGeometryScoreCli.ts",
      artifact_path: "_decisions/2026-08-12_donley_48129_geometry_honest_absence.md",
    },
  };

  it("PRESERVES the absence and reports it, rather than writing not-yet", async () => {
    const stores = makeFakeStores({
      counties: ["48129"],
      features: {},
      atoms: { "48129": 0 },
      seed: donleySeed,
    });
    const report = await runRailScore(stores.ctx, {
      railKeys: ["flood"],
      dryRun: false,
    });
    expect(report.rails[0]?.absencesPreserved).toEqual([
      {
        countyFips: "48129",
        basis: "stratmap-txgio-parcel-universe-404-county-confirmed",
      },
    ]);
    expect(report.rails[0]?.byRailState).toEqual({ "satisfied-absent": 1 });
    expect(report.totals.cellsWritten).toBe(0);
    // Checked against the STORE: the row was not touched at all.
    expect(stores.cells.get("48129|flood")?.values.rail_state).toBe(
      "satisfied-absent",
    );
  });

  it("OVERTURNS it when reassessAbsences is passed explicitly — the guard is not stuck", async () => {
    // The negative case. A control that can never be released is a control
    // nobody can reason about (DEV_PROCESS 2.2).
    const stores = makeFakeStores({
      counties: ["48129"],
      features: {},
      atoms: { "48129": 0 },
      seed: donleySeed,
    });
    const report = await runRailScore(stores.ctx, {
      railKeys: ["flood"],
      dryRun: false,
      reassessAbsences: true,
    });
    expect(report.rails[0]?.absencesPreserved).toEqual([]);
    expect(report.rails[0]?.byRailState).toEqual({ "not-yet": 1 });
    expect(stores.cells.get("48129|flood")?.values.rail_state).toBe("not-yet");
  });

  it("does NOT preserve when the cell is not an absence — only absences are protected", async () => {
    const stores = makeFakeStores({ ...BASE, seed: {} });
    const report = await runRailScore(stores.ctx, {
      railKeys: ["flood"],
      dryRun: true,
    });
    expect(report.rails[0]?.absencesPreserved).toEqual([]);
  });
});

describe("per-cell detail is emitted or its absence is explained", () => {
  it("includes numerator, denominator and state per cell when asked", async () => {
    const { ctx } = makeFakeStores(BASE);
    const report = await runRailScore(ctx, {
      railKeys: ["flood"],
      dryRun: true,
      includeCells: true,
    });
    expect(report.rails[0]?.cells).toEqual([
      {
        countyFips: "48021",
        honestCoveragePct: 99,
        railState: "satisfied-present",
        numerator: 990,
        denominator: 1000,
        changed: true,
        overcount: false,
      },
      {
        countyFips: "48029",
        honestCoveragePct: 5,
        railState: "not-yet",
        numerator: 100,
        denominator: 2000,
        changed: true,
        overcount: false,
      },
    ]);
  });

  it("omits cells past the cap and SAYS SO rather than returning a summary that looks complete", async () => {
    const many = Array.from({ length: 30 }, (_, i) => String(48001 + i * 2));
    const { ctx } = makeFakeStores({
      counties: many,
      features: Object.fromEntries(many.map((c) => [c, 100])),
      atoms: Object.fromEntries(many.map((c) => [c, 99])),
    });
    const report = await runRailScore(ctx, {
      railKeys: ["flood"],
      dryRun: true,
      includeCells: true,
    });
    expect(report.rails[0]?.cells).toBeUndefined();
    expect(report.rails[0]?.cellsOmittedReason).toMatch(/at most 25 counties.*targeted 30/);
  });

  it("omits cells silently only when they were never requested", async () => {
    const { ctx } = makeFakeStores(BASE);
    const report = await runRailScore(ctx, { railKeys: ["flood"], dryRun: true });
    expect(report.rails[0]?.cells).toBeUndefined();
    expect(report.rails[0]?.cellsOmittedReason).toBeUndefined();
  });
});

describe("coverage movement is reported apart from provenance movement", () => {
  it("a first run under a new instrument changes every cell but moves no coverage", async () => {
    // Verified live 2026-08-19: the flood rail reproduced all four stored
    // percentages EXACTLY and still reported 6 of 6 changed, because source,
    // instrument and artifact_path were all rewritten. Reading cellsChanged
    // alone would say the scorer moved all of Texas. It moved nothing.
    const seededWithOldProvenance = {
      "48021|flood": {
        county_fips: "48021",
        facet: "flood",
        honest_coverage_pct: "99.00",
        integrity_verdict: "n/a",
        owner_match_rate: null,
        source: "flood-hazard-fact-atom-count",
        source_vintage: null,
        sampled: 0,
        classification: "real-at-ceiling",
        rail_state: "satisfied-present",
        threshold_pct: "95.00",
        absence_basis: null,
        verification_method: "sweep",
        verified_by_instrument: "countyFloodScoreCli.ts",
        artifact_path: "atoms:entity_type=flood-hazard-fact,countyFips=48021",
      },
    };
    const { ctx } = makeFakeStores({
      counties: ["48021"],
      features: { "48021": 1000 },
      atoms: { "48021": 990 },
      seed: seededWithOldProvenance,
    });
    const report = await runRailScore(ctx, { railKeys: ["flood"], dryRun: true });
    expect(report.totals.cellsChanged).toBe(1);
    expect(report.totals.cellsCoverageMoved).toBe(0);
  });

  it("a moved percentage counts on BOTH numbers", async () => {
    const { ctx } = makeFakeStores(BASE);
    const report = await runRailScore(ctx, { railKeys: ["flood"], dryRun: true });
    expect(report.totals.cellsChanged).toBe(2);
    expect(report.totals.cellsCoverageMoved).toBe(2);
  });
});
