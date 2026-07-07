import '@empressaio/design-tokens/tokens.css'

export { CortexShell } from './CortexShell'
export type {
  CortexShellProps,
  SavedSpacesApi,
  SpaceSnapshot,
  AdminFunctionStatus,
} from './CortexShell'

export { GridCanvas } from './components/GridCanvas'
export { SpaceBar, snapshotState } from './components/SpaceBar'
export type { SnapshotState } from './components/SpaceBar'
export { TileWrapper } from './components/TileWrapper'
export { TilePicker } from './components/TilePicker'
export { AddressSearchBox } from './components/AddressSearchBox'
export { HeaderSearchBar } from './components/HeaderSearchBar'
export { ShellToolbar } from './components/ShellToolbar'
export { ModuleMap, personaForTile } from './components/ModuleMap'
export type { TilePersona } from './components/ModuleMap'
export { FloatingTileLayer } from './components/FloatingTileLayer'
export type { FloatingTile, FloatRect } from './components/FloatingTileLayer'
export { TileHost, createSlotRegistry } from './components/TileHost'
export { TileStatusBanner } from './components/TileStatusBanner'
export { PlannedTile } from './components/PlannedTile'

export {
  EngagementProvider,
  useEngagement,
  useActiveParcel,
} from './providers/EngagementProvider'
export type { ActiveParcel, ActiveContext } from './providers/EngagementProvider'
export { SpatialProvider, useSpatial } from './providers/SpatialProvider'
export { CodeProvider, useCode } from './providers/CodeProvider'
export {
  AnnotationSelectionProvider,
  useAnnotationSelection,
} from './providers/AnnotationSelectionProvider'
export {
  DocumentViewerNavigationProvider,
  useDocumentViewerNavigation,
} from './providers/DocumentViewerNavigationProvider'

export {
  LAYOUTS,
  layoutIdForTileCount,
  gridAreasForTiles,
  parseLayoutCols,
  parseLayoutRows,
} from './layouts'

export type {
  TileDef,
  TileCategory,
  TileStatus,
  WorkspaceComposition,
  LayoutSpec,
  OverlaySpec,
  PresetSpace,
  EngagementDetail,
  EngagementReportResult,
  PrecedenceResultWire,
} from './types'
