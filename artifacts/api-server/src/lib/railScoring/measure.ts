/**
 * MEASUREMENT KINDS — the only part of rail scoring that is code.
 *
 * A rail whose kind already exists becomes scoreable by editing
 * `./registry.ts` and nothing else. A rail that needs a NEW kind adds one
 * function here against the `RailMeasurer` interface, plus its registry entry.
 * That is the honest boundary of "scoring rules are data"; claiming more
 * would be the failure mode DEV_PROCESS 0 names.
 *
 * TWO STORES, and they are not interchangeable. `atoms` lives in the ATOMS
 * store (project `hauska-prod-497015`, database `hauska_mcp`).
 * `txgio_parcel`, `county_manifest` and `county_facet_coverage` live in the
 * DEPLOYMENT store (project `legacy-design-tools-prod`, database `neondb`).
 * Both resolve to the same Neon endpoint but different databases, so one pool
 * cannot see both.
 *
 * NAMING FOOTGUN, flagged rather than propagated: in the existing scorer CLIs
 * the env var `DATABASE_URL` means the ATOMS store, while in api-server the
 * same name means the DEPLOYMENT store. One name, two opposite meanings, in
 * one repo. Nothing in this module reads `DATABASE_URL` — callers hand it two
 * explicitly-named handles.
 */

import type { RailCellMeasurement } from "./engine";
import {
  absenceProbeCoversCounty,
  denominatorNeedsCityBoundary,
  type AtomCountRule,
  type ParcelColumnConjunctionRule,
  type ParcelColumnStampRule,
  type RailScoringRule,
} from "./registry";
import { wiredZoningCityKeys } from "@workspace/cad-ingest";
import {
  countyHasAnyGeometry,
  incorporatedStampDetail,
  measureIncorporatedStampCounts,
  readCityBoundaryAvailability,
  readLocatableFeatureCounts,
} from "./cityBoundaryDenominator";
import {
  resolveStampCellMeasurability,
  type CountyMeasurability,
} from "./countyMeasurability";

/**
 * The narrow query surface a measurer needs. `pg.Pool` and `pg.Client` both
 * satisfy it; so does a test double. Deliberately not a drizzle handle — a
 * measurer must be runnable from a CLI with no server bootstrap.
 */
export interface RailScoreQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface MeasureContext {
  /** DEPLOYMENT store: parcels, manifest, ledger. Always required. */
  deployment: RailScoreQueryable;
  /** ATOMS store. Null when not configured — atom-count rails then fail CLOSED and NAMED. */
  atoms: RailScoreQueryable | null;
  /**
   * Per-run memo of the parcel-feature denominator, keyed by county FIPS.
   *
   * Every rail shares this denominator, so without the memo a run over N
   * rails issues N `count(DISTINCT feature_index)` scans per county for one
   * unchanging number — the cost the per-rail-CLI pattern paid silently
   * because each CLI only ever knew about its own rail. `runRailScore`
   * supplies one; a caller may supply its own to share across runs.
   */
  featureCountCache?: Map<string, { features: number; table: string } | null>;
}

/** Why a rail could not be measured at all. Never silently skipped. */
export class RailNotMeasurableError extends Error {
  constructor(
    readonly railKey: string,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "RailNotMeasurableError";
  }
}

/**
 * Why ONE COUNTY of an otherwise-fine rail could not be measured.
 *
 * Distinct from `RailNotMeasurableError`, and the distinction is the whole
 * point. That one abandons the rail everywhere, which is right for "no
 * measurement spec" and catastrophic for "this county has no wired city
 * layer". This one skips the cell, names the reason, writes no row, and lets
 * the run continue. A refused cell is neither a zero nor a silence: it is a
 * declared instrument gap, and `lib/db/src/manifestDisplayState.ts` renders it
 * as one.
 */
export class CountyNotMeasurableError extends Error {
  constructor(
    readonly railKey: string,
    readonly countyFips: string,
    readonly refusal: string,
    readonly basis: string,
  ) {
    super(`${railKey} ${countyFips}: ${refusal}: ${basis}`);
    this.name = "CountyNotMeasurableError";
  }
}

const PARCEL_TABLES = ["txgio_parcel", "txgio_parcel_staging"] as const;

/** Guard every identifier that reaches SQL: registry values, but never trusted blindly. */
function assertIdentifier(kind: string, value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error(`unsafe ${kind} identifier in rail scoring registry: ${value}`);
  }
  return value;
}

async function tableExists(
  q: RailScoreQueryable,
  table: string,
): Promise<boolean> {
  const r = await q.query<{ r: string | null }>("SELECT to_regclass($1) AS r", [
    table,
  ]);
  return r.rows[0]?.r != null;
}

/**
 * The denominator: DISTINCT feature_index for the county.
 *
 * Returns null when NEITHER parcel table holds the county — a null
 * denominator, not a zero. The distinction is load-bearing: a zero would
 * divide, a null fails closed to `not-yet`.
 *
 * The machine name of what this function computes. Any rail measured through
 * this function must declare `denominator.kind` equal to this string, or the
 * declaration has drifted from the query (S-22). Keep this identifier next
 * to the SQL; do not relocate it to the registry.
 */
export const EXECUTED_PARCEL_FEATURE_DENOMINATOR_KIND =
  "txgio-parcel-distinct-feature-index" as const;

export async function readParcelFeatureCount(
  ctx: MeasureContext,
  countyFips: string,
): Promise<{ features: number; table: string } | null> {
  const cached = ctx.featureCountCache?.get(countyFips);
  if (cached !== undefined) return cached;
  let resolved: { features: number; table: string } | null = null;
  for (const table of PARCEL_TABLES) {
    if (!(await tableExists(ctx.deployment, table))) continue;
    const r = await ctx.deployment.query<{ features: string }>(
      `SELECT count(DISTINCT feature_index) AS features FROM ${table} WHERE county_fips = $1`,
      [countyFips],
    );
    const features = Number(r.rows[0]?.features ?? 0);
    if (features > 0) {
      resolved = { features, table };
      break;
    }
  }
  ctx.featureCountCache?.set(countyFips, resolved);
  return resolved;
}

/**
 * Atom count for one county, keyed on the entity_id FIPS prefix.
 *
 * Prefix RANGE rather than a LIKE or a regex so the query stays index-usable
 * on an 11M-row table, and so a single-county run never triggers a statewide
 * GROUP BY (AGENT_CONTRACT section 4: at most one heavy scan at a time across
 * all lanes).
 *
 * `left(entity_id, 5)` is the durable county key. `body->>'countyFips'` is
 * null for some counties (Harris 48201 among them), so it is not the key.
 */
export async function readAtomCountForCounty(
  atoms: RailScoreQueryable,
  entityType: string,
  countyFips: string,
): Promise<number> {
  const r = await atoms.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM atoms
      WHERE entity_type = $1
        AND entity_id >= $2
        AND entity_id < $3`,
    [entityType, countyFips, `${countyFips}￿`],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * Distinct parcel keys with at least one atom of the given type in the county.
 * Strips the family suffix after the first `:`-delimited parcel key segment
 * (e.g. `48021:34137:footprint:…` → `48021:34137`).
 */
export async function readDistinctParcelKeysWithAtoms(
  atoms: RailScoreQueryable,
  entityType: string,
  countyFips: string,
  excludeEntityId?: string,
): Promise<number> {
  const params: unknown[] = [entityType, countyFips, `${countyFips}￿`];
  let excludeClause = "";
  if (excludeEntityId != null) {
    excludeClause = " AND entity_id <> $4";
    params.push(excludeEntityId);
  }
  const r = await atoms.query<{ n: string }>(
    `SELECT count(DISTINCT split_part(entity_id, ':', 1) || ':' || split_part(entity_id, ':', 2))::text AS n
       FROM atoms
      WHERE entity_type = $1
        AND entity_id >= $2
        AND entity_id < $3${excludeClause}`,
    params,
  );
  return Number(r.rows[0]?.n ?? 0);
}

async function readSpecialDistrictCountForCounty(
  deployment: RailScoreQueryable,
  countyFips: string,
): Promise<number | null> {
  const table = "tx_special_district";
  if (!(await tableExists(deployment, table))) return null;
  const r = await deployment.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table} WHERE county_fips = $1`,
    [countyFips],
  );
  return Number(r.rows[0]?.n ?? 0);
}

function countyCoverageMarkerEntityId(countyFips: string): string {
  return `${countyFips}:_county_coverage`;
}

function basisFromCountyCoverageMarkerBody(body: unknown): string {
  if (body != null && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.absenceBasis === "string" && record.absenceBasis.trim()) {
      return record.absenceBasis.trim();
    }
    const verified = record.verifiedAbsence;
    if (verified != null && typeof verified === "object") {
      const scope = (verified as { provenanceScope?: unknown }).provenanceScope;
      if (Array.isArray(scope) && scope.length > 0) {
        return scope.filter((s): s is string => typeof s === "string").join(";");
      }
    }
  }
  return "special-district-county-coverage-marker;not-a-parcel";
}

async function readCountyCoverageMarkerAbsence(
  atoms: RailScoreQueryable,
  entityType: string,
  countyFips: string,
): Promise<RailCellMeasurement["establishedAbsence"]> {
  const entityId = countyCoverageMarkerEntityId(countyFips);
  const r = await atoms.query<{ body: unknown }>(
    `SELECT body
       FROM atoms
      WHERE entity_type = $1
        AND entity_id = $2
      LIMIT 1`,
    [entityType, entityId],
  );
  if (r.rows.length === 0) return null;
  return {
    basis: basisFromCountyCoverageMarkerBody(r.rows[0]?.body),
    source: "special-district-fact:_county_coverage",
    evidence: null,
  };
}

const MUD_PRESENT_SOURCE = "special-district-fact-determination-over-txgio-feature-index";

async function measureMud(
  rule: AtomCountRule,
  ctx: MeasureContext,
  countyFips: string,
): Promise<RailCellMeasurement> {
  if (!ctx.atoms) {
    throw new RailNotMeasurableError(
      rule.railKey,
      "atoms_store_not_configured",
      `rail '${rule.railKey}' is measured from the ATOMS store, which is not configured ` +
        `(set ATOMS_DATABASE_URL). Refusing to score it rather than reporting zero coverage.`,
    );
  }

  const markerEntityId = countyCoverageMarkerEntityId(countyFips);
  const establishedAbsence = await readCountyCoverageMarkerAbsence(
    ctx.atoms,
    rule.entityType,
    countyFips,
  );
  if (establishedAbsence != null) {
    return {
      countyFips,
      numerator: 0,
      denominator: null,
      sourcePresent: false,
      source: "special-district-fact:_county_coverage",
      detail: "countyCoverageMarker=true",
      absence: null,
      establishedAbsence,
    };
  }

  const den = await readParcelFeatureCount(ctx, countyFips);
  const num = await readDistinctParcelKeysWithAtoms(
    ctx.atoms,
    rule.entityType,
    countyFips,
    markerEntityId,
  );
  const presentSource = rule.presentSourceLabel ?? MUD_PRESENT_SOURCE;

  if (den == null) {
    const districtCount = await readSpecialDistrictCountForCounty(ctx.deployment, countyFips);
    if (districtCount != null && districtCount > 0) {
      return {
        countyFips,
        numerator: num,
        denominator: null,
        sourcePresent: num > 0,
        source: num > 0 ? presentSource : null,
        detail: "donleyGuard=features-zero-districts-positive",
        absence: null,
      };
    }
    const absence = await runAbsenceProbe(rule, ctx.deployment, countyFips);
    return {
      countyFips,
      numerator: num,
      denominator: null,
      sourcePresent: num > 0,
      source: num > 0 ? presentSource : null,
      detail: `atoms:entity_type=${rule.entityType},numeratorMode=distinct-parcel-keys,table=none`,
      absence,
    };
  }

  return {
    countyFips,
    numerator: num,
    denominator: den.features,
    sourcePresent: num > 0,
    source: presentSource,
    detail: `atoms:entity_type=${rule.entityType},numeratorMode=distinct-parcel-keys,table=${den.table}`,
    absence: null,
  };
}

/**
 * Run a declared absence probe. Returns a determination ONLY on a positive
 * finding (the source table is reachable for this county AND holds zero rows
 * for it). Everything else returns null, and null means "not established",
 * never "absent".
 */
async function runAbsenceProbe(
  rule: RailScoringRule,
  deployment: RailScoreQueryable,
  countyFips: string,
): Promise<RailCellMeasurement["absence"]> {
  const probe = rule.absenceProbe;
  if (!probe) return null;
  if (!absenceProbeCoversCounty(probe, countyFips)) return null;
  const table = assertIdentifier("absence probe table", probe.table);
  const column = assertIdentifier("absence probe fips column", probe.fipsColumn);
  if (!(await tableExists(deployment, table))) return null;
  const r = await deployment.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table} WHERE ${column} = $1`,
    [countyFips],
  );
  if (Number(r.rows[0]?.n ?? 0) !== 0) return null;
  return { basis: probe.basis, source: probe.table, evidence: null };
}

// ---------------------------------------------------------------------------
// The kinds.
// ---------------------------------------------------------------------------

async function measureAtomCount(
  rule: AtomCountRule,
  ctx: MeasureContext,
  countyFips: string,
): Promise<RailCellMeasurement> {
  if (!ctx.atoms) {
    // FAIL CLOSED AND NAMED. Scoring this as zero would write "no coverage"
    // for every county on the basis of a missing connection string.
    throw new RailNotMeasurableError(
      rule.railKey,
      "atoms_store_not_configured",
      `rail '${rule.railKey}' is measured from the ATOMS store, which is not configured ` +
        `(set ATOMS_DATABASE_URL). Refusing to score it rather than reporting zero coverage.`,
    );
  }
  const den = await readParcelFeatureCount(ctx, countyFips);
  const numeratorMode = rule.numeratorMode ?? "atom-count";
  const num =
    numeratorMode === "distinct-parcel-keys"
      ? await readDistinctParcelKeysWithAtoms(ctx.atoms, rule.entityType, countyFips)
      : await readAtomCountForCounty(ctx.atoms, rule.entityType, countyFips);
  const absence = den == null ? await runAbsenceProbe(rule, ctx.deployment, countyFips) : null;
  return {
    countyFips,
    numerator: num,
    denominator: den?.features ?? null,
    sourcePresent: num > 0,
    source: `${rule.entityType}-atom-count`,
    detail: `atoms:entity_type=${rule.entityType},numeratorMode=${numeratorMode},table=${den?.table ?? "none"}`,
    absence,
  };
}

/**
 * Does the resolved parcel table carry the stamp column at all?
 *
 * `to_regclass` (used by `tableExists`) is search_path-aware while
 * `information_schema.columns` matches on bare NAME across every schema, so
 * the `current_schemas(false)` predicate is required for the two lookups to be
 * answering about the same table. That reasoning, and this predicate, are lane
 * SS-W13's in `countyCoverageScoreCli.ts`; only the two-line helper is
 * restated, never the measurability RULE, which is imported.
 */
async function columnExists(
  q: RailScoreQueryable,
  table: string,
  column: string,
): Promise<boolean> {
  const r = await q.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2
        AND table_schema = ANY(current_schemas(false))`,
    [table, column],
  );
  return Number(r.rows[0]?.n ?? 0) > 0;
}

/**
 * The stamp rate over the INCORPORATED-CITY denominator.
 *
 * Measurability is resolved FIRST, before any spatial work: a refusal costs
 * one cheap query, and the join it avoids costs minutes on a metro county.
 * That ordering is not an optimisation dressed as a rule; it is what makes the
 * corrected denominator affordable, because only counties with a wired zoning
 * layer ever reach the join (10 today, not 254).
 */
async function measureIncorporatedColumnStamp(
  rule: ParcelColumnStampRule,
  ctx: MeasureContext,
  countyFips: string,
  column: string,
): Promise<RailCellMeasurement> {
  // EVERY QUERY HERE IS CHEAP, and that is deliberate: this path runs for the
  // whole target set, and 245 of 254 counties never get past the refusal. The
  // first version ran a full per-county `count(DISTINCT ...) FILTER` scan
  // before deciding measurability, which made the refusal path cost the same
  // as the measured one for the 244 counties it was built to spare.
  const den = await readParcelFeatureCount(ctx, countyFips);
  const table = den?.table ?? null;
  const boundary = await readCityBoundaryAvailability(ctx.deployment);
  const hasStampColumn =
    table === null ? false : await columnExists(ctx.deployment, table, column);
  const anyStamped =
    hasStampColumn && table !== null
      ? await anyStampPresent(ctx.deployment, table, column, countyFips)
      : false;
  const anyGeometry =
    table === null
      ? false
      : await countyHasAnyGeometry(ctx.deployment, table, countyFips);

  const measurability: CountyMeasurability = resolveStampCellMeasurability({
    table,
    hasStampColumn,
    wiredZoningLayers: wiredZoningCityKeys(countyFips).size,
    anyStamped,
    cityBoundaryRows: boundary.rows,
    needsCityBoundary: true,
    featuresWithGeom: anyGeometry ? 1 : 0,
  });
  if (!measurability.measurable) {
    throw new CountyNotMeasurableError(
      rule.railKey,
      countyFips,
      measurability.refusal ?? "unknown",
      measurability.basis ?? "",
    );
  }

  // Non-null by construction: every null-table path is refused above.
  const parcelTable = table as string;
  // The exact geom count is provenance, not a gate, so it is read only now
  // that the county is known to be measurable.
  const locatable = await readLocatableFeatureCounts(
    ctx.deployment,
    parcelTable,
    countyFips,
  );
  const counts = await measureIncorporatedStampCounts(
    ctx.deployment,
    parcelTable,
    column,
    countyFips,
    locatable,
  );
  return {
    countyFips,
    numerator: counts.stamped,
    denominator: counts.incorporated,
    // The COLUMN's existence, never a positive stamp rate (SF-24).
    sourcePresent: true,
    source: `${column}-stamp`,
    detail: incorporatedStampDetail(counts, parcelTable, column),
    absence: null,
  };
}

/** Does ANY parcel in the county carry the stamp? Drives SS-W13's `stamp-not-rolled`. */
async function anyStampPresent(
  q: RailScoreQueryable,
  table: string,
  column: string,
  countyFips: string,
): Promise<boolean> {
  const r = await q.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM ${table} WHERE county_fips = $1 AND ${column} IS NOT NULL
     ) AS present`,
    [countyFips],
  );
  return Boolean(r.rows[0]?.present);
}

async function measureColumnStamp(
  rule: ParcelColumnStampRule,
  ctx: MeasureContext,
  countyFips: string,
): Promise<RailCellMeasurement> {
  const column = assertIdentifier("stamp column", rule.column);
  // THE DECLARED DENOMINATOR IS NOW LOAD-BEARING. Before lane SS-W15 this
  // function ignored `rule.denominator` entirely and always used the
  // parcel-feature count, so the registry's required denominator field was
  // documentation rather than control.
  if (denominatorNeedsCityBoundary(rule.denominator.kind)) {
    return await measureIncorporatedColumnStamp(rule, ctx, countyFips, column);
  }
  const den = await readParcelFeatureCount(ctx, countyFips);
  if (den == null) {
    return {
      countyFips,
      numerator: null,
      denominator: null,
      sourcePresent: false,
      source: null,
      detail: `${rule.column}-stamp,table=none`,
      absence: await runAbsenceProbe(rule, ctx.deployment, countyFips),
    };
  }
  const r = await ctx.deployment.query<{ stamped: string }>(
    `WITH d AS (
       SELECT DISTINCT ON (feature_index) feature_index, ${column} AS v
         FROM ${den.table}
        WHERE county_fips = $1
        ORDER BY feature_index
     )
     SELECT count(*) FILTER (WHERE v IS NOT NULL)::text AS stamped FROM d`,
    [countyFips],
  );
  const stamped = Number(r.rows[0]?.stamped ?? 0);
  return {
    countyFips,
    numerator: stamped,
    denominator: den.features,
    // Source presence is the COLUMN's existence, never a positive stamp rate
    // (manufacturing presence from `stampedPct > 0` is SF-24). The column is
    // proven to exist by the query above having run at all.
    sourcePresent: true,
    source: `${rule.column}-stamp`,
    detail: `column=${rule.column},table=${den.table}`,
    absence: null,
  };
}

async function measureColumnConjunction(
  rule: ParcelColumnConjunctionRule,
  ctx: MeasureContext,
  countyFips: string,
): Promise<RailCellMeasurement> {
  const columns = rule.columns.map((c) => assertIdentifier("conjunction column", c));
  const den = await readParcelFeatureCount(ctx, countyFips);
  if (den == null) {
    return {
      countyFips,
      numerator: null,
      denominator: null,
      sourcePresent: false,
      source: null,
      detail: `conjunction=${rule.columns.join("+")},table=none`,
      absence: await runAbsenceProbe(rule, ctx.deployment, countyFips),
    };
  }
  const selectList = columns.map((c) => `${c} AS c_${c}`).join(", ");
  const predicate = columns.map((c) => `c_${c} IS NOT NULL`).join(" AND ");
  const r = await ctx.deployment.query<{ derivable: string }>(
    `WITH d AS (
       SELECT DISTINCT ON (feature_index) feature_index, ${selectList}
         FROM ${den.table}
        WHERE county_fips = $1
        ORDER BY feature_index
     )
     SELECT count(*) FILTER (WHERE ${predicate})::text AS derivable FROM d`,
    [countyFips],
  );
  const derivable = Number(r.rows[0]?.derivable ?? 0);
  return {
    countyFips,
    numerator: derivable,
    denominator: den.features,
    sourcePresent: true,
    source: "deterministic",
    detail: `conjunction=${rule.columns.join("+")},table=${den.table}`,
    absence: null,
  };
}

/** Dispatch one county's measurement for a rail. Throws for an unspecified rail. */
export async function measureRailCell(
  rule: RailScoringRule,
  ctx: MeasureContext,
  countyFips: string,
): Promise<RailCellMeasurement> {
  // FAIL CLOSED. A retired denominator means live rows were computed against
  // a lost counting rule. Executing readParcelFeatureCount would substitute
  // a reconstructible denominator and silently rewrite those rows. The guard
  // sits BEFORE the kind switch so a still-typed atom-count rule cannot
  // reach the measurer.
  if (rule.denominator.kind === "retired-unknown-denominator") {
    throw new RailNotMeasurableError(
      rule.railKey,
      "denominator_retired",
      `rail '${rule.railKey}' declares a retired denominator; live ledger rows were ` +
        `computed against a counting rule that is not reconstructible from checked-in ` +
        `source. Refusing to score rather than substituting ` +
        `${EXECUTED_PARCEL_FEATURE_DENOMINATOR_KIND}. Re-scoring is a different card (S-21).`,
    );
  }
  switch (rule.kind) {
    case "atom-count-over-parcel-features":
      if (rule.railKey === "mud") {
        return await measureMud(rule, ctx, countyFips);
      }
      return await measureAtomCount(rule, ctx, countyFips);
    case "parcel-column-stamp-rate":
      return await measureColumnStamp(rule, ctx, countyFips);
    case "parcel-column-conjunction-rate":
      return await measureColumnConjunction(rule, ctx, countyFips);
    case "unspecified":
      throw new RailNotMeasurableError(
        rule.railKey,
        "no_measurement_spec",
        `rail '${rule.railKey}' has no measurement spec. Owner: ${rule.specOwner}. ` +
          `Reason: ${rule.unspecifiedReason}`,
      );
  }
}

/** The county target set: every county in `county_manifest`. */
export async function readManifestCounties(
  deployment: RailScoreQueryable,
): Promise<Array<{ countyFips: string; countyName: string }>> {
  const r = await deployment.query<{ county_fips: string; county_name: string }>(
    "SELECT county_fips, county_name FROM county_manifest ORDER BY county_fips",
  );
  return r.rows.map((row) => ({
    countyFips: row.county_fips,
    countyName: row.county_name,
  }));
}
