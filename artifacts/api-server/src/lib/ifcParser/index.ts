/**
 * IFC parse pipeline. Public surface: {@link parseIfc}.
 *
 * Phase 1 implementation runs the parse INLINE on the request thread.
 * This is bounded by the upload size cap (50 MB; see route handler);
 * peak heap is ~10x the file size during LoadAllGeometry. A 50 MB IFC
 * therefore fits well inside Replit's 1-2 GB process budget. If a parse
 * does OOM, the api-server process dies and Replit's autoscale restarts —
 * acceptable failure mode for a first delivery.
 *
 * Phase 2 upgrade path (NOT in this sprint): swap {@link runParseInline}
 * for a worker_threads variant. The route handler keeps its current
 * `await parseIfc(...)` shape; only the implementation below changes.
 * The worker entry would re-init the WASM singleton inside the worker
 * (the singleton in {@link wasmRuntime} is per-process) and post the
 * ParseResult back. Prerequisite: a second esbuild entryPoint that
 * bundles the worker file into dist/.
 */

import {
  getIfcApi,
  TRACKED_IFC_TYPE_IDS,
  TRACKED_IFC_TYPE_NAMES,
} from "./wasmRuntime";
import { modelToGlb } from "./gltfEmitter";

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

export async function parseIfc(opts: ParseIfcOptions): Promise<ParseIfcResult> {
  return runParseInline(opts);
}

async function runParseInline(opts: ParseIfcOptions): Promise<ParseIfcResult> {
  const api = await getIfcApi();
  const bytes = new Uint8Array(opts.bytes);
  const modelID = api.OpenModel(bytes);
  try {
    const ifcVersion = api.GetModelSchema(modelID) ?? "unknown";

    const entities: ParsedEntity[] = [];
    for (const typeId of TRACKED_IFC_TYPE_IDS) {
      const ids = api.GetLineIDsWithType(modelID, typeId);
      for (let i = 0; i < ids.size(); i++) {
        const expressID = ids.get(i);
        let line: Record<string, unknown> | null;
        try {
          line = api.GetLine(modelID, expressID, /*flatten=*/ true) as
            | Record<string, unknown>
            | null;
        } catch {
          line = null;
        }
        if (!line) continue;
        const guid = readStringField(line, "GlobalId");
        const name = readStringField(line, "Name");
        entities.push({
          ifcGlobalId: guid ?? `<no-guid:${typeId}:${expressID}>`,
          ifcType: TRACKED_IFC_TYPE_NAMES[typeId] ?? `IfcType_${typeId}`,
          label: name,
          propertySet: extractPsetCommon(line),
        });
      }
    }

    const glbBytes = await modelToGlb(api, modelID);

    return {
      ifcVersion,
      entityCount: entities.length,
      entities,
      glbBytes,
    };
  } finally {
    try {
      api.CloseModel(modelID);
    } catch {
      // The native heap release is best-effort; a failure here doesn't
      // change the parse outcome.
    }
  }
}

/**
 * IFC's ifcjs-flattened lines wrap scalar values as `{ type: number, value: T }`.
 * Reach in for a string field; return null if absent or non-string.
 */
function readStringField(
  line: Record<string, unknown>,
  field: string,
): string | null {
  const wrapped = line[field];
  if (!wrapped || typeof wrapped !== "object") return null;
  const value = (wrapped as { value?: unknown }).value;
  return typeof value === "string" ? value : null;
}

/**
 * Extract Pset_*Common property values from a flattened IFC line.
 *
 * Phase 1: a thin pass that captures the top-level scalar attributes off
 * the line itself (Name, Description, ObjectType, PredefinedType) — the
 * values most commonly surfaced by the viewer. Real Pset traversal walks
 * `IfcRelDefinesByProperties` relationships, which require a second
 * pass with `GetLineIDsWithType(IFCRELDEFINESBYPROPERTIES)`. Deferred
 * to Phase 2; the schema column (`property_set jsonb`) accepts richer
 * payloads when the parser learns them.
 */
function extractPsetCommon(
  line: Record<string, unknown>,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const field of ["Description", "ObjectType", "PredefinedType"]) {
    const v = readStringField(line, field);
    if (v) out[field] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}
