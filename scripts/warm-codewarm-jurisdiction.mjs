#!/usr/bin/env node
/**
 * Warm one jurisdiction via codewarm manifests into deployment Neon (reasoning_atoms).
 *
 * Usage:
 *   pnpm --filter @workspace/scripts exec tsx scripts/warm-codewarm-jurisdiction.mjs austin_tx --edition 2024
 *   pnpm --filter @workspace/scripts exec tsx scripts/warm-codewarm-jurisdiction.mjs round_rock_tx
 *
 * Env: DATABASE_URL (deployment Neon), CODEWARM_CATALOG_DIR (default P:/doc_repo/_catalog/codes)
 */
import { join } from "node:path";
import { runCodewarmBatch } from "../lib/codewarm/src/batchRunner.ts";

const CATALOG_DIR =
  process.env.CODEWARM_CATALOG_DIR?.trim() ??
  join("P:", "doc_repo", "_catalog", "codes");

const MANIFESTS_2021 = [
  "manifest_irc_2021.yaml",
  "manifest_ibc_iebc_2021.yaml",
  "manifest_iecc_2021.yaml",
  "manifest_imc_ipc_ifgc_2021.yaml",
  "manifest_ifc_ipmc_2021.yaml",
  "manifest_accessibility_nfpa_2021.yaml",
];

const MANIFESTS_2024 = [
  "manifest_irc_2024.yaml",
  "manifest_ibc_2024.yaml",
  "manifest_iecc_2024.yaml",
  "manifest_ifc_2024.yaml",
  "manifest_accessibility_austin_2024.yaml",
  "manifest_umc_upc_2024.yaml",
];

function parseArgs(argv) {
  const args = argv.slice(2);
  const jurisdictionKey = args.find((a) => !a.startsWith("--"));
  let edition = "2021";
  let budgetCap = 200;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--edition" && args[i + 1]) edition = args[i + 1];
    if (args[i] === "--budget-cap" && args[i + 1]) {
      budgetCap = Number(args[i + 1]);
    }
    if (args[i] === "--dry-run") dryRun = true;
  }
  if (!jurisdictionKey) {
    throw new Error(
      "Usage: warm-codewarm-jurisdiction.mjs <jurisdiction_key> [--edition 2021|2024] [--budget-cap 200] [--dry-run]",
    );
  }
  return { jurisdictionKey, edition, budgetCap, dryRun };
}

const { jurisdictionKey, edition, budgetCap, dryRun } = parseArgs(process.argv);
const manifests = edition === "2024" ? MANIFESTS_2024 : MANIFESTS_2021;

if (!process.env.DATABASE_URL?.trim()) {
  throw new Error("DATABASE_URL is required");
}

console.log(
  JSON.stringify(
    { jurisdictionKey, edition, budgetCap, dryRun, manifestCount: manifests.length },
    null,
    2,
  ),
);

let totalFetchCount = 0;
let totalEstimatedCostUsd = 0;
let totalWarmed = 0;
let totalErrors = 0;

for (const file of manifests) {
  const manifestPath = join(CATALOG_DIR, file);
  const perManifestCap = budgetCap / manifests.length;
  const result = await runCodewarmBatch({
    manifestPath,
    jurisdictionKey,
    dryRun,
    budgetCapUsd: perManifestCap,
    log: (msg, meta) =>
      console.log(JSON.stringify({ msg, manifest: file, ...meta })),
  });
  totalFetchCount += result.costRecord.fetchCount;
  totalEstimatedCostUsd += result.costRecord.estimatedCostUsd;
  totalWarmed += result.warmedCount;
  totalErrors += result.errorCount;
  console.log(
    JSON.stringify(
      {
        manifest: file,
        warmedCount: result.warmedCount,
        corpusCoveredCount: result.corpusCoveredCount,
        errorCount: result.errorCount,
        fetchCount: result.costRecord.fetchCount,
        estimatedCostUsd: result.costRecord.estimatedCostUsd,
      },
      null,
      2,
    ),
  );
}

console.log(
  JSON.stringify(
    {
      ok: totalErrors === 0,
      jurisdictionKey,
      edition,
      totalWarmed,
      totalErrors,
      totalFetchCount,
      totalEstimatedCostUsd,
    },
    null,
    2,
  ),
);

if (totalErrors > 0) process.exit(1);
