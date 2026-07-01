/**
 * K2 v3 — partition local-evaluable permits + retrodiction + deposit expansion.
 *
 * Usage: pnpm --filter @workspace/scripts run measure:k2-v3
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import {
  resolveEditionInEffect,
  resolveLocalEditionInEffect,
  type EditionEffectiveDateTable,
  parseCsvToRecords,
  parseCsvLine,
  normalizeAustinVarianceRow,
  normalizeAustinPermitRow,
  normalizeSanAntonioVarianceRow,
  runRetrodictionCase,
  summarizeRetrodiction,
  type CorpusAtomRef,
  type K2BacktestDepositRow,
  tallyPermitPartition,
  type PermitPartitionCounts,
  classifyAustinPermitDomain,
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
  const { stdout } = await exec(GCLOUD, ["storage", "cat", gcsPath], {
    maxBuffer: 1024 * 1024 * 256,
    shell: true,
  });
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
};

function extractKeywords(body: string, section: string): string[] {
  const words = `${section} ${body}`
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 4);
  return [...new Set(words)].slice(0, 12);
}

async function loadCorpusRefs(jurisdiction: string): Promise<CorpusAtomRef[]> {
  const raw = await readFile(CORPUS_SNAPSHOT, "utf8");
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

  const proc = spawn(GCLOUD, ["storage", "cat", args.gcsPath], { shell: true });
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
      console.error(`  permits processed: ${rowNum - 1}, deposits: ${results.filter((r) => r.depositPayload).length}`);
    }
  }

  await new Promise<void>((resolve, reject) => {
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`gcloud exit ${code}`))));
    proc.on("error", reject);
  });

  return summarizeRetrodiction("austin_tx", results);
}

async function runVarianceBatch(args: {
  jurisdiction: string;
  editionTable: EditionEffectiveDateTable;
  corpusRefs: CorpusAtomRef[];
  varianceGcs: string;
  varianceNormalizer: typeof normalizeAustinVarianceRow;
}): Promise<{
  deposits: K2BacktestDepositRow[];
  summary: ReturnType<typeof summarizeRetrodiction>;
}> {
  const varianceCsv = await gcloudCat(args.varianceGcs);
  const varianceRows = parseCsvToRecords(varianceCsv);
  const results = varianceRows
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
    .filter((o): o is NonNullable<typeof o> => o != null)
    .map((o) => runRetrodictionCase(o, args.corpusRefs));

  const deposits = results
    .map((r) => r.depositPayload)
    .filter((d): d is K2BacktestDepositRow => d != null);

  return {
    deposits,
    summary: summarizeRetrodiction(args.jurisdiction, results),
  };
}

async function main() {
  await mkdir(INBOX, { recursive: true });
  await mkdir(OUTPUT_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);

  const austinEdition = await loadEditionTable("austin_tx");
  const saEdition = await loadEditionTable("san_antonio_tx");
  const austinRefs = await loadCorpusRefs("austin_tx");
  const saRefs = await loadCorpusRefs("san_antonio_tx");

  console.log("Variance + BOA retrodiction...");
  const austinVar = await runVarianceBatch({
    jurisdiction: "austin_tx",
    editionTable: austinEdition,
    corpusRefs: austinRefs,
    varianceGcs: `${GCS_ROOT}/backtest/austin_tx/variance/open_data/acquired=2026-06-21/data/board_of_adjustment_cases.csv`,
    varianceNormalizer: normalizeAustinVarianceRow,
  });
  const saVar = await runVarianceBatch({
    jurisdiction: "san_antonio_tx",
    editionTable: saEdition,
    corpusRefs: saRefs,
    varianceGcs: `${GCS_ROOT}/backtest/san_antonio_tx/variance/open_data/acquired=2026-06-21/data/board_of_adjustment_cases.csv`,
    varianceNormalizer: normalizeSanAntonioVarianceRow,
  });

  const partition: PermitPartitionCounts = {
    total: 0,
    localCodeEvaluable: 0,
    icodeDependent: 0,
    deferredAmbiguous: 0,
  };

  const permitDeposits: K2BacktestDepositRow[] = [];
  console.log("Streaming Austin permits (2.36M) — partition + local retrodiction...");
  const austinPermitSummary = await streamAustinPermits({
    gcsPath: `${GCS_ROOT}/backtest/austin_tx/permit/open_data/acquired=2026-06-21/data/issued_construction_permits.csv`,
    editionTable: austinEdition,
    corpusRefs: austinRefs,
    partition,
    onDeposit: (d) => permitDeposits.push(d),
  });

  const saPartition: PermitPartitionCounts = {
    total: 0,
    localCodeEvaluable: 0,
    icodeDependent: 0,
    deferredAmbiguous: 0,
  };

  const allDeposits = [
    ...austinVar.deposits,
    ...permitDeposits,
    ...saVar.deposits,
  ];

  const depositPath = join(OUTPUT_DIR, `k2-backtest-deposits-v3-${date}.json`);
  console.log(`Writing ${allDeposits.length} deposits...`);
  await writeFile(depositPath, JSON.stringify(allDeposits, null, 2), "utf8");

  const v2Deposits = 2116;
  const lines = [
    "---",
    `id: ${date}_legacy-design-tools_cc-agent-C_k2-v3-local-permit-expansion`,
    "title: K2 v3 — local-evaluable permit partition + retrodiction",
    `date: ${date}`,
    "agent: cc-agent-C",
    "repo: legacy-design-tools",
    "status: close",
    "---",
    "",
    "# K2 v3 local permit fuel expansion",
    "",
    "## Permit partition (Austin open-data)",
    "",
    `| Bucket | Count | Share |`,
    `|---|---:|---:|`,
    `| Total permits scanned | ${partition.total.toLocaleString()} | 100% |`,
    `| **Local-code-evaluable** | ${partition.localCodeEvaluable.toLocaleString()} | ${((partition.localCodeEvaluable / Math.max(1, partition.total)) * 100).toFixed(1)}% |`,
    `| I-Code-dependent (deferred) | ${partition.icodeDependent.toLocaleString()} | ${((partition.icodeDependent / Math.max(1, partition.total)) * 100).toFixed(1)}% |`,
    `| Ambiguous → I-Code bucket | ${partition.deferredAmbiguous.toLocaleString()} | ${((partition.deferredAmbiguous / Math.max(1, partition.total)) * 100).toFixed(1)}% |`,
    "",
    "## San Antonio permits",
    "",
    "**Not acquired** — portal scrape manifest has 2 xhr meta records only (~487K pending ingest). SA fuel = variance/BOA only this round.",
    "",
    "## K2 retrodiction summary",
    "",
    "| City | Source | Normalized | Local run | Deposited | Match rate |",
    "|---|---|---:|---:|---:|---:|",
    `| Austin | variance/BOA | ${austinVar.summary.normalized} | ${austinVar.summary.localCodeRun} | ${austinVar.summary.deposits} | ${austinVar.summary.matchRate?.toFixed(3) ?? "—"} |`,
    `| Austin | local permits | ${partition.localCodeEvaluable} | ${austinPermitSummary.localCodeRun} | ${austinPermitSummary.deposits} | ${austinPermitSummary.matchRate?.toFixed(3) ?? "—"} |`,
    `| San Antonio | variance/BOA | ${saVar.summary.normalized} | ${saVar.summary.localCodeRun} | ${saVar.summary.deposits} | ${saVar.summary.matchRate?.toFixed(3) ?? "—"} |`,
    "",
    "## Total backtest fuel",
    "",
    `- **v2 deposits**: ${v2Deposits}`,
    `- **v3 deposits**: **${allDeposits.length.toLocaleString()}** (+${(allDeposits.length - v2Deposits).toLocaleString()} from local-evaluable Austin permits)`,
    `- **Deposits file**: \`${depositPath}\``,
    "",
    "## Non-negotiables",
    "",
    "- Outcome disposition preserved: `issued-clean` / `with-condition` / `denied` on deposit payload",
    "- I-Code-dependent + ambiguous permits remain `pending-icc` (not retrodicted)",
    "- Local edition resolved via Wave 4 municode snapshot year windows (LDC/UDC)",
  ];

  const outPath = join(
    INBOX,
    `${date}_legacy-design-tools_cc-agent-C_k2-v3-local-permit-expansion.md`,
  );
  await writeFile(outPath, lines.join("\n"), "utf8");
  console.log("Wrote", outPath);
  console.log("Deposits:", depositPath, allDeposits.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
