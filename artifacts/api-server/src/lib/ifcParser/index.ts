/**
 * IFC parse pipeline. Public surface: {@link parseIfc}.
 *
 * The parse runs OFF the api-server main thread in a one-shot
 * `worker_threads` worker (QA-16). The route handler keeps its plain
 * `await parseIfc(...)` shape; the worker isolation lives entirely below
 * this surface:
 *
 *   - {@link parseCore}        — the web-ifc + glTF work (runs in-worker)
 *   - {@link ifcParseWorker}   — the `worker_threads` entry
 *   - {@link workerClient}     — spawns/terminates the worker, timeout,
 *                                serialization
 *
 * This replaced the earlier inline parser, where a hung or trapped parse
 * blocked the event loop and wedged the whole cortex-api instance
 * (observed in production 2026-05-21; see QA-04 / QA-16).
 */

import { parseViaWorker } from "./workerClient";
import type { ParseIfcOptions, ParseIfcResult } from "./types";

export type {
  ParseIfcOptions,
  ParsedEntity,
  ParseIfcResult,
} from "./types";

export async function parseIfc(opts: ParseIfcOptions): Promise<ParseIfcResult> {
  // `opts.bytes` is a Buffer; a Buffer IS a Uint8Array, so it crosses to
  // the worker (via structured clone of `workerData`) without conversion.
  return parseViaWorker({ bytes: opts.bytes });
}
