/**
 * Williamson (48491) cad_property land_value/land_acres reconciliation
 * from tx_wcad_ag_valuation (F-01, OPS-19b Wave 1 item 4 follow-up).
 *
 * `_inbox/2026-09-05_engine-williamson-mclennan-geomgap-nulls_close.json`:
 * 282,569 R-prefix cad_property rows carry land_value NULL / land_acres
 * 0.0000 from the 2026-08-25 leftover-farm StratMap fill, even though a
 * genuine per-property WCAD land-segment table (tx_wcad_ag_valuation,
 * acquired 2026-09-03, 11 days later) already holds real acres/value
 * data keyed on the SAME prop_id. The two pipelines were never
 * reconciled.
 *
 * tx_wcad_ag_valuation is NOT owned by this repo (acquired by a separate
 * pipeline) — this module only reads it. A property carries one row per
 * physical land segment (sampled up to ~29 rows on real large ranches),
 * each an ADDITIVE segment, never a competing reading of the same land,
 * so aggregation is SUM(acres)/SUM(value) grouped by prop_id across
 * every land_type (all 27 codes are legitimate, self-documented via the
 * table's own `description` column — R residential, L vacant, C
 * commercial, and a full set of ag/pasture/wildlife categories; none
 * need special-casing or exclusion).
 *
 * `value`, not `curr_value`: the two differ on ~66% of Residential rows
 * (not a duplicate field). `land_value` elsewhere in this codebase is
 * documented as the MARKET-rate figure (`pacs/parser.ts`'s own
 * `land_value = ... + ag_market + timber_market`, "ag/timber market is
 * how rural land market value is carried") — `value` is that market
 * figure; `curr_value` is presumed current/productivity-adjusted and is
 * deliberately not read here.
 *
 * Honesty: `acres` is NULL on the majority of tx_wcad_ag_valuation rows
 * (small residential lots routinely carry a dollar value with no
 * recorded acreage — a real source-data shape, not a gap this
 * reconciliation can close). This module resolves land_value
 * comprehensively but land_acres only for the subset of properties whose
 * land rows carry it; callers must not report a blanket "land_acres
 * fixed" claim — see UnresolvedFieldCounts.
 */

import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { cadProperty, txWcadAgValuation } from "@workspace/db/schema";
import { formatAcres } from "./p78Merge";
import { upsertCadProperties } from "./ingest";
import type { CadPropertyRecord, UpsertSummary } from "./types";

export const WILLIAMSON_COUNTY_FIPS = "48491";

/**
 * Comfortably above the real distribution measured live (p50=0.46,
 * p99=116, p999=393, true max=26,981 — a genuine large ranch), well
 * below anything a single Williamson property could legitimately be.
 * Catches a decimal-shift or unit-mixup corruption; never a real
 * property.
 */
export const WILLIAMSON_ACRES_SANITY_CEILING = 100_000;

export const AG_VALUATION_SOURCE_LABEL = "tx_wcad_ag_valuation-reconciliation";

/** One property's aggregated land-segment totals, as SUM() returns them (numeric -> string | null). */
export interface AgValuationTotals {
  totalValue: string | null;
  totalAcres: string | null;
}

/**
 * Sanity-guarded conversion from raw SUM() totals to `cad_property`'s own
 * wire shape (whole-dollar number, 4-decimal acres string). Refuses
 * (returns null for that field) rather than write a non-finite,
 * negative, or implausible figure — never a fabricated value, and never
 * a corrupted one written silently.
 */
export function reconcileLandFieldsFromAgValuation(
  totals: AgValuationTotals,
): { landValue: number | null; landAcres: string | null } {
  const value = totals.totalValue == null ? NaN : Number(totals.totalValue);
  const landValue =
    Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

  const acres = totals.totalAcres == null ? NaN : Number(totals.totalAcres);
  const landAcres =
    Number.isFinite(acres) && acres >= 0 && acres <= WILLIAMSON_ACRES_SANITY_CEILING
      ? formatAcres(acres)
      : null;

  return { landValue, landAcres };
}

/**
 * Aggregate tx_wcad_ag_valuation per prop_id for one county. Every
 * land_type contributes (see module doc) — no filtering by code.
 */
export async function aggregateAgValuationByPropId(
  db: Pick<NodePgDatabase<Record<string, unknown>>, "select">,
  countyFips: string,
): Promise<Map<string, AgValuationTotals>> {
  const rows = await db
    .select({
      propId: txWcadAgValuation.propId,
      totalValue: sql<string | null>`SUM(${txWcadAgValuation.value})`,
      totalAcres: sql<string | null>`SUM(${txWcadAgValuation.acres})`,
    })
    .from(txWcadAgValuation)
    .where(eq(txWcadAgValuation.countyFips, countyFips))
    .groupBy(txWcadAgValuation.propId);

  const byPropId = new Map<string, AgValuationTotals>();
  for (const row of rows) {
    byPropId.set(row.propId, { totalValue: row.totalValue, totalAcres: row.totalAcres });
  }
  return byPropId;
}

/** One cad_property row this reconciliation targets: needs land_value or land_acres. */
export interface TargetCadPropertyRow {
  propId: string;
  taxYear: number;
}

/**
 * Existing rows in `cad_property` for this county missing land_value
 * and/or land_acres — the reconciliation's actual targets. Rows that
 * already carry both are left alone entirely (never re-touched).
 */
export async function findWilliamsonReconciliationTargets(
  db: Pick<NodePgDatabase<Record<string, unknown>>, "select">,
  countyFips: string,
): Promise<TargetCadPropertyRow[]> {
  const rows = await db
    .select({ propId: cadProperty.propId, taxYear: cadProperty.taxYear })
    .from(cadProperty)
    .where(
      and(
        eq(cadProperty.countyFips, countyFips),
        sql`(${cadProperty.landValue} IS NULL OR ${cadProperty.landAcres} IS NULL OR ${cadProperty.landAcres} = 0)`,
      ),
    );
  return rows;
}

export interface WilliamsonReconciliationSummary {
  targetsConsidered: number;
  noAgValuationMatch: number;
  landValueResolved: number;
  landAcresResolved: number;
  /** Real source shape, not a defect: a match existed but carried no acres on any segment. */
  landAcresGenuinelyAbsent: number;
  guardRefusedValue: number;
  guardRefusedAcres: number;
  upsert: UpsertSummary;
}

/**
 * Build one CadPropertyRecord per reconciliation target with ONLY
 * landValue/landAcres set from the aggregation (everything else null),
 * for feeding through the existing upsertCadProperties()
 * COALESCE-preferring-incoming path unchanged — a target with no
 * aggregation match, or whose guard refuses both fields, is dropped
 * entirely rather than upserted as an all-null no-op row.
 */
export function buildReconciliationRecords(
  countyFips: string,
  targets: TargetCadPropertyRow[],
  aggregated: Map<string, AgValuationTotals>,
): { records: CadPropertyRecord[]; summary: Omit<WilliamsonReconciliationSummary, "upsert"> } {
  let noAgValuationMatch = 0;
  let landValueResolved = 0;
  let landAcresResolved = 0;
  let landAcresGenuinelyAbsent = 0;
  let guardRefusedValue = 0;
  let guardRefusedAcres = 0;

  const records: CadPropertyRecord[] = [];
  for (const target of targets) {
    const totals = aggregated.get(target.propId);
    if (!totals) {
      noAgValuationMatch += 1;
      continue;
    }
    const { landValue, landAcres } = reconcileLandFieldsFromAgValuation(totals);

    if (landValue != null) landValueResolved += 1;
    else if (totals.totalValue != null) guardRefusedValue += 1;

    if (landAcres != null) landAcresResolved += 1;
    else if (totals.totalAcres == null) landAcresGenuinelyAbsent += 1;
    else guardRefusedAcres += 1;

    if (landValue == null && landAcres == null) continue;

    records.push({
      countyFips,
      propId: target.propId,
      taxYear: target.taxYear,
      ownerName: null,
      ownerMailingAddress: null,
      situsAddress: null,
      situsCity: null,
      situsZip: null,
      legalDescription: null,
      exemptionCodes: null,
      landValue,
      improvementValue: null,
      marketValue: null,
      assessedValue: null,
      yearBuilt: null,
      livingAreaSqft: null,
      landAcres,
      propertyUseCode: null,
    });
  }

  return {
    records,
    summary: {
      targetsConsidered: targets.length,
      noAgValuationMatch,
      landValueResolved,
      landAcresResolved,
      landAcresGenuinelyAbsent,
      guardRefusedValue,
      guardRefusedAcres,
    },
  };
}

/**
 * Full reconciliation: find targets, aggregate the source table, build
 * guarded records, upsert. Reports an honest summary — callers must not
 * collapse this to a single "N accounts fixed" claim; land_acres in
 * particular only resolves for the subset of properties whose land rows
 * carry acreage (see module doc).
 */
export async function reconcileWilliamsonAgValuation(
  db: Pick<NodePgDatabase<Record<string, unknown>>, "select" | "insert">,
  sourceVintage: string,
): Promise<WilliamsonReconciliationSummary> {
  const [targets, aggregated] = await Promise.all([
    findWilliamsonReconciliationTargets(db, WILLIAMSON_COUNTY_FIPS),
    aggregateAgValuationByPropId(db, WILLIAMSON_COUNTY_FIPS),
  ]);

  const { records, summary } = buildReconciliationRecords(
    WILLIAMSON_COUNTY_FIPS,
    targets,
    aggregated,
  );

  const upsert = await upsertCadProperties(db, records, {
    sourceFile: AG_VALUATION_SOURCE_LABEL,
    sourceVintage,
  });

  return { ...summary, upsert };
}
