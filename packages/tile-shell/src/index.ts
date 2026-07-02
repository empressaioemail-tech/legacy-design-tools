import '@hauska/design-tokens/tokens.css'

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
export { TileStatusBanner } from './components/TileStatusBanner'
export { PlannedTile } from './components/PlannedTile'

export { EngagementProvider, useEngagement } from './providers/EngagementProvider'
export { SpatialProvider, useSpatial } from './providers/SpatialProvider'
export { CodeProvider, useCode } from './providers/CodeProvider'

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
