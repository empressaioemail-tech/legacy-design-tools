/**
 * `worker_threads` entry for the IFC parse (QA-16).
 *
 * The api-server main thread spawns ONE of these per IFC upload and tears
 * it down afterward (see {@link workerClient}). Running the parse here
 * instead of inline is the fix for the production incident on 2026-05-21:
 *
 *   - A web-ifc WASM trap on malformed input no longer corrupts a
 *     process-global `IfcAPI` singleton — the next parse is a fresh
 *     thread with a fresh WASM heap.
 *   - A parse that hangs no longer blocks the api-server event loop; the
 *     parent's timeout calls `worker.terminate()` and the instance keeps
 *     answering every other request, healthz included.
 *   - An OOM kills only this thread; the parent sees a non-zero `exit`.
 *
 * Contract: input bytes arrive via `workerData.bytes` (a `Uint8Array`).
 * The worker posts exactly one {@link ParseWorkerMessage} back, then
 * drains its event loop and exits 0. A native crash or OOM exits non-zero
 * with no message; the parent maps that to a parse failure.
 */

import { parentPort, workerData } from "node:worker_threads";
import { runParse } from "./parseCore";
import type { ParseWorkerMessage } from "./types";

async function main(): Promise<void> {
  if (!parentPort) {
    // Not launched as a worker — nothing to post results to. Throwing
    // here surfaces the misuse loudly rather than hanging silently.
    throw new Error("ifcParseWorker must be run as a worker_threads worker");
  }
  const port = parentPort;

  const bytes = (workerData as { bytes?: Uint8Array } | undefined)?.bytes;
  if (!bytes || bytes.byteLength === 0) {
    const msg: ParseWorkerMessage = {
      ok: false,
      error: "ifc parse worker received no IFC bytes",
    };
    port.postMessage(msg);
    return;
  }

  try {
    const result = await runParse(bytes);
    const msg: ParseWorkerMessage = { ok: true, result };
    port.postMessage(msg);
  } catch (err) {
    const msg: ParseWorkerMessage = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    port.postMessage(msg);
  }
}

void main();
