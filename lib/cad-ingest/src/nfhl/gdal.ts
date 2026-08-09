/**
 * Docker-backed ogr2ogr / ogrinfo helpers for the FEMA NFHL FileGDB.
 *
 * The repo has no native FileGDB driver in Node; GDAL in Docker is the
 * same pattern the tile-pipeline uses for warp/bake. Reads the statewide
 * zip via /vsizip/ so the 1.81 GB archive does not need a full extract.
 */

import { spawn } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import type { NfhlFeature } from "./parse";

export const GDAL_DOCKER_IMAGE = "ghcr.io/osgeo/gdal:ubuntu-full-latest";

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
 * Stream GeoJSON features from a FileGDB layer via ogr2ogr GeoJSONSeq on
 * stdout. Reprojects to EPSG:4326 (WGS84) at extract time.
 */
export async function* streamGdbLayerGeoJson(
  loc: NfhlGdbLocation,
  layerName: string,
  opts: { limit?: number } = {},
): AsyncGenerator<NfhlFeature> {
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

  const child = spawn(
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
  );

  let buffer = "";
  const featureQueue: NfhlFeature[] = [];
  let resolveNext: (() => void) | null = null;
  let done = false;
  let spawnError: Error | null = null;
  let exitError: Error | null = null;

  function pushFeature(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) return;
    try {
      featureQueue.push(JSON.parse(trimmed) as NfhlFeature);
      resolveNext?.();
    } catch (err) {
      spawnError =
        err instanceof Error ? err : new Error(`invalid GeoJSONSeq line: ${trimmed.slice(0, 120)}`);
      resolveNext?.();
    }
  }

  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      pushFeature(line);
    }
  });

  child.stderr.on("data", () => {
    // ogr2ogr progress on stderr — ignore unless exit fails
  });

  child.on("error", (err) => {
    spawnError = err;
    done = true;
    resolveNext?.();
  });

  child.on("close", (code) => {
    if (buffer.trim()) pushFeature(buffer);
    if (code !== 0 && !spawnError) {
      exitError = new Error(`ogr2ogr exited ${code}`);
    }
    done = true;
    resolveNext?.();
  });

  while (true) {
    if (spawnError) throw spawnError;
    if (exitError) throw exitError;
    if (featureQueue.length > 0) {
      yield featureQueue.shift()!;
      continue;
    }
    if (done) return;
    await new Promise<void>((resolveWait) => {
      resolveNext = resolveWait;
    });
    resolveNext = null;
  }
}
