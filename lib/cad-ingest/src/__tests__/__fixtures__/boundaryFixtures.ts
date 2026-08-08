/**
 * Recorded fixture fragments from live probes 2026-08-08.
 * Simplified geometries for unit tests (full Austin polygon is 20k+ vertices).
 */

import type { BoundaryFeature } from "../../boundary/parse";

/** Small box approximating downtown Austin (inside real Austin boundary). */
export const FIXTURE_AUSTIN_CITY: BoundaryFeature = {
  properties: {
    city_name: "Austin",
    geo_id: "4805000",
    gnis: "1389879",
    objectid: 1,
  },
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-97.78, 30.24],
        [-97.72, 30.24],
        [-97.72, 30.28],
        [-97.78, 30.28],
        [-97.78, 30.24],
      ],
    ],
  },
};

/** Travis County box containing the Austin fixture point. */
export const FIXTURE_TRAVIS_COUNTY: BoundaryFeature = {
  properties: {
    GEOID: "48453",
    NAME: "Travis County",
    STATE: "48",
    COUNTY: "453",
    OBJECTID: 1,
  },
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-98.2, 30.0],
        [-97.3, 30.0],
        [-97.3, 30.6],
        [-98.2, 30.6],
        [-98.2, 30.0],
      ],
    ],
  },
};

/** Rural West Texas box — unincorporated (no city polygon overlaps). */
export const FIXTURE_RURAL_UNINCORPORATED_LNG = -101.5;
export const FIXTURE_RURAL_UNINCORPORATED_LAT = 32.5;

/** Point inside Austin fixture. */
export const FIXTURE_AUSTIN_INTERIOR_LNG = -97.75;
export const FIXTURE_AUSTIN_INTERIOR_LAT = 30.26;

/** Live-probe shape: geo_id + city_name casing from TxGIO layer 0. */
export const LIVE_PROBE_CITY_FEATURE: BoundaryFeature = {
  properties: {
    city_name: "Austin",
    geo_id: "4805000",
    gnis: "1389879",
  },
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-97.75, 30.25],
        [-97.74, 30.25],
        [-97.74, 30.26],
        [-97.75, 30.26],
        [-97.75, 30.25],
      ],
    ],
  },
};

/** Live-probe shape: GEOID casing from TIGER layer 1. */
export const LIVE_PROBE_COUNTY_FEATURE: BoundaryFeature = {
  properties: {
    GEOID: "48453",
    NAME: "Travis County",
    STATE: "48",
    COUNTY: "453",
  },
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-98.0, 30.1],
        [-97.5, 30.1],
        [-97.5, 30.5],
        [-98.0, 30.5],
        [-98.0, 30.1],
      ],
    ],
  },
};
