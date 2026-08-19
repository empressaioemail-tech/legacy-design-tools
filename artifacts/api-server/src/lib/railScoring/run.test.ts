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
        return { rows: [{ r: params?.[0] === "txgio_parcel" ? "txgio_parcel" : null }] };
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
    async query(_text: string, params?: unknown[]): Promise<any> {
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

  it("a rail with no measurement spec is UNAVAILABLE with its owner named", async () => {
    const { ctx } = makeFakeStores(BASE);
    const report = await runRailScore(ctx, { railKeys: ["footprint"], dryRun: true });
    expect(report.rails).toEqual([]);
    expect(report.railsUnavailable[0]?.reason).toBe("no_measurement_spec");
    expect(report.railsUnavailable[0]?.message).toMatch(/SS-W14/);
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
