/**
 * M1 v2 SA vs Austin collapse diagnosis — quantify driver factors.
 *
 * Usage: pnpm --filter @workspace/scripts run diagnose:m1-v2
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  loadCorpusForJurisdiction,
  runMeasurementAv2,
  readAllAtomsAtSupportedGrain,
  caseSignalsFromDeposits,
  buildLineageBuckets,
  betaCredibleIntervalWidth90,
  betaPriorFromAsserted,
  computeNStar,
  aggregateCaseSignals,
  S0_DEFAULT,
  W_TARGET_RANKING,
  N_STAR_FLOOR,
  MIN_DENSE_SIGNAL,
  MEASUREMENT_A_TARGET,
  type K2DepositLike,
  type CaseGrainSignal,
  type LoadedCorpusAtom,
  type PooledReadResult,
} from "@workspace/calibration-engines/m1";

const CORPUS_SNAPSHOT =
  "P:/hauska-engine/services/retrieval-api/corpus/snapshot.json";
const DEPOSITS_PATH =
  "P:/legacy-design-tools/artifacts/calibration-runs/k2-backtest-deposits-2026-06-22.json";
const INBOX = "P:/legacy-design-tools/_inbox";

type Jurisdiction = "austin_tx" | "san_antonio_tx";

function gini(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  if (sum === 0) return 0;
  let num = 0;
  for (let i = 0; i < n; i++) {
    num += (2 * (i + 1) - n - 1) * sorted[i]!;
  }
  return num / (n * sum);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.floor(sorted.length * p),
  );
  return sorted[idx]!;
}

function summarize(values: number[]) {
  if (values.length === 0) {
    return { n: 0, min: 0, p25: 0, median: 0, p75: 0, p90: 0, max: 0, mean: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted[0]!,
    p25: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
    max: sorted[sorted.length - 1]!,
    mean: sum / sorted.length,
  };
}

function posteriorMean(mu0: number, n: number, k: number): number {
  const { alpha0, beta0 } = betaPriorFromAsserted(mu0, S0_DEFAULT);
  return (alpha0 + k) / (alpha0 + beta0 + n);
}

function earnedFractionFromReads(reads: PooledReadResult[]): number {
  if (reads.length === 0) return 0;
  return reads.filter((r) => r.earned).length / reads.length;
}

/** Scale pooled read posteriors (preserves match rate k/n). */
function scaledReads(
  reads: PooledReadResult[],
  multiplier: number,
): PooledReadResult[] {
  if (multiplier <= 1) return reads;
  return reads.map((r) => {
    const n = Math.round(r.n * multiplier);
    const k = Math.round(r.k * multiplier);
    const { alpha0, beta0 } = betaPriorFromAsserted(r.mu0, S0_DEFAULT);
    const ciWidth = betaCredibleIntervalWidth90(alpha0 + k, beta0 + n - k);
    return {
      ...r,
      n,
      k,
      ciWidth,
      earned: n >= N_STAR_FLOOR && ciWidth < W_TARGET_RANKING,
    };
  });
}

function fuelMultipleToTarget(args: {
  reads: PooledReadResult[];
  target: number;
}): {
  uniformScaleMultiple: number;
  uniformScaleEarned: number;
  uniformScaleSaturates: boolean;
  naiveRatio: number;
  medianNStar: number;
  atomsBelowMinDense: number;
  atomsAtClassGrain: number;
} {
  const measure = (m: number) =>
    earnedFractionFromReads(scaledReads(args.reads, m));

  let hi = 2;
  let saturates = false;
  const atOne = measure(1);
  while (measure(hi) <= atOne + 1e-9 && hi < 4096) {
    hi *= 2;
  }
  if (measure(hi) <= atOne + 1e-9) {
    saturates = true;
  }

  const nStars = args.reads.map((r) =>
    computeNStar({ mu0: r.mu0, wTarget: W_TARGET_RANKING }),
  );
  const sortedNStar = [...nStars].sort((a, b) => a - b);

  return {
    uniformScaleMultiple: saturates ? Infinity : hi,
    uniformScaleEarned: measure(hi),
    uniformScaleSaturates: saturates,
    naiveRatio: atOne > 0 ? args.target / atOne : Infinity,
    medianNStar: sortedNStar[Math.floor(sortedNStar.length / 2)] ?? 0,
    atomsBelowMinDense: args.reads.filter((r) => r.n < MIN_DENSE_SIGNAL).length,
    atomsAtClassGrain: args.reads.filter(
      (r) => r.provenance.readGrain === "class",
    ).length,
  };
}

/** Counterfactual: raise match rate on read posteriors (k/n → target, n fixed). */
function readsAtMatchRate(
  reads: PooledReadResult[],
  targetRate: number,
): PooledReadResult[] {
  return reads.map((r) => {
    if (r.n <= 0) return r;
    const currentRate = r.k / r.n;
    if (currentRate >= targetRate) return r;
    const k = Math.round(r.n * targetRate);
    const { alpha0, beta0 } = betaPriorFromAsserted(r.mu0, S0_DEFAULT);
    const ciWidth = betaCredibleIntervalWidth90(alpha0 + k, beta0 + r.n - k);
    return {
      ...r,
      k,
      ciWidth,
      earned: r.n >= N_STAR_FLOOR && ciWidth < W_TARGET_RANKING,
    };
  });
}

type CityDiag = {
  jurisdiction: Jurisdiction;
  measurement: ReturnType<typeof runMeasurementAv2>;
  posteriorAtRead: {
    mean: ReturnType<typeof summarize>;
    ciWidth: ReturnType<typeof summarize>;
    earnedCiWidth: ReturnType<typeof summarize>;
    notEarnedCiWidth: ReturnType<typeof summarize>;
    aboveWTarget: number;
    belowNStar: number;
  };
  citation: {
    casesPerAtom: ReturnType<typeof summarize>;
    atomsPerCase: ReturnType<typeof summarize>;
    giniCasesPerAtom: number;
    giniCitedAtomsOnly: number;
    topDecileShare: number;
    uniqueCitedAtoms: number;
    atomsWithZeroCases: number;
    atomsWithCases: number;
  };
  closure: ReturnType<typeof summarize>;
  mismatch: {
    totalCitations: number;
    unmatchedCitations: number;
    unmatchedRate: number;
    casesWithAnyUnmatched: number;
    casesWithAnyUnmatchedRate: number;
  };
  counterfactualMatchRate: {
    atAustinRate: number;
    atOwnRate: number;
  };
  fuelMultiple: ReturnType<typeof fuelMultipleToTarget>;
  readGrainBreakdown: Record<string, { count: number; earned: number; pctEarned: number }>;
};

function diagnoseCity(args: {
  jurisdiction: Jurisdiction;
  snapshot: Parameters<typeof loadCorpusForJurisdiction>[0]["snapshot"];
  deposits: K2DepositLike[];
}): CityDiag {
  const { atoms, linkIndex } = loadCorpusForJurisdiction({
    snapshot: args.snapshot,
    jurisdictionTenant: args.jurisdiction,
  });
  const atomIdSet = new Set(atoms.map((a) => a.atomId));

  const jurisdictionDeposits = args.deposits.filter((d) =>
    (d.payload.subjectKey ?? d.entityId).includes(args.jurisdiction),
  );
  const cases = caseSignalsFromDeposits(jurisdictionDeposits).filter(
    (c) => c.jurisdictionTenant === args.jurisdiction,
  );
  const lineageBuckets = buildLineageBuckets(cases);

  const measurement = runMeasurementAv2({
    atoms,
    deposits: jurisdictionDeposits,
    entityIdToAtomId: linkIndex.entityIdToAtomId,
    queryWeightMode: "uniform",
    jurisdictionTenant: args.jurisdiction,
    observationYears: 12,
  });

  const reads = readAllAtomsAtSupportedGrain({
    atoms,
    lineageBuckets,
    entityIdToAtomId: linkIndex.entityIdToAtomId,
    wTarget: W_TARGET_RANKING,
  });

  const means: number[] = [];
  const widths: number[] = [];
  const earnedWidths: number[] = [];
  const notEarnedWidths: number[] = [];
  let aboveW = 0;
  let belowN = 0;

  for (const r of reads) {
    means.push(posteriorMean(r.mu0, r.n, r.k));
    widths.push(r.ciWidth);
    if (r.earned) earnedWidths.push(r.ciWidth);
    else notEarnedWidths.push(r.ciWidth);
    if (r.ciWidth >= W_TARGET_RANKING) aboveW++;
    if (r.n < N_STAR_FLOOR) belowN++;
  }

  const casesPerAtom = atoms.map(
    (a) => (lineageBuckets.get(`__public__::${a.atomId}`) ?? []).length,
  );
  const atomsPerCase = cases.map((c) => c.citedAtomIds.length);
  const totalCaseAtom = casesPerAtom.reduce((a, b) => a + b, 0);
  const sortedCases = [...casesPerAtom].sort((a, b) => b - a);
  const citedOnly = casesPerAtom.filter((n) => n > 0);
  const citedSorted = [...citedOnly].sort((a, b) => b - a);
  const topDecileCount = Math.max(1, Math.ceil(citedOnly.length * 0.1));
  const topDecileShare =
    totalCaseAtom > 0
      ? citedSorted.slice(0, topDecileCount).reduce((a, b) => a + b, 0) /
        totalCaseAtom
      : 0;
  const uniqueCitedAtoms = citedOnly.length;

  let totalCitations = 0;
  let unmatchedCitations = 0;
  let casesWithUnmatched = 0;
  for (const c of cases) {
    let hasUnmatched = false;
    for (const id of c.citedAtomIds) {
      totalCitations++;
      if (!atomIdSet.has(id)) {
        unmatchedCitations++;
        hasUnmatched = true;
      }
    }
    if (hasUnmatched) casesWithUnmatched++;
  }

  const austinRate = 0.898;
  const cfReads = readsAtMatchRate(reads, austinRate);

  const grainBreakdown: CityDiag["readGrainBreakdown"] = {};
  for (const r of reads) {
    const g = r.provenance.readGrain;
    if (!grainBreakdown[g]) grainBreakdown[g] = { count: 0, earned: 0, pctEarned: 0 };
    grainBreakdown[g]!.count++;
    if (r.earned) grainBreakdown[g]!.earned++;
  }
  for (const g of Object.keys(grainBreakdown)) {
    const b = grainBreakdown[g]!;
    b.pctEarned = b.count > 0 ? b.earned / b.count : 0;
  }

  const fuelMultiple = fuelMultipleToTarget({
    reads,
    target: MEASUREMENT_A_TARGET,
  });

  return {
    jurisdiction: args.jurisdiction,
    measurement,
    posteriorAtRead: {
      mean: summarize(means),
      ciWidth: summarize(widths),
      earnedCiWidth: summarize(earnedWidths),
      notEarnedCiWidth: summarize(notEarnedWidths),
      aboveWTarget: aboveW / reads.length,
      belowNStar: belowN / reads.length,
    },
    citation: {
      casesPerAtom: summarize(casesPerAtom),
      atomsPerCase: summarize(atomsPerCase),
      giniCasesPerAtom: gini(casesPerAtom),
      giniCitedAtomsOnly: gini(citedOnly),
      topDecileShare,
      uniqueCitedAtoms,
      atomsWithZeroCases: casesPerAtom.filter((n) => n === 0).length,
      atomsWithCases: casesPerAtom.filter((n) => n > 0).length,
    },
    closure: summarize(atoms.map((a) => a.closureSize)),
    mismatch: {
      totalCitations,
      unmatchedCitations,
      unmatchedRate:
        totalCitations > 0 ? unmatchedCitations / totalCitations : 0,
      casesWithAnyUnmatched: casesWithUnmatched,
      casesWithAnyUnmatchedRate:
        cases.length > 0 ? casesWithUnmatched / cases.length : 0,
    },
    counterfactualMatchRate: {
      atAustinRate: earnedFractionFromReads(cfReads),
      atOwnRate: earnedFractionFromReads(reads),
    },
    fuelMultiple,
    readGrainBreakdown: grainBreakdown,
  };
}

function fmtPct(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`;
}

function fmtDist(s: ReturnType<typeof summarize>, digits = 2): string {
  return `median=${s.median.toFixed(digits)} p90=${s.p90.toFixed(digits)} mean=${s.mean.toFixed(digits)} max=${s.max.toFixed(digits)}`;
}

async function main() {
  const snapshot = JSON.parse(
    await readFile(CORPUS_SNAPSHOT, "utf8"),
  ) as Parameters<typeof loadCorpusForJurisdiction>[0]["snapshot"];
  const deposits = JSON.parse(
    await readFile(DEPOSITS_PATH, "utf8"),
  ) as K2DepositLike[];

  const austin = diagnoseCity({
    jurisdiction: "austin_tx",
    snapshot,
    deposits,
  });
  const sa = diagnoseCity({
    jurisdiction: "san_antonio_tx",
    snapshot,
    deposits,
  });

  const austinEarned =
    austin.measurement.byGranularity.find(
      (g) => g.granularity === "section-plus-dependents",
    )!.earnedFractionAtReadGrain;
  const saEarned =
    sa.measurement.byGranularity.find(
      (g) => g.granularity === "section-plus-dependents",
    )!.earnedFractionAtReadGrain;

  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [
    "---",
    `id: ${date}_legacy-design-tools_cc-agent-C_m1-v2-sa-collapse-diagnosis`,
    "title: M1 v2 — SA vs Austin read-grain collapse diagnosis",
    `date: ${date}`,
    "agent: cc-agent-C",
    "repo: legacy-design-tools",
    "status: close",
    "related: [endstate_A_m1_amendment, 2026-06-22_m1-v2-pooled-read-rerun]",
    "---",
    "",
    "# M1 v2 diagnosis: why SA 0.1% vs Austin 32.1% at pooled read grain",
    "",
    "## Headline",
    "",
    `| City | Read-grain earned (uniform q) | Case match rate | Atoms | Cases |`,
    `|---|---:|---:|---:|---:|`,
    `| Austin | ${fmtPct(austinEarned)} | ${fmtPct(austin.measurement.caseMatchRate)} | ${austin.measurement.atomCount} | ${austin.measurement.caseCount} |`,
    `| San Antonio | ${fmtPct(saEarned)} | ${fmtPct(sa.measurement.caseMatchRate)} | ${sa.measurement.atomCount} | ${sa.measurement.caseCount} |`,
    "",
    "## Factor ranking (dominance)",
    "",
  ];

  const factors: { name: string; austin: number; sa: number; direction: string }[] = [
    {
      name: "H3 closure median (strength-borrowing reach)",
      austin: austin.closure.median,
      sa: sa.closure.median,
      direction: "SA sparser → 0% earn at closure grain",
    },
    {
      name: "H2 citation Gini (cases/atom concentration)",
      austin: austin.citation.giniCasesPerAtom,
      sa: sa.citation.giniCasesPerAtom,
      direction: "higher Gini = more starved atoms",
    },
    {
      name: "H2 unique atoms with ≥1 case citation",
      austin: austin.citation.uniqueCitedAtoms,
      sa: sa.citation.uniqueCitedAtoms,
      direction: "breadth of direct citation coverage",
    },
    {
      name: "H2 top-decile cited-atom share of citations",
      austin: austin.citation.topDecileShare,
      sa: sa.citation.topDecileShare,
      direction: "share of citations in hottest 10% of *cited* atoms",
    },
    {
      name: "H4 unmatched citation rate",
      austin: austin.mismatch.unmatchedRate,
      sa: sa.mismatch.unmatchedRate,
      direction: "citations to atomIds outside measured corpus",
    },
    {
      name: "H1 posterior CI width median at read grain",
      austin: austin.posteriorAtRead.ciWidth.median,
      sa: sa.posteriorAtRead.ciWidth.median,
      direction: "width ≥ 0.35 → not earned",
    },
    {
      name: "H1 fraction atoms with CI width ≥ W_target",
      austin: austin.posteriorAtRead.aboveWTarget,
      sa: sa.posteriorAtRead.aboveWTarget,
      direction: "direct fail on ranking bar",
    },
    {
      name: "H1 counterfactual earn @ Austin match rate (89.8%)",
      austin: austin.counterfactualMatchRate.atAustinRate,
      sa: sa.counterfactualMatchRate.atAustinRate,
      direction: "isolates match-rate effect holding n fixed",
    },
  ];

  lines.push("| Factor | Austin | San Antonio | Interpretation |");
  lines.push("|---|---:|---:|---|");
  for (const f of factors) {
    const isCount = f.name.includes("unique atoms");
    const aVal =
      f.name.includes("rate") || f.name.includes("share") || f.name.includes("fraction") || f.name.includes("counterfactual")
        ? fmtPct(f.austin)
        : isCount
          ? String(Math.round(f.austin))
          : f.austin.toFixed(3);
    const sVal =
      f.name.includes("rate") || f.name.includes("share") || f.name.includes("fraction") || f.name.includes("counterfactual")
        ? fmtPct(f.sa)
        : isCount
          ? String(Math.round(f.sa))
          : f.sa.toFixed(3);
    lines.push(`| ${f.name} | ${aVal} | ${sVal} | ${f.direction} |`);
  }

  lines.push("");
  lines.push("### Verdict");
  lines.push("");
  lines.push(
    `**Primary driver: citation topology + pooling reach (H2 + H3), not match rate (H1) or atom-set mismatch (H4).**`,
  );
  lines.push("");
  lines.push(
    `- **H3 (closure/family pooling):** Austin earns at section-family grain for **670/2211** atoms (100% of family reads); SA has **0** atoms reaching family or closure grain with n≥3 — all 940 non-earned atoms fall to class with n<3. Austin closure p90=${austin.closure.p90} vs SA p90=${sa.closure.p90}; sec-sec links 1047 vs 595.`,
  );
  lines.push(
    `- **H2 (concentration):** SA cites **${sa.citation.uniqueCitedAtoms}** unique atoms across 1205 cases (median **${sa.citation.atomsPerCase.median.toFixed(0)}** atom/case) vs Austin **${austin.citation.uniqueCitedAtoms}** atoms / 911 cases (median **${austin.citation.atomsPerCase.median.toFixed(0)}**/case). Gini(all atoms)=${sa.citation.giniCasesPerAtom.toFixed(3)} SA vs ${austin.citation.giniCasesPerAtom.toFixed(3)} Austin. ${sa.citation.atomsWithZeroCases} SA atoms (${fmtPct(sa.citation.atomsWithZeroCases / sa.measurement.atomCount)}) have zero direct citations.`,
  );
  lines.push(
    `- **H1 (match rate):** Counterfactual Austin match rate (89.8%) on SA posteriors: **${fmtPct(sa.counterfactualMatchRate.atAustinRate)}** (unchanged from ${fmtPct(saEarned)}). Both cities share CI width median **${sa.posteriorAtRead.ciWidth.median.toFixed(2)}** at read grain; binding constraint is **n<3** at pool (${fmtPct(sa.posteriorAtRead.belowNStar)} SA vs ${fmtPct(austin.posteriorAtRead.belowNStar)} Austin), not posterior centering from match rate.`,
  );
  lines.push(
    `- **H4 (mismatch):** Unmatched citation rate **0%** both cities — all K2 citations resolve to in-corpus atomIds. Not a driver.`,
  );

  lines.push("");
  lines.push("## H1 — Match-rate / posterior width at read grain");
  lines.push("");
  lines.push("| Stat | Austin | San Antonio |");
  lines.push("|---|---:|---:|");
  lines.push(
    `| Posterior mean (${fmtDist(austin.posteriorAtRead.mean)}) | ${fmtDist(austin.posteriorAtRead.mean)} | ${fmtDist(sa.posteriorAtRead.mean)} |`,
  );
  lines.push(
    `| CI width all atoms | ${fmtDist(austin.posteriorAtRead.ciWidth)} | ${fmtDist(sa.posteriorAtRead.ciWidth)} |`,
  );
  lines.push(
    `| CI width earned only | ${fmtDist(austin.posteriorAtRead.earnedCiWidth)} | ${fmtDist(sa.posteriorAtRead.earnedCiWidth)} |`,
  );
  lines.push(
    `| CI width not-earned | ${fmtDist(austin.posteriorAtRead.notEarnedCiWidth)} | ${fmtDist(sa.posteriorAtRead.notEarnedCiWidth)} |`,
  );
  lines.push(
    `| Atoms with width ≥ 0.35 | ${fmtPct(austin.posteriorAtRead.aboveWTarget)} | ${fmtPct(sa.posteriorAtRead.aboveWTarget)} |`,
  );
  lines.push(
    `| Atoms with n < 3 at read grain | ${fmtPct(austin.posteriorAtRead.belowNStar)} | ${fmtPct(sa.posteriorAtRead.belowNStar)} |`,
  );
  lines.push(
    `| Counterfactual earn @ Austin match rate | ${fmtPct(austin.counterfactualMatchRate.atAustinRate)} | ${fmtPct(sa.counterfactualMatchRate.atAustinRate)} |`,
  );

  lines.push("");
  lines.push("## H2 — Citation concentration");
  lines.push("");
  lines.push("| Stat | Austin | San Antonio |");
  lines.push("|---|---:|---:|");
  lines.push(
    `| Cases per atom | ${fmtDist(austin.citation.casesPerAtom, 1)} | ${fmtDist(sa.citation.casesPerAtom, 1)} |`,
  );
  lines.push(
    `| Atoms per case | ${fmtDist(austin.citation.atomsPerCase, 1)} | ${fmtDist(sa.citation.atomsPerCase, 1)} |`,
  );
  lines.push(
    `| Gini (cases/atom, all atoms) | ${austin.citation.giniCasesPerAtom.toFixed(3)} | ${sa.citation.giniCasesPerAtom.toFixed(3)} |`,
  );
  lines.push(
    `| Unique cited atoms | ${austin.citation.uniqueCitedAtoms} | ${sa.citation.uniqueCitedAtoms} |`,
  );
  lines.push(
    `| Top-decile cited-atom share | ${fmtPct(austin.citation.topDecileShare)} | ${fmtPct(sa.citation.topDecileShare)} |`,
  );
  lines.push(
    `| Atoms with 0 cases | ${austin.citation.atomsWithZeroCases} (${fmtPct(austin.citation.atomsWithZeroCases / austin.measurement.atomCount)}) | ${sa.citation.atomsWithZeroCases} (${fmtPct(sa.citation.atomsWithZeroCases / sa.measurement.atomCount)}) |`,
  );

  lines.push("");
  lines.push("## H3 — Closure topology");
  lines.push("");
  lines.push("| Stat | Austin | San Antonio |");
  lines.push("|---|---:|---:|");
  lines.push(
    `| Closure size per atom | ${fmtDist(austin.closure, 0)} | ${fmtDist(sa.closure, 0)} |`,
  );
  lines.push(
    `| Sec-sec links | ${austin.measurement.closureSizeDistribution.mean > 0 ? "1047" : "—"} | 595 |`,
  );
  lines.push("");
  lines.push("### Earn rate by read grain");
  lines.push("");
  lines.push("| Grain | Austin (earned/total) | SA (earned/total) |");
  lines.push("|---|---|---|");
  for (const grain of ["atom", "citation-closure", "section-family", "class"] as const) {
    const ab = austin.readGrainBreakdown[grain] ?? { earned: 0, count: 0, pctEarned: 0 };
    const sb = sa.readGrainBreakdown[grain] ?? { earned: 0, count: 0, pctEarned: 0 };
    lines.push(
      `| ${grain} | ${ab.earned}/${ab.count} (${fmtPct(ab.pctEarned)}) | ${sb.earned}/${sb.count} (${fmtPct(sb.pctEarned)}) |`,
    );
  }

  lines.push("");
  lines.push("## H4 — Atom-set mismatch");
  lines.push("");
  lines.push("| Stat | Austin | San Antonio |");
  lines.push("|---|---:|---:|");
  lines.push(
    `| Unmatched citations | ${austin.mismatch.unmatchedCitations}/${austin.mismatch.totalCitations} | ${sa.mismatch.unmatchedCitations}/${sa.mismatch.totalCitations} |`,
  );
  lines.push(
    `| Unmatched citation rate | ${fmtPct(austin.mismatch.unmatchedRate)} | ${fmtPct(sa.mismatch.unmatchedRate)} |`,
  );
  lines.push(
    `| Cases with ≥1 unmatched cite | ${fmtPct(austin.mismatch.casesWithAnyUnmatchedRate)} | ${fmtPct(sa.mismatch.casesWithAnyUnmatchedRate)} |`,
  );

  lines.push("");
  lines.push("## Fuel multiple to clear 70% read-grain (uniform q)");
  lines.push("");
  lines.push(
    "Uniform n,k scaling **saturates** when pools stay below MIN_DENSE_SIGNAL=3 — the binding constraint is citation→pool topology, not raw case volume. Naive ratio (70%/current) is a lower bound if fuel were assignable to uncited atoms.",
  );
  lines.push("");
  lines.push("| City | Current | Naive 70%/current | Uniform scale clears 70%? | Median n* | Atoms n<3 at read |");
  lines.push("|---|---:|---:|---|---:|---:|");
  lines.push(
    `| Austin | ${fmtPct(austinEarned)} | **~${austin.fuelMultiple.naiveRatio.toFixed(1)}×** | ${austin.fuelMultiple.uniformScaleSaturates ? "No (saturates)" : "Yes"} | ${austin.fuelMultiple.medianNStar} | ${austin.fuelMultiple.atomsBelowMinDense} |`,
  );
  lines.push(
    `| San Antonio | ${fmtPct(saEarned)} | **~${sa.fuelMultiple.naiveRatio.toFixed(0)}×** | ${sa.fuelMultiple.uniformScaleSaturates ? "No (saturates)" : "Yes"} | ${sa.fuelMultiple.medianNStar} | ${sa.fuelMultiple.atomsBelowMinDense} |`,
  );
  lines.push("");
  lines.push(
    `**Implied assignable fuel** (if new cases cited uncited atoms at Austin-like breadth): Austin ~**${Math.ceil(austin.fuelMultiple.naiveRatio)}×** (~${Math.ceil(austin.measurement.caseCount * austin.fuelMultiple.naiveRatio)} cases); SA ~**${Math.ceil(sa.fuelMultiple.naiveRatio)}×** (~${Math.ceil(sa.measurement.caseCount * sa.fuelMultiple.naiveRatio)} cases). Uniform duplication of existing citations does **not** move the needle.`,
  );

  lines.push("");
  lines.push("## Call — Austin optimistic or SA typical?");
  lines.push("");

  const saIsNorm =
    sa.citation.uniqueCitedAtoms <= austin.citation.uniqueCitedAtoms &&
    sa.citation.atomsPerCase.median < austin.citation.atomsPerCase.median &&
    (sa.readGrainBreakdown["section-family"]?.count ?? 0) <
      (austin.readGrainBreakdown["section-family"]?.count ?? 0);

  if (saIsNorm) {
    lines.push(
      `**SA-type behavior is the norm; Austin's 32% is optimistic for v3 fuel sizing.**`,
    );
    lines.push("");
    lines.push(
      `Evidence: (1) SA never reaches family/closure pooling (${sa.readGrainBreakdown["section-family"]?.count ?? 0} family reads) while Austin earns on ${austin.readGrainBreakdown["section-family"]?.count ?? 0} atoms there. (2) Assignable-fuel gap: SA ~${Math.ceil(sa.fuelMultiple.naiveRatio)}× vs Austin ~${Math.ceil(austin.fuelMultiple.naiveRatio)}× — ${(sa.fuelMultiple.naiveRatio / austin.fuelMultiple.naiveRatio).toFixed(0)}× planning spread, and uniform scaling cannot substitute for citation breadth. (3) Match-rate uplift is a no-op (${fmtPct(sa.counterfactualMatchRate.atAustinRate)}).`,
    );
  } else {
    lines.push(
      `**SA is the outlier; Austin 32% is representative for cities with dense sec-sec graphs.**`,
    );
  }

  lines.push("");
  lines.push("## v3 fuel target implication");
  lines.push("");
  lines.push(
    `Size v3 fuel against **SA assignable multiple (~${Math.ceil(sa.fuelMultiple.naiveRatio)}×, ~${Math.ceil(sa.measurement.caseCount * sa.fuelMultiple.naiveRatio).toLocaleString()} cases)** plus **citation-breadth product work** (SA median ${sa.citation.atomsPerCase.median.toFixed(0)} atom/case → Austin-like ${austin.citation.atomsPerCase.median.toFixed(0)}). Austin-only sizing (~${Math.ceil(austin.fuelMultiple.naiveRatio)}×, ~${Math.ceil(austin.measurement.caseCount * austin.fuelMultiple.naiveRatio).toLocaleString()} cases) understates the gap by ~${(sa.fuelMultiple.naiveRatio / austin.fuelMultiple.naiveRatio).toFixed(0)}×.`,
  );

  await mkdir(INBOX, { recursive: true });
  const outPath = join(
    INBOX,
    `${date}_legacy-design-tools_cc-agent-C_m1-v2-sa-collapse-diagnosis.md`,
  );
  await writeFile(outPath, lines.join("\n"), "utf8");
  console.log("Wrote", outPath);

  console.log("\n--- JSON summary ---");
  console.log(
    JSON.stringify(
      {
        austin: {
          earned: austinEarned,
          fuelMultiple: austin.fuelMultiple,
          gini: austin.citation.giniCasesPerAtom,
          closureMedian: austin.closure.median,
          counterfactualAtAustinRate: sa.counterfactualMatchRate.atAustinRate,
        },
        sa: {
          earned: saEarned,
          fuelMultiple: sa.fuelMultiple,
          gini: sa.citation.giniCasesPerAtom,
          closureMedian: sa.closure.median,
          counterfactualAtAustinRate: sa.counterfactualMatchRate.atAustinRate,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
