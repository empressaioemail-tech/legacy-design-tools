/**
 * M1-C case-grain harness — K2 edition-correct retrodiction + M1 Measurement A/B.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run measure:m1-case-grain
 *   pnpm --filter @workspace/scripts run measure:m1-case-grain -- --fixtures
 *
 * Environment variables:
 *   CORPUS_SNAPSHOT_PATH — path to hauska-engine corpus snapshot (default: compat with prior harnesses)
 *   CALIBRATION_OUT_DIR — output directory for deposits JSON (default: ./artifacts/calibration-runs)
 *   GCLOUD_BIN — path to gcloud binary (default: C:\Users\cente\google-cloud-sdk\bin\gcloud.cmd)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
  loadCorpusForJurisdiction,
  runThreeMetricM1,
  decisionReadSlice,
  MEASUREMENT_A_TARGET,
  lambdaFromAmendments,
  resolveEffectiveLambda,
  type K2DepositLike,
  type AmendmentAtom,
  W_TARGET_ACTUATION,
} from "@workspace/calibration-engines/m1";

import {
  resolveEditionInEffect,
  resolveLocalEditionInEffect,
  type EditionEffectiveDateTable,
  parseCsvToRecords,
  parseCsvLine,
  normalizeAustinVarianceRow,
  normalizeAustinPermitRow,
  normalizeSanAntonioVarianceRow,
  normalizeSanAntonioPermitRow,
  runRetrodictionCase,
  summarizeRetrodiction,
  type CorpusAtomRef,
  type K2BacktestDepositRow,
  tallyPermitPartition,
  type PermitPartitionCounts,
  classifyAustinPermitDomain,
  classifySanAntonioPermitDomain,
} from "@workspace/calibration-engines/k2";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const DEFAULT_CORPUS_SNAPSHOT = "P:/hauska-engine/services/retrieval-api/corpus/snapshot.json";
const DEFAULT_OUT_DIR = "./artifacts/calibration-runs";
const DEFAULT_GCLOUD = "C:\\Users\\cente\\google-cloud-sdk\\bin\\gcloud.cmd";
// Report lands NEXT TO the deposits by default — never in an absolute path
// outside this clone (the prior harnesses wrote into the operator's persistent
// clone at P:/legacy-design-tools/_inbox; a task clone must not touch it).
const DEFAULT_INBOX = DEFAULT_OUT_DIR;

const GCS_ROOT = "gs://hauska-calibration-raw";

const CORPUS_SNAPSHOT_PATH = process.env.CORPUS_SNAPSHOT_PATH ?? DEFAULT_CORPUS_SNAPSHOT;
const CALIBRATION_OUT_DIR = process.env.CALIBRATION_OUT_DIR ?? DEFAULT_OUT_DIR;
const GCLOUD_BIN = process.env.GCLOUD_BIN ?? DEFAULT_GCLOUD;
const INBOX = process.env.INBOX ?? DEFAULT_INBOX;

const FIXTURES_MODE = process.argv.includes("--fixtures");

type SnapshotAtom = {
  entityType?: string;
  jurisdictionTenant?: string;
  sectionNumber?: string;
  body?: string;
  editionLabel?: string;
  effectiveDate?: string;
  sourceType?: string;
};

function fmtPct(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`;
}

async function gcloudCat(gcsPath: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const { stdout } = await exec(GCLOUD_BIN, ["storage", "cat", gcsPath], {
    maxBuffer: 1024 * 1024 * 256,
    shell: true,
  });
  return stdout;
}

async function loadEditionTable(jurisdiction: string): Promise<EditionEffectiveDateTable> {
  if (FIXTURES_MODE) {
    return {
      schemaVersion: "1.0",
      jurisdictionTenant: jurisdiction,
      table: [
        {
          editionId: "ldc-2025",
          codeFamily: "local",
          editionYear: 2025,
          effective_from: "2025-01-01",
          effective_to: null,
        },
      ],
    };
  }
  const raw = await gcloudCat(
    `${GCS_ROOT}/edition-bundle/${jurisdiction}/edition-effective-date-table.json`,
  );
  return JSON.parse(raw) as EditionEffectiveDateTable;
}

function extractKeywords(body: string, section: string): string[] {
  const words = `${section} ${body}`
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 4);
  return [...new Set(words)].slice(0, 12);
}

async function loadCorpusRefs(jurisdiction: string): Promise<CorpusAtomRef[]> {
  const snapshotPath = FIXTURES_MODE
    ? resolve(__dirname, "../../lib/calibration-engines/src/__fixtures__/k2-backtest-outcome-rows.json")
    : CORPUS_SNAPSHOT_PATH;

  const raw = await readFile(snapshotPath, "utf8");

  if (FIXTURES_MODE) {
    return [
      { atomId: "code-ibc-903-2-1", sectionNumber: "903.2.1", keywords: ["smoke", "fire"] },
      { atomId: "code-ibc-1004-1", sectionNumber: "1004.1", keywords: ["occupancy", "load"] },
    ];
  }

  const snap = JSON.parse(raw) as { atoms?: Record<string, SnapshotAtom> };
  return Object.entries(snap.atoms ?? {})
    .filter(
      ([, v]) =>
        v?.entityType === "code-section" && v.jurisdictionTenant === jurisdiction,
    )
    .map(([id, v]) => ({
      atomId: id,
      sectionNumber: v.sectionNumber ?? "",
      keywords: extractKeywords(v.body ?? "", v.sectionNumber ?? ""),
    }));
}

function toCaseDateIso(raw: string | undefined): string {
  if (!raw?.trim()) return "";
  const d = Date.parse(raw.trim().replace(/\//g, "-"));
  return Number.isFinite(d) ? new Date(d).toISOString() : "";
}

async function streamAustinPermits(args: {
  gcsPath: string;
  editionTable: EditionEffectiveDateTable;
  corpusRefs: CorpusAtomRef[];
  onDeposit: (d: K2BacktestDepositRow) => void;
  partition: PermitPartitionCounts;
}): Promise<ReturnType<typeof summarizeRetrodiction>> {
  const results: ReturnType<typeof runRetrodictionCase>[] = [];
  let headers: string[] = [];
  let rowNum = 0;

  const proc = spawn(GCLOUD_BIN, ["storage", "cat", args.gcsPath], { shell: true });
  const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (rowNum === 0) {
      headers = parseCsvLine(line);
      rowNum++;
      continue;
    }
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]!] = values[j] ?? "";
    }

    const domain = classifyAustinPermitDomain(row);
    tallyPermitPartition(domain, args.partition);

    if (domain !== "local-code-evaluable") {
      rowNum++;
      continue;
    }

    const edition = resolveLocalEditionInEffect(
      args.editionTable,
      toCaseDateIso(row["Issued Date"] ?? row["Applied Date"]),
      "austin_tx",
    );
    const normalized = normalizeAustinPermitRow(row, edition);
    if (!normalized) continue;

    const result = runRetrodictionCase(normalized, args.corpusRefs);
    results.push(result);
    if (result.depositPayload) args.onDeposit(result.depositPayload);

    rowNum++;
    if (rowNum % 100_000 === 0) {
      console.error(`  Austin permits processed: ${rowNum - 1}, deposits: ${results.filter((r) => r.depositPayload).length}`);
    }
  }

  await new Promise<void>((resolve, reject) => {
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`gcloud exit ${code}`))));
    proc.on("error", reject);
  });

  return summarizeRetrodiction("austin_tx", results);
}

async function loadVarianceCases(
  jurisdiction: string,
  editionTable: EditionEffectiveDateTable,
  corpusRefs: CorpusAtomRef[],
): Promise<K2BacktestDepositRow[]> {
  if (FIXTURES_MODE) {
    return [];
  }

  const gcsPath = `${GCS_ROOT}/backtest/${jurisdiction}/variance/open_data/acquired=2026-06-21/data/board_of_adjustment_cases.csv`;
  const raw = await gcloudCat(gcsPath);
  const records = parseCsvToRecords(raw);

  const normalizer = jurisdiction === "austin_tx"
    ? normalizeAustinVarianceRow
    : normalizeSanAntonioVarianceRow;

  const deposits: K2BacktestDepositRow[] = [];
  for (const row of records) {
    const edition = resolveEditionInEffect(
      editionTable,
      toCaseDateIso(row["Date"] ?? row["Application Date"]),
      "local",
    );
    const normalized = normalizer(row, edition);
    if (!normalized) continue;
    const result = runRetrodictionCase(normalized, corpusRefs);
    if (result.depositPayload) deposits.push(result.depositPayload);
  }

  return deposits;
}

async function loadSanAntonioPermits(
  editionTable: EditionEffectiveDateTable,
  corpusRefs: CorpusAtomRef[],
  partition: PermitPartitionCounts,
): Promise<K2BacktestDepositRow[]> {
  if (FIXTURES_MODE) {
    return [];
  }

  const deposits: K2BacktestDepositRow[] = [];
  const files = [
    "permits_issued_2020_2024.csv",
    "permits_issued_current.csv",
  ];

  for (const file of files) {
    const gcsPath = `${GCS_ROOT}/backtest/san_antonio_tx/permit/open_data/acquired=2026-06-21/data/${file}`;
    const raw = await gcloudCat(gcsPath);
    const records = parseCsvToRecords(raw);

    for (const row of records) {
      const domain = classifySanAntonioPermitDomain(row);
      tallyPermitPartition(domain, partition);

      if (domain !== "local-code-evaluable") continue;

      const edition = resolveLocalEditionInEffect(
        editionTable,
        toCaseDateIso(row["Issue Date"] ?? row["Application Date"]),
        "san_antonio_tx",
      );
      const normalized = normalizeSanAntonioPermitRow(row, edition);
      if (!normalized) continue;

      const result = runRetrodictionCase(normalized, corpusRefs);
      if (result.depositPayload) deposits.push(result.depositPayload);
    }
  }

  return deposits;
}

async function main() {
  console.log("=== M1-C case-grain harness ===");
  console.log(`Mode: ${FIXTURES_MODE ? "FIXTURES" : "GCS-backed"}`);
  console.log(
    `Corpus snapshot: ${FIXTURES_MODE ? "(fixtures — no snapshot read)" : CORPUS_SNAPSHOT_PATH}`,
  );
  console.log(`Output dir: ${CALIBRATION_OUT_DIR}`);
  console.log("");

  const snapshotPath = FIXTURES_MODE
    ? resolve(__dirname, "../../lib/calibration-engines/src/__fixtures__/k2-backtest-outcome-rows.json")
    : CORPUS_SNAPSHOT_PATH;

  const snapshotRaw = await readFile(snapshotPath, "utf8");
  let snapshot: { atoms?: Record<string, SnapshotAtom>; links?: unknown[] };

  if (FIXTURES_MODE) {
    snapshot = { atoms: {}, links: [] };
  } else {
    snapshot = JSON.parse(snapshotRaw) as { atoms?: Record<string, SnapshotAtom>; links?: unknown[] };
  }

  const amendmentAtomCount = Object.values(snapshot.atoms ?? {}).filter(
    (a) => a?.entityType === "code-amendment",
  ).length;

  console.log(`Amendment atoms in snapshot: ${amendmentAtomCount}`);
  if (!FIXTURES_MODE && amendmentAtomCount === 0) {
    console.error("\nERROR: Zero code-amendment atoms in snapshot — stale snapshot; blocked on dispatch E.");
    process.exit(1);
  }
  console.log("");

  await mkdir(CALIBRATION_OUT_DIR, { recursive: true });
  await mkdir(INBOX, { recursive: true });

  const allDeposits: K2BacktestDepositRow[] = [];
  const date = new Date().toISOString().slice(0, 10);

  if (FIXTURES_MODE) {
    const fixtureDeposits = JSON.parse(
      await readFile(
        resolve(__dirname, "../../lib/calibration-engines/src/__fixtures__/k2-backtest-outcome-rows.json"),
        "utf8",
      ),
    ) as K2DepositLike[];

    for (const d of fixtureDeposits) {
      allDeposits.push(d as K2BacktestDepositRow);
    }
  } else {
    console.log("Loading edition tables...");
    const austinEditionTable = await loadEditionTable("austin_tx");
    const saEditionTable = await loadEditionTable("san_antonio_tx");

    console.log("Loading corpus atom refs...");
    const austinCorpus = await loadCorpusRefs("austin_tx");
    const saCorpus = await loadCorpusRefs("san_antonio_tx");

    console.log(`Austin corpus: ${austinCorpus.length} atoms`);
    console.log(`San Antonio corpus: ${saCorpus.length} atoms`);
    console.log("");

    const austinPartition: PermitPartitionCounts = {
      total: 0,
      localCodeEvaluable: 0,
      icodeDependent: 0,
      deferredAmbiguous: 0,
    };
    const saPartition: PermitPartitionCounts = {
      total: 0,
      localCodeEvaluable: 0,
      icodeDependent: 0,
      deferredAmbiguous: 0,
    };

    console.log("Loading Austin variance cases...");
    const austinVariance = await loadVarianceCases("austin_tx", austinEditionTable, austinCorpus);
    allDeposits.push(...austinVariance);

    console.log("Loading San Antonio variance cases...");
    const saVariance = await loadVarianceCases("san_antonio_tx", saEditionTable, saCorpus);
    allDeposits.push(...saVariance);

    console.log("Streaming Austin permits (2.36M rows)...");
    const austinPermitSummary = await streamAustinPermits({
      gcsPath: `${GCS_ROOT}/backtest/austin_tx/permit/open_data/acquired=2026-06-21/data/issued_construction_permits.csv`,
      editionTable: austinEditionTable,
      corpusRefs: austinCorpus,
      onDeposit: (d) => allDeposits.push(d),
      partition: austinPartition,
    });

    console.log("Loading San Antonio permits...");
    const saPermitDeposits = await loadSanAntonioPermits(saEditionTable, saCorpus, saPartition);
    allDeposits.push(...saPermitDeposits);

    console.log("");
    console.log(`Austin partition: ${JSON.stringify(austinPartition)}`);
    console.log(`San Antonio partition: ${JSON.stringify(saPartition)}`);
    console.log("");
  }

  console.log(`Total deposits: ${allDeposits.length}`);

  const depositsPath = join(CALIBRATION_OUT_DIR, `k2-backtest-deposits-m1c-${date}.json`);
  await writeFile(depositsPath, JSON.stringify(allDeposits, null, 2), "utf8");
  console.log(`Wrote deposits: ${depositsPath}`);
  console.log("");

  console.log("=== M1 Measurement A/B ===");
  console.log("");

  const lines: string[] = [
    "---",
    `id: ${date}_legacy-design-tools_m1c_case-grain`,
    "title: M1-C — K2 edition-correct retrodiction + case-grain Measurement A/B",
    `date: ${date}`,
    "repo: legacy-design-tools",
    "status: close",
    "related: [m1-case-grain-recalibration, 05_measurement_spec, dispatch-E-wave4-edition-ingest]",
    "---",
    "",
    "# M1-C: K2 edition-correct retrodiction + case-grain Measurement A/B",
    "",
    `**Mode:** ${FIXTURES_MODE ? "FIXTURES (zero GCS/network)" : "GCS-backed (live fuel)"}`,
    "",
    "## Input provenance honesty",
    "",
    "| Input | Provenance | Notes |",
    "|---|---|---|",
  ];

  const results: ReturnType<typeof runThreeMetricM1>[] = [];

  for (const jurisdiction of ["austin_tx", "san_antonio_tx"] as const) {
    const { atoms, linkIndex } = loadCorpusForJurisdiction({
      snapshot: snapshot as Parameters<typeof loadCorpusForJurisdiction>[0]["snapshot"],
      jurisdictionTenant: jurisdiction,
      queryWeightMode: "uniform",
    });

    const jurisdictionDeposits = allDeposits.filter((d) =>
      (d.payload.subjectKey ?? d.entityId).includes(jurisdiction),
    );

    const amendmentHazards = lambdaFromAmendments({
      snapshot: snapshot as { atoms?: Record<string, AmendmentAtom> },
      jurisdictionTenant: jurisdiction,
      // No observationYears override: the util infers each jurisdiction's
      // window from its own amendment dates (Austin 12.81y vs SA 11.19y —
      // a shared override flattens the per-city hazards to one number).
    });

    let baseLambda = 0.02;
    let lambdaSource: "cold-start-prior" | "amendment-history" = "cold-start-prior";

    if (amendmentHazards.size > 0) {
      const jurisdictionHazard = amendmentHazards.get(jurisdiction);
      if (jurisdictionHazard) {
        baseLambda = jurisdictionHazard.rate;
        lambdaSource = jurisdictionHazard.source;
      }
    }

    const r = runThreeMetricM1({
      atoms,
      deposits: jurisdictionDeposits,
      entityIdToAtomId: linkIndex.entityIdToAtomId,
      jurisdictionTenant: jurisdiction,
      observationYears: 12,
      baseLambda,
      lambdaSource,
    });
    results.push(r);

    const city = jurisdiction === "austin_tx" ? "Austin" : "San Antonio";
    console.log(`${city}: ${jurisdictionDeposits.length} deposits, lambda=${baseLambda.toFixed(3)} (${lambdaSource})`);
  }

  lines.push(`| lambda (edition-bump hazard) | ${amendmentAtomCount > 0 ? "**amendment-history** (jurisdiction x family grain)" : "cold-start-prior (0.02/yr)"} | ${amendmentAtomCount} code-amendment atoms in corpus; ${amendmentAtomCount > 0 ? "computed from amendment effectiveDate range" : "per-section lambda remains cold-start (no ordinance-to-section mapping)"} |`);
  lines.push(`| q (query frequency) | **solved-for** (uniform) | F1 atom-grain attribution unavailable; only tool/finding-grain telemetry exists — fabricated weights disabled per 05 spec |`);
  lines.push(`| a (adjudication rate) | **observed** (backtest) | ${FIXTURES_MODE ? "Fixture" : "Austin + San Antonio variance/BOA + local-evaluable permits; Bastrop excluded (~2 rows)"} |`);
  lines.push(`| Consequence stratum | **unavailable** | F2 consequence metadata absent; all atoms stratum "II" (routine) — ICC ingest HELD |`);
  lines.push(`| Match rate | **outcome-label heuristic** | Approval-rate proxy, not substrate-prediction comparison (K3 outcomeDisposition: issued-clean/with-condition/denied/withdrawn/unknown) |`);
  lines.push("");

  for (const r of results) {
    const city = r.jurisdictionTenant === "austin_tx" ? "Austin" : "San Antonio";
    const slice = r.sliceByGranularity.find((g) => g.granularity === "section-plus-dependents")!;
    const corpusRead = r.corpusUniform.byGranularity.find(
      (g) => g.granularity === "section-plus-dependents",
    )!.earnedFractionAtReadGrain;

    lines.push(`## ${city}`);
    lines.push("");
    lines.push(`- Cases: ${r.caseCount.toLocaleString()} | match rate: ${fmtPct(r.caseMatchRate)}`);
    lines.push(`- Corpus atoms: ${r.coverage.corpusAtomCount}`);
    lines.push(`- Lambda: ${r.corpusUniform.lambdaPriorUsed.toFixed(3)}/yr (${r.corpusUniform.lambdaSource})`);
    lines.push("");

    lines.push("### Slice earned fraction — adjudication-weighted");
    lines.push("");
    lines.push("| Granularity | Slice earned (read+amendment) | Slice earned (read grain) | Corpus-uniform (read grain) |");
    lines.push("|---|---:|---:|---:|");
    for (const g of r.sliceByGranularity) {
      const corp = r.corpusUniform.byGranularity.find((x) => x.granularity === g.granularity)!;
      lines.push(
        `| ${g.granularity} | **${fmtPct(g.sliceEarnedFraction)}** | ${fmtPct(g.sliceEarnedFractionAtReadGrain)} | ${fmtPct(corp.earnedFractionAtReadGrain)} |`,
      );
    }
    lines.push("");

    lines.push("### Decision read");
    lines.push("");
    lines.push(decisionReadSlice(r));
    lines.push("");
  }

  lines.push("## Measurement B — high-consequence slice (deferred slot)");
  lines.push("");
  const mb = results[0]!.measurementB;
  lines.push("| Field | Value |");
  lines.push("|---|---|");
  lines.push(`| Status | **${mb.status}** |`);
  lines.push(`| Stratum | ${mb.stratum} |`);
  lines.push(`| W_actuation bar | ${mb.wTargetActuation} |`);
  lines.push(`| High-consequence atoms identified | ${mb.highConsequenceAtomCount} |`);
  lines.push(`| ICC fuel required | ${mb.iccFuelRequired} |`);
  lines.push("");
  lines.push(mb.reason);
  lines.push("");

  lines.push("## Conditions A & B");
  lines.push("");
  lines.push("**Condition A** (provenance honesty):");
  lines.push("");
  for (const r of results) {
    const city = r.jurisdictionTenant === "austin_tx" ? "Austin" : "San Antonio";
    lines.push(`### ${city}`);
    lines.push("");
    lines.push("| Provenance class | Count | Meaning |");
    lines.push("|---|---:|---|");
    lines.push(`| earned-slice-own | ${r.coverage.provenanceByClass["earned-slice-own"]} | own-earned at atom grain, cited |`);
    lines.push(`| earned-slice-pooled | ${r.coverage.provenanceByClass["earned-slice-pooled"]} | pooled-applied with adjudicated pool signal |`);
    lines.push(`| adjudicated-not-earned | ${r.coverage.provenanceByClass["adjudicated-not-earned"]} | cited; width ≥ W_target or n<3 |`);
    lines.push(`| asserted-tail | ${r.coverage.provenanceByClass["asserted-tail"]} | zero adjudication; asserted prior only |`);
    lines.push("");
  }

  lines.push("**Condition B** (public partition only): Family pooling draws only `PUBLIC_PARTITION` (__public__) signal; tenant-private adjudications excluded.");
  lines.push("");

  const outPath = join(INBOX, `${date}_legacy-design-tools_m1c_case-grain.md`);
  await writeFile(outPath, lines.join("\n"), "utf8");
  console.log("");
  console.log(`Wrote report: ${outPath}`);

  console.log("\n=== Summary ===");
  for (const r of results) {
    const slice = r.sliceByGranularity.find((g) => g.granularity === "section-plus-dependents")!;
    console.log(
      r.jurisdictionTenant,
      "slice:",
      (slice.sliceEarnedFractionAtReadGrain * 100).toFixed(1) + "%",
      "lambda:",
      r.corpusUniform.lambdaPriorUsed.toFixed(3),
      `(${r.corpusUniform.lambdaSource})`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
