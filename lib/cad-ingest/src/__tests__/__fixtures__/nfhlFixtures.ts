/**
 * Recorded FEMA NFHL flood-zone fixtures — probed live 2026-08-08 from
 * hazards.fema.gov/arcgis/.../MapServer/28 (layer 28 Flood Hazard Zones).
 *
 * Field casing verified: FLD_ZONE, ZONE_SUBTY, SFHA_TF, STATIC_BFE,
 * DFIRM_ID, FLD_AR_ID, OBJECTID.
 */

import type { NfhlFeature } from "../nfhl/parse";

/** AE zone in Bastrop County (48021C) — in SFHA. */
export const FIXTURE_BASTROP_AE_ZONE: NfhlFeature = {
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-97.318714640326405, 30.10388852566247],
        [-97.318759273993422, 30.103888995833575],
        [-97.318765548628832, 30.103686930275252],
        [-97.318781472945517, 30.103659084001801],
        [-97.318783120513771, 30.103642297919581],
        [-97.318790806984893, 30.103607076876383],
        [-97.318794415134363, 30.103596252426751],
        [-97.318794963887285, 30.103591702621856],
        [-97.318819046157714, 30.103534754098632],
        [-97.318714640326405, 30.10388852566247],
      ],
    ],
  },
  properties: {
    FLD_ZONE: "AE",
    ZONE_SUBTY: null,
    SFHA_TF: "T",
    STATIC_BFE: -9999,
    DFIRM_ID: "48021C",
    FLD_AR_ID: "48021C_2261",
    OBJECTID: 25343488,
  },
};

/** Zone X (0.2% annual chance) in Bastrop — outside SFHA. */
export const FIXTURE_BASTROP_X_ZONE: NfhlFeature = {
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-97.296972766365613, 30.044923489699283],
        [-97.296987513288187, 30.044942316251841],
        [-97.296985395546145, 30.044936746211544],
        [-97.296983434964986, 30.044933295222581],
        [-97.296978806579247, 30.044928666837457],
        [-97.296976138774568, 30.04492560744081],
        [-97.296972766365613, 30.044923489699283],
      ],
    ],
  },
  properties: {
    FLD_ZONE: "X",
    ZONE_SUBTY: "0.2 PCT ANNUAL CHANCE FLOOD HAZARD",
    SFHA_TF: "F",
    STATIC_BFE: -9999,
    DFIRM_ID: "48021C",
    FLD_AR_ID: "48021C_2251",
    OBJECTID: 25343478,
  },
};

/** Interior point verified inside FIXTURE_BASTROP_AE_ZONE (ray-cast). */
export const FIXTURE_BASTROP_AE_INTERIOR_LNG = -97.31876;
export const FIXTURE_BASTROP_AE_INTERIOR_LAT = 30.10378;

/** Interior point for rural West Texas — outside fixture index. */
export const FIXTURE_RURAL_OUTSIDE_LNG = -101.5;
export const FIXTURE_RURAL_OUTSIDE_LAT = 32.0;

/** Web Mercator metres — must trip the projection guard. */
export const FIXTURE_PROJECTED_METRES_POLYGON: NfhlFeature = {
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-10830000, 3500000],
        [-10829000, 3500000],
        [-10829000, 3510000],
        [-10830000, 3510000],
        [-10830000, 3500000],
      ],
    ],
  },
  properties: {
    FLD_ZONE: "AE",
    DFIRM_ID: "48021C",
    FLD_AR_ID: "48021C_BAD",
    SFHA_TF: "T",
    OBJECTID: 1,
  },
};
