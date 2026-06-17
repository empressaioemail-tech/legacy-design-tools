#!/usr/bin/env node
/**
 * Repair verified-rate regression from broken deepen runs.
 * Restores grounded atoms (snippet + verified source) to verified high-water mark.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts exec tsx repair-deepen-regression.mjs
 *   pnpm --filter @workspace/scripts exec tsx repair-deepen-regression.mjs austin_tx
 */
import { restoreGroundedReasoningAtoms } from "../lib/codes/src/reasoningAtoms/snapshot.ts";
import {
  CENTRAL_TX_ADOPTION,
  DEEPEN_TOUCHED_JURISDICTIONS,
} from "./centralTxAdoption.mjs";
import { buildVerifiedRateReport } from "./report-verified-rates.mjs";

const keys =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : DEEPEN_TOUCHED_JURISDICTIONS;

if (!process.env.DATABASE_URL?.trim()) {
  throw new Error("DATABASE_URL is required");
}

const audit = {
  generatedAt: new Date().toISOString(),
  phase: "repair-deepen-regression",
  jurisdictions: [],
};

for (const key of keys) {
  const adoption = CENTRAL_TX_ADOPTION[key];
  const preDeepen = adoption?.preDeepen ?? { verifiedRate: 0, families: {} };

  const beforeRepair = await buildVerifiedRateReport([key]);
  const before = beforeRepair.jurisdictions[0];

  const { restored } = await restoreGroundedReasoningAtoms(key);

  const afterRepair = await buildVerifiedRateReport([key]);
  const after = afterRepair.jurisdictions[0];

  const familyAudit = (after.families ?? []).map((fam) => {
    const baseline = preDeepen.families?.[fam.family];
    return {
      family: fam.family,
      preDeepenRate: baseline ?? null,
      regressedRate: before.verifiedRate < (preDeepen.verifiedRate ?? 0)
        ? before.families?.find((f) => f.family === fam.family)?.verifiedRate
        : before.families?.find((f) => f.family === fam.family)?.verifiedRate,
      afterRepairRate: fam.verifiedRate,
      meetsBaseline:
        baseline == null
          ? true
          : fam.verifiedRate >= baseline - 0.1,
    };
  });

  audit.jurisdictions.push({
    key,
    label: adoption?.label ?? key,
    preDeepenVerifiedRate: preDeepen.verifiedRate,
    regressedVerifiedRate: before.verifiedRate,
    afterRepairVerifiedRate: after.verifiedRate,
    restoredAtomCount: restored,
    meetsOverallBaseline: after.verifiedRate >= (preDeepen.verifiedRate ?? 0) - 0.1,
    families: familyAudit,
  });
}

console.log(JSON.stringify(audit, null, 2));

const failed = audit.jurisdictions.filter((j) => !j.meetsOverallBaseline);
if (failed.length > 0) {
  console.error(
    `REPAIR INCOMPLETE: ${failed.map((j) => j.key).join(", ")} still below pre-deepen baseline`,
  );
  process.exit(1);
}
