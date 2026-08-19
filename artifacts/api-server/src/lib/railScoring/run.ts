/**
 * A SCORING RUN — the thing that can be done again.
 *
 * This is the whole point of the lane. Coverage rows arrived historically
 * from one-off scripts, so there was nothing to re-run and no way to say what
 * a re-run would change. A run here is idempotent, reports its own delta, and
 * carries every counting rule it used.
 *
 * IDEMPOTENCE, stated so it can be checked rather than believed: the upsert's
 * ON CONFLICT is not the claim. `checked_at` and `last_verified_at` move on
 * every write, so row counts would report every cell as changed on every run.
 * This reads each existing row BEFORE writing and compares VALUES
 * (`railCellChanged`), so a second run over unchanged sources reports
 * `cellsChanged: 0`. That number is the claim.
 *
 * DRY RUN writes nothing and still computes the full delta — which is also
 * the load-bearing test: a dry run must report the store UNMOVED while still
 * naming what a real run would move.
 */

import {
  railCellChanged,
  scoreRailCell,
  type RailCellScore,
  type RailLedgerValues,
} from "./engine";
import {
  measureRailCell,
  readManifestCounties,
  RailNotMeasurableError,
  type MeasureContext,
  type RailScoreQueryable,
} from "./measure";
import {
  railScoringRuleFor,
  scoreableRailKeys,
  thresholdPctForRail,
  type RailScoringRule,
} from "./registry";

export interface RailScoreRunOptions {
  /** Rails to score. Defaults to every rail with a measurement spec. */
  railKeys?: readonly string[];
  /** Counties to score. Defaults to every county in `county_manifest`. */
  countyFips?: readonly string[];
  /** Compute and diff, write nothing. */
  dryRun: boolean;
  /** Called once per county so a long run proves progress rather than existence. */
  onProgress?: (line: string) => void;
}

export interface RailRunResult {
  railKey: string;
  measurementKind: string;
  /** The counting rule, carried next to the numbers it governs (DEV_PROCESS 1.2). */
  denominator: { kind: string; basis: string };
  instrument: string;
  countiesScored: number;
  cellsChanged: number;
  cellsUnchanged: number;
  cellsWritten: number;
  byRailState: Record<string, number>;
  overcountCounties: string[];
  absenceRefusals: Array<{ countyFips: string; reason: string }>;
}

export interface RailUnavailable {
  railKey: string;
  reason: string;
  message: string;
}

export interface RailScoreRunReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  dryRun: boolean;
  countyTargetCount: number;
  countyTargetBasis: string;
  rails: RailRunResult[];
  /** Rails that could NOT be scored, each with a named reason. Never silently dropped. */
  railsUnavailable: RailUnavailable[];
  totals: { cellsChanged: number; cellsUnchanged: number; cellsWritten: number };
}

const LEDGER_COLUMNS = `
  county_fips, facet, honest_coverage_pct, integrity_verdict, owner_match_rate,
  source, source_vintage, sampled, classification, rail_state, threshold_pct,
  absence_basis, verification_method, verified_by_instrument, artifact_path`;

/** Read the current stored values for one cell, as `RailLedgerValues` or null. */
async function readExistingCell(
  deployment: RailScoreQueryable,
  countyFips: string,
  facet: string,
): Promise<RailLedgerValues | null> {
  const r = await deployment.query<Record<string, unknown>>(
    `SELECT ${LEDGER_COLUMNS}
       FROM county_facet_coverage
      WHERE county_fips = $1 AND facet = $2`,
    [countyFips, facet],
  );
  const row = r.rows[0];
  if (!row) return null;
  const numOrNull = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v);
  return {
    countyFips: String(row.county_fips),
    facet: String(row.facet),
    honestCoveragePct: Number(row.honest_coverage_pct ?? 0),
    integrityVerdict: String(row.integrity_verdict),
    ownerMatchRate: numOrNull(row.owner_match_rate),
    source: (row.source as string | null) ?? null,
    sourceVintage: (row.source_vintage as string | null) ?? null,
    sampled: Number(row.sampled ?? 0),
    classification: row.classification as RailLedgerValues["classification"],
    railState: (row.rail_state as RailLedgerValues["railState"]) ?? "not-yet",
    thresholdPct: Number(row.threshold_pct ?? 0),
    absenceBasis: (row.absence_basis as string | null) ?? null,
    verificationMethod: (row.verification_method as string | null) ?? "unverified",
    verifiedByInstrument: (row.verified_by_instrument as string | null) ?? "",
    artifactPath: (row.artifact_path as string | null) ?? "",
  };
}

/**
 * ONE upsert for every rail. The per-rail scorers each wrote their own,
 * which is how `countyCoverageScoreCli.ts` came to omit `rail_state` and
 * `threshold_pct` entirely — its rows are invisible to the manifest grid's
 * display precedence. There is one write path here and every column is on it.
 */
async function upsertCell(
  deployment: RailScoreQueryable,
  score: RailCellScore,
): Promise<void> {
  await deployment.query(
    `INSERT INTO county_facet_coverage (${LEDGER_COLUMNS}, checked_at, last_verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now(), now())
     ON CONFLICT (county_fips, facet) DO UPDATE SET
       honest_coverage_pct    = EXCLUDED.honest_coverage_pct,
       integrity_verdict      = EXCLUDED.integrity_verdict,
       owner_match_rate       = EXCLUDED.owner_match_rate,
       source                 = EXCLUDED.source,
       source_vintage         = EXCLUDED.source_vintage,
       sampled                = EXCLUDED.sampled,
       classification         = EXCLUDED.classification,
       rail_state             = EXCLUDED.rail_state,
       threshold_pct          = EXCLUDED.threshold_pct,
       absence_basis          = EXCLUDED.absence_basis,
       verification_method    = EXCLUDED.verification_method,
       verified_by_instrument = EXCLUDED.verified_by_instrument,
       artifact_path          = EXCLUDED.artifact_path,
       checked_at             = now(),
       last_verified_at       = now()`,
    [
      score.countyFips,
      score.facet,
      score.honestCoveragePct.toFixed(2),
      score.integrityVerdict,
      score.ownerMatchRate != null ? score.ownerMatchRate.toFixed(4) : null,
      score.source,
      score.sourceVintage,
      score.sampled,
      score.classification,
      score.railState,
      score.thresholdPct.toFixed(2),
      // absence_basis clears to NULL on any non-absent state so a prior
      // absence cannot stick to a cell that is no longer absent.
      score.railState === "satisfied-absent" ? score.absenceBasis : null,
      score.verificationMethod,
      score.verifiedByInstrument,
      score.artifactPath,
    ],
  );
}

function resolveRules(railKeys: readonly string[] | undefined): {
  rules: RailScoringRule[];
  unavailable: RailUnavailable[];
} {
  const keys = railKeys && railKeys.length > 0 ? railKeys : scoreableRailKeys();
  const rules: RailScoringRule[] = [];
  const unavailable: RailUnavailable[] = [];
  for (const key of keys) {
    const rule = railScoringRuleFor(key);
    if (!rule) {
      unavailable.push({
        railKey: key,
        reason: "unknown_rail",
        message: `'${key}' is not in RAIL_SCORING_DECLARATION`,
      });
      continue;
    }
    rules.push(rule);
  }
  return { rules, unavailable };
}

/** Execute a scoring run. Exit-bounded: it measures, it writes, it returns. */
export async function runRailScore(
  ctx: MeasureContext,
  options: RailScoreRunOptions,
): Promise<RailScoreRunReport> {
  const startedAt = new Date();
  const { rules, unavailable } = resolveRules(options.railKeys);

  let counties: string[];
  let countyTargetBasis: string;
  if (options.countyFips && options.countyFips.length > 0) {
    counties = [...options.countyFips];
    countyTargetBasis = `explicit --county selection (${counties.length} counties)`;
  } else {
    const manifest = await readManifestCounties(ctx.deployment);
    counties = manifest.map((c) => c.countyFips);
    countyTargetBasis = `every county in county_manifest (${counties.length} rows)`;
  }

  const rails: RailRunResult[] = [];

  for (const rule of rules) {
    let threshold: number;
    try {
      threshold = thresholdPctForRail(rule.railKey);
    } catch (err) {
      unavailable.push({
        railKey: rule.railKey,
        reason: "no_threshold",
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const result: RailRunResult = {
      railKey: rule.railKey,
      measurementKind: rule.kind,
      denominator: { kind: rule.denominator.kind, basis: rule.denominator.basis },
      instrument: rule.instrument,
      countiesScored: 0,
      cellsChanged: 0,
      cellsUnchanged: 0,
      cellsWritten: 0,
      byRailState: {},
      overcountCounties: [],
      absenceRefusals: [],
    };

    let railFailed = false;
    for (const countyFips of counties) {
      let score: RailCellScore;
      try {
        const measurement = await measureRailCell(rule, ctx, countyFips);
        score = scoreRailCell(rule, threshold, measurement);
      } catch (err) {
        if (err instanceof RailNotMeasurableError) {
          // A rail-level impossibility (no spec, no atoms store). Abandon the
          // whole rail and NAME it; never score its remaining counties as
          // zero and never continue as if some counties succeeded.
          unavailable.push({
            railKey: rule.railKey,
            reason: err.reason,
            message: err.message,
          });
          railFailed = true;
          break;
        }
        throw err;
      }

      const before = await readExistingCell(ctx.deployment, countyFips, score.facet);
      const changed = railCellChanged(before, score);
      if (changed) result.cellsChanged += 1;
      else result.cellsUnchanged += 1;
      result.countiesScored += 1;
      result.byRailState[score.railState] =
        (result.byRailState[score.railState] ?? 0) + 1;
      if (score.overcount) result.overcountCounties.push(countyFips);
      if (score.absenceRefusedReason) {
        result.absenceRefusals.push({
          countyFips,
          reason: score.absenceRefusedReason,
        });
      }

      if (!options.dryRun) {
        await upsertCell(ctx.deployment, score);
        result.cellsWritten += 1;
      }
      options.onProgress?.(
        `${rule.railKey} ${countyFips} ${score.honestCoveragePct.toFixed(2)}% ` +
          `-> ${score.railState}${changed ? " CHANGED" : ""}`,
      );
    }

    if (!railFailed) rails.push(result);
  }

  const finishedAt = new Date();
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    dryRun: options.dryRun,
    countyTargetCount: counties.length,
    countyTargetBasis,
    rails,
    railsUnavailable: unavailable,
    totals: {
      cellsChanged: rails.reduce((a, r) => a + r.cellsChanged, 0),
      cellsUnchanged: rails.reduce((a, r) => a + r.cellsUnchanged, 0),
      cellsWritten: rails.reduce((a, r) => a + r.cellsWritten, 0),
    },
  };
}
