/**
 * Shared manifest grid read for county-ledger and reconciliation gate.
 */
import type pg from "pg";
import { COVERAGE_CLASS_BY_RAIL_KEY } from "./schema/countyRailDimension";
import type { ReconciliationManifestCell } from "./manifestReconciliationGate";
import {
  effectiveRailFieldsByKey,
  manifestReadProbeOptions,
} from "./railManifestDerivation";
import {
  resolveManifestDisplayState,
  resolveManifestIsPartial,
} from "./manifestCellResolve";

interface ManifestGridQueryRow extends Record<string, unknown> {
  county_fips: string;
  rail_key: string;
  rail_default_threshold: string | number | null;
  atom_family_state: string;
  has_writer: boolean;
  rail_state: string | null;
  honest_coverage_pct: string | number | null;
  cell_threshold: string | number | null;
  verified_by_instrument: string | null;
  display_state: string;
  is_partial: boolean;
}

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

/** Exported for countyLedger route parity and unit tests. */
export function applyDepthRailDisplayGate(
  cell: ReconciliationManifestCell,
): ReconciliationManifestCell {
  if (COVERAGE_CLASS_BY_RAIL_KEY[cell.railKey] !== "jurisdiction-depth") {
    return cell;
  }
  if (cell.displayState !== "satisfied-present") return cell;
  const threshold = cell.thresholdPct;
  const coverage = cell.honestCoveragePct;
  if (coverage === null || threshold === null || coverage < threshold) {
    // Downgrade display only — isPartial stays true when SQL computed partial
    // (R-09: erasing isPartial made the indicator constant on live ledger).
    return { ...cell, displayState: "not-yet" };
  }
  return cell;
}

function overlayEffectiveRailFields(
  row: ManifestGridQueryRow,
  effectiveByKey: ReturnType<typeof effectiveRailFieldsByKey>,
): {
  atomFamilyState: string;
  hasWriter: boolean;
  displayState: string;
  isPartial: boolean;
} {
  const effective = effectiveByKey.get(row.rail_key);
  const atomFamilyState = effective?.atomFamilyState ?? row.atom_family_state;
  const hasWriter = effective?.hasWriter ?? Boolean(row.has_writer);
  const honestCoveragePct = num(row.honest_coverage_pct);
  const thresholdPct = num(row.cell_threshold ?? row.rail_default_threshold);
  const displayState = resolveManifestDisplayState(
    atomFamilyState,
    hasWriter,
    row.rail_state,
  );
  const isPartial = resolveManifestIsPartial(
    atomFamilyState,
    hasWriter,
    row.rail_state,
    honestCoveragePct,
    thresholdPct,
  );
  return { atomFamilyState, hasWriter, displayState, isPartial };
}

export async function readManifestGridFromPool(
  pool: pg.Pool,
): Promise<ReconciliationManifestCell[]> {
  const effectiveByKey = effectiveRailFieldsByKey(manifestReadProbeOptions());

  const { rows } = await pool.query<ManifestGridQueryRow>(`
    SELECT
      m.county_fips,
      r.rail_key,
      r.threshold_pct AS rail_default_threshold,
      r.atom_family_state,
      r.has_writer,
      c.rail_state,
      c.honest_coverage_pct,
      c.threshold_pct AS cell_threshold,
      c.verified_by_instrument,
      CASE
        WHEN r.atom_family_state <> 'present' THEN 'no-atom'
        WHEN r.has_writer = false THEN 'no-writer'
        WHEN c.rail_state IS NULL THEN 'not-yet'
        ELSE c.rail_state
      END AS display_state,
      CASE
        WHEN r.atom_family_state = 'present'
         AND r.has_writer = true
         AND c.rail_state = 'satisfied-present'
         AND c.honest_coverage_pct < COALESCE(c.threshold_pct, r.threshold_pct)
        THEN true
        ELSE false
      END AS is_partial
    FROM county_manifest m
    CROSS JOIN county_rail r
    LEFT JOIN county_facet_coverage c
      ON c.county_fips = m.county_fips
     AND c.facet = r.rail_key
    ORDER BY m.county_fips, r.ordinal
  `);

  return rows.map((row) => {
    const overlaid = overlayEffectiveRailFields(row, effectiveByKey);
    return applyDepthRailDisplayGate({
      countyFips: row.county_fips,
      railKey: row.rail_key,
      displayState: overlaid.displayState,
      isPartial: overlaid.isPartial,
      honestCoveragePct: num(row.honest_coverage_pct),
      thresholdPct: num(row.cell_threshold ?? row.rail_default_threshold),
      hasWriter: overlaid.hasWriter,
      verifiedByInstrument: row.verified_by_instrument ?? null,
    });
  });
}

export async function readCountyManifestRowCount(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM county_manifest",
  );
  return rows[0]?.n ?? 0;
}

export async function readCountyRailHasWriterMap(
  pool: pg.Pool,
): Promise<Map<string, boolean>> {
  const effectiveByKey = effectiveRailFieldsByKey(manifestReadProbeOptions());
  const { rows } = await pool.query<{ rail_key: string; has_writer: boolean }>(
    "SELECT rail_key, has_writer FROM county_rail",
  );
  return new Map(
    rows.map((r) => [
      r.rail_key,
      effectiveByKey.get(r.rail_key)?.hasWriter ?? r.has_writer,
    ]),
  );
}
