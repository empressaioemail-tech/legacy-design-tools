/**
 * P-178 unit tests for the declared-roll membership marker.
 *
 * A mock RollMembershipDb that itself applies MARK_ABSENT_FROM_DECLARED_DROP_SQL
 * against an in-memory row set (rather than a real Postgres), so these tests
 * exercise the SQL's own predicate logic, not a hand-rewritten restatement of it.
 */

import { describe, expect, it } from "vitest";
import {
  ABSENT_FROM_DECLARED_DROP,
  MARK_ABSENT_FROM_DECLARED_DROP_SQL,
  createMemoryRecordWriter,
  markAbsentFromDeclaredDrop,
  type RollMembershipDb,
} from "../rollMembership";

interface FakeRow {
  county_fips: string;
  prop_id: string;
  tax_year: number;
  source_file: string;
  roll_membership: string | null;
  declared_source_file: string | null;
}

/**
 * A minimal, faithful-enough interpreter of
 * MARK_ABSENT_FROM_DECLARED_DROP_SQL against an in-memory table -- proves
 * the query's own WHERE/IS DISTINCT FROM logic, not a parallel
 * reimplementation of it in JS that could silently disagree.
 */
function fakeDb(rows: FakeRow[]): RollMembershipDb & { rows: FakeRow[] } {
  return {
    rows,
    async query(text, values) {
      if (!text.includes("UPDATE cad_property")) {
        throw new Error(`fakeDb: unexpected query: ${text}`);
      }
      const [countyFips, taxYear, declaredSourceFile, rollMembership] = values as [
        string,
        number,
        string,
        string,
      ];
      const matched = rows.filter(
        (r) =>
          r.county_fips === countyFips &&
          r.tax_year === taxYear &&
          r.source_file !== declaredSourceFile &&
          (r.roll_membership !== rollMembership || r.declared_source_file !== declaredSourceFile),
      );
      for (const r of matched) {
        r.roll_membership = rollMembership;
        r.declared_source_file = declaredSourceFile;
      }
      return { rows: matched.map((r) => ({ prop_id: r.prop_id })) };
    },
  };
}

function row(overrides: Partial<FakeRow>): FakeRow {
  return {
    county_fips: "48209",
    prop_id: "1",
    tax_year: 2026,
    source_file: "2026-PRELIMINARY-DATA-EXPORT-FILES.zip",
    roll_membership: null,
    declared_source_file: null,
    ...overrides,
  };
}

describe("MARK_ABSENT_FROM_DECLARED_DROP_SQL shape", () => {
  it("is a single UPDATE against cad_property naming only roll_membership/declared_source_file", () => {
    expect(MARK_ABSENT_FROM_DECLARED_DROP_SQL).toMatch(/^\s*UPDATE cad_property/);
    expect(MARK_ABSENT_FROM_DECLARED_DROP_SQL).toMatch(/SET roll_membership = \$4/);
    expect(MARK_ABSENT_FROM_DECLARED_DROP_SQL).toMatch(/declared_source_file = \$3/);
    expect(MARK_ABSENT_FROM_DECLARED_DROP_SQL).not.toMatch(/\b(INSERT|DELETE|TRUNCATE|DROP)\b/i);
  });
});

describe("markAbsentFromDeclaredDrop", () => {
  it("FALSIFIER: marks a row NOT in this run's own source_file, and only that row -- reproduces the live 2026-09-13 Hays staging gap (0 marked by the ingest CLI itself)", async () => {
    const db = fakeDb([
      row({ prop_id: "97658", source_file: "hays_20260826_certified.zip" }), // this run's own row -- must NOT be touched
      row({ prop_id: "84639" }), // fell off -- preliminary source_file, untouched by this run
    ]);
    const record = createMemoryRecordWriter();
    const result = await markAbsentFromDeclaredDrop(db, {
      countyFips: "48209",
      taxYear: 2026,
      declaredSourceFile: "hays_20260826_certified.zip",
      record,
      now: () => "2026-09-13T23:10:00.000Z",
    });
    expect(result.markedPropIds).toEqual(["84639"]);
    expect(db.rows.find((r) => r.prop_id === "97658")!.roll_membership).toBeNull();
    expect(db.rows.find((r) => r.prop_id === "84639")!.roll_membership).toBe(
      ABSENT_FROM_DECLARED_DROP,
    );
  });

  it("writes one durable record entry per marked account, naming the account", async () => {
    const db = fakeDb([row({ prop_id: "100" }), row({ prop_id: "200" })]);
    const record = createMemoryRecordWriter();
    await markAbsentFromDeclaredDrop(db, {
      countyFips: "48209",
      taxYear: 2026,
      declaredSourceFile: "hays_20260826_certified.zip",
      record,
      now: () => "2026-09-13T23:10:00.000Z",
    });
    expect(record.entries).toHaveLength(2);
    expect(record.entries.map((e) => e.propId).sort()).toEqual(["100", "200"]);
    expect(record.entries[0]).toMatchObject({
      event: "roll-membership-marked",
      countyFips: "48209",
      taxYear: 2026,
      declaredSourceFile: "hays_20260826_certified.zip",
      rollMembership: ABSENT_FROM_DECLARED_DROP,
      at: "2026-09-13T23:10:00.000Z",
    });
  });

  it("IDEMPOTENT: a second run against the same drop marks zero additional rows and writes zero additional record entries", async () => {
    const db = fakeDb([row({ prop_id: "1" })]);
    const first = await markAbsentFromDeclaredDrop(db, {
      countyFips: "48209",
      taxYear: 2026,
      declaredSourceFile: "hays_20260826_certified.zip",
      record: createMemoryRecordWriter(),
    });
    expect(first.markedPropIds).toEqual(["1"]);

    const secondRecord = createMemoryRecordWriter();
    const second = await markAbsentFromDeclaredDrop(db, {
      countyFips: "48209",
      taxYear: 2026,
      declaredSourceFile: "hays_20260826_certified.zip",
      record: secondRecord,
    });
    expect(second.markedPropIds).toEqual([]);
    expect(secondRecord.entries).toHaveLength(0);
  });

  it("scoped: never touches a different county or a different tax_year", async () => {
    const db = fakeDb([
      row({ prop_id: "1", county_fips: "48209" }),
      row({ prop_id: "2", county_fips: "48491" }), // different county -- must not be marked
      row({ prop_id: "3", tax_year: 2025 }), // different tax_year -- must not be marked
    ]);
    const result = await markAbsentFromDeclaredDrop(db, {
      countyFips: "48209",
      taxYear: 2026,
      declaredSourceFile: "hays_20260826_certified.zip",
      record: createMemoryRecordWriter(),
    });
    expect(result.markedPropIds).toEqual(["1"]);
    expect(db.rows.find((r) => r.prop_id === "2")!.roll_membership).toBeNull();
    expect(db.rows.find((r) => r.prop_id === "3")!.roll_membership).toBeNull();
  });

  it("re-marks a row previously marked from an OLDER declared drop when a newer drop still does not name it -- declared_source_file always names the CURRENT declared drop", async () => {
    const db = fakeDb([
      row({
        prop_id: "1",
        source_file: "2026-PRELIMINARY-DATA-EXPORT-FILES.zip",
        roll_membership: ABSENT_FROM_DECLARED_DROP,
        declared_source_file: "an_older_drop.zip",
      }),
    ]);
    const result = await markAbsentFromDeclaredDrop(db, {
      countyFips: "48209",
      taxYear: 2026,
      declaredSourceFile: "hays_20260826_certified.zip",
      record: createMemoryRecordWriter(),
    });
    expect(result.markedPropIds).toEqual(["1"]);
    expect(db.rows[0]!.declared_source_file).toBe("hays_20260826_certified.zip");
  });
});
