/**
 * County-ledger compute path (L18 / P-14).
 *
 * Shared by GET ?compute=live (audit) and countyLedgerMaterializeCli.
 * No main() — the server must never import a CLI entrypoint (esbuild
 * isDirectRun boot-crash class). The default GET reads county_ledger_snapshot
 * and does not call this.
 */
import {
  countyFacetCoverage,
  countyManifest,
  jurisdictionRegistryRowMirror,
  countyGateCertState,
  onboardingLedgerEvent,
  countyLedgerSnapshot,
  COUNTY_RAIL_COUNT,
  COVERAGE_CLASS_BY_RAIL_KEY,
  COUNTY_LEDGER_SNAPSHOT_ID,
} from "@workspace/db/schema";
import {
  buildEffectiveCountyRailDeclaration,
  isRailDerivationIndeterminate,
  manifestReadProbeOptions,
  probeRailCapabilities,
} from "@workspace/db/manifest";
import { eq, sql } from "drizzle-orm";

/**
 * One cell of the 254 x N manifest grid. `displayState` resolves per the
 * ruled precedence (spec section 3): `atomFamilyState != 'present'` =>
 * `no-atom`, regardless of any stored row; else `hasWriter = false` =>
 * `no-writer`, regardless of any stored row; else the stored `rail_state`,
 * or `not-yet` if no `county_facet_coverage` row exists for the cell.
 */
export interface ManifestCell {
  countyFips: string;
  railKey: string;
  displayState:
    | "derivation-indeterminate"
    | "no-atom"
    | "no-writer"
    | "not-yet"
    | "satisfied-present"
    | "satisfied-absent";
  isPartial: boolean;
  honestCoveragePct: number | null;
  thresholdPct: number | null;
  atomFamilyState: string;
  hasWriter: boolean;
  absenceBasis: string | null;
  source: string | null;
  sourceVintage: string | null;
  lastVerifiedAt: string | null;
  verifiedByInstrument: string | null;
  verificationMethod: string | null;
  artifactPath: string | null;
}

interface ManifestGridQueryRow extends Record<string, unknown> {
  county_fips: string;
  rail_key: string;
  rail_default_threshold: string | number | null;
  atom_family_state: string;
  has_writer: boolean;
  rail_state: string | null;
  honest_coverage_pct: string | number | null;
  cell_threshold: string | number | null;
  absence_basis: string | null;
  source: string | null;
  source_vintage: string | null;
  last_verified_at: Date | string | null;
  verified_by_instrument: string | null;
  verification_method: string | null;
  artifact_path: string | null;
  display_state: ManifestCell["displayState"];
  is_partial: boolean;
}

interface FacetRow {
  facet: string;
  honestCoveragePct: number | null;
  integrityVerdict: string;
  ownerMatchRate: number | null;
  source: string | null;
  sourceVintage: string | null;
  recipeVersion: string | null;
  /** @deprecated OPS-9 S1, superseded by `rows[].cert`. */
  certState: string | null;
  stalenessFlag: boolean;
  rewarmUnsafe: boolean;
  costUsd: number | null;
  /** @deprecated OPS-9 S1, superseded by `rows[].gate`. */
  onboarded: boolean;
  lastRewarmAt: string | null;
  lastRefreshAt: string | null;
}

interface RegistryRowLedgerView {
  rowId: string;
  countyName: string | null;
  gate: {
    passCount: number | null;
    declineCount: number | null;
    checks: unknown;
  } | null;
  cert: {
    label: string | null;
    blockPass: boolean | null;
    scopeAnnotations: unknown;
    gradedAt: string | null;
  } | null;
  openDefectClasses: Array<{ defectClass: string; count: number }>;
  focusedFixCount: number;
}

interface CountyLedgerRow {
  countyFips: string;
  countyName: string | null;
  onboarded: boolean;
  hasStale: boolean;
  rewarmUnsafe: boolean;
  recipeVersions: string[];
  certStates: string[];
  facets: FacetRow[];
  rows: RegistryRowLedgerView[];
}

export interface CountyLedgerSummary {
  onboardedCount: number;
  totalCounties: number;
  staleCount: number;
  rewarmUnsafeCount: number;
  totalRails: number;
  totalCells: number;
  satisfiedCells: number;
  satisfiedPresentCells: number;
  satisfiedPresentPartialCells: number;
  satisfiedAbsentCells: number;
  texasCompletenessPct: number;
  computedAt?: string;
  servedAt?: string;
  materializationAgeMs?: number;
}

export interface CountyLedgerPayload {
  counties: CountyLedgerRow[];
  manifestCells: ManifestCell[];
  railCapabilities: unknown;
  railCapabilitiesProbeReason?: string;
  summary: CountyLedgerSummary;
}

/** Drizzle handle from the route singleton or the CLI's own pool. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SelectDb = any;

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);
const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v);

/** P1.1: jurisdiction-depth rails gate display on coverage threshold (OPS-14). */
export function applyDepthRailDisplayGate(cell: ManifestCell): ManifestCell {
  if (cell.displayState === "derivation-indeterminate") return cell;
  if (COVERAGE_CLASS_BY_RAIL_KEY[cell.railKey] !== "jurisdiction-depth") return cell;
  if (cell.displayState !== "satisfied-present") return cell;
  const threshold = cell.thresholdPct;
  const coverage = cell.honestCoveragePct;
  if (coverage === null || threshold === null || coverage < threshold) {
    return { ...cell, displayState: "not-yet", isPartial: false };
  }
  return cell;
}

export function applyDerivationIndeterminateOverlay(
  cells: ManifestCell[],
  indeterminateRailKeys: ReadonlySet<string>,
): ManifestCell[] {
  if (indeterminateRailKeys.size === 0) return cells;
  return cells.map((cell) =>
    indeterminateRailKeys.has(cell.railKey)
      ? { ...cell, displayState: "derivation-indeterminate", isPartial: false }
      : cell,
  );
}

function indeterminateRailKeysFromEffectiveDeclaration(): Set<string> {
  const effective = buildEffectiveCountyRailDeclaration(manifestReadProbeOptions());
  return new Set(
    effective.filter(isRailDerivationIndeterminate).map((decl) => decl.railKey),
  );
}

async function readManifestGrid(db: SelectDb): Promise<ManifestCell[]> {
  const { rows } = (await db.execute(sql`
    SELECT
      m.county_fips,
      r.rail_key,
      r.threshold_pct AS rail_default_threshold,
      r.atom_family_state,
      r.has_writer,
      c.rail_state,
      c.honest_coverage_pct,
      c.threshold_pct AS cell_threshold,
      c.absence_basis,
      c.source,
      c.source_vintage,
      c.last_verified_at,
      c.verified_by_instrument,
      c.verification_method,
      c.artifact_path,
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
  `)) as { rows: ManifestGridQueryRow[] };
  const indeterminateRails = indeterminateRailKeysFromEffectiveDeclaration();
  return applyDerivationIndeterminateOverlay(
    rows.map((row) =>
      applyDepthRailDisplayGate({
        countyFips: row.county_fips,
        railKey: row.rail_key,
        displayState: row.display_state,
        isPartial: Boolean(row.is_partial),
        honestCoveragePct: num(row.honest_coverage_pct),
        thresholdPct: num(row.cell_threshold ?? row.rail_default_threshold),
        atomFamilyState: row.atom_family_state,
        hasWriter: Boolean(row.has_writer),
        absenceBasis: row.absence_basis ?? null,
        source: row.source ?? null,
        sourceVintage: row.source_vintage ?? null,
        lastVerifiedAt: iso(row.last_verified_at),
        verifiedByInstrument: row.verified_by_instrument ?? null,
        verificationMethod: row.verification_method ?? null,
        artifactPath: row.artifact_path ?? null,
      }),
    ),
    indeterminateRails,
  );
}

const DOCTRINE_SOURCES_EXCLUDED_FROM_ROLLUP = new Set(["zoning-regime-doctrine"]);

function isSatisfiedCell(cell: ManifestCell): boolean {
  if (cell.displayState === "derivation-indeterminate") return false;
  if (cell.source && DOCTRINE_SOURCES_EXCLUDED_FROM_ROLLUP.has(cell.source)) {
    return false;
  }
  return (
    (cell.displayState === "satisfied-present" && !cell.isPartial) ||
    cell.displayState === "satisfied-absent"
  );
}

export interface RollupResult {
  texasPct: number;
  totalParcelWeight: number;
}

export function computeTexasRollup(
  cells: ManifestCell[],
  parcelCountByFips: Map<string, number | null>,
  railCount = COUNTY_RAIL_COUNT,
): RollupResult {
  const satisfiedCountByFips = new Map<string, number>();
  for (const cell of cells) {
    if (!isSatisfiedCell(cell)) continue;
    satisfiedCountByFips.set(
      cell.countyFips,
      (satisfiedCountByFips.get(cell.countyFips) ?? 0) + 1,
    );
  }

  let numerator = 0;
  let denominator = 0;
  for (const [fips, parcelCountEst] of parcelCountByFips) {
    const weight = parcelCountEst ?? 0;
    const satisfiedCount = satisfiedCountByFips.get(fips) ?? 0;
    numerator += weight * satisfiedCount;
    denominator += weight;
  }

  const totalDenominator = denominator * railCount;
  return {
    texasPct: totalDenominator > 0 ? (100 * numerator) / totalDenominator : 0,
    totalParcelWeight: denominator,
  };
}

export interface ComputeCountyLedgerOptions {
  /**
   * Run the COUNT DISTINCT rail-capability probes (default true).
   *
   * Set false ONLY to keep a recompute inside the 300s Cloud Run request
   * timeout when the probe is the part that will not finish: the probes scan
   * cad_property / txgio_parcel / tx_special_district, and everything else in
   * this compute is small. When false, `railCapabilities` is null and
   * `railCapabilitiesProbeReason` names the skip — an honest absence carrying
   * its basis, never a stale value carried forward from a previous snapshot.
   */
  probeCapabilities?: boolean;

  /**
   * Handle used ONLY for the rail-capability probes, when it must differ from
   * the handle used for everything else.
   *
   * WHY THIS EXISTS. `probeRailCapabilities` runs raw COUNT DISTINCT queries
   * and SWALLOWS a failure per rail, returning null with a limitation string.
   * That is honest on a pooled connection, where a failed statement affects
   * only itself. Inside a TRANSACTION it is not: the first failing probe
   * aborts the whole transaction, and every later statement — including the
   * snapshot write — dies with "current transaction is aborted", carrying no
   * hint that a swallowed probe error caused it. This is reachable today:
   * `tx_special_district` is queried by the mud probe and is not part of the
   * drizzle schema, so it is absent from every test schema and from any fresh
   * database. Callers running inside a transaction pass a savepoint-guarded
   * handle here so the swallow stays local to the probe that swallowed.
   */
  capabilityDb?: SelectDb;
}

/** Reason string stamped when the capability probe is skipped by request. */
export const CAPABILITY_PROBE_SKIPPED_REASON =
  "capability probe skipped by request (probe=skip) — not measured on this run";

/**
 * Live compute of the county-ledger GET body (no servedAt). This is the
 * expensive path: facet scan + CROSS JOIN grid + COUNT DISTINCT capability
 * probes. Callers: materialize CLI, GET ?compute=live, POST /recompute.
 */
export async function computeCountyLedgerPayload(
  db: SelectDb,
  options: ComputeCountyLedgerOptions = {},
): Promise<CountyLedgerPayload> {
  const probeCapabilities = options.probeCapabilities !== false;
  const rows = await db.select().from(countyFacetCoverage);
  const [mirrorRows, gateCertRows, openEvents, manifestCells, manifestRows, capabilityOutcome] =
    await Promise.all([
      db.select().from(jurisdictionRegistryRowMirror),
      db.select().from(countyGateCertState),
      db.select().from(onboardingLedgerEvent).where(eq(onboardingLedgerEvent.status, "open")),
      readManifestGrid(db),
      db.select().from(countyManifest),
      probeCapabilities
        ? probeRailCapabilities(options.capabilityDb ?? db)
        : Promise.resolve({
            railCapabilities: null,
            reason: CAPABILITY_PROBE_SKIPPED_REASON,
          } as const),
    ]);

  const gateCertByRowId = new Map<string, (typeof gateCertRows)[number]>(
    gateCertRows.map((g: { rowId: string }) => [g.rowId, g]),
  );
  const openEventsByRowId = new Map<string, typeof openEvents>();
  for (const ev of openEvents) {
    const list = openEventsByRowId.get(ev.rowId) ?? [];
    list.push(ev);
    openEventsByRowId.set(ev.rowId, list);
  }

  const byCounty = new Map<string, CountyLedgerRow>();
  for (const r of rows) {
    const fips = r.countyFips;
    let county = byCounty.get(fips);
    if (!county) {
      county = {
        countyFips: fips,
        countyName: null,
        onboarded: false,
        hasStale: false,
        rewarmUnsafe: false,
        recipeVersions: [],
        certStates: [],
        facets: [],
        rows: [],
      };
      byCounty.set(fips, county);
    }
    const facet: FacetRow = {
      facet: r.facet,
      honestCoveragePct: num(r.honestCoveragePct),
      integrityVerdict: r.integrityVerdict,
      ownerMatchRate: num(r.ownerMatchRate),
      source: r.source ?? null,
      sourceVintage: r.sourceVintage ?? null,
      recipeVersion: r.recipeVersion ?? null,
      certState: r.certState ?? null,
      stalenessFlag: Boolean(r.stalenessFlag),
      rewarmUnsafe: Boolean(r.rewarmUnsafe),
      costUsd: num(r.costUsd),
      onboarded: Boolean(r.onboarded),
      lastRewarmAt: iso(r.lastRewarmAt),
      lastRefreshAt: iso(r.lastRefreshAt),
    };
    county.facets.push(facet);
    if (facet.onboarded) county.onboarded = true;
    if (facet.stalenessFlag) county.hasStale = true;
    if (facet.rewarmUnsafe) county.rewarmUnsafe = true;
    if (facet.recipeVersion && !county.recipeVersions.includes(facet.recipeVersion))
      county.recipeVersions.push(facet.recipeVersion);
    if (facet.certState && !county.certStates.includes(facet.certState))
      county.certStates.push(facet.certState);
  }

  for (const mirror of mirrorRows) {
    let county = byCounty.get(mirror.fips);
    if (!county) {
      county = {
        countyFips: mirror.fips,
        countyName: mirror.countyName,
        onboarded: false,
        hasStale: false,
        rewarmUnsafe: false,
        recipeVersions: [],
        certStates: [],
        facets: [],
        rows: [],
      };
      byCounty.set(mirror.fips, county);
    } else if (!county.countyName) {
      county.countyName = mirror.countyName;
    }

    const gc = gateCertByRowId.get(mirror.rowId);
    const openForRow = openEventsByRowId.get(mirror.rowId) ?? [];
    const defectCounts = new Map<string, number>();
    for (const ev of openForRow) {
      defectCounts.set(ev.defectClass, (defectCounts.get(ev.defectClass) ?? 0) + 1);
    }

    county.rows.push({
      rowId: mirror.rowId,
      countyName: mirror.countyName,
      gate: gc
        ? {
            passCount: (gc as { gatePassCount?: number | null }).gatePassCount ?? null,
            declineCount: (gc as { gateDeclineCount?: number | null }).gateDeclineCount ?? null,
            checks: (gc as { gateChecks?: unknown }).gateChecks ?? null,
          }
        : null,
      cert: gc
        ? {
            label: (gc as { certLabel?: string | null }).certLabel ?? null,
            blockPass: (gc as { certBlockPass?: boolean | null }).certBlockPass ?? null,
            scopeAnnotations: (gc as { certScopeAnnotations?: unknown }).certScopeAnnotations ?? null,
            gradedAt: iso((gc as { certGradedAt?: unknown }).certGradedAt),
          }
        : null,
      openDefectClasses: Array.from(defectCounts.entries()).map(([defectClass, count]) => ({
        defectClass,
        count,
      })),
      focusedFixCount: openForRow.length,
    });
  }

  const counties = Array.from(byCounty.values()).sort((a, b) =>
    a.countyFips.localeCompare(b.countyFips),
  );

  const totalCounties = manifestRows.length || counties.length;
  const satisfiedCells = manifestCells.filter(isSatisfiedCell).length;
  const satisfiedPresentCells = manifestCells.filter(
    (c) => c.displayState === "satisfied-present",
  ).length;
  const satisfiedPresentPartialCells = manifestCells.filter(
    (c) => c.displayState === "satisfied-present" && c.isPartial,
  ).length;
  const satisfiedAbsentCells = manifestCells.filter(
    (c) => c.displayState === "satisfied-absent",
  ).length;
  const parcelCountByFips = new Map<string, number | null>(
    manifestRows.map((m: { countyFips: string; parcelCountEst: unknown }) => [
      m.countyFips,
      num(m.parcelCountEst),
    ]),
  );
  const rollup = computeTexasRollup(manifestCells, parcelCountByFips);

  const payload: CountyLedgerPayload = {
    counties,
    manifestCells,
    railCapabilities: capabilityOutcome.railCapabilities,
    summary: {
      onboardedCount: counties.filter((c) => c.onboarded).length,
      totalCounties,
      staleCount: counties.filter((c) => c.hasStale).length,
      rewarmUnsafeCount: counties.filter((c) => c.rewarmUnsafe).length,
      totalRails: COUNTY_RAIL_COUNT,
      totalCells: manifestCells.length,
      satisfiedCells,
      satisfiedPresentCells,
      satisfiedPresentPartialCells,
      satisfiedAbsentCells,
      texasCompletenessPct: rollup.texasPct,
    },
  };
  if (capabilityOutcome.railCapabilities === null) {
    payload.railCapabilitiesProbeReason = capabilityOutcome.reason;
  }
  return payload;
}

export function stampServedPayload(
  payload: CountyLedgerPayload,
  computedAt: Date,
  servedAt = new Date(),
): CountyLedgerPayload {
  const computedIso = computedAt.toISOString();
  const servedIso = servedAt.toISOString();
  return {
    ...payload,
    summary: {
      ...payload.summary,
      computedAt: computedIso,
      servedAt: servedIso,
      materializationAgeMs: servedAt.getTime() - computedAt.getTime(),
    },
  };
}

export async function readCountyLedgerSnapshot(
  db: SelectDb,
): Promise<{ computedAt: Date; payload: CountyLedgerPayload } | null> {
  const rows = (await db
    .select()
    .from(countyLedgerSnapshot)) as Array<{
    id: string;
    computedAt: Date;
    payload: CountyLedgerPayload;
  }>;
  const row = rows.find((r) => r.id === COUNTY_LEDGER_SNAPSHOT_ID) ?? rows[0];
  if (!row) return null;
  return { computedAt: row.computedAt, payload: row.payload };
}

/** Writer seam — scorers/planner call this (or the CLI wrapping it) after scoring. */
export async function materializeCountyLedger(
  db: SelectDb,
  upsert: (computedAt: Date, payload: CountyLedgerPayload) => Promise<void>,
  options: ComputeCountyLedgerOptions = {},
): Promise<{ computedAt: Date; payload: CountyLedgerPayload }> {
  const computedAt = new Date();
  const payload = await computeCountyLedgerPayload(db, options);
  await upsert(computedAt, payload);
  return { computedAt, payload };
}

/**
 * What actually MOVED between two ledger payloads.
 *
 * A recompute always stamps a fresh `computedAt`, so a moving timestamp is
 * evidence that a job ran and NOTHING ELSE. The question the operator is
 * actually asking — did the work that landed since the last materialization
 * reach the ledger — is answered by this diff, per rail, and by nothing else.
 *
 * Cell identity is `countyFips|railKey`. `added` and `removed` are measured
 * from the two key sets rather than derived by subtracting a total
 * (DEV_PROCESS 1.3), so a grid that changes shape is visible as a shape
 * change instead of arriving pre-averaged into `changed`.
 */
export interface CountyLedgerPayloadDelta {
  payloadChanged: boolean;
  summaryChanges: Array<{ key: string; before: unknown; after: unknown }>;
  cells: {
    before: number;
    after: number;
    changed: number;
    added: number;
    removed: number;
    /** changed + added + removed, per rail key. Only non-zero rails appear. */
    byRailKey: Record<string, number>;
  };
  countiesBefore: number;
  countiesAfter: number;
}

const cellKey = (c: { countyFips: string; railKey: string }): string =>
  c.countyFips + "|" + c.railKey;

/**
 * Key-order-independent serialization for the diff.
 *
 * The BEFORE payload comes back out of a jsonb column and the AFTER payload
 * is a freshly built JS object. Postgres jsonb does not preserve key order —
 * it stores object keys sorted by length then bytes — so a plain
 * JSON.stringify comparison reports EVERY cell as changed on two identical
 * recomputes. Caught by the "second recompute with nothing changed" test,
 * which is the whole reason that test asserts a boring result.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    "{" +
    entries.map(([k, v]) => JSON.stringify(k) + ":" + stableStringify(v)).join(",") +
    "}"
  );
}

export function diffCountyLedgerPayloads(
  before: CountyLedgerPayload | null,
  after: CountyLedgerPayload,
): CountyLedgerPayloadDelta {
  const beforeCells = new Map<string, ManifestCell>(
    (before?.manifestCells ?? []).map((c) => [cellKey(c), c]),
  );
  const afterCells = new Map<string, ManifestCell>(
    after.manifestCells.map((c) => [cellKey(c), c]),
  );

  const byRailKey: Record<string, number> = {};
  const bump = (railKey: string): void => {
    byRailKey[railKey] = (byRailKey[railKey] ?? 0) + 1;
  };

  let changed = 0;
  let added = 0;
  let removed = 0;
  for (const [key, afterCell] of afterCells) {
    const beforeCell = beforeCells.get(key);
    if (!beforeCell) {
      added += 1;
      bump(afterCell.railKey);
      continue;
    }
    if (stableStringify(beforeCell) !== stableStringify(afterCell)) {
      changed += 1;
      bump(afterCell.railKey);
    }
  }
  for (const [key, beforeCell] of beforeCells) {
    if (!afterCells.has(key)) {
      removed += 1;
      bump(beforeCell.railKey);
    }
  }

  const summaryChanges: CountyLedgerPayloadDelta["summaryChanges"] = [];
  const summaryKeys = new Set<string>([
    ...Object.keys((before?.summary ?? {}) as Record<string, unknown>),
    ...Object.keys(after.summary as unknown as Record<string, unknown>),
  ]);
  // computedAt / servedAt / materializationAgeMs are stamped at READ time and
  // are not part of the stored payload; if a caller ever hands in a stamped
  // payload they are excluded here so a fresh clock cannot read as a change.
  for (const key of ["computedAt", "servedAt", "materializationAgeMs"]) {
    summaryKeys.delete(key);
  }
  for (const key of summaryKeys) {
    const b = (before?.summary as unknown as Record<string, unknown> | undefined)?.[key];
    const a = (after.summary as unknown as Record<string, unknown>)[key];
    if (stableStringify(b) !== stableStringify(a)) {
      summaryChanges.push({ key, before: b ?? null, after: a ?? null });
    }
  }

  return {
    payloadChanged:
      changed > 0 || added > 0 || removed > 0 || summaryChanges.length > 0,
    summaryChanges,
    cells: {
      before: beforeCells.size,
      after: afterCells.size,
      changed,
      added,
      removed,
      byRailKey,
    },
    countiesBefore: before?.counties.length ?? 0,
    countiesAfter: after.counties.length,
  };
}

export { isSatisfiedCell, COUNTY_LEDGER_SNAPSHOT_ID };
