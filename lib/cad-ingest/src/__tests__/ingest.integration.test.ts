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
});
