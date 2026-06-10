#!/usr/bin/env node
/**
 * Cold-warm batch CLI — reads a national reference manifest and warms reasoning atoms.
 *
 * Usage:
 *   pnpm --filter @workspace/codewarm codewarm -- \
 *     --manifest path/to/manifest.yaml \
 *     --jurisdiction miami_beach_fl \
 *     [--dry-run] [--budget-cap 5.0]
 */

import { parseArgs } from "node:util";
import { runCodewarmBatch } from "./batchRunner";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string" },
      jurisdiction: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "budget-cap": { type: "string" },
      "cost-per-fetch": { type: "string" },
    },
  });

  if (!values.manifest || !values.jurisdiction) {
    console.error(
      "Usage: codewarm --manifest <path> --jurisdiction <key> [--dry-run] [--budget-cap USD]",
    );
    process.exit(1);
  }

  const result = await runCodewarmBatch({
    manifestPath: values.manifest,
    jurisdictionKey: values.jurisdiction,
    dryRun: values["dry-run"] ?? false,
    budgetCapUsd:
      values["budget-cap"] != null ? Number(values["budget-cap"]) : undefined,
    costPerFetchUsd:
      values["cost-per-fetch"] != null
        ? Number(values["cost-per-fetch"])
        : undefined,
    log: (msg, meta) => console.log(JSON.stringify({ msg, ...meta })),
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
