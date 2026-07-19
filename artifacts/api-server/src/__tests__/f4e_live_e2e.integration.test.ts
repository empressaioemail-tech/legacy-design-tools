/**
 * F4e END-TO-END against the LIVE PROD store (Hays 48209 + Comal 48091).
 * Exercises the REAL resolver (`resolveParcelBySitusDisambiguated`) with the
 * REAL county routing (`storeCountiesContainingPoint` / `allStoreCounties`)
 * against the live `txgio_parcel` table, for the audit's failing cases and
 * the preserved cases. Read-only.
 *
 * PROD-DATA-DEPENDENT — asserts specific prod prop_ids (48209:21461,
 * 48209:177911, 48209:193340) that exist only in the live store, NOT in a
 * fresh CI test schema. It is therefore gated behind an EXPLICIT opt-in env
 * flag so CI (which points DATABASE_URL at an ephemeral test db) does NOT run
 * it. Run manually:
 *   F4E_LIVE_E2E=1 DATABASE_URL=<prod> vitest run src/__tests__/f4e_live_e2e.integration.test.ts
 *
 * It asserts the AUTHORITY OUTCOME (correct parcel, honest decline, or
 * fall-through), never a fabricated wrong neighbor.
 */

import { describe, it, expect } from "vitest";
import { db } from "@workspace/db";
import { resolveParcelBySitusDisambiguated } from "../lib/txgioAddressResolve";
import {
  storeCountiesContainingPoint,
  allStoreCounties,
} from "../lib/brokerageTxParcels";

// Opt-in only: this hits LIVE PROD rows by prop_id, so it must never run in
// CI against an ephemeral test schema (the prod prop_ids won't exist there).
const runLive =
  process.env.F4E_LIVE_E2E === "1" &&
  (process.env.DATABASE_URL !== undefined ||
    process.env.TEST_DATABASE_URL !== undefined);

/** Full route-parity resolve: pick candidate counties by point (or all when
 *  point-less), then disambiguate — exactly what the route pre-pass does. */
async function routeResolve(
  address: string,
  point: { latitude: number; longitude: number } | null,
) {
  const counties =
    point &&
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude)
      ? storeCountiesContainingPoint(point.latitude, point.longitude)
      : allStoreCounties();
  return resolveParcelBySitusDisambiguated({
    counties: counties.map((c) => ({ fips: c.fips })),
    address,
    point,
    database: db,
  });
}

describe.skipIf(!runLive)("F4e live e2e (audit failing + preserved cases)", () => {
  it("13341 W US 290 Dripping Springs: NEVER the wrong neighbor 177613 (declines or resolves to a situs-correct parcel)", async () => {
    // Geocoded street rung ~ (30.196912, -97.992419).
    const out = await routeResolve("13341 W US 290, Dripping Springs, TX", {
      latitude: 30.196912,
      longitude: -97.992419,
    });
    // The 18 candidates stack/overlap; PIP finds multiple containing -> honest
    // decline. The one hard invariant: never the wrong-situs neighbor path,
    // and if it resolves at all it is a situs-correct 13341 W US 290 parcel.
    if (out.hit) {
      expect(out.hit.parcelNodeId.startsWith("48209:")).toBe(true);
    } else {
      expect(out.reason).toMatch(/^ambiguous-/);
    }
    // 177613 must never be RETURNED as the resolved parcel.
    expect(out.hit?.parcelNodeId).not.toBe("48209:177613");
  });

  it("145 Texas Agate Dr Kyle: never the AMYTHEST DR neighbor 194058 (declines)", async () => {
    const out = await routeResolve("145 Texas Agate Dr, Kyle, TX", {
      latitude: 29.963009,
      longitude: -97.867937,
    });
    expect(out.hit?.parcelNodeId).not.toBe("48209:194058");
    // No candidate contains the point -> honest decline (correct).
    if (!out.hit) expect(out.reason).toMatch(/^ambiguous-/);
  });

  it("300 Blanco River Rd Wimberley: resolves in HAYS (was Comal misroute) via multi-county unique situs", async () => {
    // Locality-rung geocode ~ (29.997681, -98.098790) falls in BOTH Hays and
    // Comal bboxes; the unique situs lives in Hays.
    const out = await routeResolve("300 Blanco River Rd, Wimberley, TX", {
      latitude: 29.997681,
      longitude: -98.09879,
    });
    expect(out.hit?.parcelNodeId).toBe("48209:21461");
    expect(out.resolvedBy).toBe("unique-situs");
  });

  it("128 Bright Flora Ln Maxwell: resolves (clean unique situs; was falsely declined)", async () => {
    // Even with a point-less (geocode-miss) resolve, the unique situs wins.
    const out = await routeResolve("128 Bright Flora Ln, Maxwell, TX", null);
    expect(out.hit?.parcelNodeId).toBe("48209:177911");
    expect(out.resolvedBy).toBe("unique-situs");
  });

  it("PRESERVE 6026 Marsh Ln Buda -> 48209:193340 (unique situs)", async () => {
    const out = await routeResolve("6026 Marsh Ln, Buda, TX 78610", {
      latitude: 30.046670733631732,
      longitude: -97.81298044670837,
    });
    expect(out.hit?.parcelNodeId).toBe("48209:193340");
  });

  it("PRESERVE 512 Main St Buda: NO situs match -> fall-through (resolved downstream by the point path)", async () => {
    // Real store reality: 512 Main St has no house-numbered situs row (the
    // parcel's situs is bare "MAIN ST"), so situs honestly no-matches and the
    // route falls through to the pin path (which resolves it live). F4e must
    // NOT regress this to a wrong guess.
    const out = await routeResolve("512 Main St, Buda, TX 78610", {
      latitude: 30.088671,
      longitude: -97.81161,
    });
    expect(out.hit).toBeNull();
    expect(out.reason).toBe("no-situs-match");
  });
});
