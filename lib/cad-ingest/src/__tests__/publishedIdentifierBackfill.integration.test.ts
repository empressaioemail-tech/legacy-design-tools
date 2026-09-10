/**
 * CTX-HAYS-BACKFILL integration tests. P-124.
 *
 * These are the ones with real money behind them, so they run against a REAL
 * Postgres via @workspace/db/testing's withTestSchema, the same harness the
 * cad_property upsert suite uses. CI provides DATABASE_URL and a live service
 * container, so this suite is not dormant; locally it skips when there is no
 * database, which is stated rather than silent.
 *
 * The dispatch asked for four violations and every one of them is here:
 *   - an export row with no roll row must not create one;
 *   - a blank identifier must leave NULL rather than an empty string;
 *   - a wrong tax_year must refuse (unit-level, plus the row-level proof here
 *     that a non-declared year is not touched);
 *   - a run must be PROVABLY unable to alter a market value.
 *
 * The last one is proven twice, and the second proof is the one that counts:
 * once by asserting the values are unchanged, and once by making the guard
 * FAIL. A control observed only passing has not been observed working.
 */

import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withTestSchema, type TestSchemaContext } from "@workspace/db/testing";
import {
  createMemoryRecordWriter,
  readPublishedIdentifiers,
  runPublishedIdentifierBackfill,
  type BackfillExecutor,
} from "../publishedIdentifierBackfill";

const hasDb =
  process.env.TEST_DATABASE_URL !== undefined ||
  process.env.DATABASE_URL !== undefined;

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "__fixtures__", "hays_property_backfill_sample.txt");

const COUNTY = "48209";
const DECLARED_YEAR = 2026;

/**
 * The Hays roll, as it stands before a backfill: identifier columns NULL,
 * money present, source_file naming the PRELIMINARY drop. `40138` is on the
 * roll and absent from the export, so it is the fail-closed population.
 * `10005` is stored without leading zeros; the export writes it padded.
 * The second `10001` row sits at a NON-declared tax_year and must not move.
 */
const SEED = [
  { propId: "10001", marketValue: 397260, taxYear: DECLARED_YEAR },
  { propId: "10002", marketValue: 512000, taxYear: DECLARED_YEAR },
  { propId: "10003", marketValue: 250000, taxYear: DECLARED_YEAR },
  { propId: "10004", marketValue: 310000, taxYear: DECLARED_YEAR },
  { propId: "10005", marketValue: 400000, taxYear: DECLARED_YEAR },
  { propId: "40138", marketValue: 123456, taxYear: DECLARED_YEAR },
  { propId: "10001", marketValue: 111111, taxYear: 2025 },
];

async function seed(ctx: TestSchemaContext): Promise<void> {
  for (const row of SEED) {
    await ctx.pool.query(
      `INSERT INTO cad_property
         (county_fips, prop_id, tax_year, market_value, situs_address,
          source_file, source_vintage)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        COUNTY,
        row.propId,
        row.taxYear,
        row.marketValue,
        `${row.propId} SEEDED ST`,
        "2026-PRELIMINARY-DATA-EXPORT-FILES.zip",
        "tier:cad-export;adapter:orion;drop:2026-preliminary",
      ],
    );
  }
}

function executorFor(ctx: TestSchemaContext): BackfillExecutor {
  return {
    async query(text, values) {
      const r = await ctx.pool.query(text, values);
      return { rows: r.rows as never[] };
    },
  };
}

async function runOnce(
  ctx: TestSchemaContext,
  exec: BackfillExecutor = executorFor(ctx),
) {
  const read = await readPublishedIdentifiers(FIXTURE);
  const record = createMemoryRecordWriter();
  const summary = await runPublishedIdentifierBackfill(exec, read, {
    countyFips: COUNTY,
    taxYear: DECLARED_YEAR,
    sourceArchive: "hays.zip",
    sourceMember: "PropertyDataExport1404449.txt",
    sourceSha256: null,
    invocation: "integration test",
    dryRun: false,
    record,
  });
  return { summary, record };
}

async function snapshot(ctx: TestSchemaContext) {
  const r = await ctx.pool.query<{
    prop_id: string;
    tax_year: number;
    market_value: string | null;
    situs_address: string | null;
    source_file: string;
    source_vintage: string;
    ingested_at: Date;
    quick_ref_id: string | null;
    property_number: string | null;
  }>(
    `SELECT prop_id, tax_year, market_value, situs_address, source_file,
            source_vintage, ingested_at, quick_ref_id, property_number
       FROM cad_property WHERE county_fips = $1 ORDER BY tax_year, prop_id`,
    [COUNTY],
  );
  return r.rows;
}

describe.skipIf(!hasDb)("published-identifier backfill against a real store", () => {
  it("writes both identifiers, inserts nothing, and moves no other column", async () => {
    await withTestSchema(async (ctx) => {
      await seed(ctx);
      const before = await snapshot(ctx);
      expect(before).toHaveLength(SEED.length);

      const { summary, record } = await runOnce(ctx);

      // NEVER INSERT. The export carries 999999, which is not on the roll.
      const after = await snapshot(ctx);
      expect(after).toHaveLength(SEED.length);
      expect(after.map((r) => r.prop_id)).not.toContain("999999");
      expect(summary.rowsSkippedNoRollRow).toBe(1);

      // The two columns landed where they should have.
      const at = (p: string, y = DECLARED_YEAR) =>
        after.find((r) => r.prop_id === p && r.tax_year === y);
      expect(at("10001")?.quick_ref_id).toBe("R26199");
      expect(at("10001")?.property_number).toBe("11-2520-0000-03100-2");
      expect(at("10002")?.quick_ref_id).toBe("R26200");
      // Leading zeros in the export normalize onto the unpadded stored key.
      expect(at("10005")?.quick_ref_id).toBe("R26205");

      // NEVER AN EMPTY STRING. 10003 publishes neither identifier; 10004
      // publishes only one. Both untouched halves must be NULL, and NULL is
      // asserted separately from "not empty string" because collapsing those
      // two is the defect this column exists to avoid.
      expect(at("10003")?.quick_ref_id).toBeNull();
      expect(at("10003")?.property_number).toBeNull();
      expect(at("10004")?.quick_ref_id).toBe("R26202");
      expect(at("10004")?.property_number).toBeNull();
      expect(at("10004")?.property_number).not.toBe("");
      const blanks = await ctx.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM cad_property
          WHERE county_fips = $1 AND (quick_ref_id = '' OR property_number = '')`,
        [COUNTY],
      );
      expect(blanks.rows[0]?.n).toBe("0");

      // The fail-closed populations, reported SEPARATELY because "the export
      // has no such account" (40138) and "the export has it and publishes
      // nothing" (10003) are different states.
      expect(at("40138")?.quick_ref_id).toBeNull();
      expect(at("40138")?.property_number).toBeNull();
      expect(summary.rollRowsNotInExport).toBe(1);
      expect(summary.rollRowsInExportWithNoIdentifier).toBe(1);
      expect(summary.rollRowsNoWrite).toBe(2);

      // A NON-declared tax_year is not touched. The 2025 row for the same
      // prop_id is the control.
      expect(at("10001", 2025)?.quick_ref_id).toBeNull();

      // NO OTHER COLUMN MOVED. Asserted field by field, and then by the
      // digest, which is the half a wrong write cannot forge.
      for (const b of before) {
        const a = after.find(
          (r) => r.prop_id === b.prop_id && r.tax_year === b.tax_year,
        );
        expect(a?.market_value).toBe(b.market_value);
        expect(a?.situs_address).toBe(b.situs_address);
        expect(a?.source_file).toBe(b.source_file);
        expect(a?.source_vintage).toBe(b.source_vintage);
        // The backfill deliberately does NOT bump ingested_at: it loads no
        // roll data, so the row's load time did not change.
        expect(a?.ingested_at.getTime()).toBe(b.ingested_at.getTime());
      }
      expect(summary.untouchedDigestVerified).toBe(true);
      expect(summary.untouchedDigestBefore?.digest).toBe(
        summary.untouchedDigestAfter?.digest,
      );
      expect(record.entries.some((e) => e.kind === "violation")).toBe(false);

      // The digest must actually be covering the money columns, or it is a
      // check over nothing.
      expect(summary.untouchedDigestBefore?.columns).toContain("market_value");
      expect(summary.untouchedDigestBefore?.columns).toContain("source_file");
      expect(summary.untouchedDigestBefore?.columns).toContain("ingested_at");
      expect(summary.untouchedDigestBefore?.columns).not.toContain("quick_ref_id");
      expect(summary.untouchedDigestBefore?.columns).not.toContain("property_number");
    });
  }, 60_000);

  it("is idempotent: a second identical run updates zero rows", async () => {
    await withTestSchema(async (ctx) => {
      await seed(ctx);
      const first = await runOnce(ctx);
      expect(first.summary.rowsUpdated).toBe(4);
      const second = await runOnce(ctx);
      expect(second.summary.rowsMatched).toBe(4);
      // The no-op-suppressing WHERE is what makes this observable rather than
      // asserted: the rows still match, and none of them changes.
      expect(second.summary.rowsUpdated).toBe(0);
      expect(second.summary.untouchedDigestVerified).toBe(true);
    });
  }, 60_000);

  // VERIFY THE MONEY CONTROL BY VIOLATING IT.
  //
  // A wrapper executor that quietly moves market_value between the two
  // digests, exactly as a widened SET clause would. The backfill's own
  // statements are untouched; what changes is that something ELSE wrote to the
  // county in the same window. The guard must refuse the run and record it.
  it("REFUSES the run when something else moves market_value during it", async () => {
    await withTestSchema(async (ctx) => {
      await seed(ctx);
      const base = executorFor(ctx);
      let sabotaged = false;
      const saboteur: BackfillExecutor = {
        async query(text, values) {
          const res = await base.query(text, values);
          if (!sabotaged && /^UPDATE cad_property AS t/.test(text)) {
            sabotaged = true;
            await ctx.pool.query(
              `UPDATE cad_property SET market_value = market_value + 1
                WHERE county_fips = $1 AND tax_year = $2 AND prop_id = $3`,
              [COUNTY, DECLARED_YEAR, "10001"],
            );
          }
          return res as never;
        },
      };

      const read = await readPublishedIdentifiers(FIXTURE);
      const record = createMemoryRecordWriter();
      await expect(
        runPublishedIdentifierBackfill(saboteur, read, {
          countyFips: COUNTY, taxYear: DECLARED_YEAR, sourceArchive: "hays.zip",
          sourceMember: "m.txt", sourceSha256: null,
          invocation: "integration violation", dryRun: false, record,
        }),
      ).rejects.toMatchObject({ rule: "untouched-digest" });

      expect(sabotaged).toBe(true);
      const violation = record.entries.find((e) => e.kind === "violation");
      expect(violation).toBeDefined();
      // The record still closes: a refused state-changing run leaves a record
      // naming what it did, because a refusal that leaves no name is how an
      // unattributed mutation becomes unanswerable.
      expect(record.entries.some((e) => e.kind === "run-end")).toBe(true);
    });
  }, 60_000);

  it("a dry run writes nothing at all", async () => {
    await withTestSchema(async (ctx) => {
      await seed(ctx);
      const read = await readPublishedIdentifiers(FIXTURE);
      const record = createMemoryRecordWriter();
      const summary = await runPublishedIdentifierBackfill(executorFor(ctx), read, {
        countyFips: COUNTY, taxYear: DECLARED_YEAR, sourceArchive: "hays.zip",
        sourceMember: "m.txt", sourceSha256: null, invocation: "dry",
        dryRun: true, record,
      });
      expect(summary.rowsMatched).toBe(4);
      expect(summary.rowsUpdated).toBe(0);
      const after = await snapshot(ctx);
      expect(after.every((r) => r.quick_ref_id === null)).toBe(true);
      expect(after.every((r) => r.property_number === null)).toBe(true);
    });
  }, 60_000);
});
