/**
 * Shared types for the terrain-mesh `worker_threads` worker (async-terrain-job).
 *
 * The worker runs the CPU-heavy terrain triangulation + GLB encode off the
 * api-server event loop. It receives the parsed DEM grid + bbox + options via
 * `workerData` and posts back exactly one {@link TerrainMeshWorkerMessage}.
 */

import type { BboxWgs84 } from "@workspace/site-context/server";
import type { TerrainMeshMeta } from "../siteTopographyMesh";

/** Input handed to the worker (structured-clone-safe: TypedArrays transfer). */
export interface TerrainMeshWorkerInput {
  dem: {
    width: number;
    height: number;
    /** Row-major elevation values; nodata cells are NaN. */
    values: Float32Array;
  };
  bbox: BboxWgs84;
  verticalExaggeration?: number;
}

/**
 * Successful worker result. `glb` is the encoded .glb bytes; `positions` /
 * `indices` are the SAME compacted triangulation the GLB was built from, handed
 * back so the Layer-2 IFC author consumes the identical geometry (the
 * single-triangulation guarantee) without re-triangulating. `meta` is the
 * terrain metadata block.
 */
export interface TerrainMeshWorkerResult {
  glb: Uint8Array;
  positions: Float32Array;
  indices: Uint32Array;
  meta: TerrainMeshMeta;
}

/** The single message the worker posts back to the parent. */
export type TerrainMeshWorkerMessage =
  | { ok: true; result: TerrainMeshWorkerResult }
  | { ok: false; error: string };
