// @empressaio/cortex-tiles/model-viewer — dedicated subpath entry.
//
// Exposes ONLY the self-contained GLB/BIM viewer, with no dependency on the
// main tile barrel (so consumers that just want the 3D viewer — e.g. the
// Property Brief MV3 React island — do not drag in the map / document-viewer /
// pdfjs / report tiles). three + lucide-react are the only heavy deps in this
// graph, and they are externalized by tsup.
export { ModelViewerTile } from './ModelViewerTile'
export type { ModelViewerTileProps } from './ModelViewerTile'
export { GlbViewer } from './GlbViewer'
export type { GlbViewerProps } from './GlbViewer'
