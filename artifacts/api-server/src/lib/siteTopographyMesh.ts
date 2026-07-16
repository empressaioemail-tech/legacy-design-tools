/**
 * Site-topography terrain-mesh emitter — parcel-mesh/IFC Layer 1.
 *
 * Turns a parsed DEM grid (`ParsedDem` from `siteTopographyIngest.ts`)
 * plus its WGS84 bbox into a georeferenced 3D terrain mesh, encoded as a
 * .glb. The command center viewer (EngagementDetail.tsx) already renders
 * one GLB per `materializable_elements` row, so a terrain GLB attached to
 * the existing site-topography read row is consumed by the viewer with no
 * new render path (mirrors the reuse `ifcParser/gltfEmitter.ts` gets for
 * the as-built IFC bundle).
 *
 * What this is
 * ------------
 *
 *   - A GRIDDED triangle mesh, not a TIN. Each DEM cell whose four corner
 *     samples are all present becomes two triangles. This is the v1 target
 *     per the spec; a true TIN (Delaunay) is a deferred net-new dependency
 *     and is deliberately NOT added here.
 *   - Coverage-honest. A cell that references any nodata (NaN) vertex is
 *     skipped, leaving a hole in the mesh. We do NOT substitute
 *     minElevation for missing vertices; that would build a flat floor
 *     artifact, the mesh analogue of the nodata-boundary contour bug the
 *     Layer-0 fix removed.
 *   - Georeferenced in LOCAL ENU METERS (see the georeferencing note).
 *
 * Reuse of gltfEmitter
 * --------------------
 *
 * `ifcParser/gltfEmitter.ts` is monolithic (one web-ifc-specific
 * `modelToGlb`); its GLB-authoring core cannot be called directly for a
 * grid source, but its AUTHORING APPROACH is reused verbatim here:
 * `@gltf-transform/core` Document / single Buffer / VEC3 POSITION
 * accessor + SCALAR index accessor / one Primitive / one Mesh / one Node /
 * one Scene / `NodeIO().writeBinary`. No new glTF library is introduced.
 * Same lean-GLB posture (no PBR materials; the viewer colors terrain
 * itself).
 *
 * Georeferencing convention (LOAD-BEARING; the primary correctness risk)
 * ---------------------------------------------------------------------
 *
 * The mesh is authored in a LOCAL EAST-NORTH-UP (ENU) tangent-plane frame
 * measured in METERS, with the origin at the bbox SOUTH-WEST corner
 * (`westLng`, `southLat`). All three axes are meters:
 *
 *   X (east)  = (lng - originLng) * DEG_LAT_METERS * cos(meanLatRad)
 *   Y (north) = (lat - originLat) * DEG_LAT_METERS
 *   Z (up)    = elevationMeters   (real DEM Z, unchanged)
 *
 * where `DEG_LAT_METERS = 111320` and `meanLatRad` is the radian mean of
 * the bbox's south/north latitudes. This is the same equirectangular /
 * cosine-of-mean-latitude scaling `bufferBbox` already uses in
 * `siteTopographyIngest.ts`, applied per vertex. It is deliberately NOT
 * raw lng/lat degrees as X/Y with meters as Z: mixing degrees and meters
 * produces a mesh stretched by ~1e5 horizontally and would read as a
 * near-vertical wall. Converting to local meters keeps the terrain in
 * correct proportion.
 *
 * The georef ORIGIN (lat/lng of the SW corner) and the CRS convention
 * string are recorded in the returned `meta` so a downstream consumer
 * (Layer 2 IFC authoring, the viewer's world placement) can place the
 * local frame back into world space: world = origin + inverse of the
 * transform above. Nothing about the placement is baked in unrecoverably;
 * the mesh is local-meters plus a recorded origin, which is the honest
 * option (a) from the spec.
 *
 * Pure and unit-testable
 * ----------------------
 *
 * `deriveTerrainMeshGlb(dem, bbox, opts)` is a pure function: no DB, no
 * HTTP, no object storage. It is exercised directly in
 * `__tests__/siteTopographyMesh.test.ts`. The ingest worker calls it and
 * handles persistence (`siteTopographyIngest.ts`).
 */

import { Document, NodeIO } from "@gltf-transform/core";
import type { BboxWgs84 } from "@workspace/site-context/server";

/**
 * Meters per degree of latitude. Matches the constant `bufferBbox` uses
 * (111,320 m/deg) so the mesh's horizontal scale is consistent with the
 * catchment-buffer geometry the rest of the topo path computes.
 */
const DEG_LAT_METERS = 111_320;

/** CRS convention string recorded in the mesh metadata. */
export const TERRAIN_MESH_CRS_CONVENTION =
  "local-enu-meters:origin-bbox-sw:equirectangular-coslat" as const;

/** The georef origin recorded so a consumer can place the local frame. */
export interface TerrainMeshGeorefOrigin {
  /** Longitude of the local origin (bbox SW corner). */
  originLng: number;
  /** Latitude of the local origin (bbox SW corner). */
  originLat: number;
  /**
   * Mean latitude (degrees) the longitude-to-meters cosine scaling used.
   * A consumer inverting X back to longitude needs the same cosine.
   */
  meanLatDegrees: number;
  /** Meters-per-degree-latitude constant used (DEG_LAT_METERS). */
  metersPerDegreeLat: number;
}

/** Metadata describing the emitted mesh; rides into the read model. */
export interface TerrainMeshMeta {
  vertexCount: number;
  triangleCount: number;
  /** True when any cell was skipped because it referenced a nodata vertex. */
  hasHoles: boolean;
  georefOrigin: TerrainMeshGeorefOrigin;
  crsConvention: typeof TERRAIN_MESH_CRS_CONVENTION;
  /** Elevation range of the emitted vertices, meters (finite-only). */
  minElevationMeters: number;
  maxElevationMeters: number;
}

/**
 * Raw compacted triangle geometry, in local ENU meters, plus the same
 * metadata the GLB carries. This is the SINGLE source of triangulation:
 * `deriveTerrainMeshGlb` builds it and encodes the exact same
 * `positions`/`indices` into the GLB, and Layer-2 IFC authoring consumes
 * the exact same arrays. Nothing re-triangulates the grid independently, so
 * the GLB surface and the IFC surface can never diverge.
 *
 *   - `positions` is a flat XYZ Float32Array (length = vertexCount * 3),
 *     X=east meters, Y=north meters, Z=elevation meters, origin at the bbox
 *     SW corner. This is EXACTLY the array set on the GLB POSITION accessor.
 *   - `indices` is a flat triangle index Uint32Array (length =
 *     triangleCount * 3), CCW-from-above winding. This is EXACTLY the array
 *     set on the GLB index accessor.
 *   - `meta` is the same `TerrainMeshMeta` returned alongside the GLB.
 */
export interface TerrainMeshGeometry {
  // Backed by a plain ArrayBuffer (constructed from a number[]); the
  // gltf-transform accessor `setArray` requires the `<ArrayBuffer>` variant
  // specifically, so the type is pinned rather than the wider
  // `<ArrayBufferLike>` default.
  positions: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  meta: TerrainMeshMeta;
}

export interface DeriveTerrainMeshOptions {
  /**
   * Vertical exaggeration factor applied to Z only. Defaults to 1 (true
   * scale). Kept as an explicit opt-in so an operator who wants readable
   * relief on nearly-flat terrain can dial it, but the default never
   * distorts the honest geometry.
   */
  verticalExaggeration?: number;
}

/** A minimal ParsedDem-shaped input; matches `ParsedDem` in the ingest module. */
export interface TerrainMeshDemInput {
  width: number;
  height: number;
  /** Row-major elevation values; nodata cells are NaN. */
  values: Float32Array;
}

/**
 * Build the compacted terrain-mesh GEOMETRY (positions + indices) from a
 * DEM grid and its bbox. This is the single triangulation pass shared by
 * the GLB writer and the Layer-2 IFC author.
 *
 * Grid-to-mesh: the DEM's `width * height` samples are candidate vertices
 * on a regular grid. Each cell (the quad between grid samples
 * (x,y),(x+1,y),(x,y+1),(x+1,y+1)) emits two triangles ONLY when all four
 * corners carry finite elevation. A cell touching any NaN corner is
 * skipped, leaving a hole. The vertex buffer is COMPACTED: only vertices a
 * kept triangle references are emitted (allocated on first use, indices
 * remapped to the compacted ids). This keeps the GLB's auto-computed
 * POSITION bounds honest (no phantom Z-floor from unreferenced nodata
 * slots, which downstream camera auto-fit would frame off) and shrinks the
 * GLB on nodata parcels. The compacted vertex count equals `width * height`
 * on a fully-covered grid and drops when holes remove cells.
 *
 * Returns the flat XYZ positions, flat triangle indices, and the metadata
 * block. Pure (no GLB encoding here). Throws on a degenerate grid (fewer
 * than 2x2 samples) or when no fully-covered cell exists.
 */
export function buildTerrainMeshGeometry(
  dem: TerrainMeshDemInput,
  bbox: BboxWgs84,
  opts: DeriveTerrainMeshOptions = {},
): TerrainMeshGeometry {
  const { width, height } = dem;
  if (width < 2 || height < 2) {
    throw new Error(
      `DEM grid ${width}x${height} is too small to triangulate (need >= 2x2).`,
    );
  }
  const zExaggeration = opts.verticalExaggeration ?? 1;

  // Georef frame: local ENU meters, origin at the bbox SW corner. See the
  // module header. `cosMeanLat` scales longitude-degrees to meters at the
  // bbox's mean latitude, matching bufferBbox's cosine-of-mean-latitude.
  const originLng = bbox.westLng;
  const originLat = bbox.southLat;
  const meanLatDegrees = (bbox.southLat + bbox.northLat) / 2;
  const cosMeanLat = Math.cos((meanLatDegrees * Math.PI) / 180);

  // Per-pixel lng/lat step. Row 0 is the NORTH edge (raster Y grows
  // downward), matching the contour path's remap in siteTopographyIngest.
  const dLng = (bbox.eastLng - bbox.westLng) / (width - 1);
  const dLat = (bbox.northLat - bbox.southLat) / (height - 1);

  // COMPACTED vertex buffer. We emit only vertices that a kept triangle
  // actually references, never a dense one-slot-per-sample buffer. This is
  // load-bearing for coverage honesty: gltf-transform auto-computes the
  // POSITION accessor's min/max bounds over the ENTIRE backing array, not
  // just the indexed subset, so a dense buffer with placeholder-Z on nodata
  // slots would stamp a phantom Z-floor (e.g. 0) into the GLB's own bounds.
  // Downstream viewers (three.js computeBoundingBox, camera auto-fit, LOD)
  // frame off those bounds, so nodata terrain at 450-550m would render as a
  // thin sliver over a ~500m empty void. Compaction fixes the bounds
  // correctly AND shrinks the GLB (nodata parcels stop paying for dead
  // vertices).
  //
  // `vertexIdByGridIndex` maps a grid sample (y * width + x) to its
  // compacted vertex id, allocated on first reference. `positionsList`
  // collects the referenced vertices' XYZ in emit order.
  const vertexIdByGridIndex = new Map<number, number>();
  const positionsList: number[] = [];
  let minElevation = Infinity;
  let maxElevation = -Infinity;

  /**
   * Return the compacted vertex id for a grid sample, allocating (and
   * pushing its real position) on first use. Only called for samples that
   * belong to a kept (fully-covered) cell, so the elevation is always
   * finite here.
   */
  function referenceVertex(gridIndex: number): number {
    const existing = vertexIdByGridIndex.get(gridIndex);
    if (existing !== undefined) return existing;
    const x = gridIndex % width;
    const y = (gridIndex - x) / width;
    const lng = bbox.westLng + x * dLng;
    const lat = bbox.northLat - y * dLat; // Y grows downward -> flip.
    const eastMeters = (lng - originLng) * DEG_LAT_METERS * cosMeanLat;
    const northMeters = (lat - originLat) * DEG_LAT_METERS;
    const z = dem.values[gridIndex]! * zExaggeration;
    const id = positionsList.length / 3;
    positionsList.push(eastMeters, northMeters, z);
    const rawZ = dem.values[gridIndex]!;
    if (rawZ < minElevation) minElevation = rawZ;
    if (rawZ > maxElevation) maxElevation = rawZ;
    vertexIdByGridIndex.set(gridIndex, id);
    return id;
  }

  // Triangulate: two triangles per fully-covered cell. Winding is CCW when
  // viewed from +Z (up), so the surface faces the sky. Indices reference
  // the compacted vertex ids allocated by `referenceVertex`.
  const indices: number[] = [];
  let hasHoles = false;
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const topLeft = y * width + x;
      const topRight = y * width + (x + 1);
      const bottomLeft = (y + 1) * width + x;
      const bottomRight = (y + 1) * width + (x + 1);
      // Skip the cell if any corner is nodata — leave a hole, never floor.
      if (
        !Number.isFinite(dem.values[topLeft]!) ||
        !Number.isFinite(dem.values[topRight]!) ||
        !Number.isFinite(dem.values[bottomLeft]!) ||
        !Number.isFinite(dem.values[bottomRight]!)
      ) {
        hasHoles = true;
        continue;
      }
      const tl = referenceVertex(topLeft);
      const tr = referenceVertex(topRight);
      const bl = referenceVertex(bottomLeft);
      const br = referenceVertex(bottomRight);
      // Raster row 0 is north; bottomLeft/bottomRight are the more-southern
      // (smaller Y-north) samples. CCW-from-above ordering:
      //   triangle 1: bottomLeft, bottomRight, topRight
      //   triangle 2: bottomLeft, topRight, topLeft
      indices.push(bl, br, tr);
      indices.push(bl, tr, tl);
    }
  }

  if (!Number.isFinite(minElevation)) {
    // No finite sample was referenced — either an all-nodata grid or a grid
    // where nodata holes left no fully-covered cell. Mirror parseDemBytes,
    // which throws on all-nodata: a mesh with zero real vertices is not a
    // meaningful terrain output.
    throw new Error(
      "DEM grid contained no fully-covered cell; cannot build a terrain mesh.",
    );
  }

  const positions = new Float32Array(positionsList);
  const indexArray = new Uint32Array(indices);

  const meta: TerrainMeshMeta = {
    // Compacted vertex buffer — only vertices a kept triangle references.
    // Equals width * height on a fully-covered grid; drops when nodata
    // holes remove cells (and with them any vertex no surviving cell uses).
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
    hasHoles,
    georefOrigin: {
      originLng,
      originLat,
      meanLatDegrees,
      metersPerDegreeLat: DEG_LAT_METERS,
    },
    crsConvention: TERRAIN_MESH_CRS_CONVENTION,
    minElevationMeters: minElevation,
    maxElevationMeters: maxElevation,
  };

  return { positions, indices: indexArray, meta };
}

/**
 * Build a georeferenced terrain-mesh GLB from a DEM grid and its bbox.
 *
 * Thin wrapper over {@link buildTerrainMeshGeometry}: it triangulates the
 * grid ONCE (there), then encodes the SAME compacted positions + indices
 * into a GLB. Layer-2 IFC authoring calls `buildTerrainMeshGeometry`
 * directly and consumes the identical arrays, so the GLB surface and the
 * IFC surface are guaranteed to be the same triangulation.
 *
 * Returns the .glb bytes and the metadata block. Throws on a degenerate
 * grid (fewer than 2x2 samples) or when no fully-covered cell exists.
 */
export async function deriveTerrainMeshGlb(
  dem: TerrainMeshDemInput,
  bbox: BboxWgs84,
  opts: DeriveTerrainMeshOptions = {},
): Promise<{ glb: Uint8Array; meta: TerrainMeshMeta }> {
  const { positions, indices, meta } = buildTerrainMeshGeometry(
    dem,
    bbox,
    opts,
  );

  // Author the GLB. Same @gltf-transform authoring shape as
  // ifcParser/gltfEmitter.ts: Document -> Buffer -> accessors -> Primitive
  // -> Mesh -> Node -> Scene -> NodeIO().writeBinary. POSITION only; the
  // viewer colors terrain, so no NORMAL / material bloat (matches the lean
  // posture in the emitter's header). The positions/indices are used
  // verbatim — no re-derivation.
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();

  const positionAcc = doc
    .createAccessor()
    .setBuffer(buffer)
    .setType("VEC3")
    .setArray(positions);
  const indexAcc = doc
    .createAccessor()
    .setBuffer(buffer)
    .setType("SCALAR")
    .setArray(indices);

  const primitive = doc
    .createPrimitive()
    .setAttribute("POSITION", positionAcc)
    .setIndices(indexAcc);
  const mesh = doc.createMesh("terrain").addPrimitive(primitive);
  const node = doc.createNode("terrain").setMesh(mesh);
  scene.addChild(node);

  const glb = await new NodeIO().writeBinary(doc);

  return { glb, meta };
}
