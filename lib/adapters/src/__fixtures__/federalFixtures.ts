/**
 * Recorded response shapes for the DA-PI-2 federal adapters. The
 * fixtures intentionally minimize fields — adapters consume the
 * upstream attributes opaquely (FEMA via ArcGIS feature attrs, USGS
 * via the EPQS JSON envelope, EJScreen via the CalEPA-mirror ArcGIS
 * Feature Server feature attributes, FCC via the broadband layer's
 * per-provider rows).
 */

export const femaNfhlFeature = {
  features: [
    {
      attributes: {
        FLD_ZONE: "AE",
        ZONE_SUBTY: "FLOODWAY",
        SFHA_TF: "T",
        STATIC_BFE: 425.5,
        DFIRM_ID: "48021C",
      },
      geometry: { rings: [], spatialReference: { wkid: 4326 } },
    },
  ],
};

export const epqsElevationFeet = {
  location: { x: -109.5498, y: 38.5733 },
  value: 4032.7,
  units: "Feet",
  rasterId: 1,
};

/** Older EPQS deployments still ship `value` as a string. */
export const epqsStringValue = {
  location: { x: -97.3186, y: 30.1105 },
  value: "1284.5",
  units: "Feet",
  rasterId: 1,
};

export const epqsNoData = {
  location: { x: 0, y: 0 },
  value: -1000000,
  units: "Feet",
  rasterId: 1,
};

/**
 * CalEPA-mirror EJSCREEN_2023_BG_StatePct response — recorded shape from
 * `services2.arcgis.com/iq8zYa0SRsvIFFKz/.../FeatureServer/0/query`.
 * One block-group polygon feature per intersecting parcel. Field names
 * follow the EJScreen 2023 schema (P_PM25 etc. unchanged from the old
 * broker; population renamed RAW_D_POP → ACSTOTPOP; demographic index
 * P_D2_VULEOPCT → P_DEMOGIDX_2 with a methodology shift — see
 * `federal/epa-ejscreen.ts` docstring delta #3 for the rebase note).
 *
 * The numeric values mirror the live Moab UT recon result (BG
 * 490190002004) captured in 2026-05-23's session note so reading the
 * fixture's expected assertions reads consistently with the on-ground
 * data the operator opted in to.
 */
export const ejscreenBlockGroup = {
  features: [
    {
      attributes: {
        ID: "490190002004",
        STATE_NAME: "Utah",
        ACSTOTPOP: 1179,
        P_DEMOGIDX_2: 83,
        P_DEMOGIDX_5: 79,
        P_PM25: 3,
        P_OZONE: 4,
        P_LDPNT: 76,
      },
    },
  ],
};

/**
 * Empty-result envelope for the CalEPA mirror. The Feature Server
 * returns `{ features: [] }` (not an error) for points that fall
 * outside any block-group polygon — the adapter translates this to a
 * `no-coverage` failed outcome.
 */
export const ejscreenEmpty = { features: [] };

export const fccBroadbandFeatures = {
  features: [
    {
      attributes: {
        BrandName: "FastNet",
        TechCode: 50,
        MaxAdDown: 1000,
        MaxAdUp: 35,
        LowLatency: true,
        Residential: 1,
      },
    },
    {
      attributes: {
        BrandName: "RuralWisp",
        TechCode: 70,
        MaxAdDown: 100,
        MaxAdUp: 20,
        LowLatency: true,
        Residential: 1,
      },
    },
  ],
};
