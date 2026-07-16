// packages/cortex-tiles/src/site-analysis/headless.ts
//
// HEADLESS entry — the React-free, CSS-free subpath for vanilla-JS consumers
// (the Property Brief MV3 extension). Exposed as
//   import { fetchSiteContext } from '@empressaio/cortex-tiles/site-analysis'
//
// This module re-exports ONLY pure functions + their types. It imports NOTHING
// from React, react-dom, @testing-library, any *.css, or any Tile component.
// A vanilla MV3 consumer can bundle it with no react and no css. The barrel
// export "." (src/index.ts) still drags in the React tiles + CSS side effects;
// this subpath is the clean seam.
//
// Every fetching function here accepts an optional injected fetch so an MV3
// page can route the network call through the background service worker (which
// holds the credential) instead of a direct page fetch:
//   - fetchSiteContext(baseUrl, params, { fetch })       (brokerage /map-data)
//   - fetchGisLayer(baseUrl, layer, bbox, { fetch })     (brokerage gis-layer)
//   - fetch*(baseUrl, params, signal, { fetch })         (plan-review reports)

// ─── Brokerage, address-keyed site-context (Change 1) ──────────────
export {
  fetchSiteContext,
  getHydrologyLayer,
  getHazardLayer,
  getTopographyLayer,
  getParcelContext,
  SiteContextHttpError,
} from './siteContext'
export type {
  FetchLike,
  SiteContextFetchOpts,
  SiteContext,
  SiteContextMapData,
  SiteContextLayerSlot,
  SiteContextLayerKey,
  SiteContextParams,
} from './siteContext'

// ─── Brokerage map bbox function + pure map composition (React-free) ─
// fetchGisLayer already takes a baseUrl and works for a brokerage base (it
// appends /brokerage/v1/map-data/gis-layer). toLiveOverlays / parcelFillColor /
// selectionToCard / layersForZoom are pure map-composition helpers.
export {
  fetchGisLayer,
  layersForZoom,
  coarseAffordanceForZoom,
  parcelFillColor,
  parcelZoningFillColor,
  toLiveOverlays,
  overlayForLayer,
  selectionToCard,
  // Storm-guard + bbox helpers. Re-exported here (they were omitted from the
  // 0.1.8 subpath, forcing the Brief to vendor byte-faithful copies); a consumer
  // can now import them directly from /site-analysis instead of vendoring.
  createLiveGisGuard,
  normalizeBbox,
  shouldSuppressAfter,
  // Layer keys / zoom floors / overlay-key map (drive the toggle UI + LOD).
  LIVE_LAYER_KEYS,
  OVERLAY_KEY_FOR_LAYER,
  MIN_PARCEL_ZOOM,
  MIN_FEMA_ZOOM,
  MIN_SOILS_ZOOM,
  MIN_MUDPID_ZOOM,
  MIN_EDWARDS_ZOOM,
  MIN_RRC_ZOOM,
  MIN_GROUNDWATER_ZOOM,
  LIVE_PARCELS_KEY,
  LIVE_FEMA_KEY,
  LIVE_SSURGO_KEY,
  LIVE_GROUNDWATER_KEY,
  LIVE_MUDPID_KEY,
  LIVE_EDWARDS_KEY,
  LIVE_RRC_KEY,
} from '../map/liveGis'
export type {
  GisFetchLike,
  GisLayerOpts,
  LiveLayerKey,
  LiveLayerState,
  LiveGisGuard,
  CoarseAffordance,
  GisLayerResponse,
  FeatureCollectionLike,
  GeoJsonFeature,
  GisBBox,
  ViewportState,
  ParcelCardData,
  LiveOverlaySpec,
} from '../map/liveGis'

// ─── Plan-review, engagement-keyed report functions (existing) ─────
// The pre-existing pure report functions (peers of fetchGisLayer). Re-exported
// here so the headless consumer gets the whole pure surface from one subpath.
export {
  fetchHydrology,
  fetchDrainage,
  fetchTopography,
  fetchSubsurface,
  fetchHazardProfile,
  fetchSetbacks,
  ReportHttpError,
} from './siteReports'
export type {
  ReportFetchLike,
  SiteReportAuth,
  ReportParams,
  ReportState,
  ReportStatusWire,
  ReportResultWire,
  GeoJsonFC,
  HydrologyData,
  DrainageData,
  TopographyData,
  SubsurfaceData,
  HazardData,
  HazardLayer,
  SetbacksState,
  SetbackTable,
  SetbackDistrict,
} from './siteReports'
