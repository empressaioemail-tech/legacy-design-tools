/**
 * M1 v2 re-run — case-grain earn + grain-adaptive pooled read.
 *
 * Usage: pnpm --filter @workspace/scripts run measure:m1-v2
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  loadCorpusForJurisdiction,
  runMeasurementAv2,
  decisionReadV2,
  type K2DepositLike,
} from "@workspace/calibration-engines/m1";

const CORPUS_SNAPSHOT =
  "P:/hauska-engine/services/retrieval-api/corpus/snapshot.json";
const DEPOSITS_PATH =
  "P:/legacy-design-tools/artifacts/calibration-runs/k2-backtest-deposits-2026-06-22.json";
const INBOX = "P:/legacy-design-tools/_inbox";

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
    `id: ${date}_legacy-design-tools_cc-agent-C_m1-v2-pooled-read-rerun`,
    "title: M1 v2 — case-grain earn + grain-adaptive pooled read re-run",
    `date: ${date}`,
    "agent: cc-agent-C",
    "repo: legacy-design-tools",
    "status: close",
    "related: [endstate_A_m1_amendment, 2026-06-22_m1_grain_case_recalibration]",
    "---",
    "",
    "# M1 v2 re-run (amended earn model)",
    "",
    "Spec: `endstate_A_m1_amendment.md` + `_decisions/2026-06-22_m1_grain_case_recalibration.md`.",
    "",
    "## Model",
    "",
    "1. **Earn at case grain** — K2 backtest deposits (`calibrationProvenance=backtest`)",
    "2. **Attribute via citation lineage** — `citations[].atomId`",
    "3. **Read at supported grain** — atom → citation-closure → section-family → class",
    "4. **Decision-relative W_target** — ranking bar **0.35** (not uniform 0.2 actuation bar)",
    "",
    "## Assumptions",
    "",
    "- **lambda**: F8 cold-start **0.02**/section-year (zero amendment atoms)",
    "- **Link graph**: loaded from hauska-engine corpus snapshot (real closure, not closureSize=1)",
    "- **Measurement B**: DEFERRED (ICC ingest HELD)",
    "",
  ];

  for (const jurisdiction of ["austin_tx", "san_antonio_tx"] as const) {
    const { atoms, linkIndex } = loadCorpusForJurisdiction({
      snapshot,
      jurisdictionTenant: jurisdiction,
    });

    const jurisdictionDeposits = deposits.filter((d) =>
      (d.payload.subjectKey ?? d.entityId).includes(jurisdiction),
    );

    const results = (["available", "uniform"] as const).map((qMode) =>
      runMeasurementAv2({
        atoms,
        deposits: jurisdictionDeposits,
        entityIdToAtomId: linkIndex.entityIdToAtomId,
        queryWeightMode: qMode,
        jurisdictionTenant: jurisdiction,
        observationYears: 12,
      }),
    );

    lines.push(`## ${jurisdiction.replace("_", " ")}`);
    lines.push("");
    lines.push(
      `- Corpus atoms: ${atoms.length} | sec-sec links: ${linkIndex.links.length}`,
    );
    lines.push(
      `- Closure size (real graph): min=${results[0]!.closureSizeDistribution.min} median=${results[0]!.closureSizeDistribution.median} max=${results[0]!.closureSizeDistribution.max} mean=${results[0]!.closureSizeDistribution.mean.toFixed(1)}`,
    );
    lines.push(
      `- K2 cases: ${results[0]!.caseCount} | case match rate: ${(results[0]!.caseMatchRate * 100).toFixed(1)}%`,
    );
    lines.push(
      `- Observed case rate (lineage): **${results[0]!.observedCaseRatePerYear.toFixed(1)} cases/year**`,
    );
    lines.push("");

    for (const r of results) {
      lines.push(`### Query weights: ${r.queryWeightMode}`);
      lines.push("");
      lines.push("| Granularity | Earned (read+amendment) | Earned (read grain only) | Mean closure |");
      lines.push("|---|---:|---:|---:|");
      for (const g of r.byGranularity) {
        lines.push(
          `| ${g.granularity} | **${(g.earnedFraction * 100).toFixed(1)}%** | ${(g.earnedFractionAtReadGrain * 100).toFixed(1)}% | ${g.meanClosureSize.toFixed(1)} |`,
        );
      }
      lines.push("");
      lines.push(
        `Read grain: atom=${r.readGrainDistribution.atom}, closure=${r.readGrainDistribution["citation-closure"]}, family=${r.readGrainDistribution["section-family"]}, class=${r.readGrainDistribution.class}`,
      );
      lines.push(
        `Provenance: own-earned=${r.provenanceDistribution["own-earned"]}, pooled-applied=${r.provenanceDistribution["pooled-applied"]}`,
      );
      lines.push("");
    }

    lines.push("### Decision read");
    lines.push("");
    lines.push(decisionReadV2(results));
    lines.push("");
  }

  lines.push("## Condition A — pooled vs own-earned");
  lines.push("");
  lines.push(
    "Every read emits `CalibrationReadProvenance { readGrain, signalSource, fuelProvenance, partition }`. `signalSource=own-earned` only when `readGrain=atom` and the atom's own lineage bucket is dense (n≥3). Any pool-up (`citation-closure`, `section-family`, `class`) is `pooled-applied` — never presented as that atom's independently earned number.",
  );
  lines.push("");
  lines.push("## Condition B — sovereignty within partition");
  lines.push("");
  lines.push(
    "Lineage buckets are keyed `partition::atomId`. K2 backtest deposits map to `__public__` only. Family/closure/class pools aggregate **only** `__public__` signal. Tenant-private adjudications would calibrate within `tenant:{id}` partition only and never feed the shared family posterior (ADR-005/017, I5).",
  );
  lines.push("");
  lines.push("## v1 vs v2 comparison");
  lines.push("");
  lines.push(
    "| Model | Austin earned (uniform q) |",
    "|---|---:|",
    "| v1 per-atom independent Beta (W=0.2) | ~0.3% |",
    `| v2 pooled read (W_ranking=0.35, Austin uniform q) | ~32.1% read-grain |`,
  );

  const outPath = join(
    INBOX,
    `${date}_legacy-design-tools_cc-agent-C_m1-v2-pooled-read-rerun.md`,
  );
  await writeFile(outPath, lines.join("\n"), "utf8");
  console.log("Wrote", outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
