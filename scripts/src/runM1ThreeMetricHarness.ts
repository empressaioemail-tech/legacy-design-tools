/**
 * M1 three-metric formal pass — adjudication-weighted slice vs corpus-uniform.
 *
 * Usage: pnpm --filter @workspace/scripts run measure:m1-three-metric
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  loadCorpusForJurisdiction,
  runThreeMetricM1,
  decisionReadSlice,
  MEASUREMENT_A_TARGET,
  type K2DepositLike,
} from "@workspace/calibration-engines/m1";

const CORPUS_SNAPSHOT =
  "P:/hauska-engine/services/retrieval-api/corpus/snapshot.json";
const DEPOSITS_PATH =
  "P:/legacy-design-tools/artifacts/calibration-runs/k2-backtest-deposits-v3-2026-06-22.json";
const INBOX = "P:/legacy-design-tools/_inbox";

function fmtPct(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`;
}

async function main() {
  const snapshot = JSON.parse(
    await readFile(CORPUS_SNAPSHOT, "utf8"),
  ) as Parameters<typeof loadCorpusForJurisdiction>[0]["snapshot"];

  const deposits = JSON.parse(
    await readFile(DEPOSITS_PATH, "utf8"),
  ) as K2DepositLike[];

  await mkdir(INBOX, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);

  const lines: string[] = [
    "---",
    `id: ${date}_legacy-design-tools_cc-agent-C_m1-three-metric-pass`,
    "title: M1 three-metric formal pass — adjudication-weighted slice",
    `date: ${date}`,
    "agent: cc-agent-C",
    "repo: legacy-design-tools",
    "status: close",
    "related: [endstate_A_m1_amendment, 05_measurement_spec, m1-v3-expanded-fuel]",
    "---",
    "",
    "# M1 three-metric pass (v3 deposits, no new fuel)",
    "",
    "Fuel: `artifacts/calibration-runs/k2-backtest-deposits-v3-2026-06-22.json` (138,248 deposits).",
    "",
    "**Corrected decision rule:** M1 passes if the **adjudication-weighted slice** earns ≥70% at a defensible grain. Corpus-uniform (legacy denominator) reported for context only.",
    "",
    "Non-negotiables: Conditions A & B; λ=F8 cold-start 0.02; no fabricated adjudications.",
    "",
  ];

  const results: ReturnType<typeof runThreeMetricM1>[] = [];

  for (const jurisdiction of ["austin_tx", "san_antonio_tx"] as const) {
    const { atoms, linkIndex } = loadCorpusForJurisdiction({
      snapshot,
      jurisdictionTenant: jurisdiction,
    });

    const jurisdictionDeposits = deposits.filter((d) =>
      (d.payload.subjectKey ?? d.entityId).includes(jurisdiction),
    );

    const r = runThreeMetricM1({
      atoms,
      deposits: jurisdictionDeposits,
      entityIdToAtomId: linkIndex.entityIdToAtomId,
      jurisdictionTenant: jurisdiction,
      observationYears: 12,
    });
    results.push(r);

    const city = jurisdiction === "austin_tx" ? "Austin" : "San Antonio";
    const corpusUniform = r.corpusUniform.byGranularity.find(
      (g) => g.granularity === "section-plus-dependents",
    )!.earnedFractionAtReadGrain;
    const slice = r.sliceByGranularity.find(
      (g) => g.granularity === "section-plus-dependents",
    )!;

    lines.push(`## ${city}`);
    lines.push("");
    lines.push(`- Cases: ${r.caseCount.toLocaleString()} | match rate: ${fmtPct(r.caseMatchRate)}`);
    lines.push(`- Corpus atoms: ${r.coverage.corpusAtomCount}`);
    lines.push("");

    lines.push("### (a) Slice earned fraction — adjudication-weighted");
    lines.push("");
    lines.push("| Granularity | Slice earned (read+amendment) | Slice earned (read grain) | Corpus-uniform (read grain) |");
    lines.push("|---|---:|---:|---:|");
    for (const g of r.sliceByGranularity) {
      const corp = r.corpusUniform.byGranularity.find(
        (x) => x.granularity === g.granularity,
      )!;
      lines.push(
        `| ${g.granularity} | **${fmtPct(g.sliceEarnedFraction)}** | ${fmtPct(g.sliceEarnedFractionAtReadGrain)} | ${fmtPct(corp.earnedFractionAtReadGrain)} |`,
      );
    }
    lines.push("");
    lines.push(
      `Adjudicated atoms: **${r.coverage.adjudicatedAtomCount}** (slice weight ${slice.sliceTotalWeight.toLocaleString()} case-citations)`,
    );
    lines.push("");

    lines.push("### (b) Coverage honesty — asserted tail");
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("|---|---:|");
    lines.push(`| Un-adjudicated atoms (asserted-with-provenance) | ${r.coverage.unAdjudicatedAtomCount} |`);
    lines.push(`| Un-adjudicated share of corpus | **${fmtPct(r.coverage.unAdjudicatedShare)}** |`);
    lines.push(`| Adjudicated atoms | ${r.coverage.adjudicatedAtomCount} |`);
    lines.push(`| Earned-slice atoms (read grain) | ${r.coverage.earnedSliceAtomCount} |`);
    lines.push(`| Adjudicated, not earned | ${r.coverage.adjudicatedNotEarnedCount} |`);
    lines.push("");
    lines.push("**Condition A provenance classes** (`CalibrationReadProvenance`):");
    lines.push("");
    lines.push("| Class | Count | Meaning |");
    lines.push("|---|---:|---|");
    lines.push(`| earned-slice-own | ${r.coverage.provenanceByClass["earned-slice-own"]} | own-earned at atom grain, cited |`);
    lines.push(`| earned-slice-pooled | ${r.coverage.provenanceByClass["earned-slice-pooled"]} | pooled-applied with adjudicated pool signal |`);
    lines.push(`| adjudicated-not-earned | ${r.coverage.provenanceByClass["adjudicated-not-earned"]} | cited; width ≥ W_target or n<3 |`);
    lines.push(`| asserted-tail | ${r.coverage.provenanceByClass["asserted-tail"]} | zero adjudication; asserted prior only |`);
    lines.push("");

    lines.push("### Side-by-side (section-plus-dependents, read grain)");
    lines.push("");
    lines.push(`| Metric | ${city} |`);
    lines.push("|---|---:|");
    lines.push(`| **(a) Slice earned** | **${fmtPct(slice.sliceEarnedFractionAtReadGrain)}** |`);
    lines.push(`| Corpus-uniform (legacy) | ${fmtPct(corpusUniform)} |`);
    lines.push(`| Δ slice − corpus | ${slice.sliceEarnedFractionAtReadGrain >= corpusUniform ? "+" : ""}${fmtPct(slice.sliceEarnedFractionAtReadGrain - corpusUniform)} |`);
    lines.push(`| Clears ${fmtPct(MEASUREMENT_A_TARGET)} target? | ${slice.sliceEarnedFractionAtReadGrain >= MEASUREMENT_A_TARGET ? "**YES**" : "No"} |`);
    lines.push("");

    lines.push("### Decision read (slice metric)");
    lines.push("");
    lines.push(decisionReadSlice(r));
    lines.push("");
  }

  lines.push("## (c) Measurement B — high-consequence slice (ICC slot)");
  lines.push("");
  const mb = results[0]!.measurementB;
  lines.push("| Field | Value |");
  lines.push("|---|---|");
  lines.push(`| Status | **${mb.status}** |`);
  lines.push(`| Stratum | ${mb.stratum} |`);
  lines.push(`| W_actuation bar | ${mb.wTargetActuation} |`);
  lines.push(`| High-consequence atoms identified | ${mb.highConsequenceAtomCount} |`);
  lines.push(`| High-consequence earned fraction | **${fmtPct(mb.highConsequenceEarnedFraction)}** |`);
  lines.push(`| ICC fuel required | ${mb.iccFuelRequired} |`);
  lines.push("");
  lines.push(mb.reason);
  lines.push("");

  lines.push("## Formal pass / no-go");
  lines.push("");
  const austin = results.find((r) => r.jurisdictionTenant === "austin_tx")!;
  const sa = results.find((r) => r.jurisdictionTenant === "san_antonio_tx")!;
  const austinSlice = austin.sliceByGranularity.find(
    (g) => g.granularity === "section-plus-dependents",
  )!.sliceEarnedFractionAtReadGrain;
  const saSlice = sa.sliceByGranularity.find(
    (g) => g.granularity === "section-plus-dependents",
  )!.sliceEarnedFractionAtReadGrain;
  const austinCorp = austin.corpusUniform.byGranularity.find(
    (g) => g.granularity === "section-plus-dependents",
  )!.earnedFractionAtReadGrain;
  const saCorp = sa.corpusUniform.byGranularity.find(
    (g) => g.granularity === "section-plus-dependents",
  )!.earnedFractionAtReadGrain;

  const austinPass = austinSlice >= MEASUREMENT_A_TARGET;
  const saPass = saSlice >= MEASUREMENT_A_TARGET;

  lines.push("| City | Corpus-uniform | Slice (a) | Pass? |");
  lines.push("|---|---:|---:|---|");
  lines.push(
    `| Austin | ${fmtPct(austinCorp)} | **${fmtPct(austinSlice)}** | ${austinPass ? "**PASS**" : "NO-GO"} |`,
  );
  lines.push(
    `| San Antonio | ${fmtPct(saCorp)} | **${fmtPct(saSlice)}** | ${saPass ? "**PASS**" : "NO-GO"} |`,
  );
  lines.push("");

  if (austinPass || saPass) {
    lines.push(
      `**M1 PASS (corrected slice metric)** — ${[austinPass && "Austin", saPass && "San Antonio"].filter(Boolean).join(", ")} clear ${fmtPct(MEASUREMENT_A_TARGET)} at section-plus-dependents read grain on the adjudication-weighted slice. Corpus-uniform figures (${fmtPct(austinCorp)} / ${fmtPct(saCorp)}) understate moat health on the queried/adjudicated slice; un-adjudicated tail (${austin.coverage.unAdjudicatedAtomCount} + ${sa.coverage.unAdjudicatedAtomCount} atoms) correctly carries asserted-with-provenance per Condition A.`,
    );
  } else {
    lines.push(
      `**M1 NO-GO (slice metric)** — neither city clears ${fmtPct(MEASUREMENT_A_TARGET)} on the adjudication-weighted slice. Corpus-uniform and slice metrics converge; citation-breadth topology remains binding.`,
    );
  }

  const outPath = join(
    INBOX,
    `${date}_legacy-design-tools_cc-agent-C_m1-three-metric-pass.md`,
  );
  await writeFile(outPath, lines.join("\n"), "utf8");
  console.log("Wrote", outPath);

  console.log("\n--- Summary ---");
  for (const r of results) {
    const slice = r.sliceByGranularity.find(
      (g) => g.granularity === "section-plus-dependents",
    )!;
    const corp = r.corpusUniform.byGranularity.find(
      (g) => g.granularity === "section-plus-dependents",
    )!;
    console.log(
      r.jurisdictionTenant,
      "corpus:",
      (corp.earnedFractionAtReadGrain * 100).toFixed(1) + "%",
      "slice:",
      (slice.sliceEarnedFractionAtReadGrain * 100).toFixed(1) + "%",
      "tail:",
      (r.coverage.unAdjudicatedShare * 100).toFixed(1) + "%",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
