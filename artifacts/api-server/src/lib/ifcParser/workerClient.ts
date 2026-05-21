/**
 * Worker client — dispatches an IFC parse to a one-shot `worker_threads`
 * worker and owns the thread lifecycle (QA-16).
 *
 * Why one worker per parse rather than a pool: a web-ifc WASM trap leaves
 * the `IfcAPI` singleton corrupt with no reset path, so a reused worker
 * would carry that corruption into the next parse. A fresh thread per
 * parse is the only way to guarantee "each parse gets a fresh WASM
 * context" — and IFC ingest is a rare, operator-initiated path, so the
 * sub-second worker spin-up cost is irrelevant.
 *
 * Concurrency: parses are serialized one-at-a-time. The inline parser was
 * already effectively serial (the `IfcAPI` singleton is non-reentrant);
 * keeping that here also bounds memory to a single web-ifc WASM heap,
 * which matters because one heap alone already pushed past the old 2 GiB
 * container limit (QA-04 / PR #58).
 *
 * Failure isolation: a hang is killed by {@link IFC_PARSE_TIMEOUT_MS}
 * via `worker.terminate()`; an OOM or native crash surfaces as a non-zero
 * worker `exit`. Either way the api-server event loop is untouched.
 */

import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ParseIfcResult, ParseWorkerMessage } from "./types";

/**
 * Hard cap on a single parse. On expiry the worker is terminated and the
 * parse rejects, so the route returns its clean error JSON well before
 * the Cloud Run request timeout (default 300 s) kills the request with
 * an opaque 5xx. Override with the `IFC_PARSE_TIMEOUT_MS` env var.
 */
export const IFC_PARSE_TIMEOUT_MS = (() => {
  const raw = process.env["IFC_PARSE_TIMEOUT_MS"];
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 240_000;
})();

/**
 * Minimal slice of the `worker_threads` `Worker` surface this client
 * needs. A real `Worker` satisfies it structurally; tests substitute a
 * fake so the dispatch logic (timeout, error mapping, serialization) can
 * be exercised without loading web-ifc's WASM.
 */
export interface ParseWorkerHandle {
  on(event: "message", cb: (msg: ParseWorkerMessage) => void): unknown;
  on(event: "error", cb: (err: unknown) => void): unknown;
  on(event: "exit", cb: (code: number) => void): unknown;
  terminate(): Promise<number> | void;
}

export type ParseWorkerFactory = (args: {
  bytes: Uint8Array;
}) => ParseWorkerHandle;

/**
 * Resolve the bundled worker entry. In production the api-server runs as
 * a single esbuild bundle (`dist/index.mjs`), so this module's
 * `import.meta.url` points at `dist/index.mjs` and the worker is the
 * separately-bundled `dist/lib/ifcParser/ifcParseWorker.mjs`.
 */
function resolveWorkerEntry(): string {
  const candidates = [
    new URL("./lib/ifcParser/ifcParseWorker.mjs", import.meta.url),
    new URL("./ifcParseWorker.mjs", import.meta.url),
  ].map((url) => fileURLToPath(url));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `ifc parse worker entry not found (looked in: ${candidates.join(", ")})`,
  );
}

const defaultWorkerFactory: ParseWorkerFactory = ({ bytes }) =>
  new Worker(resolveWorkerEntry(), { workerData: { bytes } });

let workerFactory: ParseWorkerFactory = defaultWorkerFactory;

/**
 * Test seam — substitute the worker factory so the dispatch logic can be
 * tested without a real thread / web-ifc. Pass `null` to restore the
 * production factory. Production code must never call this.
 */
export function __setParseWorkerFactoryForTests(
  factory: ParseWorkerFactory | null,
): void {
  workerFactory = factory ?? defaultWorkerFactory;
}

/**
 * Serialize parses through a single promise chain so at most one worker
 * (and therefore one web-ifc WASM heap) is alive at a time. Each link
 * runs regardless of whether the previous parse resolved or rejected.
 */
let parseChain: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = parseChain.then(task, task);
  // Swallow rejections on the chain itself so one failed parse cannot
  // reject every parse queued behind it.
  parseChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function dispatchToWorker(
  bytes: Uint8Array,
  timeoutMs: number,
): Promise<ParseIfcResult> {
  return new Promise<ParseIfcResult>((resolve, reject) => {
    let settled = false;
    let worker: ParseWorkerHandle;
    try {
      worker = workerFactory({ bytes });
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
      reject(new Error(`ifc parse timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Don't let the timeout alone hold the event loop open.
    (timer as { unref?: () => void }).unref?.();

    const settleOk = (result: ParseIfcResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killWorker();
      resolve(result);
    };
    const settleErr = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killWorker();
      reject(err);
    };

    worker.on("message", (msg: ParseWorkerMessage) => {
      if (msg && msg.ok) {
        // `glbBytes` crosses the thread boundary as a plain Uint8Array
        // (structured clone drops the Buffer subclass); re-wrap it as a
        // Buffer so downstream storage code keeps its expected type.
        const raw = msg.result.glbBytes as unknown as Uint8Array;
        resolveGlb(msg.result, raw);
        settleOk(msg.result);
      } else {
        settleErr(new Error(msg?.error ?? "ifc parse failed in worker"));
      }
    });

    worker.on("error", (err: unknown) => {
      settleErr(err instanceof Error ? err : new Error(String(err)));
    });

    worker.on("exit", (code: number) => {
      if (settled) return;
      // The worker exited without posting a result — a native crash or
      // an OOM-kill. Surface it as a parse failure; the api-server
      // instance itself is untouched.
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `ifc parse worker exited (code ${code}) before returning a result — likely out of memory`,
        ),
      );
    });
  });
}

function resolveGlb(result: ParseIfcResult, raw: Uint8Array): void {
  result.glbBytes = Buffer.from(
    raw.buffer,
    raw.byteOffset,
    raw.byteLength,
  );
}

/**
 * Parse raw IFC bytes in a one-shot worker thread. Serialized against
 * every other in-flight parse and bounded by {@link IFC_PARSE_TIMEOUT_MS}.
 * Rejects on a malformed IFC, a timeout, or a worker crash — the caller
 * (`ingestSnapshotIfc`) maps any rejection to the route's parse-failure
 * response.
 */
export function parseViaWorker(opts: {
  bytes: Uint8Array;
  timeoutMs?: number;
}): Promise<ParseIfcResult> {
  const timeoutMs = opts.timeoutMs ?? IFC_PARSE_TIMEOUT_MS;
  return serialize(() => dispatchToWorker(opts.bytes, timeoutMs));
}
