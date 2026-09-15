/**
 * P-242 falsifier 2: "Delete the gate and confirm the test goes red. A test
 * that passes with the control removed is testing nothing."
 *
 * records-extraction.test.ts already proves the gate refuses (by asserting
 * the RESPONSE SHAPE for a FREE/SOLO caller), against a real isolated
 * Postgres. This file adds a stronger, DB-less proof of the same control:
 * a fake `db` whose `select()` throws if it is ever called, so a passing
 * test here proves canRunStudioReport runs and returns BEFORE any query is
 * built — not merely that the eventual response happens to look like a
 * refusal. No live Postgres is needed for this file, unlike
 * records-extraction.test.ts.
 */
import { describe, expect, it } from "vitest";

import { listPurchasedRecords, readPurchasedRecord } from "../src/recordsExtraction.js";
import type { SmartsiteEntitlementSnapshot } from "../src/entitlement.js";
import type { RecordsExtractionDb } from "../src/recordsExtraction.js";

const FREE: SmartsiteEntitlementSnapshot = {
  tier: "free",
  subscriptionTier: null,
  devRole: false,
};
const SOLO: SmartsiteEntitlementSnapshot = {
  tier: "paid",
  subscriptionTier: "solo",
  devRole: false,
};

const PARCEL_NODE_ID = "48453:R123456";

/** A db stub that fails the test loudly if the gate ever lets a query reach it. */
function dbThatThrowsIfQueried(): RecordsExtractionDb {
  return {
    select() {
      throw new Error(
        "DB QUERIED — the Studio gate did not refuse before reaching the database",
      );
    },
  } as unknown as RecordsExtractionDb;
}

describe("recordsExtraction — Studio gate runs BEFORE any DB call (spy-based, no Postgres needed)", () => {
  it("listPurchasedRecords never calls db.select for FREE or SOLO", async () => {
    const throwingDb = dbThatThrowsIfQueried();
    for (const snap of [FREE, SOLO]) {
      const result = await listPurchasedRecords(
        snap,
        "user-a",
        { parcelNodeId: PARCEL_NODE_ID },
        { db: throwingDb },
      );
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0]!.text);
      expect(body.status).toBe("upgrade_required");
    }
  });

  it("readPurchasedRecord never calls db.select for FREE or SOLO", async () => {
    const throwingDb = dbThatThrowsIfQueried();
    for (const snap of [FREE, SOLO]) {
      const result = await readPurchasedRecord(
        snap,
        "user-a",
        { parcelNodeId: PARCEL_NODE_ID, artifactId: "00000000-0000-0000-0000-000000000000" },
        { db: throwingDb },
      );
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0]!.text);
      expect(body.status).toBe("upgrade_required");
    }
  });
});
