#!/usr/bin/env node
/**
 * P-499 source-shape gate (OPS-16 A-382/A-383; design
 * `_design/2026-10-09_P-499_source_shape_and_address_from_record.md`
 * section 5's "source-shape check"). Modelled on
 * `scripts/check-no-hauska-atom-contract.mjs` (self-test, exit codes,
 * `pr-checks.yml` wiring).
 *
 * Two independent checks, either of which can fail this gate:
 *
 *  (a) REGISTRY VALIDITY. `lib/source-registry`'s `SOURCE_REGISTRY` must
 *      pass its own `validateRegistry` -- in particular, no entry's
 *      `keyRule` may be positional, bigserial, or missing (see that
 *      package's doc comments for why those are the only two legitimate
 *      key-rule shapes). Run via `tsx` against the REAL registry source
 *      (`check-source-shape-validate-registry.mts`), not a
 *      re-implementation of its rules.
 *
 *  (b) NO NEW PER-STATE SOURCE TABLE. No migration in `lib/db/drizzle`
 *      numbered AFTER this card's own migration (`HIGH_WATER_MARK`) may
 *      `CREATE TABLE` something matching the `tx_*` / `txgio_*` pattern
 *      -- the per-state shape P-499 retires in favour of the one
 *      `source_feature` table. Migrations at or before the high-water
 *      mark are never scanned (the whole point of this gate is "no NEW
 *      one"; the ~20 that already exist are grandfathered, not refused
 *      retroactively).
 *
 * exit 0   clean
 * exit 1   violation (including a self-test that failed to detect its
 *          planted violation -- a starved gate must not read green)
 * exit 2   did-not-run (the gate's own tooling failed, not the thing it
 *          checks)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const GATE_ID = "check-source-shape";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const DRIZZLE_DIR = path.join(REPO_ROOT, "lib", "db", "drizzle");
const VALIDATE_REGISTRY_SCRIPT = path.join(HERE, "check-source-shape-validate-registry.mts");

/**
 * This card's own migration number (`0111_source_feature.sql`). Anything
 * numbered STRICTLY GREATER is in scope for the new-table scan. Bump this
 * only when a later card's own migration should itself stop being
 * scanned (i.e. never bump it to "hide" a real violation -- it tracks
 * where P-499's shape rule starts applying, not a moving goalpost).
 */
const HIGH_WATER_MARK = 111;

const EXIT_CLEAN = 0;
const EXIT_VIOLATION = 1;
const EXIT_DID_NOT_RUN = 2;

function didNotRun(message) {
  console.error(`GATE-DID-NOT-RUN ${GATE_ID}: ${message}`);
  process.exit(EXIT_DID_NOT_RUN);
}

/**
 * `tsx` is a devDependency of `@workspace/scripts` (this package), not of
 * the repo root, so it is resolved from THIS directory's own
 * `node_modules/.bin`, not via a bare `npx`/`pnpm exec` that resolves
 * against the invoking shell's cwd (which can be the repo root, where
 * `tsx` is not hoisted).
 */
function resolveTsxBin() {
  const binDir = path.join(HERE, "node_modules", ".bin");
  const candidates = process.platform === "win32" ? ["tsx.CMD", "tsx.cmd", "tsx"] : ["tsx"];
  for (const name of candidates) {
    const p = path.join(binDir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Runs the real registry validator (via tsx) against SOURCE_REGISTRY, or against the JSON fixture at `entriesPath` if given. */
function runRegistryValidation(entriesPath) {
  const tsxBin = resolveTsxBin();
  if (!tsxBin) {
    didNotRun(
      `tsx binary not found under ${path.join(HERE, "node_modules", ".bin")} -- did "pnpm install" run?`,
    );
  }
  const args = [VALIDATE_REGISTRY_SCRIPT, ...(entriesPath ? [entriesPath] : [])];
  // shell: true -- on Windows the resolved binary is a .CMD shim, which
  // spawnSync cannot exec directly without a shell; harmless on Linux CI.
  const result = spawnSync(tsxBin, args, { encoding: "utf8", cwd: REPO_ROOT, shell: true });
  if (result.error) {
    didNotRun(`failed to spawn tsx for registry validation: ${result.error.message}`);
  }
  if (result.status !== 0) {
    didNotRun(
      `registry validation script exited ${result.status}:\n${result.stderr || result.stdout}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    didNotRun(
      `registry validation script did not print JSON (${err instanceof Error ? err.message : err}):\n${result.stdout}`,
    );
  }
  return undefined; // unreachable; didNotRun exits the process
}

const FORBIDDEN_TABLE_PREFIX_RE = /^(tx_|txgio_)/;

function migrationNumber(filename) {
  const m = /^(\d{4})_/.exec(filename);
  return m ? Number(m[1]) : null;
}

/** Scans every `*.sql` file in `drizzleDir` numbered after `highWaterMark` for a `CREATE TABLE` of a forbidden-prefix table name. Returns `[{ file, table }]`. */
function findNewSourceTableViolations(drizzleDir, highWaterMark) {
  if (!fs.existsSync(drizzleDir)) {
    didNotRun(`drizzle directory not found: ${drizzleDir}`);
  }
  const files = fs.readdirSync(drizzleDir).filter((f) => f.endsWith(".sql"));
  const violations = [];
  const createTableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-zA-Z0-9_]+)"?/gi;
  for (const file of files.sort()) {
    const num = migrationNumber(file);
    if (num === null || num <= highWaterMark) continue;
    const content = fs.readFileSync(path.join(drizzleDir, file), "utf8");
    createTableRe.lastIndex = 0;
    let m;
    while ((m = createTableRe.exec(content))) {
      const table = m[1];
      if (FORBIDDEN_TABLE_PREFIX_RE.test(table)) {
        violations.push({ file, table });
      }
    }
  }
  return violations;
}

function writeTmpMigration(dir, filename, sqlText) {
  fs.writeFileSync(path.join(dir, filename), sqlText, "utf8");
}

function runSelfTest() {
  // --- (a) registry validity: a planted positional keyRule, and a clean fixture ---
  const tmpRegistry = fs.mkdtempSync(path.join(os.tmpdir(), "source-shape-registry-"));
  try {
    const badEntriesPath = path.join(tmpRegistry, "bad-entries.json");
    fs.writeFileSync(
      badEntriesPath,
      JSON.stringify([
        {
          provider: "fixture.bad",
          description: "fixture",
          keyRule: { kind: "positional", attribute: "feature_index" },
          expectedCountSource: { description: "fixture" },
          partitionIndexes: [],
        },
      ]),
    );
    const badResult = runRegistryValidation(badEntriesPath);
    if (badResult.valid !== false) {
      console.error(
        `FAIL ${GATE_ID}: self-test — a positional keyRule was not flagged; gate is starved`,
      );
      process.exit(EXIT_VIOLATION);
    }

    const goodEntriesPath = path.join(tmpRegistry, "good-entries.json");
    fs.writeFileSync(
      goodEntriesPath,
      JSON.stringify([
        {
          provider: "fixture.good",
          description: "fixture",
          keyRule: { kind: "provider-id", attribute: "objectid" },
          expectedCountSource: { description: "fixture" },
          partitionIndexes: [],
        },
      ]),
    );
    const goodResult = runRegistryValidation(goodEntriesPath);
    if (goodResult.valid !== true) {
      console.error(
        `FAIL ${GATE_ID}: self-test — a clean registry fixture was flagged: ${JSON.stringify(goodResult.issues)}`,
      );
      process.exit(EXIT_VIOLATION);
    }
  } finally {
    fs.rmSync(tmpRegistry, { recursive: true, force: true });
  }

  // --- (b) new-table scan: a planted tx_* table after the high-water mark, and a clean fixture ---
  let tmpDrizzle = fs.mkdtempSync(path.join(os.tmpdir(), "source-shape-migration-"));
  try {
    writeTmpMigration(
      tmpDrizzle,
      `${String(HIGH_WATER_MARK + 1).padStart(4, "0")}_fixture_bad.sql`,
      `CREATE TABLE "tx_fixture_bad" ("id" text PRIMARY KEY);\n`,
    );
    const badViolations = findNewSourceTableViolations(tmpDrizzle, HIGH_WATER_MARK);
    if (badViolations.length === 0) {
      console.error(
        `FAIL ${GATE_ID}: self-test — a new tx_* table after the high-water mark was not flagged; gate is starved`,
      );
      process.exit(EXIT_VIOLATION);
    }

    fs.rmSync(tmpDrizzle, { recursive: true, force: true });
    tmpDrizzle = fs.mkdtempSync(path.join(os.tmpdir(), "source-shape-migration-"));
    writeTmpMigration(
      tmpDrizzle,
      `${String(HIGH_WATER_MARK + 1).padStart(4, "0")}_fixture_good.sql`,
      `CREATE TABLE IF NOT EXISTS "source_feature_fixture_good" PARTITION OF "source_feature" FOR VALUES IN ('fixture.good');\n`,
    );
    const goodViolations = findNewSourceTableViolations(tmpDrizzle, HIGH_WATER_MARK);
    if (goodViolations.length !== 0) {
      console.error(
        `FAIL ${GATE_ID}: self-test — a clean migration fixture was flagged: ${JSON.stringify(goodViolations)}`,
      );
      process.exit(EXIT_VIOLATION);
    }

    // A migration AT OR BEFORE the high-water mark is never scanned, even
    // if (hypothetically) it created a tx_* table -- grandfathered, not a
    // retroactive refusal of the ~20 that already exist.
    fs.rmSync(tmpDrizzle, { recursive: true, force: true });
    tmpDrizzle = fs.mkdtempSync(path.join(os.tmpdir(), "source-shape-migration-"));
    writeTmpMigration(
      tmpDrizzle,
      `0001_fixture_old.sql`,
      `CREATE TABLE "tx_fixture_old" ("id" text PRIMARY KEY);\n`,
    );
    const oldViolations = findNewSourceTableViolations(tmpDrizzle, HIGH_WATER_MARK);
    if (oldViolations.length !== 0) {
      console.error(
        `FAIL ${GATE_ID}: self-test — a migration at/before the high-water mark was scanned (it must not be)`,
      );
      process.exit(EXIT_VIOLATION);
    }
  } finally {
    fs.rmSync(tmpDrizzle, { recursive: true, force: true });
  }

  console.log(`${GATE_ID}: self-test passed`);
}

function main() {
  const selfTestOnly = process.argv.includes("--selftest");

  runSelfTest();
  if (selfTestOnly) {
    process.exit(EXIT_CLEAN);
  }

  const registryResult = runRegistryValidation();
  const migrationViolations = findNewSourceTableViolations(DRIZZLE_DIR, HIGH_WATER_MARK);

  let failed = false;
  if (!registryResult.valid) {
    failed = true;
    console.error(`FAIL ${GATE_ID}: lib/source-registry has invalid entries:`);
    for (const issue of registryResult.issues) {
      console.error(`  - [${issue.provider ?? "(no provider)"}] ${issue.reason}`);
    }
  }
  if (migrationViolations.length > 0) {
    failed = true;
    console.error(
      `FAIL ${GATE_ID}: new tx_*/txgio_* table(s) created by a migration after ${HIGH_WATER_MARK}:`,
    );
    for (const v of migrationViolations) {
      console.error(`  - ${v.file}: CREATE TABLE "${v.table}"`);
    }
  }

  if (failed) {
    process.exit(EXIT_VIOLATION);
  }
  console.log(
    `${GATE_ID}: clean (registry valid; no new tx_*/txgio_* table after migration ${HIGH_WATER_MARK})`,
  );
  process.exit(EXIT_CLEAN);
}

main();
