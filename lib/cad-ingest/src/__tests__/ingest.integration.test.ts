/**
 * cad_property upsert integration tests — run against a real Postgres
 * via @workspace/db/testing's withTestSchema (same harness as the
 * lib/db integration suite). Skipped when no DATABASE_URL /
 * TEST_DATABASE_URL is available locally; CI always provides one.
 */

import { describe, expect, it } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { withTestSchema } from "@workspace/db/testing";
import { cadProperty } from "@workspace/db/schema";
import { parsePacsExport } from "../pacs/parser";
import { upsertCadProperties } from "../ingest";
import { newCounters } from "../types";

const hasDb =
  process.env.TEST_DATABASE_URL !== undefined ||
  process.env.DATABASE_URL !== undefined;

const here = dirname(fileURLToPath(import.meta.url));
const INFO_FIXTURE = join(here, "__fixtures__", "caldwell_appraisal_info_sample.txt");
const DETAIL_FIXTURE = join(
  here,
  "__fixtures__",
  "caldwell_improvement_detail_sample.txt",
);

function parseFixture() {
  return parsePacsExport(
    {
      countyFips: "48055",
      infoFile: INFO_FIXTURE,
      improvementDetailFile: DETAIL_FIXTURE,
    },
    newCounters(),
  );
}

describe.skipIf(!hasDb)("cad_property upsert", () => {
  it("inserts, then idempotently re-upserts the same export", async () => {
    await withTestSchema(async ({ db }) => {
      const first = await upsertCadProperties(db, parseFixture(), {
        sourceFile: "caldwell_appraisal_info_sample.txt",
        sourceVintage: "2026-june-5",
        batchSize: 2, // exercise multi-batch flushing
      });
      expect(first.rowsUpserted).toBe(5);
      expect(first.batches).toBe(3);

      const countRows = async () => {
        const [row] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(cadProperty);
        return row.n;
      };
      expect(await countRows()).toBe(5);

      const [before] = await db
        .select()
        .from(cadProperty)
        .where(eq(cadProperty.propId, "10001"));
      expect(before.marketValue).toBe(397260);
      expect(before.exemptionCodes).toBeNull();
      expect(before.landAcres).toBe("1.7716");
      expect(before.sourceVintage).toBe("2026-june-5");

      // Re-run of the same export: same key set, no duplicate rows.
      const second = await upsertCadProperties(db, parseFixture(), {
        sourceFile: "caldwell_appraisal_info_sample.txt",
        sourceVintage: "2026-june-5-rerun",
      });
      expect(second.rowsUpserted).toBe(5);
      expect(await countRows()).toBe(5);

      const [after] = await db
        .select()
        .from(cadProperty)
        .where(eq(cadProperty.propId, "10001"));
      expect(after.marketValue).toBe(397260);
      expect(after.sourceVintage).toBe("2026-june-5-rerun");
      expect(after.ingestedAt.getTime()).toBeGreaterThanOrEqual(
        before.ingestedAt.getTime(),
      );

      // Exemption array round-trips.
      const [hs] = await db
        .select()
        .from(cadProperty)
        .where(eq(cadProperty.propId, "10004"));
      expect(hs.exemptionCodes).toEqual(["HS"]);
      expect(hs.yearBuilt).toBe(2007);
      expect(hs.livingAreaSqft).toBe(1228);
    });
  });

  it("keeps distinct tax years side by side", async () => {
    await withTestSchema(async ({ db }) => {
      const base = {
        countyFips: "48055",
        propId: "77",
        ownerName: "OWNER A",
        ownerMailingAddress: null,
        situsAddress: null,
        situsCity: null,
        situsZip: null,
        legalDescription: null,
        exemptionCodes: null,
        landValue: 100,
        improvementValue: null,
        marketValue: 100,
        assessedValue: 100,
        yearBuilt: null,
        livingAreaSqft: null,
        landAcres: null,
        propertyUseCode: null,
      };
      await upsertCadProperties(
        db,
        [
          { ...base, taxYear: 2025 },
          { ...base, taxYear: 2026, marketValue: 120 },
        ],
        { sourceFile: "f", sourceVintage: "v" },
      );
      const rows = await db
        .select()
        .from(cadProperty)
        .where(eq(cadProperty.propId, "77"));
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.taxYear))).toEqual(new Set([2025, 2026]));
    });
  });

  /**
   * THE P-78 MERGE ROOT, against the REAL UPSERT SQL (not the JS reference).
   *
   * The audit's own failure shape (P7, "one fact derived in several places"):
   * a fix lands in the pure JS mirror (p78-merge.test.ts, 25/25 passing) but
   * the live SQL CASE expressions in ingest.ts's `upsertCadProperties` --
   * the ACTUAL production write path -- are never exercised. This test
   * closes that gap: it runs the real ON CONFLICT ... DO UPDATE against a
   * real table and asserts the cad-export row's appraisal fields survive a
   * later StratMap re-apply.
   */
  it("THE P-78 MERGE ROOT (real SQL): a cad-export row's appraisal fields survive a later StratMap re-apply, for every AUTHORITY_COALESCE_FIELDS column", async () => {
    await withTestSchema(async ({ db }) => {
      const camaRow = {
        countyFips: "48053",
        propId: "23321",
        taxYear: 2025,
        ownerName: "SHARP REX ARTHUR & LORI RENEE",
        ownerMailingAddress: "502 LUCY LN HORSESHOE BAY TX 78657",
        situsAddress: "502 LUCY LN",
        situsCity: "HORSESHOE BAY",
        situsZip: "78657",
        legalDescription: "S5222 HORSESHOE BAY NORTH LOT PT OF N13001",
        exemptionCodes: ["HS"],
        landValue: 400000,
        improvementValue: 832910,
        marketValue: 1232910,
        assessedValue: 1100000,
        yearBuilt: 2004,
        livingAreaSqft: 3100,
        landAcres: "0.4600",
        propertyUseCode: "A1",
        quickRefId: "R23321",
        propertyNumber: "11-2520-0000-23321-0",
      };

      await upsertCadProperties(db, [camaRow], {
        sourceFile: "burnet_cad_export.zip",
        sourceVintage: "tier:cad-export;adapter:bis-consultants",
      });

      const stratmapIncoming = {
        countyFips: "48053",
        propId: "23321",
        taxYear: 2025,
        ownerName: "STRATMAP OWNER WRONG",
        ownerMailingAddress: "WRONG ADDRESS",
        situsAddress: "WRONG SITUS",
        situsCity: "WRONG CITY",
        situsZip: "00000",
        legalDescription: "WRONG LEGAL",
        exemptionCodes: ["WRONG"],
        landValue: 1,
        improvementValue: 1,
        marketValue: 2,
        assessedValue: 3,
        yearBuilt: null,
        livingAreaSqft: null,
        landAcres: "9.9999",
        propertyUseCode: "XX",
        quickRefId: null,
        propertyNumber: null,
      };

      await upsertCadProperties(db, [stratmapIncoming], {
        sourceFile: "stratmap25-landparcels_48053_lp.zip",
        sourceVintage: "tier:stratmap-roll;adapter:stratmap",
      });

      const [row] = await db
        .select()
        .from(cadProperty)
        .where(eq(cadProperty.propId, "23321"));

      // Every AUTHORITY_COALESCE_FIELDS column keeps the cad-export value --
      // the StratMap re-apply's wrong values must not appear anywhere here.
      expect(row.ownerName).toBe(camaRow.ownerName);
      expect(row.ownerMailingAddress).toBe(camaRow.ownerMailingAddress);
      expect(row.situsAddress).toBe(camaRow.situsAddress);
      expect(row.situsCity).toBe(camaRow.situsCity);
      expect(row.situsZip).toBe(camaRow.situsZip);
      expect(row.legalDescription).toBe(camaRow.legalDescription);
      expect(row.exemptionCodes).toEqual(camaRow.exemptionCodes);
      expect(row.landValue).toBe(camaRow.landValue);
      expect(row.improvementValue).toBe(camaRow.improvementValue);
      expect(row.marketValue).toBe(camaRow.marketValue);
      expect(row.assessedValue).toBe(camaRow.assessedValue);
      expect(row.landAcres).toBe(camaRow.landAcres);
      expect(row.propertyUseCode).toBe(camaRow.propertyUseCode);
      // yearBuilt/livingAreaSqft were already fixed before this PR -- pinned
      // here too, on the real SQL, as the control that this fixture is not
      // accidentally testing nothing.
      expect(row.yearBuilt).toBe(camaRow.yearBuilt);
      expect(row.livingAreaSqft).toBe(camaRow.livingAreaSqft);
      // quickRefId/propertyNumber: bare coalesce, unchanged by this PR --
      // the StratMap loader's null must not blank the real CAD identifiers.
      expect(row.quickRefId).toBe(camaRow.quickRefId);
      expect(row.propertyNumber).toBe(camaRow.propertyNumber);
      // sourceFile/sourceVintage are NOT authority-merged (provenance, not an
      // appraisal attribute) -- the incoming StratMap row's own file/vintage
      // DOES overwrite, same as before this PR. The control that proves the
      // assertions above are not just "nothing changed at all".
      expect(row.sourceFile).toBe("stratmap25-landparcels_48053_lp.zip");
      expect(row.sourceVintage).toBe("tier:stratmap-roll;adapter:stratmap");
    });
  });
});
