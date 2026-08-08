/**
 * `txgio_parcel` write-path integration tests — the county replace
 * (delete + load) the statewide parcel acquisition runs 235 times.
 *
 * This path had ZERO coverage before 2026-08-08: no test anywhere
 * referenced `upsertTxgioParcels` or `deleteCountyParcels`, and the
 * delete ran OUTSIDE any transaction, so a mid-county failure left the
 * county deleted with nothing loaded. What is asserted here:
 *
 *   1. Idempotence — a re-run of the same archive produces no
 *      duplicate rows and refreshes the vintage in place.
 *   2. ATOMICITY — a failure partway through the load rolls the delete
 *      back, so the county keeps its previous rows. This is the fix.
 *   3. Tile-key composition — a feature lands once per grid cell its
 *      bbox intersects, with the exact keys the reader computes.
 *   4. County isolation — replacing one county never touches another.
 *
 * Runs against a real Postgres via `withTestSchema` (a fresh
 * `test_<ts>_<rand>` schema, dropped after), the same harness the
 * cad_property suite uses. NEVER point DATABASE_URL at a deployment
 * database to run this: the harness creates and drops schemas.
 * Skipped when no TEST_DATABASE_URL / DATABASE_URL is available
 * locally; CI always provides one.
 */

import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { withTestSchema } from "@workspace/db/testing";
import { txgioParcel } from "@workspace/db/schema";
import {
  countCountyParcels,
  deleteCountyParcels,
  replaceCountyParcels,
  upsertTxgioParcels,
  type TxgioTransactionalDb,
} from "../txgio/ingest";
import { normalizeTxgioFeature } from "../txgio/parse";
import { cellKeyForPoint, cellKeysForBbox } from "../txgio/geo";
import { newCounters } from "../types";
import {
  HAYS_PARCEL_12310,
  HAYS_PARCEL_12310_INSIDE,
} from "./__fixtures__/txgioHaysParcel";

const hasDb =
  process.env.TEST_DATABASE_URL !== undefined ||
  process.env.DATABASE_URL !== undefined;

const OPTS = {
  sourceFile: "stratmap25-landparcels_48209_lp.zip",
  sourceVintage: "stratmap25-landparcels_48209_hays_202503",
};

/** The real Hays parcel, normalized — one small polygon, one tile cell. */
function haysRecord(featureIndex = 0) {
  const rec = normalizeTxgioFeature(
    "48209",
    featureIndex,
    HAYS_PARCEL_12310 as never,
    newCounters(),
  );
  if (!rec) throw new Error("fixture failed to normalize");
  return rec;
}

/**
 * A synthetic parcel spanning several 0.02-degree cells, so tile-key
 * fan-out (rows > features) is exercised rather than assumed. Roughly
 * 0.05 x 0.03 degrees near San Marcos.
 */
function wideRecord(featureIndex: number) {
  const rec = normalizeTxgioFeature(
    "48209",
    featureIndex,
    {
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-97.95, 29.87],
            [-97.9, 29.87],
            [-97.9, 29.9],
            [-97.95, 29.9],
            [-97.95, 29.87],
          ],
        ],
      },
      properties: { Prop_ID: `wide-${featureIndex}` },
    } as never,
    newCounters(),
  );
  if (!rec) throw new Error("wide fixture failed to normalize");
  return rec;
}

/** Total rows in the test schema's txgio_parcel, all counties. */
async function countAllRows(db: {
  select: (fields: {
    n: unknown;
  }) => { from: (t: typeof txgioParcel) => Promise<Array<{ n: number }>> };
}): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(txgioParcel);
  return rows[0].n;
}

describe.skipIf(!hasDb)("txgio_parcel write path", () => {
  it("loads features, one row per intersecting grid cell, with the reader's exact keys", async () => {
    await withTestSchema(async ({ db }) => {
      const hays = haysRecord(0);
      const wide = wideRecord(1);
      // The small parcel is one cell; the wide one spans several.
      expect(hays.tileKeys).toHaveLength(1);
      expect(wide.tileKeys.length).toBeGreaterThan(1);

      const summary = await upsertTxgioParcels(
        db as unknown as TxgioTransactionalDb,
        [hays, wide],
        OPTS,
      );
      expect(summary.featuresLoaded).toBe(2);
      expect(summary.rowsInserted).toBe(
        hays.tileKeys.length + wide.tileKeys.length,
      );
      expect(await countAllRows(db)).toBe(summary.rowsInserted);

      // The stored key for the small parcel is exactly the key the
      // point-lookup read path computes for a point inside it.
      const [row] = await db
        .select()
        .from(txgioParcel)
        .where(eq(txgioParcel.featureIndex, 0));
      expect(row.tileKey).toBe(
        cellKeyForPoint(
          HAYS_PARCEL_12310_INSIDE.longitude,
          HAYS_PARCEL_12310_INSIDE.latitude,
        ),
      );
      expect(row.propId).toBe("12310");
      expect(row.sourceVintage).toBe(OPTS.sourceVintage);
      expect(row.westLng).toBeCloseTo(hays.bbox.westLng, 10);

      // Every key the geometry helper derives is present in the store.
      const wideRows = await db
        .select()
        .from(txgioParcel)
        .where(eq(txgioParcel.featureIndex, 1));
      expect(new Set(wideRows.map((r) => r.tileKey))).toEqual(
        new Set(cellKeysForBbox(wide.bbox)!),
      );
    });
  });

  it("re-running the same county is idempotent — no duplicate rows", async () => {
    await withTestSchema(async ({ db }) => {
      const handle = db as unknown as TxgioTransactionalDb;
      const records = () => [haysRecord(0), wideRecord(1)];

      const first = await replaceCountyParcels(
        handle,
        "48209",
        records(),
        OPTS,
      );
      expect(first.rowsDeleted).toBe(0);
      const rowsAfterFirst = first.rowsInserted;
      expect(await countCountyParcels(handle, "48209")).toBe(rowsAfterFirst);

      // Same archive, fresher vintage label.
      const second = await replaceCountyParcels(handle, "48209", records(), {
        ...OPTS,
        sourceVintage: "stratmap25-landparcels_48209_hays_202508",
      });
      expect(second.rowsDeleted).toBe(rowsAfterFirst);
      expect(second.rowsInserted).toBe(rowsAfterFirst);
      // The count is UNCHANGED — the defining idempotence assertion.
      expect(await countCountyParcels(handle, "48209")).toBe(rowsAfterFirst);

      const [row] = await db
        .select()
        .from(txgioParcel)
        .where(eq(txgioParcel.featureIndex, 0));
      expect(row.sourceVintage).toBe(
        "stratmap25-landparcels_48209_hays_202508",
      );
    });
  });

  it("ON CONFLICT DO UPDATE absorbs a resumed load without a second delete", async () => {
    await withTestSchema(async ({ db }) => {
      const handle = db as unknown as TxgioTransactionalDb;
      await upsertTxgioParcels(handle, [haysRecord(0)], OPTS);
      // Re-insert the same key with changed attributes: updates in
      // place rather than duplicating or erroring.
      const changed = { ...haysRecord(0), ownerName: "NEW OWNER" };
      await upsertTxgioParcels(handle, [changed], {
        ...OPTS,
        sourceVintage: "resumed",
      });
      expect(await countCountyParcels(handle, "48209")).toBe(1);
      const [row] = await db.select().from(txgioParcel);
      expect(row.ownerName).toBe("NEW OWNER");
      expect(row.sourceVintage).toBe("resumed");
    });
  });

  it("THE FIX: a mid-load failure rolls the delete back — the county is never left empty", async () => {
    await withTestSchema(async ({ db }) => {
      const handle = db as unknown as TxgioTransactionalDb;

      // A county already loaded from a previous vintage.
      const before = await replaceCountyParcels(
        handle,
        "48209",
        [haysRecord(0), wideRecord(1)],
        OPTS,
      );
      const rowsBefore = before.rowsInserted;
      expect(rowsBefore).toBeGreaterThan(0);

      // A re-load that dies partway — exactly what a projection error
      // on feature N of a 202505 county does now that parse.ts throws.
      async function* failsPartway() {
        yield haysRecord(0);
        throw new Error("simulated projection failure on feature 1");
      }
      await expect(
        replaceCountyParcels(handle, "48209", failsPartway(), {
          ...OPTS,
          sourceVintage: "doomed",
        }),
      ).rejects.toThrow(/simulated projection failure/);

      // The county still holds its ORIGINAL rows at its ORIGINAL
      // vintage. Pre-fix, the delete had already committed and this
      // count was 0.
      expect(await countCountyParcels(handle, "48209")).toBe(rowsBefore);
      const rows = await db.select().from(txgioParcel);
      expect(rows.every((r) => r.sourceVintage === OPTS.sourceVintage)).toBe(
        true,
      );
    });
  });

  it("replacing one county leaves other counties untouched", async () => {
    await withTestSchema(async ({ db }) => {
      const handle = db as unknown as TxgioTransactionalDb;
      const comal = normalizeTxgioFeature(
        "48091",
        0,
        HAYS_PARCEL_12310 as never,
        newCounters(),
      )!;
      await upsertTxgioParcels(handle, [comal], {
        sourceFile: "comal.zip",
        sourceVintage: "comal-v1",
      });
      await replaceCountyParcels(handle, "48209", [haysRecord(0)], OPTS);
      expect(await countCountyParcels(handle, "48091")).toBe(1);

      // And a delete is likewise county-scoped.
      await deleteCountyParcels(handle, "48209");
      expect(await countCountyParcels(handle, "48209")).toBe(0);
      expect(await countCountyParcels(handle, "48091")).toBe(1);
    });
  });

  it("countCountyParcels reports zero for a county with no rows (the dry-run delete prediction)", async () => {
    await withTestSchema(async ({ db }) => {
      const handle = db as unknown as TxgioTransactionalDb;
      expect(await countCountyParcels(handle, "48269")).toBe(0);
      await upsertTxgioParcels(handle, [haysRecord(0)], OPTS);
      expect(await countCountyParcels(handle, "48209")).toBe(1);
      expect(await countCountyParcels(handle, "48269")).toBe(0);
    });
  });
});
