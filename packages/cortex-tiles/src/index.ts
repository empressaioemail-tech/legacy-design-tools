// @empressaio/cortex-tiles — package-resident Cortex tile components.
//
// Every exported tile wraps its inner implementation in TileErrorBoundary and
// reads its data through useCortexClient() (no app dependency). The app's
// TILE_REGISTRY (artifacts/codex-reviewer-qa/src/tile-shell/tiles.tsx) imports
// these named exports and maps them into TileDef.el.

// Provider + client hook.
export { CortexProvider, useCortexClient } from './CortexProvider'

// Shared error boundary (also imported by the two Option-3 app-resident tiles).
export { TileErrorBoundary } from './TileErrorBoundary'

// Compliance
export { IntakeQueueTile } from './compliance/IntakeQueueTile'
export { FindingsLibraryTile } from './compliance/FindingsLibraryTile'
export { ComplianceRunTile } from './compliance/ComplianceRunTile'
export { DocumentViewerTile } from './compliance/DocumentViewerTile'

// Intake
export { IntakeTile } from './intake/IntakeTile'

// Dataroom / Files
export { DataroomTile } from './dataroom/DataroomTile'

// Site Analysis
export { MapTile } from './map/MapTile'
// LIVE map tile — the promoted, live-GIS map (parcels + FEMA via the cortex
// proxy, honest states, parcel-click card, report overlay stack). The
// fixture-only MapTile above is retained for consumers that want it; this is the
// real map every app should consume. MV3 worker seam threaded via workerUrl /
// workerClass (mapWorker.ts) for Chrome-extension consumers.
export { LiveMapTile } from './map/LiveMapTile'
export type { LiveMapTileProps } from './map/LiveMapTile'
export type { MapWorkerSeam, MapWorkerClass } from './map/mapWorker'
// Pure live-GIS logic + types (viewport fetch policy, gis-layer client, overlay
// composition, parcel-card mapping) — consumable standalone/testable.
export {
  MIN_PARCEL_ZOOM,
  MIN_FEMA_ZOOM,
  LIVE_PARCELS_KEY,
  LIVE_FEMA_KEY,
  layersForZoom,
  fetchGisLayer,
  parcelFillColor,
  toLiveOverlays,
  selectionToCard,
} from './map/liveGis'
export type {
  GisFetchLike,
  GisLayerOpts,
  LiveLayerKey,
  LiveLayerState,
  GisLayerResponse,
  FeatureCollectionLike,
  GeoJsonFeature,
  ParcelCardData,
} from './map/liveGis'
export { TopographyTile } from './site-analysis/TopographyTile'
export { DrainageTile } from './site-analysis/DrainageTile'
export { HydrologyTile } from './site-analysis/HydrologyTile'
export { SubsurfaceTile } from './site-analysis/SubsurfaceTile'
// RAW-FUNCTION mode — pure, React-free, vanilla-consumable data functions for
// the report-backed tiles (peers of the map's fetchGisLayer). Each takes a
// baseUrl (spine proxy) + params + optional AbortSignal + optional auth and
// returns a Promise of an honest discriminated state. The tile components above
// call these internally, so there is one source of truth.
export {
  fetchHydrology,
  fetchDrainage,
  fetchTopography,
  fetchSubsurface,
  fetchHazardProfile,
  fetchSetbacks,
  ReportHttpError,
} from './site-analysis/siteReports'
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
} from './site-analysis/siteReports'
// BROKERAGE, ADDRESS-keyed site-context (Change 1) — the Property Brief MV3
// data plane. POST {baseUrl}/map-data keyed by lat/lng + address; pure
// extractors over the bundled response. Peer of the engagement-keyed report
// functions above. Also available React-free via the "./site-analysis" subpath.
export {
  fetchSiteContext,
  getHydrologyLayer,
  getHazardLayer,
  getTopographyLayer,
  getParcelContext,
  SiteContextHttpError,
} from './site-analysis/siteContext'
export type {
  FetchLike,
  SiteContextFetchOpts,
  SiteContext,
  SiteContextMapData,
  SiteContextLayerSlot,
  SiteContextLayerKey,
  SiteContextParams,
} from './site-analysis/siteContext'

// Property Intel
export { PropertyBriefTile } from './property-intel/PropertyBriefTile'
export { HazardProfileTile } from './property-intel/HazardProfileTile'
export { EncumbranceTile } from './property-intel/EncumbranceTile'
export { LocalSetbacksTile } from './property-intel/LocalSetbacksTile'
export { ReportTileShell } from './property-intel/ReportTileShell'

// Design Accelerator
export { SheetExtractionTile } from './design-accelerator/SheetExtractionTile'
export { ResponseTasksTile } from './design-accelerator/ResponseTasksTile'
export { DocumentParsingTile } from './design-accelerator/DocumentParsingTile'
export { ProductSpecReferenceTile } from './design-accelerator/ProductSpecReferenceTile'

// Deliverable
export { LetterTile } from './deliverable/LetterTile'
