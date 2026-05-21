/**
 * Shared types for the IFC parse pipeline.
 *
 * These live in their own module so the public surface ({@link index}),
 * the parse core that runs inside the worker ({@link parseCore}), and the
 * worker client that dispatches to it ({@link workerClient}) can all share
 * the contract without a runtime import cycle.
 */

export interface ParseIfcOptions {
  /** Raw IFC bytes. Caller has already enforced any size cap. */
  bytes: Buffer;
}

export interface ParsedEntity {
  ifcGlobalId: string;
  ifcType: string;
  label: string | null;
  propertySet: Record<string, unknown> | null;
}

export interface ParseIfcResult {
  ifcVersion: string;
  entityCount: number;
  entities: ParsedEntity[];
  glbBytes: Buffer;
}

/**
 * Message the parse worker posts back to the main thread. Exactly one of
 * these is sent per worker, after which the worker drains and exits.
 *
 * `result.glbBytes` survives the `worker_threads` structured-clone hop as
 * a plain `Uint8Array` (Node does not preserve the `Buffer` subclass); the
 * worker client re-wraps it as a `Buffer` before handing it back.
 */
export type ParseWorkerMessage =
  | { ok: true; result: ParseIfcResult }
  | { ok: false; error: string };
