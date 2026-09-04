#!/usr/bin/env node
/**
 * F-15 retirement gate — the frozen hauska atom-contract name must not appear in manifests or imports.
 *
 * exit 0   clean
 * exit 1   violation (or self-test expected violation not detected)
 * exit 2   did-not-run
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const GATE_ID = "check-no-hauska-atom-contract";
const FORBIDDEN = ["@hauska/", "atom-contract"].join("");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

const EXIT_CLEAN = 0;
const EXIT_VIOLATION = 1;
const EXIT_DID_NOT_RUN = 2;

function didNotRun(message) {
  console.error(`GATE-DID-NOT-RUN ${GATE_ID}: ${message}`);
  process.exit(EXIT_DID_NOT_RUN);
}

function scanTree(root, excludePaths = new Set()) {
  const hits = [];
  const rg = spawnSync(
    "rg",
    [
      "-n",
      "--glob",
      "package.json",
      "--glob",
      "*.ts",
      "--glob",
      "*.tsx",
      "--glob",
      "*.mjs",
      "--glob",
      "!.claude/**",
      FORBIDDEN,
      root,
    ],
    { encoding: "utf8", cwd: REPO_ROOT },
  );
  if (rg.error) didNotRun(`ripgrep failed to spawn: ${rg.error.message}`);
  if (rg.status > 1) didNotRun(`ripgrep errored (exit ${rg.status}): ${rg.stderr}`);
  const lines = (rg.stdout || "").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const file = line.split(":")[0].replace(/\\/g, "/");
    const abs = path.resolve(REPO_ROOT, file).replace(/\\/g, "/");
    const excluded = [...excludePaths].some(
      (p) => p.replace(/\\/g, "/") === abs,
    );
    if (excluded) continue;
    hits.push(line);
  }
  return hits;
}

function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hauska-retire-"));
  try {
    const violationFile = path.join(tmp, "violation.ts");
    fs.writeFileSync(violationFile, `import x from "${FORBIDDEN}";\n`, "utf8");
    const hits = scanTree(tmp);
    if (hits.length === 0) {
      console.error(
        `FAIL ${GATE_ID}: self-test — expected violation not detected; gate is starved`,
      );
      process.exit(EXIT_VIOLATION);
    }
    const cleanFile = path.join(tmp, "clean.ts");
    fs.writeFileSync(
      cleanFile,
      'import type { AccessPair } from "@empressaio/atom-contract/access";\n',
      "utf8",
    );
    const cleanHits = scanTree(tmp);
    if (cleanHits.length !== 1) {
      console.error(
        `FAIL ${GATE_ID}: self-test — clean fixture flagged (${cleanHits.length} hits)`,
      );
      process.exit(EXIT_VIOLATION);
    }
    console.log(`${GATE_ID}: self-test passed`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  const expectViolation = process.argv.includes("--expect-violation");
  const selfPath = path.resolve(HERE, "check-no-hauska-atom-contract.mjs").replace(/\\/g, "/");
  const exclude = new Set([selfPath]);

  if (expectViolation) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hauska-expect-"));
    try {
      fs.writeFileSync(
        path.join(tmp, "package.json"),
        JSON.stringify({ dependencies: { [FORBIDDEN]: "1.0.0" } }, null, 2),
        "utf8",
      );
      const hits = scanTree(tmp);
      if (hits.length === 0) {
        console.error(`FAIL ${GATE_ID}: --expect-violation but no hit`);
        process.exit(EXIT_VIOLATION);
      }
      console.log(`${GATE_ID}: --expect-violation ok (${hits.length} hit(s))`);
      process.exit(EXIT_CLEAN);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  runSelfTest();

  const hits = scanTree(REPO_ROOT, exclude);
  if (hits.length > 0) {
    console.error(`FAIL ${GATE_ID}: ${FORBIDDEN} still present:`);
    for (const h of hits) console.error(`  ${h}`);
    process.exit(EXIT_VIOLATION);
  }

  console.log(`${GATE_ID}: clean`);
  process.exit(EXIT_CLEAN);
}

main();
