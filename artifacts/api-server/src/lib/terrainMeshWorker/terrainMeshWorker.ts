/**
 * `worker_threads` entry for the terrain-mesh build (async-terrain-job).
 *
 * The site-topography ingest used to build the terrain mesh INLINE on the
 * api-server main thread — a nested per-pixel triangulation loop
 * (`siteTopographyMesh.ts` `buildTerrainMeshGeometry`) plus the gltf-transform
 * GLB encode. On the shared 2-CPU cortex-api container that synchronous loop
 * pegged a core and stalled the co-scheduled 29s brief request, producing Cloud
 * Run "malformed response" 503s. Running it here instead of inline is the fix:
 * the CPU work executes on a separate thread, so the parent's request event
 * loop stays responsive and healthz + the brief keep answering.
 *
 * Modeled on the existing `ifcParser/ifcParseWorker.ts` one-shot worker: the
 * parent spawns one per authoring run and tears it down afterward. Input arrives
 * via `workerData`; the worker posts exactly one {@link TerrainMeshWorkerMessage}
 * back, then drains and exits 0. A crash / OOM exits non-zero with no message;
 * the parent maps that to a mesh failure (best-effort — a mesh failure never
 * fails the ingest).
 */

import { parentPort, workerData } from "node:worker_threads";
import { deriveTerrainMeshGlb, buildTerrainMeshGeometry } from "../siteTopographyMesh";
import type {
  TerrainMeshWorkerInput,
  TerrainMeshWorkerMessage,
} from "./types";

async function main(): Promise<void> {
  if (!parentPort) {
    throw new Error(
      "terrainMeshWorker must be run as a worker_threads worker",
    );
  }
  const port = parentPort;

  const input = workerData as TerrainMeshWorkerInput | undefined;
  if (
    !input ||
    !input.dem ||
    !(input.dem.values instanceof Float32Array) ||
    input.dem.values.length === 0
  ) {
    const msg: TerrainMeshWorkerMessage = {
      ok: false,
      error: "terrain mesh worker received no DEM grid",
    };
    port.postMessage(msg);
    return;
  }

  try {
    const demInput = {
      width: input.dem.width,
      height: input.dem.height,
      values: input.dem.values,
    };
    // Triangulate once (buildTerrainMeshGeometry) and encode the SAME arrays
    // into the GLB (deriveTerrainMeshGlb wraps that build). We call the build
    // directly too so the compacted positions/indices travel back for the IFC
    // author — nothing re-triangulates the grid, preserving the
    // GLB-surface == IFC-surface guarantee.
    const geometry = buildTerrainMeshGeometry(demInput, input.bbox, {
      verticalExaggeration: input.verticalExaggeration,
    });
    const { glb } = await deriveTerrainMeshGlb(demInput, input.bbox, {
      verticalExaggeration: input.verticalExaggeration,
    });
    const msg: TerrainMeshWorkerMessage = {
      ok: true,
      result: {
        glb,
        positions: geometry.positions,
        indices: geometry.indices,
        meta: geometry.meta,
      },
    };
    port.postMessage(msg);
  } catch (err) {
    const msg: TerrainMeshWorkerMessage = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    port.postMessage(msg);
  }
}

void main();
