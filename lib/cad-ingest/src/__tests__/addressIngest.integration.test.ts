/**
 * txgio_address upsert integration tests — run against a real Postgres
 * via @workspace/db/testing's withTestSchema (same harness as
 * ingest.integration.test.ts for cad_property). Skipped when no
 * DATABASE_URL / TEST_DATABASE_URL is available locally; CI always
 * provides one.
 *
 * These exercise the migration-0110 key fix (county_fips, object_id)
 * against the REAL upsert SQL in address/ingest.ts, not a JS mirror —
 * the defect this closes (Burnet, 2026-10-09: 35,857 service points,
 * only 35,690 stored) was in the live ON CONFLICT target, so the proof
 * has to run that statement for real.
 */

import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { withTestSchema } from "@workspace/db/testing";
import { txgioAddress } from "@workspace/db/schema";
import { upsertAddresses, deleteCountyAddresses } from "../address/ingest";
import type { TxgioAddressRecord } from "../address/parse";

const hasDb =
  process.env.TEST_DATABASE_URL !== undefined ||
  process.env.DATABASE_URL !== undefined;

const BASE: Omit<TxgioAddressRecord, "objectId" | "fullAddr" | "unit"> & {
  fullAddr: string;
  unit: string;
} = {
  countyFips: "48053",
  fullAddr: "2903 N US 281",
  unit: "",
  addNumber: "2903",
  stName: "US 281",
  postComm: "Burnet",
  postCode: "78611",
  state: "TX",
  countyName: "Burnet",
  source: "CAPCOG",
  dateAcq: "2025-04-07",
  longitude: -98.2,
  latitude: 30.7,
  tileKey: "g0.02:-98.20000,30.70000",
};

function rec(objectId: number, overrides: Partial<TxgioAddressRecord> = {}): TxgioAddressRecord {
  return { ...BASE, objectId, ...overrides };
}

describe.skipIf(!hasDb)("txgio_address upsert (migration 0110 key)", () => {
  it("THE COLLISION ROOT (real SQL): two points sharing (full_addr, unit) at different coordinates, with different objectids, BOTH survive", async () => {
    await withTestSchema(async ({ db }) => {
      // Same label as the live Burnet collision ("2903 N US 281" exists
      // at two points ~21 km apart, 2026-10-09 measurement) -- the OLD
      // key (county_fips, full_addr, unit) could not tell these apart.
      const pointA = rec(10001, { longitude: -98.2, latitude: 30.7 });
      const pointB = rec(10002, { longitude: -98.05, latitude: 30.52 });

      const summary = await upsertAddresses(db, [pointA, pointB], {
        sourceFile: "test",
        sourceVintage: "v1",
      });

      expect(summary.rowsInserted).toBe(2);
      expect(summary.duplicateObjectIds).toBe(0);

      const rows = await db
        .select()
        .from(txgioAddress)
        .where(eq(txgioAddress.fullAddr, "2903 N US 281"));
      expect(rows).toHaveLength(2);
      const byObjectId = new Map(rows.map((r) => [r.objectId, r]));
      expect(byObjectId.get(10001)?.longitude).toBe(-98.2);
      expect(byObjectId.get(10001)?.latitude).toBe(30.7);
      expect(byObjectId.get(10002)?.longitude).toBe(-98.05);
      expect(byObjectId.get(10002)?.latitude).toBe(30.52);
    });
  });

  it("counts a same-objectid repeat within one load as a duplicate, not a second insert", async () => {
    await withTestSchema(async ({ db }) => {
      const first = rec(20001, { longitude: -98.2, latitude: 30.7 });
      // Same objectid, different coordinates -- should never happen (the
      // service's OBJECTID is statewide-unique), but must be COUNTED if
      // it does, not silently absorbed by ON CONFLICT DO UPDATE.
      const repeat = rec(20001, { longitude: -98.3, latitude: 30.9 });

      const summary = await upsertAddresses(db, [first, repeat], {
        sourceFile: "test",
        sourceVintage: "v1",
      });

      expect(summary.duplicateObjectIds).toBe(1);
      expect(summary.rowsInserted).toBe(1);

      const rows = await db
        .select()
        .from(txgioAddress)
        .where(eq(txgioAddress.objectId, 20001));
      expect(rows).toHaveLength(1);
      // The first-seen record wins (repeat is dropped before it reaches
      // the database at all).
      expect(rows[0].longitude).toBe(-98.2);
    });
  });

  it("rowsInserted equals the rows actually stored, across multiple batches", async () => {
    await withTestSchema(async ({ db }) => {
      const records = Array.from({ length: 7 }, (_v, i) =>
        rec(30000 + i, { fullAddr: `${30000 + i} MAIN ST` }),
      );

      const summary = await upsertAddresses(db, records, {
        sourceFile: "test",
        sourceVintage: "v1",
        batchSize: 3, // exercise multi-batch flushing (3,3,1)
      });

      expect(summary.batches).toBe(3);
      expect(summary.rowsInserted).toBe(7);

      const countRows = async () => {
        const [row] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(txgioAddress);
        return row.n;
      };
      expect(await countRows()).toBe(7);
      expect(summary.rowsInserted).toBe(await countRows());
    });
  });

  it("a fresher vintage re-fetch of the SAME point updates in place by (county_fips, object_id), not by label", async () => {
    await withTestSchema(async ({ db }) => {
      const v1 = rec(40001, { longitude: -98.2, latitude: 30.7 });
      await upsertAddresses(db, [v1], { sourceFile: "f1", sourceVintage: "v1" });

      // Same point, same objectid, a later vintage nudges the coordinate
      // (the kind of re-survey StratMap ships between vintages).
      const v2 = rec(40001, { longitude: -98.2001, latitude: 30.7001 });
      await upsertAddresses(db, [v2], { sourceFile: "f2", sourceVintage: "v2" });

      const rows = await db
        .select()
        .from(txgioAddress)
        .where(eq(txgioAddress.objectId, 40001));
      expect(rows).toHaveLength(1);
      expect(rows[0].longitude).toBe(-98.2001);
      expect(rows[0].sourceVintage).toBe("v2");
    });
  });

  it("deleteCountyAddresses only touches the named county (wholesale-replace scope)", async () => {
    await withTestSchema(async ({ db }) => {
      await upsertAddresses(
        db,
        [rec(50001, { countyFips: "48053" }), rec(50002, { countyFips: "48453", fullAddr: "1 OTHER ST" })],
        { sourceFile: "test", sourceVintage: "v1" },
      );
      await deleteCountyAddresses(db, "48053");

      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(txgioAddress);
      expect(row.n).toBe(1);
      const remaining = await db.select().from(txgioAddress);
      expect(remaining[0].countyFips).toBe("48453");
    });
  });
});
