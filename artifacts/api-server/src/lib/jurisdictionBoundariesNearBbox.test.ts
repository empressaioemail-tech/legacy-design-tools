/**
 * P-430 — agreement test: layer membership vs determination (shifted-ring falsifier).
 */

import { describe, expect, it } from "vitest";
import {
  buildCityBoundaryIndex,
  buildEtjBoundaryIndex,
  type EtjBoundarySourceRow,
  type EtjSourceCoverageEntry,
} from "@workspace/cad-ingest/boundary";
import { jurisdictionMembershipAtPoint } from "./jurisdictionBoundariesNearBbox";

const AUSTIN_CITY = {
  geoId: "4805000",
  cityName: "Austin",
  gnis: null as string | null,
  geometry: {
    type: "Polygon" as const,
    coordinates: [
      [
        [-97.78, 30.40],
        [-97.74, 30.40],
        [-97.74, 30.44],
        [-97.78, 30.44],
        [-97.78, 30.40],
      ],
    ],
  },
};

const AUSTIN_ETJ: EtjBoundarySourceRow = {
  etjId: "austin-tx:22",
  cityKey: "austin-tx",
  cityName: "Austin",
  ringLabel: "AUSTIN 2 MILE ETJ",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-97.88, 30.33],
        [-97.83, 30.33],
        [-97.83, 30.38],
        [-97.88, 30.38],
        [-97.88, 30.33],
      ],
    ],
  },
  servedStatus: "verbatim",
  bbox: { westLng: -97.88, southLat: 30.33, eastLng: -97.83, northLat: 30.38 },
  sourceCitation: "fixture",
};

const AUSTIN_EXTENT: EtjSourceCoverageEntry = {
  cityKey: "austin-tx",
  cityName: "Austin",
  cityGeoId: "4805000",
  mode: "combined",
  hasEtjRings: true,
  bbox: { westLng: -98.02, southLat: 30.03, eastLng: -97.47, northLat: 30.53 },
};

const COVERAGE = [AUSTIN_EXTENT];
const IN_ETJ = { longitude: -97.855113, latitude: 30.352812 };
/** Inside city limits (matches IN_CITY_LIMITS). */
const IN_CITY = { longitude: -97.75715, latitude: 30.41603 };
/** Outside both. */
const OUTSIDE = { longitude: -95.36936, latitude: 29.76024 };

function etjStatusFromMembership(
  m: ReturnType<typeof jurisdictionMembershipAtPoint>,
): string {
  if (m.cityLimits.status === "incorporated") return "absent";
  if (m.etj.status === "present") return "present";
  if (m.etj.status === "absent") return "absent";
  return "unresolved";
}

describe("jurisdictionMembershipAtPoint (P-430 layer vs card)", () => {
  it("inside city limits reads incorporated / ETJ absent (P-376)", () => {
    const cityIndex = buildCityBoundaryIndex([AUSTIN_CITY]);
    const etjIndex = buildEtjBoundaryIndex([AUSTIN_ETJ]);
    const m = jurisdictionMembershipAtPoint(IN_CITY.longitude, IN_CITY.latitude, cityIndex, etjIndex, COVERAGE);
    expect(m.cityLimits.status).toBe("incorporated");
    expect(etjStatusFromMembership(m)).toBe("absent");
  });

  it("inside ETJ strip reads present", () => {
    const cityIndex = buildCityBoundaryIndex([AUSTIN_CITY]);
    const etjIndex = buildEtjBoundaryIndex([AUSTIN_ETJ]);
    const m = jurisdictionMembershipAtPoint(IN_ETJ.longitude, IN_ETJ.latitude, cityIndex, etjIndex, COVERAGE);
    expect(m.cityLimits.status).toBe("unincorporated");
    expect(etjStatusFromMembership(m)).toBe("present");
  });

  it("outside both reads absent ETJ", () => {
    const cityIndex = buildCityBoundaryIndex([AUSTIN_CITY]);
    const etjIndex = buildEtjBoundaryIndex([AUSTIN_ETJ]);
    const m = jurisdictionMembershipAtPoint(OUTSIDE.longitude, OUTSIDE.latitude, cityIndex, etjIndex, COVERAGE);
    expect(m.cityLimits.status).toBe("unincorporated");
    expect(etjStatusFromMembership(m)).toBe("unresolved");
  });

  it("FALSIFIER: a deliberately shifted drawn ring disagrees with the determination index", () => {
    const cityIndex = buildCityBoundaryIndex([AUSTIN_CITY]);
    const truthIndex = buildEtjBoundaryIndex([AUSTIN_ETJ]);
    const shiftedRing: EtjBoundarySourceRow = {
      ...AUSTIN_ETJ,
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-97.75, 30.33],
            [-97.70, 30.33],
            [-97.70, 30.38],
            [-97.75, 30.38],
            [-97.75, 30.33],
          ],
        ],
      },
    };
    const shiftedIndex = buildEtjBoundaryIndex([shiftedRing]);

    const truth = jurisdictionMembershipAtPoint(
      IN_ETJ.longitude,
      IN_ETJ.latitude,
      cityIndex,
      truthIndex,
      COVERAGE,
    );
    const fromShiftedLayer = jurisdictionMembershipAtPoint(
      IN_ETJ.longitude,
      IN_ETJ.latitude,
      cityIndex,
      shiftedIndex,
      COVERAGE,
    );

    expect(truth.etj.status).toBe("present");
    expect(fromShiftedLayer.etj.status).not.toBe("present");
  });
});
