#!/usr/bin/env node
/**
 * P-499 serving-read ratchet (OPS-16 A-382/A-383; design
 * `_design/2026-10-09_P-499_source_shape_and_address_from_record.md`
 * section 5). Modelled on `scripts/check-no-hauska-atom-contract.mjs`
 * (self-test, exit codes, `pr-checks.yml` wiring).
 *
 * This card (A1) scopes the ratchet to LDT only -- the design's full
 * scope (section 5) also names hauska-engine's retrieval-api and
 * hauska-map, which are different repos this card does not touch.
 *
 * TOKENS. Every source-table name reachable from `lib/source-registry`'s
 * `SOURCE_REGISTRY` plus the legacy list (`txgio_*`, `tx_*`,
 * `cad_property*`, `permit_record`, `source_feature*`), discovered by
 * scanning `lib/db/src/schema/*.ts` for `pgTable(...)` declarations whose
 * SQL table name matches one of those prefixes -- auto-discovered rather
 * than hand-maintained, so the token list tracks the schema as it grows.
 * Each table contributes TWO tokens: its raw SQL name (e.g.
 * `txgio_parcel`) and its exported `@workspace/db` symbol name (e.g.
 * `txgioParcel`).
 *
 * SCOPE. `artifacts/api-server/src/routes/**` plus every module under
 * `artifacts/api-server/src/**` reachable by import from those routes
 * (an import-graph walk: relative imports are followed; bare/workspace
 * imports are not followed into node_modules but still count as a token
 * occurrence if the token text appears in the importing file), plus the
 * whole of `artifacts/smartsite-mcp/src/**` (included wholesale, not by
 * reachability -- smartsite-mcp has no equivalent "routes" entry point).
 * `*Cli.ts`, anything under a `scripts/` or `__tests__/` directory, and
 * `*.test.ts` are excluded BY PATH wherever they are found, including
 * when they would otherwise be import-reachable -- these are the
 * design's declared batch paths, allowed to read a source table directly.
 *
 * RATCHET. A checked-in allow-list
 * (`scripts/serving-source-reads.allow.json`) of today's (file, token)
 * readers, each tagged with an owning OPS-16 row. The gate fails on any
 * (file, token) hit that is NOT on the allow-list (a new, unreviewed
 * reader), and on any allow-list entry that NO LONGER occurs in the live
 * scan (a stale entry -- the list may only shrink, in step with an
 * actual removal, never silently).
 *
 * exit 0   clean
 * exit 1   violation (including a self-test that failed to detect its
 *          planted violation)
 * exit 2   did-not-run
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GATE_ID = "check-serving-source-reads";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const SCHEMA_DIR = path.join(REPO_ROOT, "lib", "db", "src", "schema");
const ALLOW_LIST_PATH = path.join(HERE, "serving-source-reads.allow.json");

const EXIT_CLEAN = 0;
const EXIT_VIOLATION = 1;
const EXIT_DID_NOT_RUN = 2;

function didNotRun(message) {
  console.error(`GATE-DID-NOT-RUN ${GATE_ID}: ${message}`);
  process.exit(EXIT_DID_NOT_RUN);
}

// -------------------------------------------------------------------------
// Token discovery: every `pgTable(...)` in lib/db/src/schema whose SQL name
// matches the legacy/source_feature prefixes, as (sqlName, symbolName) pairs.
// -------------------------------------------------------------------------

const SOURCE_TABLE_PREFIX_RE = /^(tx_|txgio_|cad_property|permit_record|source_feature)/;

/** `export const X = pgTable("name", ...)` or `export const X = pgTable(IDENT, ...)` where IDENT resolves to a `const IDENT = "name"` in the same file. */
function discoverSchemaTables(schemaDir) {
  if (!fs.existsSync(schemaDir)) {
    didNotRun(`schema directory not found: ${schemaDir}`);
  }
  const files = fs.readdirSync(schemaDir).filter((f) => f.endsWith(".ts") && f !== "index.ts");
  const tables = [];
  const pgTableRe = /export\s+const\s+(\w+)\s*=\s*pgTable\(\s*(?:"([^"]+)"|'([^']+)'|(\w+))/g;
  for (const file of files) {
    const content = fs.readFileSync(path.join(schemaDir, file), "utf8");
    pgTableRe.lastIndex = 0;
    let m;
    while ((m = pgTableRe.exec(content))) {
      const symbolName = m[1];
      let sqlName = m[2] ?? m[3];
      if (!sqlName && m[4]) {
        // Table name given via a named constant in the same file, e.g.
        // `export const TX_UTILITY_TERRITORY_STAGING_TABLE = "tx_utility_territory_staging" as const;`
        const constRe = new RegExp(
          `(?:const|let)\\s+${m[4]}\\s*(?::[^=]+)?=\\s*["']([^"']+)["']`,
        );
        const constMatch = constRe.exec(content);
        sqlName = constMatch?.[1];
      }
      if (sqlName) {
        tables.push({ file, symbolName, sqlName });
      }
    }
  }
  return tables;
}

function buildTokens(tables) {
  const tokens = new Set();
  for (const t of tables) {
    if (SOURCE_TABLE_PREFIX_RE.test(t.sqlName)) {
      tokens.add(t.sqlName);
      tokens.add(t.symbolName);
    }
  }
  return [...tokens];
}

// -------------------------------------------------------------------------
// Scope: routes + import-reachable api-server modules, plus smartsite-mcp
// wholesale. Both minus the declared batch-path exclusions.
// -------------------------------------------------------------------------

function isExcludedPath(relPosixPath) {
  if (relPosixPath.endsWith("Cli.ts")) return true;
  if (relPosixPath.endsWith(".test.ts")) return true;
  if (/(^|\/)scripts\//.test(relPosixPath)) return true;
  if (/(^|\/)__tests__\//.test(relPosixPath)) return true;
  return false;
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function relFromRoot(repoRoot, absPath) {
  return toPosix(path.relative(repoRoot, absPath));
}

function listTsFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

const IMPORT_SPEC_RE = /\bfrom\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function extractImportSpecifiers(content) {
  const specs = new Set();
  IMPORT_SPEC_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_SPEC_RE.exec(content))) specs.add(m[1]);
  DYNAMIC_IMPORT_RE.lastIndex = 0;
  while ((m = DYNAMIC_IMPORT_RE.exec(content))) specs.add(m[1]);
  return [...specs];
}

function resolveRelativeImport(fromDir, spec) {
  let base = spec;
  if (base.endsWith(".js")) base = base.slice(0, -3) + ".ts";
  else if (base.endsWith(".jsx")) base = base.slice(0, -4) + ".tsx";
  const resolved = path.resolve(fromDir, base);
  const candidates = [
    resolved,
    `${resolved}.ts`,
    `${resolved}.tsx`,
    path.join(resolved, "index.ts"),
    path.join(resolved, "index.tsx"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/**
 * BFS from `artifacts/api-server/src/routes/**` through relative imports,
 * staying within `artifacts/api-server/src/**` and never crossing an
 * excluded path (it is neither added to scope nor traversed further).
 */
function buildApiServerScope(repoRoot) {
  const apiServerSrc = path.join(repoRoot, "artifacts", "api-server", "src");
  const routesDir = path.join(apiServerSrc, "routes");
  const rootFiles = listTsFilesRecursive(routesDir).filter(
    (f) => !isExcludedPath(relFromRoot(repoRoot, f)),
  );

  const scope = new Set(rootFiles);
  const visited = new Set();
  const queue = [...rootFiles];

  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const content = fs.readFileSync(file, "utf8");
    for (const spec of extractImportSpecifiers(content)) {
      if (!spec.startsWith(".")) continue; // bare/workspace specifiers are not traversed
      const resolved = resolveRelativeImport(path.dirname(file), spec);
      if (!resolved) continue;
      if (!resolved.startsWith(apiServerSrc + path.sep) && resolved !== apiServerSrc) continue;
      const rel = relFromRoot(repoRoot, resolved);
      if (isExcludedPath(rel)) continue;
      if (!scope.has(resolved)) {
        scope.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return scope;
}

function buildSmartsiteMcpScope(repoRoot) {
  const dir = path.join(repoRoot, "artifacts", "smartsite-mcp", "src");
  return listTsFilesRecursive(dir).filter((f) => !isExcludedPath(relFromRoot(repoRoot, f)));
}

// -------------------------------------------------------------------------
// Token scan over the built scope.
// -------------------------------------------------------------------------

function wordBoundaryRegex(token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`);
}

/** Returns a sorted array of `{ file, token }` (file relative-posix to repoRoot) for every token hit in the given file set. */
function scanForTokenHits(repoRoot, files, tokens) {
  const tokenRes = tokens.map((t) => ({ token: t, re: wordBoundaryRegex(t) }));
  const hits = [];
  for (const absFile of files) {
    const content = fs.readFileSync(absFile, "utf8");
    const rel = relFromRoot(repoRoot, absFile);
    for (const { token, re } of tokenRes) {
      if (re.test(content)) {
        hits.push({ file: rel, token });
      }
    }
  }
  hits.sort((a, b) => (a.file === b.file ? a.token.localeCompare(b.token) : a.file.localeCompare(b.file)));
  return hits;
}

function runScan(repoRoot, schemaDir) {
  const tables = discoverSchemaTables(schemaDir);
  const tokens = buildTokens(tables);
  if (tokens.length === 0) {
    didNotRun(`no source-table tokens discovered under ${schemaDir} -- gate is starved`);
  }
  const apiServerScope = buildApiServerScope(repoRoot);
  const mcpScope = buildSmartsiteMcpScope(repoRoot);
  const allFiles = new Set([...apiServerScope, ...mcpScope]);
  const hits = scanForTokenHits(repoRoot, allFiles, tokens);
  return { tokens, hits };
}

// -------------------------------------------------------------------------
// Allow-list comparison.
// -------------------------------------------------------------------------

function loadAllowList(allowListPath) {
  if (!fs.existsSync(allowListPath)) {
    didNotRun(`allow-list not found: ${allowListPath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(allowListPath, "utf8"));
  } catch (err) {
    didNotRun(`allow-list is not valid JSON (${err instanceof Error ? err.message : err}): ${allowListPath}`);
  }
  if (!Array.isArray(parsed)) {
    didNotRun(`allow-list must be a JSON array: ${allowListPath}`);
  }
  for (const entry of parsed) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.file !== "string" ||
      typeof entry.token !== "string" ||
      typeof entry.row !== "string"
    ) {
      didNotRun(`allow-list entry malformed (needs file, token, row strings): ${JSON.stringify(entry)}`);
    }
  }
  return parsed;
}

function pairKey(file, token) {
  return `${file}\u0000${token}`;
}

/** Compares live hits against the allow-list. Returns `{ unauthorized, stale }`. */
function diffAgainstAllowList(hits, allowList) {
  const liveSet = new Set(hits.map((h) => pairKey(h.file, h.token)));
  const allowSet = new Set(allowList.map((a) => pairKey(a.file, a.token)));

  const unauthorized = hits.filter((h) => !allowSet.has(pairKey(h.file, h.token)));
  const stale = allowList.filter((a) => !liveSet.has(pairKey(a.file, a.token)));
  return { unauthorized, stale };
}

// -------------------------------------------------------------------------
// Self-test: a temp repo-shaped tree, never the real repo or allow-list.
// -------------------------------------------------------------------------

function writeFixtureRepo(root, { routeContent, libContent, cliContent }) {
  const routesDir = path.join(root, "artifacts", "api-server", "src", "routes");
  const libDir = path.join(root, "artifacts", "api-server", "src", "lib");
  const schemaDir = path.join(root, "lib", "db", "src", "schema");
  fs.mkdirSync(routesDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });
  fs.mkdirSync(schemaDir, { recursive: true });
  fs.mkdirSync(path.join(root, "artifacts", "smartsite-mcp", "src"), { recursive: true });

  fs.writeFileSync(
    path.join(schemaDir, "index.ts"),
    `export * from "./txgioAddress";\n`,
  );
  fs.writeFileSync(
    path.join(schemaDir, "txgioAddress.ts"),
    `import { pgTable, text } from "drizzle-orm/pg-core";\n` +
      `export const txgioAddress = pgTable("txgio_address", { id: text("id") });\n`,
  );

  fs.writeFileSync(path.join(routesDir, "fixtureRoute.ts"), routeContent);
  if (libContent) {
    fs.writeFileSync(path.join(libDir, "fixtureLib.ts"), libContent);
  }
  if (cliContent) {
    fs.writeFileSync(path.join(libDir, "fixtureCli.ts"), cliContent);
  }
}

function runFixtureScan(root) {
  return runScan(root, path.join(root, "lib", "db", "src", "schema"));
}

function runSelfTest() {
  // --- (1) a planted raw-SQL token in a route-reachable lib -> must be a hit ---
  let tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serving-reads-"));
  try {
    writeFixtureRepo(tmp, {
      routeContent: `import { readIt } from "../lib/fixtureLib";\nexport const route = readIt;\n`,
      libContent: `export function readIt() { return "SELECT 1 FROM txgio_address"; }\n`,
    });
    const { hits } = runFixtureScan(tmp);
    const found = hits.some(
      (h) => h.file === "artifacts/api-server/src/lib/fixtureLib.ts" && h.token === "txgio_address",
    );
    if (!found) {
      console.error(
        `FAIL ${GATE_ID}: self-test — a raw "FROM txgio_address" in a route-reachable lib was not detected; gate is starved`,
      );
      process.exit(EXIT_VIOLATION);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // --- (2) the SAME token planted in a *Cli.ts -> must NOT be a hit (excluded by path, even though importable) ---
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serving-reads-"));
  try {
    writeFixtureRepo(tmp, {
      routeContent: `import { readIt } from "../lib/fixtureCli";\nexport const route = readIt;\n`,
      cliContent: `export function readIt() { return "SELECT 1 FROM txgio_address"; }\n`,
    });
    const { hits } = runFixtureScan(tmp);
    const found = hits.some((h) => h.file === "artifacts/api-server/src/lib/fixtureCli.ts");
    if (found) {
      console.error(
        `FAIL ${GATE_ID}: self-test — a "*Cli.ts" file was scanned/flagged; it must be excluded by path`,
      );
      process.exit(EXIT_VIOLATION);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // --- (3) an allow-list entry that no longer occurs -> stale, must fail ---
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serving-reads-"));
  try {
    writeFixtureRepo(tmp, {
      routeContent: `export const route = () => "nothing to see here";\n`,
    });
    const { hits } = runFixtureScan(tmp);
    const staleAllowList = [
      { file: "artifacts/api-server/src/routes/fixtureRoute.ts", token: "txgio_address", row: "P-FIXTURE" },
    ];
    const { unauthorized, stale } = diffAgainstAllowList(hits, staleAllowList);
    if (stale.length === 0) {
      console.error(
        `FAIL ${GATE_ID}: self-test — a stale allow-list entry (no longer read) was not detected; gate is starved`,
      );
      process.exit(EXIT_VIOLATION);
    }
    if (unauthorized.length !== 0) {
      console.error(
        `FAIL ${GATE_ID}: self-test — unexpected unauthorized hit(s) in the stale-entry fixture: ${JSON.stringify(unauthorized)}`,
      );
      process.exit(EXIT_VIOLATION);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // --- (4) a clean fixture (token present, allow-listed, nothing stale) -> no violation ---
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serving-reads-"));
  try {
    writeFixtureRepo(tmp, {
      routeContent: `import { readIt } from "../lib/fixtureLib";\nexport const route = readIt;\n`,
      libContent: `export function readIt() { return "SELECT 1 FROM txgio_address"; }\n`,
    });
    const { hits } = runFixtureScan(tmp);
    const cleanAllowList = [
      { file: "artifacts/api-server/src/lib/fixtureLib.ts", token: "txgio_address", row: "P-FIXTURE" },
    ];
    const { unauthorized, stale } = diffAgainstAllowList(hits, cleanAllowList);
    if (unauthorized.length !== 0 || stale.length !== 0) {
      console.error(
        `FAIL ${GATE_ID}: self-test — a clean fixture was flagged: unauthorized=${JSON.stringify(unauthorized)} stale=${JSON.stringify(stale)}`,
      );
      process.exit(EXIT_VIOLATION);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`${GATE_ID}: self-test passed`);
}

// -------------------------------------------------------------------------

function main() {
  const selfTestOnly = process.argv.includes("--selftest");
  const printReaders = process.argv.includes("--print-readers");

  runSelfTest();
  if (selfTestOnly) {
    process.exit(EXIT_CLEAN);
  }

  const { tokens, hits } = runScan(REPO_ROOT, SCHEMA_DIR);
  const allowList = loadAllowList(ALLOW_LIST_PATH);
  const { unauthorized, stale } = diffAgainstAllowList(hits, allowList);

  if (printReaders) {
    console.log(`${GATE_ID}: ${tokens.length} token(s), ${hits.length} reader hit(s):`);
    const byFile = new Map();
    for (const h of hits) {
      if (!byFile.has(h.file)) byFile.set(h.file, []);
      byFile.get(h.file).push(h.token);
    }
    for (const [file, fileTokens] of [...byFile.entries()].sort()) {
      console.log(`  ${file} -> ${fileTokens.join(", ")}`);
    }
  }

  let failed = false;
  if (unauthorized.length > 0) {
    failed = true;
    console.error(`FAIL ${GATE_ID}: unauthorized source-table reader(s) (not on the allow-list):`);
    for (const h of unauthorized) {
      console.error(`  - ${h.file} reads token "${h.token}"`);
    }
  }
  if (stale.length > 0) {
    failed = true;
    console.error(`FAIL ${GATE_ID}: stale allow-list entry/entries (listed reader no longer reads):`);
    for (const s of stale) {
      console.error(`  - ${s.file} token "${s.token}" (row ${s.row})`);
    }
  }

  if (failed) {
    process.exit(EXIT_VIOLATION);
  }
  console.log(
    `${GATE_ID}: clean (${hits.length} reader(s), all allow-listed; allow-list has no stale entries)`,
  );
  process.exit(EXIT_CLEAN);
}

main();
