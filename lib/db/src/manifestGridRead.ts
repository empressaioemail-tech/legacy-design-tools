/**
 * Shared manifest grid read for county-ledger and reconciliation gate.
 */
import type pg from "pg";
import { COVERAGE_CLASS_BY_RAIL_KEY } from "./schema/countyRailDimension";
import {
  DEPTH_GATE_DEMOTION_STATE,
  MANIFEST_DISPLAY_STATE_SQL,
  MANIFEST_IS_PARTIAL_SQL,
} from "./manifestDisplayState";
import type { ReconciliationManifestCell } from "./manifestReconciliationGate";

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

function applyDepthRailDisplayGate(
  cell: ReconciliationManifestCell,
): ReconciliationManifestCell {
  if (COVERAGE_CLASS_BY_RAIL_KEY[cell.railKey] !== "jurisdiction-depth") {
    return cell;
  }
  if (cell.displayState !== "satisfied-present") return cell;
  const threshold = cell.thresholdPct;
  const coverage = cell.honestCoveragePct;
  if (coverage === null || threshold === null || coverage < threshold) {
    return { ...cell, displayState: DEPTH_GATE_DEMOTION_STATE, isPartial: false };
  }
  return cell;
}

export async function readManifestGridFromPool(
  pool: pg.Pool,
): Promise<ReconciliationManifestCell[]> {
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
${MANIFEST_DISPLAY_STATE_SQL},
${MANIFEST_IS_PARTIAL_SQL}
    FROM county_manifest m
    CROSS JOIN county_rail r
    LEFT JOIN county_facet_coverage c
      ON c.county_fips = m.county_fips
     AND c.facet = r.rail_key
    ORDER BY m.county_fips, r.ordinal
  `);

  return rows.map((row) =>
    applyDepthRailDisplayGate({
      countyFips: row.county_fips,
      railKey: row.rail_key,
      displayState: row.display_state,
      isPartial: Boolean(row.is_partial),
      honestCoveragePct: num(row.honest_coverage_pct),
      thresholdPct: num(row.cell_threshold ?? row.rail_default_threshold),
      hasWriter: Boolean(row.has_writer),
      verifiedByInstrument: row.verified_by_instrument ?? null,
    }),
  );
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
  const { rows } = await pool.query<{ rail_key: string; has_writer: boolean }>(
    "SELECT rail_key, has_writer FROM county_rail",
  );
  return new Map(rows.map((r) => [r.rail_key, r.has_writer]));
}
