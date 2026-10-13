/**
 * The typeahead's prefix queries must hand the 0058 btree indexes an index
 * RANGE on the whole typed prefix, not just its leading non-letters.
 *
 * Live 2026-10-13: GET /api/pe-situs-search?q=7 huisache answered
 * `situs-search-budget-exceeded` in ~4.3 s although "7 HUISACHE LN, WIMBERLEY,
 * TX 78676" (48209:49502) is in txgio_parcel. EXPLAIN on prod showed the
 * ILIKE-only predicate gives `Index Cond: <normalized> >= '7 ' AND < '7!'`
 * (every "7 ..." situs statewide, regexp chain re-run per heap row: 3,274 ms
 * EXPLAIN ANALYZE); the added case-sensitive LIKE gives
 * `>= '7 HUISACHE' AND < '7 HUISACHF'` (9 ms).
 *
 * Fake db only, no DATABASE_URL. Each query's WHERE clause is rendered through
 * drizzle's PgDialect, so the assertion is on the SQL the store would run.
 */

import { describe, it, expect, vi } from "vitest";
import type { SQL } from "drizzle-orm";

vi.mock("@workspace/db", async () => {
  const { pgTable, text, doublePrecision } = await import("drizzle-orm/pg-core");
  // Column names match lib/db/src/schema (txgioParcel.ts / txgioAddress.ts).
  const txgioParcel = pgTable("txgio_parcel", {
    countyFips: text("county_fips").notNull(),
    propId: text("prop_id"),
    situsAddress: text("situs_address"),
    situsCity: text("situs_city"),
    situsState: text("situs_state"),
    situsZip: text("situs_zip"),
  });
  const txgioAddress = pgTable("txgio_address", {
    countyFips: text("county_fips").notNull(),
    fullAddr: text("full_addr"),
    postComm: text("post_comm"),
    state: text("state"),
    postCode: text("post_code"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
  });
  return { db: {}, txgioParcel, txgioAddress };
});

vi.mock("../brokerageTxParcels", () => ({
  allStoreCounties: () => [],
}));

const { searchSitusByPrefix, searchAddressPointsByPrefix, searchPlaceByPrefix } =
  await import("../txgioAddressResolve");
const { PgDialect } = await import("drizzle-orm/pg-core");

const dialect = new PgDialect();

/** A fake db that records every WHERE clause and returns `rows`. */
function recordingDb(rows: unknown[] = []) {
  const wheres: { sql: string; params: unknown[] }[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: (clause: SQL) => {
          const q = dialect.sqlToQuery(clause);
          wheres.push({ sql: q.sql, params: q.params });
          return { limit: async () => rows };
        },
      }),
    }),
  };
  return { db, wheres };
}

/** The params bound to a case-SENSITIVE `LIKE $n` (not ILIKE) in `w`. */
function likeParams(w: { sql: string; params: unknown[] }): unknown[] {
  const out: unknown[] = [];
  for (const m of w.sql.matchAll(/(?<!I)LIKE \$(\d+)/g)) {
    out.push(w.params[Number(m[1]) - 1]);
  }
  return out;
}

function ilikeParams(w: { sql: string; params: unknown[] }): unknown[] {
  const out: unknown[] = [];
  for (const m of w.sql.matchAll(/ILIKE \$(\d+)/g)) {
    out.push(w.params[Number(m[1]) - 1]);
  }
  return out;
}

describe("situs prefix queries carry an index-range LIKE on the whole prefix", () => {
  it("searchSitusByPrefix: '7 huisache' -> LIKE '7 HUISACHE%' beside the ILIKE", async () => {
    const { db, wheres } = recordingDb();
    await searchSitusByPrefix({ query: "7 huisache", database: db as never });
    expect(wheres).toHaveLength(1);
    expect(likeParams(wheres[0]!)).toEqual(["7 HUISACHE%"]);
    // The ILIKE is still the predicate of record.
    expect(ilikeParams(wheres[0]!)).toEqual(["7 HUISACHE%"]);
  });

  it("searchAddressPointsByPrefix: same range on full_addr", async () => {
    const { db, wheres } = recordingDb();
    await searchAddressPointsByPrefix({ query: "7 huisache", database: db as never });
    expect(wheres).toHaveLength(1);
    expect(wheres[0]!.sql).toContain("full_addr");
    expect(likeParams(wheres[0]!)).toEqual(["7 HUISACHE%"]);
    expect(ilikeParams(wheres[0]!)).toEqual(["7 HUISACHE%"]);
  });

  it("the locality-filtered prefix fallback ranges every variant", async () => {
    const { db, wheres } = recordingDb();
    await searchPlaceByPrefix({
      query: "7 Huisache Ln, Wimberley, TX 78676",
      database: db as never,
      coverageSource: {
        checkCoverage: async () => ({ status: "covered" }) as never,
      },
    });
    // street keys (equality), prefix-with-locality, address points.
    const withLike = wheres.filter((w) => likeParams(w).length > 0);
    expect(withLike.length).toBeGreaterThanOrEqual(2);
    const all = withLike.flatMap(likeParams);
    expect(all).toContain("7 HUISACHE LN%");
    expect(all).toContain("7 HUISACHE%");
  });

  it("escapes LIKE metacharacters in the range exactly as in the ILIKE", async () => {
    const { db, wheres } = recordingDb();
    await searchSitusByPrefix({ query: "12 A_B%C", database: db as never });
    expect(likeParams(wheres[0]!)).toEqual(ilikeParams(wheres[0]!));
  });
});
