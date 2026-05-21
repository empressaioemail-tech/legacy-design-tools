/**
 * IFC parse core — the actual web-ifc + glTF work.
 *
 * This module is imported ONLY by the parse worker ({@link ifcParseWorker}),
 * never by the api-server main thread. It is the code that QA-16 moved off
 * the event loop: a hang, a WASM trap (`memory access out of bounds` on
 * malformed input), or an OOM here kills only the one-shot worker, leaving
 * the api-server instance answering every other request — healthz included.
 *
 * The {@link wasmRuntime} `IfcAPI` singleton is per-process; because each
 * worker is one-shot it is instantiated exactly once per parse and torn
 * down with the worker, so a trapped/corrupt singleton can never be reused.
 */

import {
  getIfcApi,
  TRACKED_IFC_TYPE_IDS,
  TRACKED_IFC_TYPE_NAMES,
} from "./wasmRuntime";
import { modelToGlb } from "./gltfEmitter";
import type { ParsedEntity, ParseIfcResult } from "./types";

/**
 * Parse raw IFC bytes into tracked entity rows + a consolidated GLB.
 * Runs inside the parse worker; the caller (the worker entry) owns the
 * thread lifecycle.
 */
export async function runParse(bytes: Uint8Array): Promise<ParseIfcResult> {
  const api = await getIfcApi();
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
      // change the parse outcome. (The worker is one-shot anyway — the
      // whole WASM heap is freed when the thread exits.)
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
 * A thin pass that captures the top-level scalar attributes off the line
 * itself (Description, ObjectType, PredefinedType) — the values most
 * commonly surfaced by the viewer. Real Pset traversal walks
 * `IfcRelDefinesByProperties` relationships, which require a second pass
 * with `GetLineIDsWithType(IFCRELDEFINESBYPROPERTIES)`; the schema column
 * (`property_set jsonb`) accepts richer payloads when the parser learns
 * them.
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
