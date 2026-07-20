/**
 * F4j END-TO-END against the LIVE PROD store — point-in-polygon county
 * pre-resolution. Exercises the REAL resolver (`resolvePointCountyByPip` +
 * `countyStoreContainsPoint`) against the live `txgio_parcel` table for the
 * straddle-routing failures F4j fixes and the happy-path no-regression cases.
 * Read-only.
 *
 * PROD-DATA-DEPENDENT — asserts routing against specific prod parcels that
 * exist only in the live store, NOT in a fresh CI test schema. Gated behind
 * an EXPLICIT opt-in env flag so CI (ephemeral test db) does NOT run it:
 *   F4J_LIVE_E2E=1 DATABASE_URL=<prod> vitest run \
 *     src/__tests__/f4j_pip_county_live_e2e.integration.test.ts
 *
 * It asserts the ROUTING OUTCOME (the county that actually owns the parcel),
 * never a wrong-county guess. On a genuine gap the resolver falls back to
 * nearest-centroid (behavior identical to pre-F4j), which is correct.
 */

import { describe, it, expect } from "vitest";
import { db } from "@workspace/db";
import {
  resolvePointCountyByPip,
  resolveTxParcelCounty,
} from "../lib/brokerageTxParcels";
import { countyStoreContainsPoint } from "../lib/txgioParcelStore";

const runLive =
  process.env.F4J_LIVE_E2E === "1" &&
  (process.env.DATABASE_URL !== undefined ||
    process.env.TEST_DATABASE_URL !== undefined);

describe.skipIf(!runLive)("F4j live e2e (PIP county pre-resolution)", () => {
  it("HEADLINE: New Braunfels 1400-block E Common St straddle routes to COMAL (was Guadalupe misroute -> no-parcel)", async () => {
    // 1400 Common St, New Braunfels geocodes to ~(29.72195, -98.10012) — the
    // 1412/1448 E Common St COMAL parcels (48091:29336 / 48091:29338). Both
    // the Comal and Guadalupe routing bboxes contain the point; nearest-
    // centroid picks GUADALUPE (dist^2 0.0149) over Comal (0.0391), queries
    // the Guadalupe store, finds nothing, and declines. PIP routes to Comal
    // because Comal's parcel fabric CONTAINS the point and Guadalupe's does
    // not.
    const pt = { latitude: 29.72195, longitude: -98.10012 };

    // Pre-condition: nearest-centroid still mis-picks Guadalupe (the bug).
    expect(resolveTxParcelCounty({ ...pt })?.fips).toBe("48187");

    // The fix: PIP routes to Comal.
    const res = await resolvePointCountyByPip({ ...pt, database: db });
    expect(res.county?.fips).toBe("48091");
    expect(res.resolvedBy).toBe("pip");

    // Guadalupe genuinely has no containing parcel here; Comal does.
    expect(
      await countyStoreContainsPoint({ countyFips: "48187", ...pt, database: db }),
    ).toBeNull();
    expect(
      (await countyStoreContainsPoint({ countyFips: "48091", ...pt, database: db }))
        ?.propId,
    ).toBeTruthy();
  });

  it("TRAVIS BORDER-LEAK: a west-Travis parcel center near the Hays line routes to TRAVIS (was Hays leak)", async () => {
    // Real Travis parcel center (documented in brokerageTxParcels.test.ts):
    // (30.17047, -97.87057). Travis' parcel-mass centroid sits far east, so
    // nearest-centroid hands this SW point to the Hays store (no coverage).
    // PIP routes to Travis because the Travis parcel contains the point.
    const pt = { latitude: 30.17047, longitude: -97.87057 };

    // Pre-condition: nearest-centroid still leaks to Hays.
    expect(resolveTxParcelCounty({ ...pt })?.fips).toBe("48209");

    // The fix: PIP routes to Travis.
    const res = await resolvePointCountyByPip({ ...pt, database: db });
    expect(res.county?.fips).toBe("48453");
    expect(res.resolvedBy).toBe("pip");
  });

  it("NO-REGRESSION: Bexar San Antonio core still routes to Bexar", async () => {
    const pt = { latitude: 29.409875, longitude: -98.61826 };
    const res = await resolvePointCountyByPip({ ...pt, database: db });
    expect(res.county?.fips).toBe("48029");
    expect(res.county?.source).toBe("txgio-store");
  });

  it("NO-REGRESSION: Hays core still routes to Hays", async () => {
    const pt = { latitude: 30.217842, longitude: -98.052452 };
    const res = await resolvePointCountyByPip({ ...pt, database: db });
    expect(res.county?.fips).toBe("48209");
  });

  it("NO-REGRESSION: downtown Austin still routes to Travis", async () => {
    const res = await resolvePointCountyByPip({
      latitude: 30.27,
      longitude: -97.74,
      database: db,
    });
    expect(res.county?.fips).toBe("48453");
  });

  it("GAP: a point in no store parcel falls back to nearest-centroid (never force-routed, commitment #1)", async () => {
    // Deep in the Gulf of Mexico bbox of nothing — outside every supported
    // county bbox -> not a supported county at all.
    const res = await resolvePointCountyByPip({
      latitude: 27.0,
      longitude: -95.0,
      database: db,
    });
    expect(res.county).toBeNull();
    expect(res.resolvedBy).toBe("none");
  });

  it("GAP inside a county bbox but in no parcel (ROW/water) falls back to centroid, not a wrong-county guess", async () => {
    // A point inside the Comal routing bbox but chosen to sit off any parcel
    // (far NW corner of the bbox). If no store parcel contains it, PIP must
    // NOT invent a county: it returns whatever nearest-centroid returns
    // (identical to pre-F4j) — an honest routing, and the downstream store
    // pin-query then declines honestly if there is truly no parcel.
    const pt = { latitude: 30.04, longitude: -98.65 };
    const res = await resolvePointCountyByPip({ ...pt, database: db });
    const centroid = resolveTxParcelCounty({ ...pt });
    // Either a store parcel genuinely contains it (pip) OR it falls back to
    // exactly the nearest-centroid answer — never a third, invented county.
    if (res.resolvedBy === "centroid-fallback") {
      expect(res.county?.fips).toBe(centroid?.fips);
    } else {
      expect(res.resolvedBy).toBe("pip");
    }
  });
});
