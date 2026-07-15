/**
 * building_permits upsert integration tests — run against a real
 * Postgres via @workspace/db/testing's withTestSchema (same harness as
 * the lib/db integration suite). Skipped when no DATABASE_URL /
 * TEST_DATABASE_URL is available locally; CI always provides one.
 *
 * The fixtures are real rows copied verbatim from the live 2026-06-21
 * open-data drops.
 */

import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { withTestSchema } from "@workspace/db/testing";
import { buildingPermits } from "@workspace/db/schema";
import { PERMIT_SOURCES } from "../sources";
import { parsePermitStream } from "../normalize";
import { upsertBuildingPermits } from "../ingest";
import { newCounters } from "../types";

const hasDb =
  process.env.TEST_DATABASE_URL !== undefined ||
  process.env.DATABASE_URL !== undefined;

const here = dirname(fileURLToPath(import.meta.url));
const SA_FIXTURE = join(here, "__fixtures__", "san_antonio_permits_current_sample.csv");

function parseSa() {
  return parsePermitStream(
    PERMIT_SOURCES["san-antonio"],
    Readable.from(readFileSync(SA_FIXTURE)),
    newCounters(),
  );
}

describe.skipIf(!hasDb)("building_permits upsert", () => {
  it("inserts, then idempotently re-upserts the same drop", async () => {
    await withTestSchema(async ({ db }) => {
      const countRows = async () => {
        const [row] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(buildingPermits);
        return row!.n;
      };

      const first = await upsertBuildingPermits(db, parseSa(), {
        sourceFile: "permits_issued_current.csv",
        sourceVintage: "permits_issued_current",
        batchSize: 2, // exercise multi-batch flushing
      });
      expect(first.rowsUpserted).toBeGreaterThan(0);
      const n1 = await countRows();
      expect(n1).toBe(first.rowsUpserted);

      // Every row is Bexar 48029 and carries the source labels.
      const [sample] = await db.select().from(buildingPermits).limit(1);
      expect(sample!.countyFips).toBe("48029");
      expect(sample!.sourceVintage).toBe("permits_issued_current");

      const before = (
        await db
          .select()
          .from(buildingPermits)
          .where(
            and(
              eq(buildingPermits.countyFips, "48029"),
              eq(buildingPermits.permitId, "BLDG-GS-PMT-13814068"),
            ),
          )
      )[0]!;
      expect(before.issuedDate).toBe("2025-01-01");
      expect(before.propId).toBe("");

      // Re-run the same drop: same key set, zero new rows.
      const second = await upsertBuildingPermits(db, parseSa(), {
        sourceFile: "permits_issued_current.csv",
        sourceVintage: "permits_issued_current-rerun",
      });
      expect(second.rowsUpserted).toBe(first.rowsUpserted);
      expect(await countRows()).toBe(n1);

      const after = (
        await db
          .select()
          .from(buildingPermits)
          .where(
            and(
              eq(buildingPermits.countyFips, "48029"),
              eq(buildingPermits.permitId, "BLDG-GS-PMT-13814068"),
            ),
          )
      )[0]!;
      expect(after.sourceVintage).toBe("permits_issued_current-rerun");
      expect(after.ingestedAt.getTime()).toBeGreaterThanOrEqual(
        before.ingestedAt.getTime(),
      );
    });
  });

  it("keeps the same permit id distinct across counties", async () => {
    await withTestSchema(async ({ db }) => {
      const base = {
        permitId: "SHARED-1",
        propId: "",
        issuedDate: "2026-01-01",
        appliedDate: null,
        workClass: null,
        status: null,
        description: null,
        permitType: null,
      };
      await upsertBuildingPermits(
        db,
        [
          { ...base, countyFips: "48453" },
          { ...base, countyFips: "48029" },
        ],
        { sourceFile: "f", sourceVintage: "v" },
      );
      const rows = await db
        .select()
        .from(buildingPermits)
        .where(eq(buildingPermits.permitId, "SHARED-1"));
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.countyFips))).toEqual(
        new Set(["48453", "48029"]),
      );
    });
  });
});
