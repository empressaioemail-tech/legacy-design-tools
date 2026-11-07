/**
 * lookupParcelNodeForScreen: the existence probe behind add_to_screen,
 * create_screen node-id rows, and the research/brief miss split.
 *
 * Fake db only, no DATABASE_URL. The fake renders the drizzle WHERE clause
 * through PgDialect and evaluates the rendered SQL against in-memory rows
 * with a small interpreter, so the predicate the store would run is the
 * predicate under test. A fake that ignored the WHERE clause would pass the
 * leading-zero case on the post-filter alone and prove nothing. The
 * interpreter refuses SQL it does not understand rather than passing it.
 *
 * Store facts this test encodes (verified 2026-08-29 against
 * lib/db/src/schema/txgioParcel.ts and cad-ingest txgio parse): prop_id is
 * stored RAW (leading zeros intact); the node id suffix is the normalized
 * form (leading zeros stripped, parcelNodeId.ts).
 */

import { describe, it, expect, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import type { TxgioAddressResolveDb } from "../txgioAddressResolve";

vi.mock("@workspace/db", async () => {
  const { pgTable, text } = await import("drizzle-orm/pg-core");
  // Column names match lib/db/src/schema/txgioParcel.ts.
  const txgioParcel = pgTable("txgio_parcel", {
    countyFips: text("county_fips").notNull(),
    propId: text("prop_id"),
    situsAddress: text("situs_address"),
  });
  return { db: {}, txgioParcel, txgioAddress: {} };
});

vi.mock("../brokerageTxParcels", () => ({
  allStoreCounties: () => [],
}));

const { lookupParcelNodeForScreen } = await import("../txgioAddressResolve");
const { PgDialect } = await import("drizzle-orm/pg-core");

type ParcelRow = {
  county_fips: string;
  prop_id: string | null;
  situs_address: string | null;
};

type Tok =
  | { t: "id"; v: string }
  | { t: "param"; v: number }
  | { t: "lit"; v: string }
  | { t: "sym"; v: string }
  | { t: "word"; v: string };

function tokenize(sqlText: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < sqlText.length) {
    const c = sqlText[i]!;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === '"') {
      // "table"."column": keep the last quoted segment as the column name.
      let name = "";
      while (sqlText[i] === '"') {
        const end = sqlText.indexOf('"', i + 1);
        if (end < 0) throw new Error(`unterminated identifier at ${i}`);
        name = sqlText.slice(i + 1, end);
        i = end + 1;
        if (sqlText[i] === ".") i += 1;
      }
      out.push({ t: "id", v: name });
      continue;
    }
    if (c === "$") {
      let j = i + 1;
      while (/\d/.test(sqlText[j] ?? "")) j += 1;
      out.push({ t: "param", v: Number(sqlText.slice(i + 1, j)) - 1 });
      i = j;
      continue;
    }
    if (c === "'") {
      const end = sqlText.indexOf("'", i + 1);
      if (end < 0) throw new Error(`unterminated literal at ${i}`);
      out.push({ t: "lit", v: sqlText.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if ("(),=".includes(c)) {
      out.push({ t: "sym", v: c });
      i += 1;
      continue;
    }
    let j = i;
    while (/[A-Za-z_]/.test(sqlText[j] ?? "")) j += 1;
    if (j === i) {
      throw new Error(`unsupported SQL at ${i}: ${sqlText.slice(i, i + 24)}`);
    }
    out.push({ t: "word", v: sqlText.slice(i, j).toLowerCase() });
    i = j;
  }
  return out;
}

/**
 * Evaluates `a = b`, `and`, `or`, parentheses, `ltrim(x, 'chars')`,
 * columns, `$n` params, and quoted literals with SQL NULL semantics
 * (NULL = x is not true). Anything else throws.
 */
function evaluate(
  sqlText: string,
  params: unknown[],
  row: ParcelRow,
): boolean {
  const toks = tokenize(sqlText);
  let p = 0;
  const peek = () => toks[p];
  const take = () => {
    const tok = toks[p];
    if (!tok) throw new Error("unexpected end of SQL");
    p += 1;
    return tok;
  };
  const expectSym = (v: string) => {
    const tok = take();
    if (tok.t !== "sym" || tok.v !== v) {
      throw new Error(`expected ${v}, got ${JSON.stringify(tok)}`);
    }
  };
  function operand(): string | null {
    const tok = take();
    if (tok.t === "id") {
      if (!(tok.v in row)) throw new Error(`unknown column ${tok.v}`);
      return row[tok.v as keyof ParcelRow];
    }
    if (tok.t === "param") {
      const value = params[tok.v];
      if (typeof value !== "string") {
        throw new Error(`param $${tok.v + 1} is not a string`);
      }
      return value;
    }
    if (tok.t === "lit") return tok.v;
    if (tok.t === "word" && tok.v === "ltrim") {
      expectSym("(");
      const s = operand();
      expectSym(",");
      const chars = operand();
      expectSym(")");
      if (s === null || chars === null) return null;
      let k = 0;
      while (k < s.length && chars.includes(s[k]!)) k += 1;
      return s.slice(k);
    }
    throw new Error(`unsupported operand ${JSON.stringify(tok)}`);
  }
  function factor(): boolean {
    const next = peek();
    if (next?.t === "sym" && next.v === "(") {
      take();
      const v = expr();
      expectSym(")");
      return v;
    }
    const l = operand();
    expectSym("=");
    const r = operand();
    return l !== null && r !== null && l === r;
  }
  function term(): boolean {
    let v = factor();
    while (peek()?.t === "word" && peek()?.v === "and") {
      take();
      const r = factor();
      v = v && r;
    }
    return v;
  }
  function expr(): boolean {
    let v = term();
    while (peek()?.t === "word" && peek()?.v === "or") {
      take();
      const r = term();
      v = v || r;
    }
    return v;
  }
  const result = expr();
  if (p !== toks.length) throw new Error("trailing tokens in SQL");
  return result;
}

function fakeParcelDb(rows: ParcelRow[]) {
  const dialect = new PgDialect();
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const database = {
    select: () => ({
      from: () => ({
        where: (cond: SQL) => ({
          limit: async (n: number) => {
            const q = dialect.sqlToQuery(cond);
            calls.push({ sql: q.sql, params: q.params });
            return rows
              .filter((r) => evaluate(q.sql, q.params, r))
              .slice(0, n)
              .map((r) => ({ propId: r.prop_id, situsAddress: r.situs_address }));
          },
        }),
      }),
    }),
  };
  return { database: database as unknown as TxgioAddressResolveDb, calls };
}

const BASTROP = "48021";
const PINE_SITUS = "908 PINE , BASTROP, TX 78602";

describe("SQL interpreter self-test (the fake must be able to fail)", () => {
  const row: ParcelRow = {
    county_fips: BASTROP,
    prop_id: "0034137",
    situs_address: PINE_SITUS,
  };

  it("matches and rejects on the rendered predicate", () => {
    expect(
      evaluate('("t"."county_fips" = $1 and "t"."prop_id" = $2)', [BASTROP, "0034137"], row),
    ).toBe(true);
    expect(
      evaluate('("t"."county_fips" = $1 and "t"."prop_id" = $2)', [BASTROP, "34137"], row),
    ).toBe(false);
    expect(
      evaluate('ltrim("t"."prop_id", \'0\') = $1', ["34137"], row),
    ).toBe(true);
    expect(evaluate('"t"."prop_id" = $1', ["0034137"], { ...row, prop_id: null })).toBe(false);
  });

  it("refuses SQL it does not understand instead of passing it", () => {
    expect(() => evaluate('"t"."prop_id" LIKE $1', ["%"], row)).toThrow(
      /expected =|unsupported/,
    );
    expect(() => evaluate('"t"."missing" = $1', ["x"], row)).toThrow(
      /unknown column/,
    );
  });
});

describe("lookupParcelNodeForScreen", () => {
  it("present: returns the node id and the situs as the label", async () => {
    const { database, calls } = fakeParcelDb([
      { county_fips: BASTROP, prop_id: "34137", situs_address: PINE_SITUS },
      { county_fips: BASTROP, prop_id: "34169", situs_address: "910 PINE , BASTROP, TX 78602" },
    ]);
    await expect(
      lookupParcelNodeForScreen({ parcelNodeId: "48021:34137", database }),
    ).resolves.toEqual({ parcelNodeId: "48021:34137", label: PINE_SITUS });
    expect(calls).toHaveLength(1);
  });

  it("empty situs: still a hit, labelled with the node id, never a sentinel", async () => {
    const { database } = fakeParcelDb([
      { county_fips: BASTROP, prop_id: "34137", situs_address: null },
    ]);
    await expect(
      lookupParcelNodeForScreen({ parcelNodeId: "48021:34137", database }),
    ).resolves.toEqual({ parcelNodeId: "48021:34137", label: "48021:34137" });

    const blank = fakeParcelDb([
      { county_fips: BASTROP, prop_id: "34137", situs_address: "   " },
    ]);
    await expect(
      lookupParcelNodeForScreen({ parcelNodeId: "48021:34137", database: blank.database }),
    ).resolves.toEqual({ parcelNodeId: "48021:34137", label: "48021:34137" });

    // The store's punctuation-only situs sentinel (", ,") is an empty situs.
    const sentinel = fakeParcelDb([
      { county_fips: BASTROP, prop_id: "34137", situs_address: ", ," },
    ]);
    await expect(
      lookupParcelNodeForScreen({ parcelNodeId: "48021:34137", database: sentinel.database }),
    ).resolves.toEqual({ parcelNodeId: "48021:34137", label: "48021:34137" });
  });

  it("absent: null when no row in that county carries the id, even if another county does", async () => {
    const { database, calls } = fakeParcelDb([
      { county_fips: BASTROP, prop_id: "34137", situs_address: PINE_SITUS },
      { county_fips: "48209", prop_id: "900099", situs_address: "1 ELSEWHERE, BUDA, TX" },
    ]);
    await expect(
      lookupParcelNodeForScreen({ parcelNodeId: "48021:900099", database }),
    ).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("leading-zero stored id: the normalized suffix still finds the raw row", async () => {
    const { database } = fakeParcelDb([
      { county_fips: BASTROP, prop_id: "0034137", situs_address: PINE_SITUS },
    ]);
    await expect(
      lookupParcelNodeForScreen({ parcelNodeId: "48021:34137", database }),
    ).resolves.toEqual({ parcelNodeId: "48021:34137", label: PINE_SITUS });
  });

  it("post-filter kept: a non-canonical id (unstripped zeros) is not the stored parcel's node id", async () => {
    const { database } = fakeParcelDb([
      { county_fips: BASTROP, prop_id: "0034137", situs_address: PINE_SITUS },
    ]);
    await expect(
      lookupParcelNodeForScreen({ parcelNodeId: "48021:0034137", database }),
    ).resolves.toBeNull();
  });

  it("does not query the store for an id that does not parse", async () => {
    const { database, calls } = fakeParcelDb([]);
    await expect(
      lookupParcelNodeForScreen({ parcelNodeId: "not-a-node-id", database }),
    ).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("a store error propagates; it is never answered as null", async () => {
    const database = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              throw new Error("password authentication failed");
            },
          }),
        }),
      }),
    } as unknown as TxgioAddressResolveDb;
    await expect(
      lookupParcelNodeForScreen({ parcelNodeId: "48021:34137", database }),
    ).rejects.toThrow("password authentication failed");
  });
});
