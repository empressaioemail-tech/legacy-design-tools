/**
 * Recorded response shapes for the DA-PI-2 federal adapters. The
 * fixtures intentionally minimize fields — adapters consume the
 * upstream attributes opaquely (FEMA via ArcGIS feature attrs, USGS
 * via the EPQS JSON envelope, EJScreen via the broker `data.main`
 * map, FCC via the broadband layer's per-provider rows).
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

export const ejscreenBlockGroup = {
  data: {
    main: {
      RAW_D_POP: 1234,
      P_D2_VULEOPCT: 65,
      P_PM25: 72,
      P_OZONE: 48,
      P_LDPNT: 30,
    },
  },
};

export const ejscreenEmpty = { data: { main: {} } };

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
