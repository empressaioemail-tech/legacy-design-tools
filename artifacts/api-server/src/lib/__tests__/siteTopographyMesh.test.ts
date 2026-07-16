/**
 * Terrain-mesh emitter unit tests — parcel-mesh/IFC Layer 1.
 *
 * Direct tests for the pure `deriveTerrainMeshGlb` function in
 * `siteTopographyMesh.ts`. These are the load-bearing correctness checks
 * the spec calls out:
 *
 *   - Vertex / triangle counts for a fully-covered synthetic DEM.
 *   - Nodata cells produce HOLES (triangles referencing NaN are skipped,
 *     triangle count drops), never a substituted floor.
 *   - Z values are preserved (a vertex's elevation matches its DEM cell).
 *   - Georeferencing: the horizontal extent is in METERS proportional to
 *     the bbox's real-world meters, NOT degrees. This is the assertion
 *     that stops a regression to degree-scaled X/Y.
 *   - The GLB round-trips through NodeIO as a valid glTF with accessors.
 */

import { describe, it, expect } from "vitest";
import { NodeIO } from "@gltf-transform/core";
import {
  buildTerrainMeshGeometry,
  deriveTerrainMeshGlb,
  TERRAIN_MESH_CRS_CONVENTION,
  type TerrainMeshDemInput,
} from "../siteTopographyMesh";
import type { BboxWgs84 } from "@workspace/site-context/server";

/**
 * A ~1km-square bbox near Bastrop, TX. Latitude ~30 deg, so cos(lat) is
 * ~0.866; the georef test uses the real cosine so the meters extent is
 * checked, not a degree-scaled one.
 */
const TEST_BBOX: BboxWgs84 = {
  westLng: -97.31,
  southLat: 30.1,
  eastLng: -97.3, // 0.01 deg east
  northLat: 30.11, // 0.01 deg north
};

/**
 * Build a `TerrainMeshDemInput` from a row-major 2D array of elevations,
 * where `null` marks a nodata cell (stored as NaN, exactly as
 * `parseDemBytes` encodes the 3DEP nodata sentinel).
 */
function makeDem(
  rows: ReadonlyArray<ReadonlyArray<number | null>>,
): TerrainMeshDemInput {
  const height = rows.length;
  const width = rows[0]!.length;
  const values = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = rows[y]![x]!;
      values[y * width + x] = v === null ? Number.NaN : v;
    }
  }
  return { width, height, values };
}

/**
 * Invert an emitted local-ENU-meters (X, Y) back to a DEM grid (col, row)
 * using the same equirectangular transform the emitter applies. Rounds to
 * the nearest grid line so a vertex that sits exactly on a sample resolves
 * to that sample. Lets a Z-preservation check work against the compacted
 * (order-independent) vertex buffer.
 */
function gridCoordFromMeters(
  eastMeters: number,
  northMeters: number,
  dem: TerrainMeshDemInput,
  bbox: BboxWgs84,
): [col: number, row: number] {
  const DEG_LAT_METERS = 111_320;
  const meanLatRad = ((bbox.southLat + bbox.northLat) / 2) * (Math.PI / 180);
  const dLng = (bbox.eastLng - bbox.westLng) / (dem.width - 1);
  const dLat = (bbox.northLat - bbox.southLat) / (dem.height - 1);
  const lng = bbox.westLng + eastMeters / (DEG_LAT_METERS * Math.cos(meanLatRad));
  const lat = bbox.southLat + northMeters / DEG_LAT_METERS;
  const col = Math.round((lng - bbox.westLng) / dLng);
  const row = Math.round((bbox.northLat - lat) / dLat); // Y grows downward.
  return [col, row];
}

describe("deriveTerrainMeshGlb geometry", () => {
  it("fully-covered 3x3 DEM yields 9 vertices and 8 triangles", async () => {
    // 3x3 -> 4 cells -> 8 triangles; dense vertex buffer is 9 slots.
    const dem = makeDem([
      [100, 101, 102],
      [103, 104, 105],
      [106, 107, 108],
    ]);
    const { meta } = await deriveTerrainMeshGlb(dem, TEST_BBOX);

    expect(meta.vertexCount).toBe(9);
    expect(meta.triangleCount).toBe(8);
    expect(meta.hasHoles).toBe(false);
    expect(meta.crsConvention).toBe(TERRAIN_MESH_CRS_CONVENTION);
  });

  it("nodata vertices produce holes: triangles referencing NaN are skipped, count drops", async () => {
    // Fully-covered baseline: 4x4 -> 9 cells -> 18 triangles.
    const covered = makeDem([
      [100, 101, 102, 103],
      [104, 105, 106, 107],
      [108, 109, 110, 111],
      [112, 113, 114, 115],
    ]);
    const coveredMesh = await deriveTerrainMeshGlb(covered, TEST_BBOX);
    expect(coveredMesh.meta.triangleCount).toBe(18);
    expect(coveredMesh.meta.hasHoles).toBe(false);

    // Punch a single nodata cell in the interior. That vertex is a corner
    // of 4 cells, so 4 cells (8 triangles) drop -> 18 - 8 = 10 triangles.
    const holed = makeDem([
      [100, 101, 102, 103],
      [104, null, 106, 107],
      [108, 109, 110, 111],
      [112, 113, 114, 115],
    ]);
    const holedMesh = await deriveTerrainMeshGlb(holed, TEST_BBOX);

    expect(holedMesh.meta.hasHoles).toBe(true);
    expect(holedMesh.meta.triangleCount).toBeLessThan(
      coveredMesh.meta.triangleCount,
    );
    expect(holedMesh.meta.triangleCount).toBe(10);
    // Compaction: the fully-covered baseline emits every grid sample (16).
    // The single nodata sample at (col1,row1) removes the 4 cells that share
    // it as a corner; that strips the whole NW block of samples that were
    // referenced ONLY by those removed cells — samples (0,0),(1,0),(0,1) and
    // the nodata (1,1) itself — so 4 vertices drop, leaving 12. The buffer
    // is COMPACTED (only referenced vertices emitted), never
    // dense-with-placeholder-slots.
    expect(coveredMesh.meta.vertexCount).toBe(16);
    expect(holedMesh.meta.vertexCount).toBe(12);
    expect(holedMesh.meta.vertexCount).toBeLessThan(
      coveredMesh.meta.vertexCount,
    );
  });

  it("preserves Z: a vertex's elevation matches its DEM cell", async () => {
    const dem = makeDem([
      [200, 250, 300],
      [210, 260, 310],
      [220, 270, 320],
    ]);
    const { glb } = await deriveTerrainMeshGlb(dem, TEST_BBOX);

    // Round-trip and read POSITION back. With a compacted buffer the vertex
    // index no longer equals the grid index, so we look each vertex up by
    // its (X, Y) position and assert Z. Build the expected (x,y)->Z map from
    // the same georef transform the emitter uses.
    const doc = await new NodeIO().readBinary(glb);
    const prim = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    const posArray = prim.getAttribute("POSITION")!.getArray()!;

    // Invert each emitted (X, Y) back to a grid (col, row) via the same
    // georef transform, then assert Z equals the DEM elevation there. This
    // proves Z preservation without depending on the (compacted) vertex
    // ordering.
    let checked = 0;
    for (let i = 0; i < posArray.length; i += 3) {
      const x = posArray[i]!;
      const y = posArray[i + 1]!;
      const z = posArray[i + 2]!;
      const [col, row] = gridCoordFromMeters(x, y, dem, TEST_BBOX);
      const expectedZ = dem.values[row * dem.width + col]!;
      expect(z).toBeCloseTo(expectedZ, 3);
      checked++;
    }
    // A fully-covered 3x3 emits all 9 vertices.
    expect(checked).toBe(9);
  });

  it("georef: horizontal extent is in METERS proportional to the bbox, not degrees", async () => {
    // The bbox spans 0.01 deg east and 0.01 deg north near lat 30.1.
    // Expected real-world meters:
    //   north extent = 0.01 * 111320                ~= 1113.2 m
    //   east extent  = 0.01 * 111320 * cos(30.1deg) ~= 963.9 m
    // A degree-scaled (buggy) mesh would instead span ~0.01 in X/Y, i.e.
    // ~1e5x too small. Asserting hundreds-to-thousands-of-meters proves the
    // conversion happened.
    const dem = makeDem([
      [100, 100, 100],
      [100, 100, 100],
      [100, 100, 100],
    ]);
    const { glb } = await deriveTerrainMeshGlb(dem, TEST_BBOX);
    const doc = await new NodeIO().readBinary(glb);
    const posArray = doc
      .getRoot()
      .listMeshes()[0]!
      .listPrimitives()[0]!
      .getAttribute("POSITION")!
      .getArray()!;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < posArray.length; i += 3) {
      const x = posArray[i]!;
      const y = posArray[i + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const eastExtent = maxX - minX;
    const northExtent = maxY - minY;

    const DEG_LAT_METERS = 111_320;
    const meanLatRad = ((30.1 + 30.11) / 2) * (Math.PI / 180);
    const expectedNorth = 0.01 * DEG_LAT_METERS;
    const expectedEast = 0.01 * DEG_LAT_METERS * Math.cos(meanLatRad);

    // Meters, not degrees: extents are hundreds-to-thousands of meters.
    expect(northExtent).toBeGreaterThan(1000);
    expect(eastExtent).toBeGreaterThan(900);
    // And they match the equirectangular meters within a tight tolerance.
    expect(northExtent).toBeCloseTo(expectedNorth, 1);
    expect(eastExtent).toBeCloseTo(expectedEast, 1);
    // Origin is the SW corner; recorded for downstream world placement.
    expect(minX).toBeCloseTo(0, 6);
    expect(minY).toBeCloseTo(0, 6);
  });

  it("emits a valid parseable glTF: round-trips through NodeIO with accessors", async () => {
    const dem = makeDem([
      [10, 11, 12],
      [13, 14, 15],
      [16, 17, 18],
    ]);
    const { glb, meta } = await deriveTerrainMeshGlb(dem, TEST_BBOX);

    expect(glb).toBeInstanceOf(Uint8Array);
    expect(glb.byteLength).toBeGreaterThan(0);

    const doc = await new NodeIO().readBinary(glb);
    const root = doc.getRoot();
    expect(root.listScenes().length).toBe(1);
    expect(root.listMeshes().length).toBe(1);
    const prim = root.listMeshes()[0]!.listPrimitives()[0]!;
    const posAcc = prim.getAttribute("POSITION");
    const idxAcc = prim.getIndices();
    expect(posAcc).not.toBeNull();
    expect(idxAcc).not.toBeNull();
    // Accessor counts agree with the metadata.
    expect(posAcc!.getCount()).toBe(meta.vertexCount);
    expect(idxAcc!.getCount()).toBe(meta.triangleCount * 3);
  });

  it("georef origin and CRS convention are recorded in metadata", async () => {
    const dem = makeDem([
      [1, 2],
      [3, 4],
    ]);
    const { meta } = await deriveTerrainMeshGlb(dem, TEST_BBOX);
    expect(meta.georefOrigin.originLng).toBeCloseTo(TEST_BBOX.westLng, 9);
    expect(meta.georefOrigin.originLat).toBeCloseTo(TEST_BBOX.southLat, 9);
    expect(meta.georefOrigin.metersPerDegreeLat).toBe(111_320);
    expect(meta.crsConvention).toBe(TERRAIN_MESH_CRS_CONVENTION);
    expect(meta.minElevationMeters).toBe(1);
    expect(meta.maxElevationMeters).toBe(4);
  });

  it("throws on a grid too small to triangulate", async () => {
    const dem = makeDem([[42]]);
    await expect(deriveTerrainMeshGlb(dem, TEST_BBOX)).rejects.toThrow(
      /too small/,
    );
  });

  it("nodata grid: POSITION accessor Z-bounds reflect REAL elevation, no phantom 0-floor", async () => {
    // The bug guard. Real terrain sits at 450-550m with a nodata hole. A
    // dense buffer with placeholder-Z(0) on the nodata slot would make
    // gltf-transform stamp POSITION.min[2] = 0 (bounds are computed over the
    // whole backing array, not the indexed subset), so a viewer framing off
    // the GLB's own bounds would render the terrain as a sliver over a ~500m
    // void. With a compacted buffer, min[2]/max[2] must be the true finite
    // elevation range.
    const dem = makeDem([
      [450, 460, 470, 480],
      [490, null, 510, 520],
      [530, 540, 550, 460],
      [470, 480, 490, 500],
    ]);
    const { glb, meta } = await deriveTerrainMeshGlb(dem, TEST_BBOX);
    expect(meta.hasHoles).toBe(true);

    const doc = await new NodeIO().readBinary(glb);
    const posAcc = doc
      .getRoot()
      .listMeshes()[0]!
      .listPrimitives()[0]!
      .getAttribute("POSITION")!;

    // gltf-transform stamps the accessor's computed min/max bounds into the
    // glTF; `getMin`/`getMax` read exactly what a downstream viewer sees.
    const min = posAcc.getMin([0, 0, 0]);
    const max = posAcc.getMax([0, 0, 0]);

    // The true finite-elevation range of the REFERENCED vertices. The nodata
    // cell at (col1,row1) removes its four neighbouring cells, which orphans
    // the NW-corner sample (450) — so 450 is NOT emitted and the honest min
    // over the referenced vertices is 460; the max stays 550. Critically
    // min[2] is a real elevation, NOT the phantom 0-floor the dense-buffer
    // bug would have stamped.
    expect(min[2]).not.toBe(0);
    expect(min[2]).toBeCloseTo(460, 3);
    expect(max[2]).toBeCloseTo(550, 3);
    // The metadata's elevation range agrees with the accessor bounds.
    expect(meta.minElevationMeters).toBeCloseTo(min[2]!, 3);
    expect(meta.maxElevationMeters).toBeCloseTo(max[2]!, 3);
  });

  it("row-orientation guard: a north-edge (row 0) vertex lands at MAX Y, a last-row vertex at Y=0", async () => {
    // Locks the raster-row-to-north mapping so a future refactor can't
    // silently flip the terrain north/south. Row 0 is the north edge, so its
    // Y-north meters is the maximum; the last row is the south edge at Y=0
    // (the origin is the SW corner).
    const dem = makeDem([
      [10, 11, 12],
      [13, 14, 15],
      [16, 17, 18],
    ]);
    const { glb } = await deriveTerrainMeshGlb(dem, TEST_BBOX);
    const doc = await new NodeIO().readBinary(glb);
    const posArray = doc
      .getRoot()
      .listMeshes()[0]!
      .listPrimitives()[0]!
      .getAttribute("POSITION")!
      .getArray()!;

    let maxY = -Infinity;
    let minY = Infinity;
    let zAtMaxY = NaN;
    let zAtMinY = NaN;
    for (let i = 0; i < posArray.length; i += 3) {
      const y = posArray[i + 1]!;
      const z = posArray[i + 2]!;
      if (y > maxY) {
        maxY = y;
        zAtMaxY = z;
      }
      if (y < minY) {
        minY = y;
        zAtMinY = z;
      }
    }
    // South edge (last row) sits at the origin Y = 0.
    expect(minY).toBeCloseTo(0, 6);
    // North edge (row 0) sits at the maximum Y (positive north meters).
    expect(maxY).toBeGreaterThan(1000);
    // And the elevations at those edges are row-0 (10-12) vs last-row
    // (16-18) values, proving row 0 mapped to the north (max-Y) edge.
    expect(zAtMaxY).toBeLessThan(13); // a row-0 vertex (10,11,12)
    expect(zAtMinY).toBeGreaterThan(15); // a last-row vertex (16,17,18)
  });
});

/**
 * Geometry-consistency guarantee (parcel-mesh/IFC Layer 2).
 *
 * The load-bearing correctness item for Layer 2: the compacted positions +
 * indices `buildTerrainMeshGeometry` hands to the IFC worker MUST be the
 * exact same geometry the Layer-1 GLB is built from. If they diverged, the
 * IFC surface and the GLB surface would be different meshes — a silent
 * defect. `deriveTerrainMeshGlb` is a thin wrapper over
 * `buildTerrainMeshGeometry` (it encodes that geometry's arrays verbatim
 * into the GLB), and the IFC step consumes `buildTerrainMeshGeometry`
 * directly, so this test proves the two share one triangulation by reading
 * the GLB back and comparing its accessor arrays to the raw geometry.
 */
describe("buildTerrainMeshGeometry / GLB consistency", () => {
  it("GLB POSITION + indices are byte-identical to buildTerrainMeshGeometry output", async () => {
    const dem = makeDem([
      [450, 460, 470, 480],
      [490, 500, 510, 520],
      [530, 540, 550, 460],
      [470, 480, 490, 500],
    ]);
    const geom = buildTerrainMeshGeometry(dem, TEST_BBOX);
    const { glb, meta } = await deriveTerrainMeshGlb(dem, TEST_BBOX);

    // The GLB's meta must match the geometry's meta (same source).
    expect(meta.vertexCount).toBe(geom.meta.vertexCount);
    expect(meta.triangleCount).toBe(geom.meta.triangleCount);
    expect(geom.positions.length).toBe(geom.meta.vertexCount * 3);
    expect(geom.indices.length).toBe(geom.meta.triangleCount * 3);

    const doc = await new NodeIO().readBinary(glb);
    const prim = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    const glbPositions = prim.getAttribute("POSITION")!.getArray()!;
    const glbIndices = prim.getIndices()!.getArray()!;

    // Same lengths.
    expect(glbPositions.length).toBe(geom.positions.length);
    expect(glbIndices.length).toBe(geom.indices.length);

    // Same values, element-for-element. Float32 round-trips through the GLB
    // exactly (both are Float32), and the indices are integers.
    for (let i = 0; i < geom.positions.length; i++) {
      expect(glbPositions[i]).toBe(geom.positions[i]);
    }
    for (let i = 0; i < geom.indices.length; i++) {
      expect(glbIndices[i]).toBe(geom.indices[i]);
    }
  });

  it("nodata holes: the shared geometry drops the same cells in both paths", async () => {
    // A hole must remove the same triangles from the geometry AND the GLB,
    // since they are the same arrays. Compare counts + array identity.
    const holed = makeDem([
      [100, 101, 102, 103],
      [104, null, 106, 107],
      [108, 109, 110, 111],
      [112, 113, 114, 115],
    ]);
    const geom = buildTerrainMeshGeometry(holed, TEST_BBOX);
    expect(geom.meta.hasHoles).toBe(true);

    const { glb } = await deriveTerrainMeshGlb(holed, TEST_BBOX);
    const doc = await new NodeIO().readBinary(glb);
    const prim = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    const glbIndices = prim.getIndices()!.getArray()!;
    expect(glbIndices.length).toBe(geom.indices.length);
    for (let i = 0; i < geom.indices.length; i++) {
      expect(glbIndices[i]).toBe(geom.indices[i]);
    }
  });
});
