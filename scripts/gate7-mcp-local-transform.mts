#!/usr/bin/env -S npx tsx
/**
 * Gate 7 companion: runs the REAL `normalizeR1BodyForExternal` (artifacts/smartsite-mcp/src/
 * tool-honesty.ts -- the exact function `tools.ts`'s get_smart_site / run_report call on a
 * cortex `/research/brief` body, via `normalizeR1ResponseText`) against a card-shaped JSON
 * file, and prints the result.
 *
 * WHY A SEPARATE FILE. `check-surface-agreement.mjs` is a plain, dependency-free `.mjs` so it
 * runs under plain `node` with no build step (matching this repo's own
 * `check-cross-repo-literal-drift.mjs` convention). `tool-honesty.ts` is TypeScript inside
 * the `@workspace/smartsite-mcp` package and pulls in `@empressaio/atom-contract/display` --
 * importing it from a bare `.mjs` would need either a build step or a bundler. This file is
 * the "local build" the gate-7 assignment explicitly allows ("calls the same functions the
 * routes call, on a local build"): it is run via `tsx` (already a devDependency of
 * `@workspace/smartsite-mcp`) so it imports the REAL, UNMODIFIED source file, not a
 * reimplementation.
 *
 * Usage: npx tsx scripts/gate7-mcp-local-transform.mts <card.json> [--can-see-owner]
 * Prints the normalized JSON to stdout. Exits 2 and prints {error} to stderr on failure.
 */
import { readFileSync } from "node:fs";
import { normalizeR1BodyForExternal } from "../artifacts/smartsite-mcp/src/tool-honesty.js";

function main() {
  const [inputPath, ...rest] = process.argv.slice(2);
  if (!inputPath) {
    console.error(JSON.stringify({ error: "usage: gate7-mcp-local-transform.mts <card.json> [--can-see-owner]" }));
    process.exit(2);
  }
  const canSeeOwner = rest.includes("--can-see-owner");
  const body = JSON.parse(readFileSync(inputPath, "utf8"));
  const normalized = normalizeR1BodyForExternal(body, canSeeOwner);
  process.stdout.write(JSON.stringify(normalized));
}

main();
