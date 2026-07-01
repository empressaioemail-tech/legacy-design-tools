/**
 * M1 v3 — expanded K2 fuel (variance/BOA + local-evaluable permits).
 *
 * Usage: pnpm --filter @workspace/scripts run measure:m1-v3
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  loadCorpusForJurisdiction,
  runMeasurementAv2,
  decisionReadV2,
  MEASUREMENT_A_TARGET,
  type K2DepositLike,
} from "@workspace/calibration-engines/m1";

const CORPUS_SNAPSHOT =
  "P:/hauska-engine/services/retrieval-api/corpus/snapshot.json";
const DEPOSITS_V2 =
  "P:/legacy-design-tools/artifacts/calibration-runs/k2-backtest-deposits-2026-06-22.json";
const OUTPUT_DIR = "P:/legacy-design-tools/artifacts/calibration-runs";
const INBOX = "P:/legacy-design-tools/_inbox";

async function findLatestV3Deposits(): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(OUTPUT_DIR);
  const v3 = files
    .filter((f) => f.startsWith("k2-backtest-deposits-v3-") && f.endsWith(".json"))
    .sort()
    .reverse();
  if (v3[0]) return join(OUTPUT_DIR, v3[0]);
  throw new Error("No k2-backtest-deposits-v3-*.json found — run measure:k2-v3 first");
}

async function main() {
  const depositPath = await findLatestV3Deposits();
  const snapshot = JSON.parse(
    await readFile(CORPUS_SNAPSHOT, "utf8"),
  ) as Parameters<typeof loadCorpusForJurisdiction>[0]["snapshot"];

  const deposits = JSON.parse(
    await readFile(depositPath, "utf8"),
  ) as K2DepositLike[];

  let v2Deposits: K2DepositLike[] = [];
  try {
    v2Deposits = JSON.parse(await readFile(DEPOSITS_V2, "utf8")) as K2DepositLike[];
  } catch {
    /* v2 baseline optional */
  }

  await mkdir(INBOX, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);

  const lines: string[] = [
    "---",
    `id: ${date}_legacy-design-tools_cc-agent-C_m1-v3-expanded-fuel-rerun`,
    "title: M1 v3 — expanded local permit fuel re-run",
    `date: ${date}`,
    "agent: cc-agent-C",
    "repo: legacy-design-tools",
    "status: close",
    "related: [endstate_A_m1_amendment, k2-v3-local-permit-expansion]",
    "---",
    "",
    "# M1 v3 re-run (expanded K2 fuel)",
    "",
    "## Model (unchanged from v2)",
    "",
    "1. Earn at case grain — K2 backtest deposits",
    "2. Attribute via citation lineage",
    "3. Read at supported grain — atom → closure → family → class",
    "4. W_target ranking bar **0.35**",
    "5. Conditions A & B intact — provenance + PUBLIC partition only",
    "",
    `## Fuel`,
    "",
    `- v2 deposits: ${v2Deposits.length.toLocaleString()}`,
    `- **v3 deposits**: ${deposits.length.toLocaleString()} (\`${depositPath}\`)`,
    "",
  ];

  const v2Baseline = { austin: 0.321, sa: 0.001 };

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

    const uniform = results.find((r) => r.queryWeightMode === "uniform")!;
    const readGrain =
      uniform.byGranularity.find(
        (g) => g.granularity === "section-plus-dependents",
      )!.earnedFractionAtReadGrain;

    const cityLabel = jurisdiction === "austin_tx" ? "Austin" : "San Antonio";
    const v2 =
      jurisdiction === "austin_tx" ? v2Baseline.austin : v2Baseline.sa;

    lines.push(`## ${cityLabel}`);
    lines.push("");
    lines.push(`- Corpus atoms: ${atoms.length}`);
    lines.push(`- K2 cases: ${uniform.caseCount} | match rate: ${(uniform.caseMatchRate * 100).toFixed(1)}%`);
    lines.push(`- **v2 → v3 read-grain earned**: ${(v2 * 100).toFixed(1)}% → **${(readGrain * 100).toFixed(1)}%**`);
    lines.push("");

    for (const r of results) {
      lines.push(`### Query weights: ${r.queryWeightMode}`);
      lines.push("");
      lines.push("| Granularity | Earned (read+amendment) | Earned (read grain only) |");
      lines.push("|---|---:|---:|");
      for (const g of r.byGranularity) {
        lines.push(
          `| ${g.granularity} | ${(g.earnedFraction * 100).toFixed(1)}% | ${(g.earnedFractionAtReadGrain * 100).toFixed(1)}% |`,
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

  lines.push("## v2 vs v3 comparison (uniform q, section-plus-dependents read grain)");
  lines.push("");
  lines.push("| City | v2 read-grain | v3 read-grain | Δ | Clears 70%? |");
  lines.push("|---|---:|---:|---:|---|");

  for (const jurisdiction of ["austin_tx", "san_antonio_tx"] as const) {
    const { atoms, linkIndex } = loadCorpusForJurisdiction({
      snapshot,
      jurisdictionTenant: jurisdiction,
    });
    const jurisdictionDeposits = deposits.filter((d) =>
      (d.payload.subjectKey ?? d.entityId).includes(jurisdiction),
    );
    const r = runMeasurementAv2({
      atoms,
      deposits: jurisdictionDeposits,
      entityIdToAtomId: linkIndex.entityIdToAtomId,
      queryWeightMode: "uniform",
      jurisdictionTenant: jurisdiction,
      observationYears: 12,
    });
    const earned =
      r.byGranularity.find((g) => g.granularity === "section-plus-dependents")!
        .earnedFractionAtReadGrain;
    const v2 = jurisdiction === "austin_tx" ? v2Baseline.austin : v2Baseline.sa;
    const city = jurisdiction === "austin_tx" ? "Austin" : "San Antonio";
    lines.push(
      `| ${city} | ${(v2 * 100).toFixed(1)}% | ${(earned * 100).toFixed(1)}% | ${earned >= v2 ? "+" : ""}${((earned - v2) * 100).toFixed(1)}pp | ${earned >= MEASUREMENT_A_TARGET ? "**YES**" : "No"} |`,
    );
  }

  lines.push("");
  lines.push("## Reversal threshold");
  lines.push("");
  const austinV3 = runMeasurementAv2({
    atoms: loadCorpusForJurisdiction({ snapshot, jurisdictionTenant: "austin_tx" }).atoms,
    deposits: deposits.filter((d) =>
      (d.payload.subjectKey ?? d.entityId).includes("austin_tx"),
    ),
    entityIdToAtomId: loadCorpusForJurisdiction({
      snapshot,
      jurisdictionTenant: "austin_tx",
    }).linkIndex.entityIdToAtomId,
    queryWeightMode: "uniform",
    jurisdictionTenant: "austin_tx",
    observationYears: 12,
  });
  const saV3 = runMeasurementAv2({
    atoms: loadCorpusForJurisdiction({ snapshot, jurisdictionTenant: "san_antonio_tx" }).atoms,
    deposits: deposits.filter((d) =>
      (d.payload.subjectKey ?? d.entityId).includes("san_antonio_tx"),
    ),
    entityIdToAtomId: loadCorpusForJurisdiction({
      snapshot,
      jurisdictionTenant: "san_antonio_tx",
    }).linkIndex.entityIdToAtomId,
    queryWeightMode: "uniform",
    jurisdictionTenant: "san_antonio_tx",
    observationYears: 12,
  });
  const austinEarned =
    austinV3.byGranularity.find((g) => g.granularity === "section-plus-dependents")!
      .earnedFractionAtReadGrain;
  const saEarned =
    saV3.byGranularity.find((g) => g.granularity === "section-plus-dependents")!
      .earnedFractionAtReadGrain;

  if (austinEarned >= MEASUREMENT_A_TARGET || saEarned >= MEASUREMENT_A_TARGET) {
    lines.push(
      `**GO at pooled read grain** for ${austinEarned >= MEASUREMENT_A_TARGET ? "Austin" : ""}${austinEarned >= MEASUREMENT_A_TARGET && saEarned >= MEASUREMENT_A_TARGET ? " and " : ""}${saEarned >= MEASUREMENT_A_TARGET ? "San Antonio" : ""} — expanded local fuel clears 70% target.`,
    );
  } else {
    lines.push(
      `**Target not met at any granularity** even with expanded local-evaluable permit fuel. Austin ${(austinEarned * 100).toFixed(1)}%, SA ${(saEarned * 100).toFixed(1)}% read-grain (uniform q, coarsest section-plus-dependents). **Reversal threshold reached** for local-only fuel — remaining gap requires ICC historical I-Code ingest + tenant-leg adjudications (operator call).`,
    );
  }

  const outPath = join(
    INBOX,
    `${date}_legacy-design-tools_cc-agent-C_m1-v3-expanded-fuel-rerun.md`,
  );
  await writeFile(outPath, lines.join("\n"), "utf8");
  console.log("Wrote", outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
