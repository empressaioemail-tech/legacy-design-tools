#!/usr/bin/env -S npx tsx
/**
 * Companion to `check-source-shape.mjs` (P-499, OPS-16 A-382/A-383).
 *
 * WHY A SEPARATE FILE. `check-source-shape.mjs` is a plain, dependency-free
 * `.mjs` so it runs under plain `node` with no build step (matching this
 * repo's `check-cross-repo-literal-drift.mjs` / `check-no-hauska-atom-
 * contract.mjs` convention). `lib/source-registry` is a TypeScript
 * workspace package; importing it from a bare `.mjs` would need a build
 * step. This file is run via `tsx` (same pattern as
 * `scripts/gate7-mcp-local-transform.mts`) so it imports the REAL,
 * unmodified registry source, not a re-implementation of its validation
 * rules.
 *
 * Usage: npx tsx scripts/check-source-shape-validate-registry.mts [entries.json]
 * With no argument, validates the committed `SOURCE_REGISTRY`. With an
 * argument, validates the JSON array at that path instead -- used by
 * `check-source-shape.mjs --selftest` to feed a deliberately malformed
 * fixture through the REAL validator without touching the committed
 * registry.
 * Prints `{ valid, issues }` JSON to stdout. Exits 2 and prints
 * `{ error }` to stderr on a usage/parse failure (not a validation
 * failure -- `valid: false` is a normal, successful result).
 */
import { readFileSync } from "node:fs";
import { SOURCE_REGISTRY, validateRegistry } from "../lib/source-registry/src/index.js";

function main() {
  const [entriesPath] = process.argv.slice(2);
  let entries: readonly unknown[] = SOURCE_REGISTRY;
  if (entriesPath) {
    try {
      const raw = JSON.parse(readFileSync(entriesPath, "utf8"));
      if (!Array.isArray(raw)) {
        throw new Error("fixture JSON must be an array of entries");
      }
      entries = raw;
    } catch (err) {
      console.error(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      process.exit(2);
    }
  }
  const result = validateRegistry(entries);
  process.stdout.write(JSON.stringify(result));
}

main();
