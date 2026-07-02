// @hauska/cortex-tiles — package-resident Cortex tile components.
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

// Intake
export { IntakeTile } from './intake/IntakeTile'

// Site Analysis
export { MapTile } from './map/MapTile'
export { TopographyTile } from './site-analysis/TopographyTile'
export { DrainageTile } from './site-analysis/DrainageTile'
export { HydrologyTile } from './site-analysis/HydrologyTile'
export { SubsurfaceTile } from './site-analysis/SubsurfaceTile'

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
