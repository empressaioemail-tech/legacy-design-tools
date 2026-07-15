/**
 * Resolve a `--file` argument to a readable byte stream.
 *
 * Two forms, both streaming (the drops are large — Austin ~2.36M rows —
 * so nothing is buffered whole):
 *  - `gs://bucket/path` — spawned `gcloud storage cat`, whose stdout is
 *    the stream. Mirrors the K2 calibration harness
 *    (`scripts/src/runK2V3Harness.ts`). If gcloud-cat streaming is
 *    flaky in the operator's environment, `gcloud storage cp` the file
 *    down first and pass the local path instead — both forms feed the
 *    same parser.
 *  - a local path — `createReadStream`.
 */

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";

export function isGcsUri(input: string): boolean {
  return /^gs:\/\//i.test(input);
}

/**
 * The gcloud binary. `PERMIT_INGEST_GCLOUD` overrides it (the K2
 * harness hardcodes a Windows path; here it is env-driven so CI/linux
 * runners can point at their own `gcloud`). Defaults to the one on PATH.
 */
function gcloudBin(): string {
  return process.env.PERMIT_INGEST_GCLOUD ?? "gcloud";
}

export interface ResolvedInput {
  /** Readable byte/utf8 stream of the CSV. */
  stream: Readable;
  /** Basename recorded on every row (`source_file`). */
  sourceFile: string;
  /** Resolves/rejects when a spawned child exits; null for local files. */
  done: Promise<void> | null;
}

function basenameOf(p: string): string {
  const noQuery = p.split(/[?#]/)[0] ?? p;
  return noQuery.split(/[\\/]/).pop() || noQuery;
}

/**
 * Open `input` as a stream. For gs:// the returned `done` promise
 * resolves when `gcloud storage cat` exits 0 and rejects on a non-zero
 * exit; callers should await it after draining the stream so a partial
 * read is not mistaken for a complete ingest.
 */
export function openInput(input: string): ResolvedInput {
  const sourceFile = basenameOf(input);
  if (isGcsUri(input)) {
    const proc = spawn(gcloudBin(), ["storage", "cat", input], {
      shell: true,
    });
    let stderr = "";
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    const done = new Promise<void>((resolve, reject) => {
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `gcloud storage cat exited ${code} for ${input}` +
                (stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : ""),
            ),
          );
      });
    });
    return { stream: proc.stdout, sourceFile, done };
  }
  return {
    stream: createReadStream(input, { encoding: "utf8" }),
    sourceFile,
    done: null,
  };
}

/**
 * Derive a `source_vintage` label from the `--file` argument: strip the
 * directory and the extension, lowercase, collapse whitespace to dashes.
 * e.g. `.../issued_construction_permits.csv` -> `issued_construction_permits`.
 */
export function deriveVintage(fileArg: string): string {
  const base = basenameOf(fileArg);
  const withoutExt = base.replace(/\.[^.]+$/, "");
  return withoutExt.toLowerCase().replace(/\s+/g, "-");
}
