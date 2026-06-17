#!/usr/bin/env node
/**
 * Safe deepen — gap families only, incremental re-warm, auto-rollback on regression.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts exec tsx deepen-central-tx-jurisdiction.mjs austin_tx
 *   pnpm --filter @workspace/scripts exec tsx deepen-central-tx-jurisdiction.mjs san_antonio_tx --budget-cap 200
 */
import { join, dirname } from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCodewarmBatch } from "../lib/codewarm/src/batchRunner.ts";
import { snapshotReasoningVerification, rollbackReasoningVerification } from "../lib/codes/src/reasoningAtoms/snapshot.ts";
import { CENTRAL_TX_ADOPTION } from "./centralTxAdoption.mjs";
import { buildVerifiedRateReport } from "./report-verified-rates.mjs";

const CATALOG_DIR =
  process.env.CODEWARM_CATALOG_DIR?.trim() ??
  join("P:", "doc_repo", "_catalog", "codes");

function parseArgs(argv) {
  const args = argv.slice(2);
  const jurisdictionKey = args.find((a) => !a.startsWith("--"));
  let budgetCap = 200;
  let dryRun = false;
  let fullPackage = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--budget-cap" && args[i + 1]) {
      budgetCap = Number(args[i + 1]);
    }
    if (args[i] === "--dry-run") dryRun = true;
    if (args[i] === "--full-package") fullPackage = true;
  }
  if (!jurisdictionKey) {
    throw new Error(
      "Usage: deepen-central-tx-jurisdiction.mjs <jurisdiction_key> [--budget-cap 200] [--dry-run] [--full-package]",
    );
  }
  return { jurisdictionKey, budgetCap, dryRun, fullPackage };
}

const { jurisdictionKey, budgetCap, dryRun, fullPackage } = parseArgs(process.argv);
const adoption = CENTRAL_TX_ADOPTION[jurisdictionKey];
if (!adoption) {
  throw new Error(
    `No adoption package for ${jurisdictionKey} — add to scripts/centralTxAdoption.mjs`,
  );
}

if (!process.env.DATABASE_URL?.trim()) {
  throw new Error("DATABASE_URL is required");
}

const manifestList =
  !fullPackage && adoption.deepenManifests?.length
    ? adoption.deepenManifests
    : adoption.manifests;

const beforeReport = await buildVerifiedRateReport([jurisdictionKey]);
const beforeRate = beforeReport.jurisdictions[0]?.verifiedRate ?? 0;
const preDeepenFloor = adoption.preDeepen?.verifiedRate ?? beforeRate;

console.log("=== BEFORE (verified rates) ===");
console.log(JSON.stringify(beforeReport, null, 2));

const snapshot = await snapshotReasoningVerification(jurisdictionKey);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const snapshotPath = join(
  SCRIPT_DIR,
  `_deepen-snapshot-${jurisdictionKey}-${Date.now()}.json`,
);
writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));

console.log(
  JSON.stringify(
    {
      phase: "deepen-start",
      mode: "safe-incremental",
      jurisdictionKey,
      label: adoption.label,
      adoptedEditions: adoption.adoptedEditions,
      manifestCount: manifestList.length,
      manifests: manifestList,
      budgetCap,
      dryRun,
      beforeVerifiedRate: beforeRate,
      preDeepenFloor,
      snapshotPath,
    },
    null,
    2,
  ),
);

let totalFetchCount = 0;
let totalEstimatedCostUsd = 0;
let totalWarmed = 0;
let totalVerifiedSkipped = 0;
let totalErrors = 0;
const manifestResults = [];

for (const file of manifestList) {
  const manifestPath = join(CATALOG_DIR, file);
  const perManifestCap = budgetCap / manifestList.length;
  const result = await runCodewarmBatch({
    manifestPath,
    jurisdictionKey,
    dryRun,
    budgetCapUsd: perManifestCap,
    incrementalDeepen: true,
    log: (msg, meta) =>
      console.log(JSON.stringify({ msg, manifest: file, ...meta })),
  });
  totalFetchCount += result.costRecord.fetchCount;
  totalEstimatedCostUsd += result.costRecord.estimatedCostUsd;
  totalWarmed += result.warmedCount;
  totalVerifiedSkipped += result.verifiedSkippedCount ?? 0;
  totalErrors += result.errorCount;
  manifestResults.push({
    manifest: file,
    warmedCount: result.warmedCount,
    verifiedSkippedCount: result.verifiedSkippedCount ?? 0,
    unverifiedSkippedCount: result.unverifiedSkippedCount ?? 0,
    corpusCoveredCount: result.corpusCoveredCount,
    errorCount: result.errorCount,
    fetchCount: result.costRecord.fetchCount,
    estimatedCostUsd: result.costRecord.estimatedCostUsd,
  });
  console.log(JSON.stringify(manifestResults.at(-1), null, 2));
}

const afterReport = await buildVerifiedRateReport([jurisdictionKey]);
const afterRate = afterReport.jurisdictions[0]?.verifiedRate ?? 0;

console.log(
  JSON.stringify(
    {
      ok: totalErrors === 0 && afterRate >= preDeepenFloor - 0.1,
      jurisdictionKey,
      adoptedEditions: adoption.adoptedEditions,
      totalWarmed,
      totalVerifiedSkipped,
      totalErrors,
      totalFetchCount,
      totalEstimatedCostUsd,
      beforeVerifiedRate: beforeRate,
      afterVerifiedRate: afterRate,
      preDeepenFloor,
      manifestResults,
    },
    null,
    2,
  ),
);

if (!dryRun && afterRate < preDeepenFloor - 0.1) {
  console.error(
    JSON.stringify({
      phase: "auto-rollback",
      reason: "afterVerifiedRate below preDeepenFloor",
      beforeVerifiedRate: beforeRate,
      afterVerifiedRate: afterRate,
      preDeepenFloor,
    }),
  );
  const restored = await rollbackReasoningVerification(snapshot);
  const rolledBack = await buildVerifiedRateReport([jurisdictionKey]);
  console.log("=== ROLLED BACK (verified rates) ===");
  console.log(JSON.stringify(rolledBack, null, 2));
  console.log(JSON.stringify({ restoredRowCount: restored }, null, 2));
  process.exit(1);
}

console.log("=== AFTER (verified rates) ===");
console.log(JSON.stringify(afterReport, null, 2));

if (totalErrors > 0) process.exit(1);
