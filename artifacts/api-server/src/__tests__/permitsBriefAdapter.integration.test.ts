/**
 * permits:record brief adapter against a REAL local Postgres — proves
 * the api-server accessor injection end to end: seed `permit_record`
 * rows (real-shaped copies of the Wave-3 acquisition CSV rows), build
 * `makePermitHistoryLookup` over the test schema, run the real
 * (unmocked) adapter runner with the real accessor, and assert the
 * permits-history layer emerges with honest match disclosure,
 * most-recent-N paging, and full-set aggregates.
 *
 * Same withTestSchema harness as the cad:* integration suite. Skipped
 * when no DATABASE_URL / TEST_DATABASE_URL is available locally; CI
 * always provides one.
 */

import { describe, expect, it } from "vitest";
import { withTestSchema } from "@workspace/db/testing";
import { permitRecord } from "@workspace/db/schema";
import { runAdapters } from "@workspace/adapters";
import {
  PERMIT_ADAPTERS,
  summarizePermitsPayload,
} from "@workspace/adapters/local/permits";
import { makePermitHistoryLookup } from "../lib/permitHistoryLookup";

const hasDb =
  process.env.TEST_DATABASE_URL !== undefined ||
  process.env.DATABASE_URL !== undefined;

/** Real-shaped Austin rows (issued_construction_permits.csv). */
function austinSeed(
  n: number,
  overrides: Partial<typeof permitRecord.$inferInsert> = {},
): typeof permitRecord.$inferInsert {
  return {
    metro: "austin_tx",
    recordHash: `test-hash-${n}`,
    permitNumber: `2019-${100000 + n} BP`,
    permitType: "Building Permit",
    workClass: "Remodel",
    permitClass: "Residential",
    description: "Interior remodel",
    status: "Final",
    appliedDate: "2019-08-02",
    issuedDate: "2019-09-14",
    valuation: "68500.00",
    addressRaw: "12800 PEARCE LN",
    addressNormalized: "12800 PEARCE LN",
    tcadId: "0330430122",
    sourceFile: "issued_construction_permits.csv",
    acquiredDate: "2026-06-21",
    ...overrides,
  };
}

const AUSTIN_CTX = {
  parcel: {
    latitude: 30.2672,
    longitude: -97.7431,
    address: "12800 Pearce Ln, Austin, TX 78617",
    state: "TX" as const,
  },
  jurisdiction: { stateKey: "texas" as const, localKey: null },
};

describe.skipIf(!hasDb)("permits:record over a real permit_record store", () => {
  it("seeds rows and produces the permits-history layer via runAdapters + the real accessor", async () => {
    await withTestSchema(async ({ db }) => {
      await db.insert(permitRecord).values([
        austinSeed(1),
        austinSeed(2, {
          permitNumber: "2026-061052 EP",
          permitType: "Electrical Permit",
          workClass: "Wall",
          permitClass: "Commercial",
          status: "Active",
          description: "Mi Casa Family Dentistry",
          appliedDate: "2026-05-20",
          issuedDate: "2026-06-11",
          valuation: null,
        }),
        // Undated row — must sort last, not first (DESC NULLS LAST).
        austinSeed(3, { permitNumber: "1998-000001 XX", issuedDate: null }),
        // Different address — must not match.
        austinSeed(4, {
          addressRaw: "13305 UNDERBANK RD",
          addressNormalized: "13305 UNDERBANK RD",
        }),
      ]);

      const outcomes = await runAdapters({
        adapters: [...PERMIT_ADAPTERS],
        context: { ...AUSTIN_CTX, permitLookup: makePermitHistoryLookup(db) },
      });

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].status).toBe("ok");
      const payload = outcomes[0].result!.payload as Record<string, unknown>;

      expect(payload.totalMatched).toBe(3);
      expect(payload.returnedCount).toBe(3);
      const permits = payload.permits as Array<Record<string, unknown>>;
      // Newest issued first; the undated row is last, never first.
      expect(permits.map((p) => p.permitNumber)).toEqual([
        "2026-061052 EP",
        "2019-100001 BP",
        "1998-000001 XX",
      ]);
      // numeric(14,2) column comes back as a JS number in the payload.
      expect(permits[1].declaredValuation).toBe(68500);
      expect(payload.earliestIssued).toBe("2019-09-14");
      expect(payload.latestIssued).toBe("2026-06-11");

      // The rendered summary carries the honesty language.
      const summary = summarizePermitsPayload("permits-history", payload);
      expect(summary).toContain("3 permits on record since 2019");
      expect(summary).toContain("matched by street address");
      expect(summary).toContain("acquired 2026-06-21");
    });
  });

  it("pages to most-recent-N while aggregating over the full match set", async () => {
    await withTestSchema(async ({ db }) => {
      const rows = Array.from({ length: 12 }, (_, i) =>
        austinSeed(i + 10, {
          permitNumber: `20${String(10 + i).padStart(2, "0")}-000001 BP`,
          issuedDate: `20${String(10 + i).padStart(2, "0")}-01-15`,
        }),
      );
      await db.insert(permitRecord).values(rows);

      const outcomes = await runAdapters({
        adapters: [...PERMIT_ADAPTERS],
        context: { ...AUSTIN_CTX, permitLookup: makePermitHistoryLookup(db) },
      });
      const payload = outcomes[0].result!.payload as Record<string, unknown>;
      expect(payload.totalMatched).toBe(12);
      expect(payload.returnedCount).toBe(10);
      expect(payload.earliestIssued).toBe("2010-01-15"); // full set, not the page
      expect(payload.latestIssued).toBe("2021-01-15");
      const summary = summarizePermitsPayload("permits-history", payload);
      expect(summary).toContain("12 permits on record since 2010 (showing 10)");
    });
  });

  it("is an honest no-coverage when nothing matches the subject address", async () => {
    await withTestSchema(async ({ db }) => {
      await db
        .insert(permitRecord)
        .values([
          austinSeed(1, {
            addressRaw: "13305 UNDERBANK RD",
            addressNormalized: "13305 UNDERBANK RD",
          }),
        ]);
      const outcomes = await runAdapters({
        adapters: [...PERMIT_ADAPTERS],
        context: { ...AUSTIN_CTX, permitLookup: makePermitHistoryLookup(db) },
      });
      expect(outcomes[0].status).toBe("no-coverage");
      expect(outcomes[0].error?.message).toContain("No permit records matched");
    });
  });
});
