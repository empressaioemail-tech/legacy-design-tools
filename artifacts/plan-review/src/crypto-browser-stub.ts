// Browser stub for node:crypto — pulled in transitively via
// portal-ui → engine-core → @workspace/codes → contentHash.ts.
// createHash is never called client-side; this stub exists only to
// prevent the module from crashing on import in the browser bundle.
export function createHash(_algorithm: string): never {
  throw new Error("createHash is server-only — should not be called in browser");
}
