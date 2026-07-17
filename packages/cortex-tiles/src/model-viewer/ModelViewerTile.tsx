import { TileErrorBoundary } from '../TileErrorBoundary'
import { GlbViewer, type GlbViewerProps } from './GlbViewer'

/**
 * ModelViewerTile — cortex-tiles wrapper around {@link GlbViewer}.
 *
 * A published, self-contained GLB/BIM model viewer. Unlike the map/report
 * tiles it does NOT read from the engagement/spatial CortexProvider context —
 * the model source is passed in directly (a `glbUrl` string or raw GLB bytes),
 * so the tile is consumable as a bare React island (e.g. the Property Brief
 * MV3 popup) without a CortexProvider.
 *
 * v1 is a clean model viewer: load a GLB, orbit, and a Revit-style ViewCube.
 * Plan-review features (element picking, annotations, diff, reviewer state) are
 * intentionally NOT carried over from the source component.
 */
export type ModelViewerTileProps = GlbViewerProps & {
  /** Error-boundary label. Defaults to "3D Model". */
  label?: string
}

export function ModelViewerTile({ label = '3D Model', ...props }: ModelViewerTileProps) {
  return (
    <TileErrorBoundary label={label}>
      <GlbViewer {...props} />
    </TileErrorBoundary>
  )
}
