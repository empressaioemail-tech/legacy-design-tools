/**
 * CTX-HAYS-BACKFILL unit tests. P-124.
 *
 * EVERY CONSTRAINT HERE FAILS A TEST BEFORE IT PASSES ONE. A check observed
 * only passing has not been observed working, so each rule is exercised
 * against a known violation and asserted to refuse, by name.
 *
 * The integration half -- the ones that need a real Postgres to prove no
 * money moved -- lives in publishedIdentifierBackfill.integration.test.ts.
 */

import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HeaderIndex } from "../csv";
import {
  ACCOUNT_CARDINALITY_MAX_DUPLICATE_RATIO,
  ACCOUNT_CARDINALITY_MIN_ROWS,
  BACKFILL_WRITABLE_COLUMNS,
  BackfillRefusal,
  assertBackfillStatementSafe,
  buildBackfillUpdate,
  buildUntouchedDigestSql,
  assertDigestScopeIntact,
  createMemoryRecordWriter,
  DIGEST_EXCLUDED_COLUMNS,
  DIGEST_MUST_COVER,
  discriminateOrionPropertyMember,
  readPublishedIdentifiers,
  resolveBackfillTaxYear,
  runPublishedIdentifierBackfill,
  type BackfillExecutor,
  type PublishedIdentifierRow,
} from "../publishedIdentifierBackfill";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => join(here, "__fixtures__", n);

const PROPERTY_HEADER = [
  "RecordType", "PropertyID", "QuickRefID", "PropertyNumber", "LegalDesc",
  "LegalLocationCode", "LegalLocationDesc", "LegalAcres", "AbstractBlock",
  "SubBlock", "SubLot", "SubLotRange", "SubSection", "SubUnit",
  "TaxingUnitList", "LeaseNumber", "MapNumber", "CurrMarketValue",
  "CurrAssessedValue", "CurrLandValue", "CurrImprovmentValue", "CurrAgValue",
  "MarketValue", "AssessedValue", "LandValue", "ImprovmentValue", "AgValue",
  "SquareFootage", "NbhdCode", "NbhdDesc", "Situs", "SitusPreDirectional",
  "SitusStreetNumber", "SitusStreetName", "SitusStreetSuffix",
  "SitusPostDirectional", "SitusCity", "SitusState", "SitusZip",
  "SitusLocation",
];

function decide(header: string[]) {
  return discriminateOrionPropertyMember(new HeaderIndex(header), header.length);
}

describe("member discrimination", () => {
  it("accepts the PROPERTY header", () => {
    const d = decide(PROPERTY_HEADER);
    expect(d.accepted).toBe(true);
    expect(d.columnCount).toBe(40);
    expect(d.rulesPassed).toEqual([
      "R1 identifier-columns-present",
      "R2 sibling-marker-absent",
      "R3 property-columns-present",
    ]);
  });

  // THE TRAP, STATED AS A TEST. Every member of a Hays drop carries these four
  // columns, so a check for the identifier columns passes on all six files.
  // R1 passing and the file still being refused is the whole point.
  it("R1 alone is NOT sufficient: the four shared columns pass R1 and are still refused", () => {
    const d = decide(["RecordType", "PropertyID", "QuickRefID", "PropertyNumber"]);
    expect(d.rulesPassed).toContain("R1 identifier-columns-present");
    expect(d.accepted).toBe(false);
    expect(d.refusal?.rule).toBe("R3 property-columns-present");
  });

  it.each([
    ["IMPROVEMENT", ["RecordType", "PropertyID", "QuickRefID", "PropertyNumber", "InstanceID", "Type", "Description", "StateCode", "Sequence", "PrevImpValue", "ImpValue"], "IMPROVEMENT"],
    ["SEGMENT", ["RecordType", "PropertyID", "QuickRefID", "PropertyNumber", "InstanceID", "Type", "Description", "Class", "ActYrBuilt", "EffYrBuilt", "Area"], "SEGMENT"],
    ["OWNER", ["RecordType", "PropertyID", "QuickRefID", "PropertyNumber", "OwnerID", "OwnerName", "Address1", "City", "State", "Zip", "ExemptionList"], "OWNER"],
    ["LAND", ["RecordType", "PropertyID", "QuickRefID", "PropertyNumber", "LandType", "Description", "StateCode", "Acres", "SquareFeet", "Sequence", "Value"], "LAND"],
    ["SALES", ["RecordType", "PropertyID", "QuickRefID", "PropertyNumber", "SaleDate", "DeedDate", "InstrumentNumber", "Book", "Page", "PrevOwnerName", "DeedType"], "SALES"],
  ])("refuses the %s member and NAMES it", (_label, header, named) => {
    const d = decide(header as string[]);
    expect(d.accepted).toBe(false);
    expect(d.refusal?.rule).toBe("R2 sibling-marker-absent");
    expect(d.refusal?.identifiedAs).toBe(named);
  });

  it("refuses a file with no identifier columns at all", () => {
    const d = decide(["prop_id", "market_value", "situs"]);
    expect(d.accepted).toBe(false);
    expect(d.refusal?.rule).toBe("R1 identifier-columns-present");
  });

  // Width is RECORDED and NOT GATED, and this is the test that says so: a
  // PROPERTY header with one extra column is still accepted.
  it("accepts a PROPERTY header that gained a column (width is not the gate)", () => {
    const d = decide([...PROPERTY_HEADER, "SomeNewColumn2027"]);
    expect(d.accepted).toBe(true);
    expect(d.columnCount).toBe(41);
  });
});

describe("readPublishedIdentifiers", () => {
  it("refuses the IMPROVEMENT member end to end and names IMPROVEMENT", async () => {
    // The exact false start: 103,490 rows read as if they were the 134,592-row
    // roll, because the identifier columns matched.
    await expect(
      readPublishedIdentifiers(fx("hays_improvement_sample.txt")),
    ).rejects.toMatchObject({
      name: "BackfillRefusal",
      rule: "R2 sibling-marker-absent",
      detail: { identifiedAs: "IMPROVEMENT" },
    });
  });

  it.each([
    ["hays_owner_sample.txt", "OWNER"],
    ["hays_land_sample.txt", "LAND"],
    ["hays_segment_sample.txt", "SEGMENT"],
  ])("refuses %s", async (file, named) => {
    await expect(readPublishedIdentifiers(fx(file))).rejects.toMatchObject({
      rule: "R2 sibling-marker-absent",
      detail: { identifiedAs: named },
    });
  });

  // R4 is the only rule that reads ROWS. This file passes R1-R3 on its header
  // and is a per-instance file underneath, which is precisely the case a
  // header-only gate cannot see.
  it("R4 refuses a PROPERTY-shaped file whose accounts repeat", async () => {
    await expect(
      readPublishedIdentifiers(fx("hays_property_per_instance_sample.txt")),
    ).rejects.toMatchObject({ rule: "R4 account-cardinality" });
  });

  it("reads the PROPERTY fixture and partitions every case", async () => {
    const read = await readPublishedIdentifiers(fx("hays_property_backfill_sample.txt"));
    expect(read.discrimination.accepted).toBe(true);
    expect(read.rowsRead).toBe(6);
    // A row publishing NEITHER identifier is dropped, named, and never written.
    expect(read.rowsWithNoIdentifier).toBe(1);
    expect(read.noIdentifierPropIds).toEqual(["10003"]);
    expect(read.rows.map((r) => r.propId).sort()).toEqual(
      ["10001", "10002", "10004", "10005", "999999"].sort(),
    );
    // Leading zeros are stripped exactly as prop_id holds them.
    expect(read.rows.find((r) => r.propId === "10005")?.quickRefId).toBe("R26205");
    // A half-published row keeps its null half as NULL, never "".
    const half = read.rows.find((r) => r.propId === "10004");
    expect(half?.quickRefId).toBe("R26202");
    expect(half?.propertyNumber).toBeNull();
    expect(half?.propertyNumber).not.toBe("");
  });

  // Declared degradation, not silent: below the floor R4 says so rather than
  // quietly passing.
  it("declares R4 not-applicable below the row floor instead of skipping silently", async () => {
    const read = await readPublishedIdentifiers(fx("hays_property_backfill_sample.txt"));
    expect(read.discrimination.accountCardinality?.applicable).toBe(false);
    expect(read.discrimination.accountCardinality?.minRows).toBe(
      ACCOUNT_CARDINALITY_MIN_ROWS,
    );
    expect(read.discrimination.accountCardinality?.note).toMatch(/NOT APPLICABLE/);
    expect(read.discrimination.rulesPassed).toContain(
      "R4 account-cardinality (not applicable)",
    );
  });

  it("counts an exact duplicate and REFUSES an account whose two rows disagree", async () => {
    const read = await readPublishedIdentifiers(
      fx("hays_property_duplicate_accounts_sample.txt"),
    );
    expect(read.duplicateRowsExact).toBe(1);
    expect(read.duplicateRowsConflicting).toBe(1);
    expect(read.conflictingPropIds).toEqual(["10006"]);
    // The conflicting account is dropped entirely: picking a winner would be a
    // resolution nobody authorised.
    expect(read.rows.map((r) => r.propId)).not.toContain("10006");
    expect(read.rows.map((r) => r.propId).sort()).toEqual(["10001", "10005"]);
  });

  it("the R4 ceiling is not vacuous: the per-instance fixture exceeds it and the property fixture does not", async () => {
    // Pre-registered falsifier: if BOTH fixtures sat on the same side of the
    // ceiling, this rule would be measuring nothing.
    await expect(
      readPublishedIdentifiers(fx("hays_property_per_instance_sample.txt")),
    ).rejects.toMatchObject({ rule: "R4 account-cardinality" });
    const clean = await readPublishedIdentifiers(
      fx("hays_property_duplicate_accounts_sample.txt"),
    );
    expect(clean.discrimination.accountCardinality?.duplicateRatio).toBeGreaterThan(
      ACCOUNT_CARDINALITY_MAX_DUPLICATE_RATIO,
    );
    // ...and it is only the FLOOR that saves it, which is the honest reading.
    expect(clean.discrimination.accountCardinality?.applicable).toBe(false);
  });
});

describe("declared-vintage gate", () => {
  it("resolves Hays to its declared 2026 without being told", () => {
    const d = resolveBackfillTaxYear("48209");
    expect(d.taxYear).toBe(2026);
    expect(d.tier).toBe("cad-export");
  });

  it("accepts a --tax-year that AGREES", () => {
    expect(resolveBackfillTaxYear("48209", 2026).taxYear).toBe(2026);
  });

  it("REFUSES a --tax-year that disagrees, naming both years", () => {
    let caught: BackfillRefusal | null = null;
    try {
      resolveBackfillTaxYear("48209", 2025);
    } catch (e) {
      caught = e as BackfillRefusal;
    }
    expect(caught?.rule).toBe("declared-vintage");
    expect(caught?.message).toContain("2025");
    expect(caught?.message).toContain("2026");
    expect(caught?.detail).toMatchObject({ requestedTaxYear: 2025, declaredTaxYear: 2026 });
  });

  it("refuses a county with no declared vintage rather than inventing one", () => {
    expect(() => resolveBackfillTaxYear("48999")).toThrow(/FAIL CLOSED/);
  });
});

describe("the statement", () => {
  const batch: PublishedIdentifierRow[] = [
    { propId: "10001", quickRefId: "R26199", propertyNumber: "11-2520-0000-03100-2" },
    { propId: "10004", quickRefId: "R26202", propertyNumber: null },
  ];

  it("is an UPDATE ... FROM (VALUES ...) and carries no INSERT", () => {
    const s = buildBackfillUpdate("48209", 2026, batch);
    expect(s.text).toMatch(/^UPDATE cad_property AS t/);
    expect(s.text).not.toMatch(/insert/i);
    expect(s.text).toMatch(/RETURNING t\.prop_id$/);
  });

  it("names ONLY the two allowlisted columns in its SET clause", () => {
    const s = buildBackfillUpdate("48209", 2026, batch);
    const setClause = /\bSET\b([\s\S]*?)\bFROM\b/i.exec(s.text)?.[1] ?? "";
    for (const forbidden of [
      "market_value", "assessed_value", "land_value", "improvement_value",
      "situs_address", "owner_name", "source_file", "source_vintage",
      "ingested_at", "year_built", "living_area_sqft", "land_acres",
      "property_use_code", "legal_description", "exemption_codes",
    ]) {
      expect(setClause).not.toContain(forbidden);
    }
    expect(setClause).toContain("quick_ref_id");
    expect(setClause).toContain("property_number");
    expect(() => assertBackfillStatementSafe(s.text)).not.toThrow();
  });

  it("scopes every write to (county_fips, declared tax_year, prop_id)", () => {
    const s = buildBackfillUpdate("48209", 2026, batch);
    expect(s.text).toContain("t.county_fips = $1");
    expect(s.text).toContain("t.tax_year = $2::int");
    expect(s.text).toContain("t.prop_id = v.prop_id");
    expect(s.values[0]).toBe("48209");
    expect(s.values[1]).toBe(2026);
  });

  it("passes a null identifier as SQL NULL, never as an empty string", () => {
    const s = buildBackfillUpdate("48209", 2026, batch);
    expect(s.values).toContain(null);
    expect(s.values).not.toContain("");
    expect(s.text).toContain("COALESCE(v.property_number, t.property_number)");
  });

  it("casts EVERY tuple, so correctness does not depend on which row is first", () => {
    const s = buildBackfillUpdate("48209", 2026, batch);
    const tupleCasts = s.text.match(/::text/g) ?? [];
    expect(tupleCasts).toHaveLength(batch.length * 3);
  });
});

describe("assertBackfillStatementSafe — verified by violating it", () => {
  it("REFUSES a SET clause that touches market_value", () => {
    const rogue =
      "UPDATE cad_property AS t SET quick_ref_id = v.q, market_value = v.m " +
      "FROM (VALUES ($1::text)) AS v(q) WHERE t.county_fips = $2";
    expect(() => assertBackfillStatementSafe(rogue)).toThrow(/market_value/);
  });

  it("REFUSES a SET clause that touches source_file", () => {
    const rogue =
      "UPDATE cad_property AS t SET source_file = v.f FROM (VALUES ($1::text)) AS v(f) WHERE 1=1";
    expect(() => assertBackfillStatementSafe(rogue)).toThrow(/source_file/);
  });

  it("REFUSES a statement carrying an INSERT verb", () => {
    const rogue =
      "UPDATE cad_property AS t SET quick_ref_id = v.q FROM (VALUES ($1::text)) AS v(q) " +
      "WHERE 1=1; INSERT INTO cad_property (prop_id) VALUES ('x')";
    expect(() => assertBackfillStatementSafe(rogue)).toThrow(/non-UPDATE verb/);
  });

  it("REFUSES a statement with no parsable SET clause", () => {
    expect(() => assertBackfillStatementSafe("DELETE FROM cad_property")).toThrow();
  });

  it("the allowlist is exactly the two identifier columns", () => {
    expect([...BACKFILL_WRITABLE_COLUMNS]).toEqual(["quick_ref_id", "property_number"]);
  });
});

describe("digest scope — the defect a mutation run found", () => {
  // THE HISTORY THIS TEST CARRIES. The first draft subtracted the writer's own
  // allowlist from the digest's column list. Adding market_value to that
  // allowlist and to the SET clause was ONE conceptual edit, and it both moved
  // a dollar on every row and removed market_value from the digest, which then
  // reported VERIFIED. The mutation run is what found it; nothing about
  // reading the code did.
  it("as shipped, the writer's allowlist and the digest's blind spot agree", () => {
    expect(() => assertDigestScopeIntact()).not.toThrow();
    expect([...DIGEST_EXCLUDED_COLUMNS]).toEqual([...BACKFILL_WRITABLE_COLUMNS]);
  });

  it("REFUSES when the writer is widened without widening the digest", () => {
    expect(() =>
      assertDigestScopeIntact(
        ["quick_ref_id", "property_number", "market_value"],
        ["quick_ref_id", "property_number"],
      ),
    ).toThrow(/diverged/);
  });

  it("REFUSES in the other direction too", () => {
    expect(() =>
      assertDigestScopeIntact(["quick_ref_id"], ["quick_ref_id", "property_number"]),
    ).toThrow(/diverged/);
  });

  it("names every money column the digest must be watching", () => {
    for (const c of ["market_value", "assessed_value", "land_value", "improvement_value", "source_file", "source_vintage", "ingested_at"]) {
      expect([...DIGEST_MUST_COVER]).toContain(c);
    }
  });
});

describe("the untouched-columns digest SQL", () => {
  it("renders NULL and the empty string differently", () => {
    const sql = buildUntouchedDigestSql(["market_value", "situs_address"]);
    expect(sql).toContain(`coalesce("market_value"::text, '~NULL~')`);
    expect(sql).toContain(`coalesce("situs_address"::text, '~NULL~')`);
  });

  it("REFUSES an empty column list rather than digesting nothing", () => {
    // A digest over zero columns would agree with itself forever: the exact
    // shape of a check that passes on a sentinel.
    expect(() => buildUntouchedDigestSql([])).toThrow(/no untouched columns/);
  });

  it("REFUSES a catalog name that is not a plain identifier", () => {
    expect(() => buildUntouchedDigestSql(['market_value"; DROP TABLE x --'])).toThrow(
      /not a plain identifier/,
    );
  });
});

/* ------------------------------------------------------------------ *
 * end to end against a recording executor
 * ------------------------------------------------------------------ */

interface Issued {
  text: string;
  values: unknown[] | undefined;
}

function fakeExecutor(opts: {
  rollPropIds: string[];
  digests?: [string, string];
  catalogColumns?: string[];
}): BackfillExecutor & { issued: Issued[] } {
  const issued: Issued[] = [];
  let digestCalls = 0;
  return {
    issued,
    async query(text: string, values?: unknown[]) {
      issued.push({ text, values });
      if (/FROM information_schema\.columns/.test(text)) {
        const cols = opts.catalogColumns ?? [
          "prop_id",
          "market_value",
          "assessed_value",
          "land_value",
          "improvement_value",
          "situs_address",
          "owner_name",
          "source_file",
          "source_vintage",
          "ingested_at",
        ];
        return { rows: cols.map((c) => ({ column_name: c })) as never[] };
      }
      if (/md5\(/.test(text)) {
        const pair = opts.digests ?? ["same", "same"];
        const d = digestCalls === 0 ? pair[0] : pair[1];
        digestCalls += 1;
        return { rows: [{ n: "3", digest: d }] as never[] };
      }
      if (/^SELECT prop_id FROM cad_property/.test(text)) {
        return { rows: opts.rollPropIds.map((p) => ({ prop_id: p })) as never[] };
      }
      // The UPDATE: echo back the prop_ids that are on the roll.
      const offered = (values ?? []).slice(2).filter((_, i) => i % 3 === 0) as string[];
      return {
        rows: offered
          .filter((p) => opts.rollPropIds.includes(p))
          .map((p) => ({ prop_id: p })) as never[],
      };
    },
  };
}

describe("runPublishedIdentifierBackfill", () => {
  it("skips an account with no roll row, names it, and issues no INSERT", async () => {
    const read = await readPublishedIdentifiers(fx("hays_property_backfill_sample.txt"));
    const exec = fakeExecutor({
      rollPropIds: ["10001", "10002", "10003", "10004", "10005", "40138"],
    });
    const record = createMemoryRecordWriter();
    const summary = await runPublishedIdentifierBackfill(exec, read, {
      countyFips: "48209",
      taxYear: 2026,
      sourceArchive: "hays.zip",
      sourceMember: "PropertyDataExport1404449.txt",
      sourceSha256: null,
      invocation: "test",
      dryRun: false,
      record,
      now: () => "2026-09-10T00:00:00.000Z",
    });

    expect(summary.rowsSkippedNoRollRow).toBe(1);
    expect(summary.rowsMatched).toBe(4);
    expect(summary.rowsUpdated).toBe(4);
    expect(summary.rowsSkippedNullIdentifier).toBe(1);
    // 40138 is on the roll and ABSENT from the export. 10003 is on the roll,
    // PRESENT in the export, and publishes nothing. Both stay NULL and they
    // are DIFFERENT states, so the summary reports them separately.
    expect(summary.rollRowsNotInExport).toBe(1);
    expect(summary.rollRowsInExportWithNoIdentifier).toBe(1);
    expect(summary.rollRowsInExportRefusedAsConflicting).toBe(0);
    expect(summary.rollRowsNoWrite).toBe(2);
    expect(summary.untouchedDigestVerified).toBe(true);

    for (const s of exec.issued) {
      expect(s.text).not.toMatch(/\binsert\s+into\b/i);
      expect(s.text).not.toMatch(/\bdelete\s+from\b/i);
    }

    // A count is not a record: the fail-closed populations are named.
    const plan = record.entries.find((e) => e.kind === "plan") as Record<string, unknown>;
    expect(plan.skippedNoRollRowPropIds).toEqual(["999999"]);
    expect(plan.skippedNullIdentifierPropIds).toEqual(["10003"]);
    expect(plan.rollRowsNotInExportPropIds).toEqual(["40138"]);
    expect(plan.rollRowsNoWritePropIds).toEqual(["10003", "40138"]);
    const batches = record.entries.filter((e) => e.kind === "batch");
    expect(batches).toHaveLength(1);
    expect((batches[0] as Record<string, unknown>).updatedPropIds).toHaveLength(4);
  });

  it("a dry run computes the plan and issues no UPDATE at all", async () => {
    const read = await readPublishedIdentifiers(fx("hays_property_backfill_sample.txt"));
    const exec = fakeExecutor({ rollPropIds: ["10001", "10002", "10004", "10005"] });
    const record = createMemoryRecordWriter();
    const summary = await runPublishedIdentifierBackfill(exec, read, {
      countyFips: "48209", taxYear: 2026, sourceArchive: "hays.zip",
      sourceMember: "m.txt", sourceSha256: null, invocation: "test",
      dryRun: true, record,
    });
    expect(summary.rowsMatched).toBe(4);
    expect(summary.rowsUpdated).toBe(0);
    expect(exec.issued.some((s) => /^UPDATE/.test(s.text))).toBe(false);
    expect(exec.issued.some((s) => /md5\(/.test(s.text))).toBe(false);
  });

  // VERIFY THE DIGEST GUARD BY VIOLATING IT. A digest observed only agreeing
  // has not been observed working, so this run makes the two digests differ
  // and asserts the guard refuses and records the violation.
  it("REFUSES and records a violation when the untouched-columns digest moves", async () => {
    const read = await readPublishedIdentifiers(fx("hays_property_backfill_sample.txt"));
    const exec = fakeExecutor({
      rollPropIds: ["10001", "10002", "10004", "10005"],
      digests: ["digest-before", "digest-AFTER-SOMETHING-MOVED"],
    });
    const record = createMemoryRecordWriter();
    await expect(
      runPublishedIdentifierBackfill(exec, read, {
        countyFips: "48209", taxYear: 2026, sourceArchive: "hays.zip",
        sourceMember: "m.txt", sourceSha256: null, invocation: "test",
        dryRun: false, record,
      }),
    ).rejects.toMatchObject({ rule: "untouched-digest" });
    const violation = record.entries.find((e) => e.kind === "violation");
    expect(violation).toBeDefined();
    expect(record.entries.some((e) => e.kind === "run-end")).toBe(true);
  });

  it("REFUSES when the catalog read comes back without the money columns", async () => {
    // The positive half of the scope defence, proven reachable: a digest that
    // is not watching market_value proves nothing about market_value, so the
    // run must refuse rather than report a verified nothing.
    const read = await readPublishedIdentifiers(fx("hays_property_backfill_sample.txt"));
    const exec = fakeExecutor({ rollPropIds: ["10001"], catalogColumns: ["prop_id"] });
    await expect(
      runPublishedIdentifierBackfill(exec, read, {
        countyFips: "48209", taxYear: 2026, sourceArchive: "hays.zip",
        sourceMember: "m.txt", sourceSha256: null, invocation: "test",
        dryRun: false, record: createMemoryRecordWriter(),
      }),
    ).rejects.toMatchObject({ rule: "digest-scope" });
  });

  it("the digest guard is not vacuous: the same run passes when the digests agree", async () => {
    // The other half of the pre-registered falsifier. If this run ALSO failed,
    // the guard would be refusing everything rather than detecting anything.
    const read = await readPublishedIdentifiers(fx("hays_property_backfill_sample.txt"));
    const exec = fakeExecutor({
      rollPropIds: ["10001"],
      digests: ["identical", "identical"],
    });
    const record = createMemoryRecordWriter();
    const summary = await runPublishedIdentifierBackfill(exec, read, {
      countyFips: "48209", taxYear: 2026, sourceArchive: "hays.zip",
      sourceMember: "m.txt", sourceSha256: null, invocation: "test",
      dryRun: false, record,
    });
    expect(summary.untouchedDigestVerified).toBe(true);
    expect(record.entries.some((e) => e.kind === "violation")).toBe(false);
  });
});
