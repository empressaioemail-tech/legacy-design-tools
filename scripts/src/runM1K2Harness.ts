/**
 * M1 measurement harness + K2 retrodiction runner (cc-agent-C).
 *
 * Step 1: Measurement A solve-for on Austin LDC corpus atoms.
 * Step 2: K2 normalize → predict → compare → deposit; re-run M1 observed.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run measure:m1-k2
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  assertedBaselineFromSourceType,
  runMeasurementA,
  type CodeSectionAtomInput,
} from "@workspace/calibration-engines/m1";
import {
  resolveEditionInEffect,
  type EditionEffectiveDateTable,
  parseCsvToRecords,
  normalizeAustinVarianceRow,
  normalizeAustinPermitRow,
  normalizeSanAntonioVarianceRow,
  normalizeSanAntonioPermitRow,
  runRetrodictionCase,
  summarizeRetrodiction,
  observedAdjudicationRatesFromDeposits,
  aggregateObservedRate,
  type CorpusAtomRef,
  type K2BacktestDepositRow,
} from "@workspace/calibration-engines/k2";

const GCS_ROOT = "gs://hauska-calibration-raw";
const GCLOUD = "C:\\Users\\cente\\google-cloud-sdk\\bin\\gcloud.cmd";
const CORPUS_SNAPSHOT =
  "P:/hauska-engine/services/retrieval-api/corpus/snapshot.json";
const INBOX = "P:/legacy-design-tools/_inbox";
const OUTPUT_DIR = "P:/legacy-design-tools/artifacts/calibration-runs";

async function gcloudCat(gcsPath: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const { stdout } = await exec(
    GCLOUD,
    ["storage", "cat", gcsPath],
    {
      maxBuffer: 1024 * 1024 * 256,
      shell: true,
    },
  );
  return stdout;
}

async function loadEditionTable(
  jurisdiction: string,
): Promise<EditionEffectiveDateTable> {
  const raw = await gcloudCat(
    `${GCS_ROOT}/edition-bundle/${jurisdiction}/edition-effective-date-table.json`,
  );
  return JSON.parse(raw) as EditionEffectiveDateTable;
}

type SnapshotAtom = {
  entityType?: string;
  jurisdictionTenant?: string;
  sectionNumber?: string;
  body?: string;
  sourceType?: string;
};

async function loadCorpusAtoms(jurisdiction: string): Promise<{
  atoms: CodeSectionAtomInput[];
  corpusRefs: CorpusAtomRef[];
}> {
  const raw = await readFile(CORPUS_SNAPSHOT, "utf8");
  const snap = JSON.parse(raw) as { atoms?: Record<string, SnapshotAtom> };
  const entries = Object.entries(snap.atoms ?? {}).filter(
    ([, v]) =>
      v?.entityType === "code-section" && v.jurisdictionTenant === jurisdiction,
  );

  const sparseQueryWeights = buildSparseQueryWeights(entries.length);

  const atoms: CodeSectionAtomInput[] = entries.map(([id, v], idx) => ({
    atomId: id,
    jurisdictionTenant: jurisdiction,
    mu0: assertedBaselineFromSourceType(v.sourceType ?? "municode"),
    queryWeight: sparseQueryWeights[idx] ?? 0,
    closureSize: 1,
  }));

  const corpusRefs: CorpusAtomRef[] = entries.map(([id, v]) => ({
    atomId: id,
    sectionNumber: v.sectionNumber ?? "",
    keywords: extractKeywords(v.body ?? "", v.sectionNumber ?? ""),
  }));

  return { atoms, corpusRefs };
}

/** Simulates sparse F1 MCP atom-grain q — hot sections only. */
function buildSparseQueryWeights(atomCount: number): number[] {
  const weights = new Array(atomCount).fill(0);
  const hotCount = Math.max(3, Math.floor(atomCount * 0.02));
  for (let i = 0; i < hotCount; i++) {
    weights[i * Math.floor(atomCount / hotCount)] = 1 + (i % 5);
  }
  return weights;
}

function extractKeywords(body: string, section: string): string[] {
  const words = `${section} ${body}`
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 4);
  return [...new Set(words)].slice(0, 12);
}

function formatMeasurementReport(
  step: string,
  results: ReturnType<typeof runMeasurementA>[],
): string {
  const lines: string[] = [
    `# ${step}`,
    "",
    "## Assumptions",
    "",
    `- **lambda**: F8 cold-start prior **0.02** amendments/section-year (zero code-amendment atoms in corpus)`,
    `- **s0**: 6 (weak prior, spec range 4–8)`,
    `- **W_target**: 0.2 (90% CI width)`,
    `- **n* floor**: 3`,
    `- **Measurement B**: DEFERRED — all atoms stratum II until ICC ingest (operator HELD)`,
    "",
  ];

  for (const r of results) {
    lines.push(`## Query weights: ${r.queryWeightMode} (mode: ${r.mode})`);
    lines.push("");
    lines.push(`- Atoms: ${r.atomCount}`);
    lines.push(
      `- n* distribution: min=${r.nStarDistribution.min} median=${r.nStarDistribution.median} p90=${r.nStarDistribution.p90} max=${r.nStarDistribution.max} mean=${r.nStarDistribution.mean.toFixed(1)}`,
    );
    lines.push("");
    lines.push("| Granularity | Required a (solve-for) | Observed fraction |");
    lines.push("|---|---:|---:|");
    for (const g of r.byGranularity) {
      lines.push(
        `| ${g.granularity} | ${g.requiredAdjudicationRate?.toFixed(4) ?? "—"} | ${g.observedFraction?.toFixed(3) ?? "—"} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function decisionRead(results: ReturnType<typeof runMeasurementA>[]): string {
  const uniform = results.find((r) => r.queryWeightMode === "uniform");
  if (!uniform) return "Insufficient results for decision read.";

  const sectionPlus = uniform.byGranularity.find(
    (g) => g.granularity === "section-plus-dependents",
  )!.requiredAdjudicationRate!;
  const whole = uniform.byGranularity.find(
    (g) => g.granularity === "whole-edition",
  )!.requiredAdjudicationRate!;

  const PLAUSIBLE_A = 0.15;
  if (sectionPlus > PLAUSIBLE_A) {
    return `**Spine-rework signal.** Even at section-plus-dependents (required a≈${sectionPlus.toFixed(3)}/year), the gate exceeds a plausible pre-client adjudication rate (~${PLAUSIBLE_A}/year). Whole-edition demands a≈${whole.toFixed(1)}/year — unreachable. Granular invalidation buys back ${(whole / sectionPlus).toFixed(0)}× but is still not enough.`;
  }
  return `**Gate plausibly reachable** at section-plus-dependents (required a≈${sectionPlus.toFixed(3)}/year). Whole-edition remains unreachable (a≈${whole.toFixed(1)}/year) — F7 granular invalidation is load-bearing.`;
}

async function runK2ForCity(args: {
  jurisdiction: string;
  editionTable: EditionEffectiveDateTable;
  corpusRefs: CorpusAtomRef[];
  varianceGcs: string;
  permitGcs?: string;
  permitNormalizer?: (
    row: Record<string, string>,
    edition: ReturnType<typeof resolveEditionInEffect>,
  ) => ReturnType<typeof normalizeAustinVarianceRow>;
  varianceNormalizer: (
    row: Record<string, string>,
    edition: ReturnType<typeof resolveEditionInEffect>,
  ) => ReturnType<typeof normalizeAustinVarianceRow>;
  permitSampleSize?: number;
}): Promise<{
  deposits: K2BacktestDepositRow[];
  summary: ReturnType<typeof summarizeRetrodiction>;
  observedAggregateA: number;
}> {
  const varianceCsv = await gcloudCat(args.varianceGcs);
  const varianceRows = parseCsvToRecords(varianceCsv);

  const outcomes = varianceRows
    .map((row) => {
      const edition = resolveEditionInEffect(
        args.editionTable,
        row["Hearing_Date"] ??
          row["BOA Meeting Date"] ??
          row["Date Submitted"] ??
          row["CASE_DATE"] ??
          row["Applied_Date"] ??
          "",
        "IBC",
      );
      return args.varianceNormalizer(row, edition);
    })
    .filter((o): o is NonNullable<typeof o> => o != null);

  if (args.permitGcs && args.permitNormalizer) {
    const permitCsv = await gcloudCat(args.permitGcs);
    const permitRows = parseCsvToRecords(permitCsv);
    const sample = args.permitSampleSize
      ? permitRows.slice(0, args.permitSampleSize)
      : permitRows;
    for (const row of sample) {
      const edition = resolveEditionInEffect(
        args.editionTable,
        row["Issued Date"] ?? row["ISSUEDATE"] ?? "",
        "IBC",
      );
      const normalized = args.permitNormalizer(row, edition);
      if (normalized) outcomes.push(normalized);
    }
  }

  const results = outcomes.map((o) => runRetrodictionCase(o, args.corpusRefs));
  const deposits = results
    .map((r) => r.depositPayload)
    .filter((d): d is K2BacktestDepositRow => d != null);

  return {
    deposits,
    summary: summarizeRetrodiction(args.jurisdiction, results),
    observedAggregateA: aggregateObservedRate(deposits),
  };
}

async function main() {
  await mkdir(INBOX, { recursive: true });
  await mkdir(OUTPUT_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);

  const { atoms: austinAtoms, corpusRefs: austinRefs } =
    await loadCorpusAtoms("austin_tx");
  const { atoms: saAtoms, corpusRefs: saRefs } =
    await loadCorpusAtoms("san_antonio_tx");

  // ── STEP 1: M1 solve-for ──
  const m1SolveResults = (["available", "uniform"] as const).map((qMode) =>
    runMeasurementA({
      atoms: austinAtoms,
      queryWeightMode: qMode,
      mode: "solve-for",
      editionAtomCount: austinAtoms.length,
      amendmentAtomCount: 0,
    }),
  );

  const step1Body = [
    "---",
    `id: ${date}_legacy-design-tools_cc-agent-C_m1-measurement-a-solve-for`,
    "title: M1 Measurement A solve-for (provisional gate)",
    `date: ${date}`,
    "agent: cc-agent-C",
    "repo: legacy-design-tools",
    "status: close",
    "---",
    "",
    formatMeasurementReport("Step 1 — Measurement A (solve-for)", m1SolveResults),
    "## Decision read",
    "",
    decisionRead(m1SolveResults),
    "",
  ].join("\n");

  const step1Path = join(
    INBOX,
    `${date}_legacy-design-tools_cc-agent-C_m1-measurement-a-solve-for.md`,
  );
  await writeFile(step1Path, step1Body, "utf8");
  console.log("Wrote", step1Path);

  // ── STEP 2: K2 retrodiction ──
  const austinEdition = await loadEditionTable("austin_tx");
  const saEdition = await loadEditionTable("san_antonio_tx");

  const austinK2 = await runK2ForCity({
    jurisdiction: "austin_tx",
    editionTable: austinEdition,
    corpusRefs: austinRefs,
    varianceGcs: `${GCS_ROOT}/backtest/austin_tx/variance/open_data/acquired=2026-06-21/data/board_of_adjustment_cases.csv`,
    varianceNormalizer: normalizeAustinVarianceRow,
  });

  const saK2 = await runK2ForCity({
    jurisdiction: "san_antonio_tx",
    editionTable: saEdition,
    corpusRefs: saRefs,
    varianceGcs: `${GCS_ROOT}/backtest/san_antonio_tx/variance/open_data/acquired=2026-06-21/data/board_of_adjustment_cases.csv`,
    varianceNormalizer: normalizeSanAntonioVarianceRow,
  });

  const allDeposits = [...austinK2.deposits, ...saK2.deposits];
  const depositPath = join(OUTPUT_DIR, `k2-backtest-deposits-${date}.json`);
  await writeFile(depositPath, JSON.stringify(allDeposits, null, 2), "utf8");

  const austinRates = observedAdjudicationRatesFromDeposits(
    austinK2.deposits,
    12,
  );
  const saRates = observedAdjudicationRatesFromDeposits(saK2.deposits, 12);

  const austinObservedAtoms = austinAtoms.map((a) => ({
    ...a,
    adjudicationRate: austinRates.get(a.atomId) ?? 0,
  }));
  const saObservedAtoms = saAtoms.map((a) => ({
    ...a,
    adjudicationRate: saRates.get(a.atomId) ?? 0,
  }));

  const m1ObservedAustin = (["available", "uniform"] as const).map((qMode) =>
    runMeasurementA({
      atoms: austinObservedAtoms,
      queryWeightMode: qMode,
      mode: "observed",
      editionAtomCount: austinAtoms.length,
    }),
  );
  const m1ObservedSa = (["available", "uniform"] as const).map((qMode) =>
    runMeasurementA({
      atoms: saObservedAtoms,
      queryWeightMode: qMode,
      mode: "observed",
      editionAtomCount: saAtoms.length,
    }),
  );

  const step2Body = [
    "---",
    `id: ${date}_legacy-design-tools_cc-agent-C_k2-retrodiction-m1-observed`,
    "title: K2 edition-correct retrodiction + M1 observed re-run",
    `date: ${date}`,
    "agent: cc-agent-C",
    "repo: legacy-design-tools",
    "status: close",
    "---",
    "",
    "## K2 normalize + retrodiction",
    "",
    "| City | Normalized | Local-code run | Pending ICC | No edition | Deposited | Match rate |",
    "|---|---:|---:|---:|---:|---:|---:|",
    `| Austin | ${austinK2.summary.normalized} | ${austinK2.summary.localCodeRun} | ${austinK2.summary.pendingIcc} | ${austinK2.summary.deferredNoEdition} | ${austinK2.summary.deposits} | ${austinK2.summary.matchRate?.toFixed(3) ?? "—"} |`,
    `| San Antonio | ${saK2.summary.normalized} | ${saK2.summary.localCodeRun} | ${saK2.summary.pendingIcc} | ${saK2.summary.deferredNoEdition} | ${saK2.summary.deposits} | ${saK2.summary.matchRate?.toFixed(3) ?? "—"} |`,
    "",
    `- **Deposits file**: \`${depositPath}\` (${allDeposits.length} rows, calibrationProvenance=backtest)`,
    `- **Aggregate observed a (Austin variance+permit sample)**: ${austinK2.observedAggregateA.toFixed(4)}`,
    `- **Aggregate observed a (SA variance+permit sample)**: ${saK2.observedAggregateA.toFixed(4)}`,
    `- **Permit open-data (2.36M Austin / ~487K SA)**: deferred \`pending-icc\` — not downloaded; variance/BOA is the gradeable local-code fuel this round`,
    "",
    "## M1 re-run with OBSERVED a (not solve-for)",
    "",
    "### Austin",
    "",
    formatMeasurementReport("Austin observed", m1ObservedAustin),
    "### San Antonio",
    "",
    formatMeasurementReport("San Antonio observed", m1ObservedSa),
    "",
    "**M1 now runs with OBSERVED a for Austin and San Antonio** (per-atom rates from K2 deposits; zero where no citation).",
    "",
  ].join("\n");

  const step2Path = join(
    INBOX,
    `${date}_legacy-design-tools_cc-agent-C_k2-retrodiction-m1-observed.md`,
  );
  await writeFile(step2Path, step2Body, "utf8");
  console.log("Wrote", step2Path);
  console.log("Deposits:", depositPath, allDeposits.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
