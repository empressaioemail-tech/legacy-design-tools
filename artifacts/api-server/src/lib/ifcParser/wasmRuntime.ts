/**
 * web-ifc WASM runtime: singleton init for the IfcAPI.
 *
 * web-ifc ships three wasm artifacts (browser, multithreaded browser, Node).
 * The Node entry — `web-ifc/web-ifc-api-node.js` — is CJS, and the package's
 * `exports` map only resolves it under the `require` condition. Under pure
 * ESM `import`, Node resolves the browser entry, which expects fetch/URL for
 * WASM and breaks. We therefore use `createRequire` to force the Node entry
 * regardless of how this module is loaded (esbuild bundle, tsx, vitest).
 *
 * Singleton: the WASM module is heavy to instantiate (~sub-second) and the
 * IfcAPI holds native heap; we cache it for the lifetime of the thread.
 * IfcAPI is NOT reentrant — concurrent OpenModel calls on the same instance
 * race on shared state. Since QA-16 this module is loaded ONLY inside the
 * one-shot IFC parse worker ({@link ./ifcParseWorker}): the singleton is
 * therefore per-worker, instantiated once, and discarded with the thread,
 * so a WASM trap that corrupts it can never be carried into the next parse.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { IfcAPI } from "web-ifc";

const localRequire = createRequire(import.meta.url);

let cached: Promise<IfcAPI> | null = null;

export function getIfcApi(): Promise<IfcAPI> {
  if (cached) return cached;
  cached = (async () => {
    // The Node entry's IfcAPI ctor + Init() pattern. SetWasmPath defends
    // against bundlers/odd cwd by handing the loader an explicit absolute
    // dir; otherwise Init() builds a relative URL off __dirname which can
    // resolve to dist/ where the wasm doesn't exist (issue #268).
    const WebIFC: typeof import("web-ifc") = localRequire("web-ifc");
    const api = new WebIFC.IfcAPI();
    // web-ifc 0.0.71's `exports` map exposes ONLY the `.` entry — every
    // explicit subpath (`web-ifc/package.json`, and — the bug this line
    // fixes — `web-ifc/web-ifc-api-node.js`) throws
    // ERR_PACKAGE_PATH_NOT_EXPORTED. Resolve the `.` entry instead: under
    // the `require` condition it maps to the CJS Node entry file, and
    // web-ifc ships its `.wasm` artifacts in that same directory, so
    // `dirname` of the resolved entry is the wasm dir SetWasmPath needs.
    // `localRequire("web-ifc")` just above proves the `.` entry resolves.
    // See https://github.com/IFCjs/web-ifc/issues/268.
    const entryPath = localRequire.resolve("web-ifc");
    const wasmDir = path.dirname(entryPath);
    api.SetWasmPath(wasmDir + path.sep, /*absolute=*/ true);
    await api.Init();
    return api;
  })();
  return cached;
}

/**
 * Test-only: drop the singleton so the next getIfcApi() re-inits. Tests use
 * this between fixtures that need a clean WASM heap. Production code must
 * NOT call this — the cache is the whole point.
 */
export function __resetIfcApiForTests(): void {
  cached = null;
}

/**
 * Map a numeric IFC entity-type ID to its canonical type name. We only
 * surface the names the ingest tracks; everything else falls through to a
 * generic IfcBuildingElementProxy bucket. This is a closed map rather than
 * a reverse-lookup over the WebIFC namespace because the module exports
 * thousands of constants and we want a small, intentional surface.
 */
export const TRACKED_IFC_TYPE_NAMES: Record<number, string> = (() => {
  const WebIFC: typeof import("web-ifc") = localRequire("web-ifc");
  return {
    [WebIFC.IFCWALL]: "IfcWall",
    [WebIFC.IFCWALLSTANDARDCASE]: "IfcWallStandardCase",
    [WebIFC.IFCSLAB]: "IfcSlab",
    [WebIFC.IFCDOOR]: "IfcDoor",
    [WebIFC.IFCWINDOW]: "IfcWindow",
    [WebIFC.IFCSPACE]: "IfcSpace",
    [WebIFC.IFCCOLUMN]: "IfcColumn",
    [WebIFC.IFCBEAM]: "IfcBeam",
    [WebIFC.IFCROOF]: "IfcRoof",
    [WebIFC.IFCBUILDINGELEMENTPROXY]: "IfcBuildingElementProxy",
  };
})();

/**
 * Numeric type IDs the ingest iterates. Order is stable for deterministic
 * test expectations.
 */
export const TRACKED_IFC_TYPE_IDS: number[] = Object.keys(
  TRACKED_IFC_TYPE_NAMES,
).map(Number);

/**
 * Best-effort source-file path for diagnostics (matches the spawn target
 * we'd use if we promoted to worker_threads). Not used at runtime by the
 * inline parser; kept for telemetry.
 */
export function thisModulePath(): string {
  return fileURLToPath(import.meta.url);
}
