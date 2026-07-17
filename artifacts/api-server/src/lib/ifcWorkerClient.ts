/**
 * IFC-authoring worker client — parcel-mesh/IFC Layer 2.
 *
 * Spawns the ifcopenshell Python sidecar (artifacts/ifc-worker/run.py),
 * writes the terrain mesh geometry + provenance/confidence as JSON on
 * stdin, reads the authored IFC (as text) back on stdout. Mirrors the
 * hydrology worker client's spawn-JSON-over-stdio shape (child_process
 * spawn, timeout, typed result).
 *
 * There is NO native/JS fallback: authoring a valid IFC4 STEP file by hand
 * in TypeScript would be a second, divergent implementation of the
 * correctness core (the whole point of the single-triangulation refactor).
 * When Python/ifcopenshell is unavailable the client returns a structured
 * error and the ingest integration treats IFC as best-effort-skipped (the
 * mesh / contour / confidence output still lands). See ingestSiteTopography
 * step 5.6.
 *
 * The geometry handed in here is the EXACT compacted positions + indices
 * `siteTopographyMesh.buildTerrainMeshGeometry` produced for the GLB, so
 * the IFC surface and the GLB surface are the same triangulation.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Georef origin for the local ENU frame (bbox SW corner). */
export interface IfcWorkerGeorefOrigin {
  originLng: number;
  originLat: number;
  /** OrthogonalHeight of the local origin above the datum (metres). */
  originHeightMeters?: number;
}

/** Source/coverage provenance stamped into the IFC provenance Pset. */
export interface IfcWorkerProvenance {
  sourceCitation: string;
  coverageFraction: number;
  demResolutionMeters: number;
  demResolutionMeasured: boolean;
  /** Proxy collection date (the DEM fetch time until real lidar vintage lands). */
  collectionProxyDate: string;
  hasHoles: boolean;
}

/** Widthed-confidence estimate stamped into the IFC confidence Pset. */
export interface IfcWorkerConfidence {
  estimate: number;
  provenance: string;
  n: number;
  intervalWidth: number;
}

export interface IfcWorkerRequest {
  /** Flat [x,y,z,...] local-ENU-metres positions (GLB POSITION array). */
  positions: Float32Array | number[];
  /** Flat zero-based triangle indices (GLB index array). */
  indices: Uint32Array | number[];
  georefOrigin: IfcWorkerGeorefOrigin;
  crsConvention: string;
  provenance: IfcWorkerProvenance;
  confidence: IfcWorkerConfidence;
}

export interface IfcWorkerSuccess {
  status: "ok";
  library: string;
  libraryVersion: string;
  schemaVersion: "IFC4";
  geometryPrimitive: "IfcTriangulatedFaceSet";
  georefCrs: string;
  vertexCount: number;
  triangleCount: number;
  byteCount: number;
  /** The authored IFC as STEP/SPF text. */
  ifcText: string;
}

export type IfcWorkerResult =
  | IfcWorkerSuccess
  | { status: "error"; code: string; message: string };

/**
 * Resolve the worker path. Env override wins (the deploy sets
 * `IFC_WORKER_PATH` to the image's absolute run.py path, since the api
 * bundle at dist/index.mjs is several dirs away from artifacts/ifc-worker).
 * The computed default walks from this module up to the repo's
 * `artifacts/ifc-worker/run.py`, which is correct when running from source
 * (vitest / ts-node) where this file sits at
 * artifacts/api-server/src/lib/ifcWorkerClient.ts.
 */
function resolveWorkerPath(): string {
  const override = process.env.IFC_WORKER_PATH?.trim();
  if (override) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  // src/lib -> src -> api-server -> artifacts -> artifacts/ifc-worker/run.py
  return join(here, "..", "..", "..", "ifc-worker", "run.py");
}

function resolvePythonBin(): string {
  return process.env.IFC_PYTHON?.trim() || "python3";
}

/** Read the timeout at call time so an env override applies per-invocation. */
function resolveTimeoutMs(): number {
  const raw = Number(process.env.IFC_WORKER_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 45_000;
}

/** Normalize a typed array or plain array to a plain number[] for JSON. */
function toNumberArray(a: Float32Array | Uint32Array | number[]): number[] {
  return Array.isArray(a) ? a : Array.from(a);
}

/**
 * Author an IFC from a terrain mesh by spawning the Python worker. Never
 * throws for an operational failure (missing python, worker crash, timeout,
 * unparseable output); those resolve to a structured `{ status: "error" }`
 * so the caller can treat IFC as best-effort. Throws only on a programming
 * error in marshalling (which the caller's try/catch also absorbs).
 */
export async function runIfcWorker(
  req: IfcWorkerRequest,
): Promise<IfcWorkerResult> {
  const python = resolvePythonBin();
  const workerPath = resolveWorkerPath();
  const timeoutMs = resolveTimeoutMs();
  const payload = JSON.stringify({
    positions: toNumberArray(req.positions),
    indices: toNumberArray(req.indices),
    georefOrigin: {
      originLng: req.georefOrigin.originLng,
      originLat: req.georefOrigin.originLat,
      originHeightMeters: req.georefOrigin.originHeightMeters ?? 0,
    },
    crsConvention: req.crsConvention,
    provenance: req.provenance,
    confidence: req.confidence,
  });

  return new Promise((resolve) => {
    const child = spawn(python, [workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    // Diagnostic state for the EPIPE-on-write path. When the child dies before
    // reading its stdin (the failure mode this whole file exists to survive),
    // the parent's write EPIPEs. We must NOT resolve on that raw stream error
    // immediately: the child's REAL failure reason — an ifcopenshell import
    // crash on stderr, or the worker's own structured `missing-deps` JSON on
    // stdout — is still arriving. Record the EPIPE, give the child a short
    // grace window to flush stderr and emit 'close', then resolve carrying the
    // captured diagnostics so "continuing without IFC" names the Python cause,
    // not a bare EPIPE. (Root-causing a future regression needs the child's
    // stderr, which the old immediate-resolve threw away.)
    let stdinEpipe: NodeJS.ErrnoException | null = null;
    let epipeGraceTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (epipeGraceTimer) clearTimeout(epipeGraceTimer);
      child.kill("SIGTERM");
      resolve({
        status: "error",
        code: "worker-timeout",
        message: `ifc worker exceeded ${timeoutMs}ms`,
      });
    }, timeoutMs);

    /**
     * Build the structured stdin-write-failure result, folding in whatever the
     * child managed to emit before/while dying. `stderr` is the actual Python
     * traceback (e.g. an ifcopenshell import error); a non-null `exitCode` is
     * the child's exit status. Both are appended when present so the single
     * log line the ingest prints for "continuing without IFC" is diagnosable.
     */
    const stdinFailureResult = (
      err: NodeJS.ErrnoException,
      exitCode: number | null,
    ): IfcWorkerResult => {
      const parts = [
        `write to ifc worker stdin failed (${err.code ?? "unknown"}): ${err.message}`,
      ];
      if (exitCode !== null) {
        parts.push(`child exit code: ${exitCode}`);
      }
      const trimmedErr = stderr.trim();
      if (trimmedErr) {
        parts.push(`child stderr: ${trimmedErr}`);
      }
      // The worker's import guard prints a structured `missing-deps` JSON to
      // stdout then exits 0 before reading stdin; surface it too, since it is
      // the single most likely real cause (ifcopenshell not importable in the
      // deployed image) and it lands on stdout, not stderr.
      const trimmedOut = stdout.trim();
      if (trimmedOut) {
        parts.push(`child stdout: ${trimmedOut}`);
      }
      return {
        status: "error",
        code: "stdin-write-failed",
        message: parts.join(" | "),
      };
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: "error",
        code: "spawn-failed",
        message: err.message,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (epipeGraceTimer) clearTimeout(epipeGraceTimer);
      // If the write EPIPE'd, the child died early: resolve as
      // stdin-write-failed but now WITH the child's stderr + exit code that
      // arrived on 'close'. This is the diagnosable path — the real Python
      // error (or the worker's missing-deps stdout) rides along.
      if (stdinEpipe) {
        resolve(stdinFailureResult(stdinEpipe, code));
        return;
      }
      if (code !== 0) {
        resolve({
          status: "error",
          code: "worker-exit",
          message: stderr.trim() || `python exited ${code}`,
        });
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as IfcWorkerResult;
        resolve(parsed);
      } catch (err) {
        resolve({
          status: "error",
          code: "parse-failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // Handle 'error' on the stdin pipe. This is the crash the async terrain
    // worker was hitting: the payload below (positions + indices for the full
    // terrain mesh, serialized as JSON number arrays) is large enough to be
    // written to the pipe in multiple chunks. If the Python child exits early
    // — missing interpreter at the resolved path, an ifcopenshell import crash,
    // or an OOM kill on the shared 2-CPU container — the kernel resets the
    // stdin pipe and the in-flight write completes with EPIPE. A writable
    // stream with NO 'error' listener re-emits that as an UNHANDLED 'error'
    // event on the Socket, which Node turns into an uncaughtException and the
    // process exits(1) — taking down the whole container (and every
    // co-scheduled brief/map request) instead of failing just this job. The
    // '.catch()' the terrain job worker attaches to the fire-and-forget launch
    // cannot intercept this: it is a raw stream 'error' event, not a promise
    // rejection. Catching it here converts the EPIPE into the client's
    // structured best-effort result: the ingest logs it and continues WITHOUT
    // the IFC layer, and the terrain job is stamped 'ready'/'failed' with a
    // real reason on the normal path — never swept 8 minutes later after a
    // process death.
    child.stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      // Do NOT resolve immediately. Record the EPIPE and let the child's
      // 'close' fire so its stderr/exit code (the actual reason it died —
      // most likely an ifcopenshell import crash in the deployed image) is
      // captured into the message. Kick SIGTERM to hurry a dead-but-not-yet-
      // reaped child. A short grace timer guarantees we still settle even if
      // 'close' never arrives (e.g. a wedged child, or a unit test that emits
      // only the stdin error).
      if (stdinEpipe) return; // already recorded; ignore repeat errors
      stdinEpipe = err;
      try {
        child.kill("SIGTERM");
      } catch {
        // Already exited — ignore.
      }
      epipeGraceTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(stdinFailureResult(err, null));
      }, 250);
    });

    // Guard the write itself: if the child already died before we get here,
    // its stdin is no longer writable and a bare `.write()` would throw
    // synchronously (or emit EPIPE) rather than returning a normal false. Skip
    // the write in that case and let the 'error'/'close' handlers settle the
    // result. `.write()`/`.end()` are additionally wrapped so a synchronous
    // throw (e.g. "write after end") is caught instead of escaping this
    // Promise executor as an unhandled exception.
    try {
      if (child.stdin.writable && !child.stdin.destroyed) {
        child.stdin.write(payload);
        child.stdin.end();
      }
    } catch (err) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (epipeGraceTimer) clearTimeout(epipeGraceTimer);
        try {
          child.kill("SIGTERM");
        } catch {
          // Already exited — ignore.
        }
        // Fold in any stderr/stdout already captured so a synchronous write
        // throw ("write after end", a child that died before this line) is
        // just as diagnosable as the async EPIPE path.
        const wrapped: NodeJS.ErrnoException =
          err instanceof Error ? err : new Error(String(err));
        resolve(stdinFailureResult(wrapped, null));
      }
    }
  });
}
