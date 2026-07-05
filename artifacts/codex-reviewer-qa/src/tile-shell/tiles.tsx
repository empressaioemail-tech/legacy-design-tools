import type { TileDef } from "./types";
// Capability fields are the single source of truth in @empressaio/cortex-client
// (React-free). This module DERIVES its registry from TILE_CAPABILITIES and
// attaches the React `el` factories — so the app and the server-side
// GET /api/plan-review/admin/tile-registry endpoint cannot drift.
import { TILE_CAPABILITIES, type TileCapability } from "@empressaio/cortex-client";
// Package-resident tiles (moved in Track C Phase 3) — named exports.
import {
  IntakeQueueTile,
  IntakeTile,
  DataroomTile,
  MapTile,
  TopographyTile,
  DrainageTile,
  HydrologyTile,
  SubsurfaceTile,
  PropertyBriefTile,
  HazardProfileTile,
  EncumbranceTile,
  SheetExtractionTile,
  ResponseTasksTile,
  FindingsLibraryTile,
  LocalSetbacksTile,
  DocumentParsingTile,
  ProductSpecReferenceTile,
  ComplianceRunTile,
  DocumentViewerTile,
  LetterTile,
} from "@empressaio/cortex-tiles";
// Option-3 app-resident tiles (kept in the app; still error-boundary-wrapped).
import { makeStubTile, type StubTileMeta } from "../tiles/stubFactory";

function stub(meta: StubTileMeta): () => React.ReactElement {
  return makeStubTile(meta);
}

// Build a stub factory for a capability entry (used for tiles without a real
// React component yet). Passes through status/degradedReason so the stub
// renders the correct banner.
function stubFor(cap: TileCapability): () => React.ReactElement {
  return stub({
    id: cap.id,
    label: cap.label,
    category: cap.category,
    status: cap.status,
    degradedReason: cap.degradedReason,
  });
}

// Real React component factories, keyed by tile id. Any id present here gets a
// real component; every other id falls back to a status-aware stub. This is the
// ONLY place a tile's rendering is wired — capability metadata lives in
// TILE_CAPABILITIES.
const COMPONENTS: Record<string, () => React.ReactElement> = {
  intake: () => <IntakeTile />,
  "intake-queue": () => <IntakeQueueTile />,
  dataroom: () => <DataroomTile />,
  "compliance-run": () => <ComplianceRunTile />,
  "document-viewer": () => <DocumentViewerTile />,
  topography: () => <TopographyTile />,
  drainage: () => <DrainageTile />,
  hydrology: () => <HydrologyTile />,
  subsurface: () => <SubsurfaceTile />,
  map: () => <MapTile />,
  "property-brief": () => <PropertyBriefTile />,
  hazard: () => <HazardProfileTile />,
  encumbrances: () => <EncumbranceTile />,
  "sheet-extraction": () => <SheetExtractionTile />,
  "response-tasks": () => <ResponseTasksTile />,
  "findings-library": () => <FindingsLibraryTile />,
  setbacks: () => <LocalSetbacksTile />,
  "doc-parsing": () => <DocumentParsingTile />,
  "product-spec": () => <ProductSpecReferenceTile />,
  letter: () => <LetterTile />,
};

// Derive the full TileDef list: capability fields from the shared source, `el`
// from the local COMPONENTS map (or a status-aware stub).
const ALL_TILE_DEFS: TileDef[] = TILE_CAPABILITIES.map((cap) => ({
  ...cap,
  el: COMPONENTS[cap.id] ?? stubFor(cap),
}));

export const TILE_REGISTRY: Record<string, TileDef> = Object.fromEntries(
  ALL_TILE_DEFS.map((t) => [t.id, t]),
);

export const ALL_TILES: TileDef[] = ALL_TILE_DEFS;

export const TILE_CATEGORIES = [
  "Compliance",
  "Site Analysis",
  "Property Intel",
  "Design Accelerator",
  "Deliverable",
  "Market",
] as const;

export function getTile(id: string): TileDef | undefined {
  return TILE_REGISTRY[id];
}
