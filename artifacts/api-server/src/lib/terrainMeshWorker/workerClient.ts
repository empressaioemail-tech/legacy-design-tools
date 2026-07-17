/**
 * Worker client — dispatches the terrain-mesh build to a one-shot
 * `worker_threads` worker and owns the thread lifecycle (async-terrain-job).
 *
 * Why a worker thread: the triangulation is a nested per-pixel loop and the GLB
 * encode is CPU-bound; running them inline on the api-server main thread pegged
 * a core on the shared 2-CPU container and starved the co-scheduled 29s brief
 * request (Cloud Run "malformed response" 503s). Off-loading to a thread keeps
 * the parent event loop responsive. One worker per authoring run (the terrain
 * job worker already serializes runs per engagement via the single-flight
 * index), torn down after the single result — the same one-shot shape
 * `ifcParser/workerClient.ts` uses.
 *
 * Failure isolation: a hang is killed by {@link TERRAIN_MESH_TIMEOUT_MS} via
 * `worker.terminate()`; an OOM / crash surfaces as a non-zero `exit`. Either way
 * the parent event loop is untouched, and a mesh failure is best-effort (the
 * caller continues the ingest without the mesh/IFC).
 */

import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  TerrainMeshWorkerInput,
  TerrainMeshWorkerMessage,
  TerrainMeshWorkerResult,
} from "./types";

/**
 * Hard cap on a single mesh build. On expiry the worker is terminated and the
 * build rejects. Parcel-scale grids build in well under a second; the generous
 * default guards a pathological wide-catchment / high-resolution grid without
 * ever approaching the Cloud Run request timeout (the whole point is that this
 * runs OFF the request path anyway). Override with `TERRAIN_MESH_TIMEOUT_MS`.
 */
export const TERRAIN_MESH_TIMEOUT_MS = (() => {
  const raw = process.env["TERRAIN_MESH_TIMEOUT_MS"];
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 60_000;
})();

/** Minimal slice of `worker_threads` `Worker` this client needs. */
export interface TerrainMeshWorkerHandle {
  on(event: "message", cb: (msg: TerrainMeshWorkerMessage) => void): unknown;
  on(event: "error", cb: (err: unknown) => void): unknown;
  on(event: "exit", cb: (code: number) => void): unknown;
  terminate(): Promise<number> | void;
}

export type TerrainMeshWorkerFactory = (
  input: TerrainMeshWorkerInput,
) => TerrainMeshWorkerHandle;

/**
 * Resolve the bundled worker entry. In production the api-server runs as a
 * single esbuild bundle (`dist/index.mjs`); this module's `import.meta.url`
 * points there and the worker is the separately-bundled
 * `dist/lib/terrainMeshWorker/terrainMeshWorker.mjs` (added as a second esbuild
 * entry in build.mjs, mirroring the ifc parse worker).
 */
function resolveWorkerEntry(): string {
  const candidates = [
    new URL(
      "./lib/terrainMeshWorker/terrainMeshWorker.mjs",
      import.meta.url,
    ),
    new URL("./terrainMeshWorker.mjs", import.meta.url),
  ].map((url) => fileURLToPath(url));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `terrain mesh worker entry not found (looked in: ${candidates.join(", ")})`,
  );
}

const defaultWorkerFactory: TerrainMeshWorkerFactory = (input) =>
  new Worker(resolveWorkerEntry(), { workerData: input });

let workerFactory: TerrainMeshWorkerFactory = defaultWorkerFactory;

/**
 * Test seam — substitute the worker factory so callers can be tested without a
 * real thread. Pass `null` to restore the production factory. Production code
 * must never call this.
 */
export function __setTerrainMeshWorkerFactoryForTests(
  factory: TerrainMeshWorkerFactory | null,
): void {
  workerFactory = factory ?? defaultWorkerFactory;
}

/**
 * Build the terrain mesh (GLB + geometry + meta) on a worker thread. Rejects on
 * timeout, worker error, non-zero exit, or a worker-reported build failure. The
 * caller (the terrain ingest step) treats a rejection as best-effort-skipped:
 * the contour/coverage output still lands, the mesh/IFC payload just stays
 * absent.
 */
export function buildTerrainMeshInWorker(
  input: TerrainMeshWorkerInput,
  timeoutMs: number = TERRAIN_MESH_TIMEOUT_MS,
): Promise<TerrainMeshWorkerResult> {
  return new Promise<TerrainMeshWorkerResult>((resolve, reject) => {
    let settled = false;
    let worker: TerrainMeshWorkerHandle;
    try {
      worker = workerFactory(input);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const killWorker = () => {
      try {
        void Promise.resolve(worker.terminate()).catch(() => undefined);
      } catch {
        // terminate() on an already-exited worker is a no-op; ignore.
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killWorker();
      reject(new Error(`terrain mesh build timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Don't let the timeout alone hold the event loop open.
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }

    worker.on("message", (msg: TerrainMeshWorkerMessage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A one-shot worker posts one message then exits on its own; no
      // terminate() needed on the happy path.
      if (msg.ok) {
        resolve(msg.result);
      } else {
        reject(new Error(msg.error));
      }
    });

    worker.on("error", (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killWorker();
      reject(err instanceof Error ? err : new Error(String(err)));
    });

    worker.on("exit", (code: number) => {
      if (settled) return;
      // Exited without posting a message — OOM / native crash.
      settled = true;
      clearTimeout(timer);
      reject(new Error(`terrain mesh worker exited with code ${code}`));
    });
  });
}
