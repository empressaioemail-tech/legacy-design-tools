/**
 * Docker-backed ogr2ogr / ogrinfo helpers for the FEMA NFHL FileGDB.
 *
 * The repo has no native FileGDB driver in Node; GDAL in Docker is the
 * same pattern the tile-pipeline uses for warp/bake. Reads the statewide
 * zip via /vsizip/ so the 1.81 GB archive does not need a full extract.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import type { Readable } from "node:stream";
import type { NfhlFeature } from "./parse";

export const GDAL_DOCKER_IMAGE = "ghcr.io/osgeo/gdal:ubuntu-full-latest";

/** Default high-water mark: pause child stdout once this many features await yield. */
export const STREAM_QUEUE_HIGH_WATER = 32;
/** Resume child stdout once the queue drains to this many features. */
export const STREAM_QUEUE_LOW_WATER = 8;

export interface NfhlGdbLocation {
  /** Absolute path to the NFHL_48_*.zip on the host. */
  zipPath: string;
  /** Directory name inside the zip, e.g. NFHL_48_20260101.gdb */
  gdbDir: string;
}

export interface OgrLayerSummary {
  layerName: string;
  featureCount: number;
  geometryType: string;
  srsEpsg: string | null;
  fields: string[];
}

export interface StreamGdbLayerOptions {
  limit?: number;
  /** Pause stdout when pending features exceed this count. Default 32. */
  highWaterMark?: number;
  /** Resume stdout when pending features fall to this count. Default 8. */
  lowWaterMark?: number;
  /**
   * Test seam: override the spawn that produces GeoJSONSeq on stdout.
   * Production path always uses Docker ogr2ogr.
   */
  spawnProducer?: () => ChildProcessWithoutNullStreams;
}

function dockerMountPath(hostPath: string): string {
  return resolve(hostPath).replace(/\\/g, "/");
}

function vsizipGdbPath(loc: NfhlGdbLocation): string {
  const zipBase = basename(loc.zipPath);
  return `/vsizip//work/${zipBase}/${loc.gdbDir}`;
}

function runDocker(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `docker gdal exited ${code}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
      } else {
        resolvePromise({ stdout, stderr });
      }
    });
  });
}

/** Parse `ogrinfo -so` output for layer metadata. */
export function parseOgrLayerSummary(
  stderrAndStdout: string,
  layerName: string,
): OgrLayerSummary {
  const text = stderrAndStdout;
  const featureMatch = text.match(/Feature Count:\s*(\d+)/);
  const geomMatch = text.match(/Geometry:\s*(.+)/);
  const epsgMatch = text.match(/ID\["EPSG",(\d+)\]/);
  const fieldLines = text.match(/^[A-Z0-9_]+:/gm) ?? [];
  return {
    layerName,
    featureCount: featureMatch ? Number(featureMatch[1]) : 0,
    geometryType: geomMatch?.[1]?.trim() ?? "unknown",
    srsEpsg: epsgMatch ? epsgMatch[1] : null,
    fields: fieldLines.map((line) => line.replace(/:$/, "")),
  };
}

export async function ogrInfoLayer(
  loc: NfhlGdbLocation,
  layerName: string,
): Promise<OgrLayerSummary> {
  const zipDir = dockerMountPath(dirname(loc.zipPath));
  const gdbPath = vsizipGdbPath(loc);
  const { stdout, stderr } = await runDocker([
    "run",
    "--rm",
    "-v",
    `${zipDir}:/work:ro`,
    GDAL_DOCKER_IMAGE,
    "ogrinfo",
    "-so",
    gdbPath,
    layerName,
  ]);
  return parseOgrLayerSummary(`${stderr}\n${stdout}`, layerName);
}

/**
 * Bounded async bridge from a Readable producing GeoJSONSeq lines to an
 * async generator. Pauses the Readable when the queue hits highWaterMark
 * and resumes at lowWaterMark so producers cannot outrun slow consumers
 * (the failure mode that OOM'd the statewide NFHL apply).
 *
 * Exported for unit tests — production callers use streamGdbLayerGeoJson.
 */
export async function* streamGeoJsonSeqWithBackpressure(
  stdout: Readable,
  opts: {
    highWaterMark?: number;
    lowWaterMark?: number;
    onClose?: Promise<{ code: number | null; spawnError: Error | null }>;
    /** Test seam: fired whenever queue depth changes. */
    onQueueDepth?: (depth: number) => void;
  } = {},
): AsyncGenerator<NfhlFeature> {
  const highWater = opts.highWaterMark ?? STREAM_QUEUE_HIGH_WATER;
  const lowWater = opts.lowWaterMark ?? STREAM_QUEUE_LOW_WATER;
  if (highWater < 1) {
    throw new Error("highWaterMark must be >= 1");
  }
  if (lowWater < 0 || lowWater >= highWater) {
    throw new Error("lowWaterMark must satisfy 0 <= lowWaterMark < highWaterMark");
  }

  let buffer = "";
  const featureQueue: NfhlFeature[] = [];
  let resolveNext: (() => void) | null = null;
  let done = false;
  let parseError: Error | null = null;
  let exitError: Error | null = null;
  let paused = false;

  function reportDepth(): void {
    opts.onQueueDepth?.(featureQueue.length);
  }

  function wake(): void {
    resolveNext?.();
    resolveNext = null;
  }

  function applyBackpressure(): void {
    if (!paused && featureQueue.length >= highWater) {
      stdout.pause();
      paused = true;
    }
  }

  function drainBuffer(): void {
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      if (featureQueue.length >= highWater) {
        applyBackpressure();
        return;
      }
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      pushFeature(line);
      if (parseError) return;
    }
  }

  function releaseBackpressure(): void {
    if (paused && featureQueue.length <= lowWater) {
      stdout.resume();
      paused = false;
      // Drain lines already held in `buffer` before more chunks arrive.
      drainBuffer();
    }
  }

  function pushFeature(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) return;
    try {
      featureQueue.push(JSON.parse(trimmed) as NfhlFeature);
      reportDepth();
      applyBackpressure();
      wake();
    } catch (err) {
      parseError =
        err instanceof Error
          ? err
          : new Error(`invalid GeoJSONSeq line: ${trimmed.slice(0, 120)}`);
      wake();
    }
  }

  stdout.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    drainBuffer();
  });

  stdout.on("end", () => {
    // Final drain even if still "paused" — producer is gone.
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      pushFeature(line);
    }
    if (buffer.trim()) pushFeature(buffer);
    buffer = "";
    done = true;
    wake();
  });

  stdout.on("error", (err) => {
    parseError = err;
    done = true;
    wake();
  });

  if (opts.onClose) {
    void opts.onClose.then(({ code, spawnError }) => {
      if (spawnError) {
        parseError = spawnError;
      } else if (code !== 0 && code !== null) {
        exitError = new Error(`ogr2ogr exited ${code}`);
      }
      done = true;
      wake();
    });
  }

  try {
    while (true) {
      if (parseError) throw parseError;
      if (exitError) throw exitError;
      if (featureQueue.length > 0) {
        const next = featureQueue.shift()!;
        reportDepth();
        releaseBackpressure();
        yield next;
        continue;
      }
      if (done) return;
      await new Promise<void>((resolveWait) => {
        resolveNext = resolveWait;
      });
    }
  } finally {
    if (paused) {
      stdout.resume();
      paused = false;
    }
  }
}

/**
 * Stream GeoJSON features from a FileGDB layer via ogr2ogr GeoJSONSeq on
 * stdout. Reprojects to EPSG:4326 (WGS84) at extract time.
 *
 * Memory stays flat: child stdout is paused when the in-process feature
 * queue hits highWaterMark and resumed at lowWaterMark. Without this,
 * ogr2ogr outruns DB-bound consumers and the Node heap grows without bound.
 */
export async function* streamGdbLayerGeoJson(
  loc: NfhlGdbLocation,
  layerName: string,
  opts: StreamGdbLayerOptions = {},
): AsyncGenerator<NfhlFeature> {
  let child: ChildProcessWithoutNullStreams;
  let spawnError: Error | null = null;

  if (opts.spawnProducer) {
    child = opts.spawnProducer();
  } else {
    const zipDir = dockerMountPath(dirname(loc.zipPath));
    const gdbPath = vsizipGdbPath(loc);
    const ogrArgs = [
      "ogr2ogr",
      "-f",
      "GeoJSONSeq",
      "-t_srs",
      "EPSG:4326",
      "/vsistdout/",
      gdbPath,
      layerName,
    ];
    if (opts.limit !== undefined) {
      ogrArgs.push("-limit", String(opts.limit));
    }

    child = spawn(
      "docker",
      [
        "run",
        "--rm",
        "-i",
        "-v",
        `${zipDir}:/work:ro`,
        GDAL_DOCKER_IMAGE,
        ...ogrArgs,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    ) as ChildProcessWithoutNullStreams;
  }

  child.stderr.on("data", () => {
    // ogr2ogr progress on stderr — ignore unless exit fails
  });

  child.on("error", (err) => {
    spawnError = err;
  });

  const onClose = new Promise<{ code: number | null; spawnError: Error | null }>(
    (resolveClose) => {
      child.on("close", (code) => {
        resolveClose({ code, spawnError });
      });
    },
  );

  yield* streamGeoJsonSeqWithBackpressure(child.stdout, {
    highWaterMark: opts.highWaterMark,
    lowWaterMark: opts.lowWaterMark,
    onClose,
  });
}
