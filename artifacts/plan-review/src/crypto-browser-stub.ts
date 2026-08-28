// Browser stub for node:crypto — pulled in transitively via
// portal-ui → engine-core → @empressaio/atom-contract/identity/node-id.
// Crypto helpers are never called client-side; this stub exists only to
// prevent the module from crashing on import in the browser bundle.
export function createHash(_algorithm: string): never {
  throw new Error("createHash is server-only — should not be called in browser");
}

export function randomBytes(_size: number): never {
  throw new Error("randomBytes is server-only — should not be called in browser");
}
