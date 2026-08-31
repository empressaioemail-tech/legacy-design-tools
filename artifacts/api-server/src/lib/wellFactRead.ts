/**
 * Inspect-card well READ from well-fact atoms.
 *
 * Writer seam `well-fact-writer.ts` stores
 * entity_id = `${parcelNodeId}:${wellKey}`. Present wellKey is apiNumber14.
 * Absence wellKey is `none`. Spatial attach (on-parcel PIP + near-parcel
 * within 152 m against staged tx_rrc_well) happens at WRITE. This module
 * is a NEW sibling lookup of those atoms, never a live GIS near query,
 * never a special-district :sd: picker, and never pipelineFact's
 * entity_id = ANY(bare parcel keys).
 *
 * Dual grammar (R-07 Q8): the parcel PREFIX is stored as both
 * `{fips}:{prop}` and `{fips}:{prop}.00000000`. Bind tries both as
 * prefix-ranges `[prefix:, prefix;)`. Miss on both is a typed refusal
 * that names the prefixes, never a silent null. Q8 well bind rate is
 * UNMEASURED; this file invents no percent.
 *
 * Outside the 152 m radius is a stored `:none` absence, not a present
 * well and not an invented miss. Gold Bastrop 48021:34137 has no
 * well-fact row at all: that is atom-miss, not a fabricated absence.
 *
 * Never SELECT bake / place_layer_snapshots / CAD / texas-rrc /
 * tx_rrc_well for this field.
 *
 * TWO STORES. Atoms live in hauska_mcp (ATOMS_DATABASE_URL). The inspect
 * route's drizzle `db` is the deployment store. DATABASE_URL in api-server
 * means deployment, not atoms — this module does not read that name.
 */

import pg from "pg";

const PADDED_SUFFIX = ".00000000";
const ABSENCE_WELL_KEY = "none";
export const WELL_FACT_ENTITY_TYPE = "well-fact" as const;
export const WELL_FACT_SOURCE = "well-fact" as const;

export interface AtomQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export type WellFactBindPrefixes = readonly [string, string];

export type WellFactPrefixRanges = {
  integerStart: string;
  integerEnd: string;
  paddedStart: string;
  paddedEnd: string;
};

/**
 * Both parcel-prefix grammars, always, in stable order: integer then padded.
 * Inbound `{fips}:{prop}.00000000` inverts to the integer prefix; inbound
 * integer appends the suffix. Never returns one prefix. Never appends a
 * well id. Never appends :sd:.
 */
export function wellFactBindPrefixes(
  parcelNodeId: string,
): WellFactBindPrefixes {
  if (parcelNodeId.endsWith(PADDED_SUFFIX)) {
    const integerForm = parcelNodeId.slice(0, -PADDED_SUFFIX.length);
    return [integerForm, parcelNodeId];
  }
  return [parcelNodeId, `${parcelNodeId}${PADDED_SUFFIX}`];
}

/** Writer-derived prefix-range bounds. `:` then `;` closes the wellKey suffix. */
export function wellFactPrefixRanges(
  prefixes: WellFactBindPrefixes,
): WellFactPrefixRanges {
  return {
    integerStart: `${prefixes[0]}:`,
    integerEnd: `${prefixes[0]};`,
    paddedStart: `${prefixes[1]}:`,
    paddedEnd: `${prefixes[1]};`,
  };
}

export function entityIdInWellFactPrefixRange(
  entityId: string,
  prefixes: WellFactBindPrefixes,
): boolean {
  const ranges = wellFactPrefixRanges(prefixes);
  return (
    (entityId >= ranges.integerStart && entityId < ranges.integerEnd) ||
    (entityId >= ranges.paddedStart && entityId < ranges.paddedEnd)
  );
}

export type WellFactWell = {
  entityId: string;
  wellKey: string;
  apiNumber14: string | null;
  wellStatus: string | null;
  wellType: string | null;
  orphaned: boolean | null;
  operatorName: string | null;
  parcelRelation: "on-parcel" | "near-parcel";
  proximityRadiusMeters: number | null;
  proximityDistanceMeters: number | null;
  surfaceLocation: { lat: number; lng: number } | null;
};

export type WellFactPresent = {
  state: "present";
  source: typeof WELL_FACT_SOURCE;
  boundAs: string;
  tried: WellFactBindPrefixes;
  entityId: string;
  wellKey: string;
  apiNumber14: string | null;
  wellStatus: string | null;
  wellType: string | null;
  orphaned: boolean | null;
  operatorName: string | null;
  parcelRelation: "on-parcel" | "near-parcel";
  proximityRadiusMeters: number | null;
  proximityDistanceMeters: number | null;
  surfaceLocation: { lat: number; lng: number } | null;
  wells: WellFactWell[];
  sourceAdapter: string | null;
  sourceVintage: string | null;
  evaluatedAt: string | null;
};

export type WellFactTypedAbsence = {
  state: "absent";
  source: typeof WELL_FACT_SOURCE;
  boundAs: string;
  tried: WellFactBindPrefixes;
  entityId: string;
  absence: { kind: string; reason: string } | null;
  verifiedAbsence: unknown;
  sourceTier: string | null;
  sourceAdapter: string | null;
  sourceVintage: string | null;
};

export type WellFactRefusal = {
  state: "refused";
  code:
    | "atom-miss"
    | "bind-conflict"
    | "atoms-store-not-configured"
    | "malformed-atom";
  source: typeof WELL_FACT_SOURCE;
  tried: WellFactBindPrefixes | [];
  reason: string;
};

export type WellFactRead =
  | WellFactPresent
  | WellFactTypedAbsence
  | WellFactRefusal;

type AtomRow = { entity_id: string; body: unknown };

const SELECT_WELL_FACT = `
SELECT entity_id, body
  FROM atoms
 WHERE entity_type = $1
   AND (
     (entity_id >= $2 AND entity_id < $3)
     OR (entity_id >= $4 AND entity_id < $5)
   )
`;

let injectedQueryable: AtomQueryable | null | undefined;
let sharedPool: pg.Pool | null = null;

/** Test seam. `null` means store not configured. `undefined` (reset) means env. */
export function setWellFactAtomQueryableForTests(
  queryable: AtomQueryable | null,
): void {
  injectedQueryable = queryable;
}

export function resetWellFactAtomQueryableForTests(): void {
  injectedQueryable = undefined;
}

function atomsQueryableFromEnv(): AtomQueryable | null {
  const url = process.env.ATOMS_DATABASE_URL?.trim();
  if (!url) return null;
  if (!sharedPool) {
    sharedPool = new pg.Pool({
      connectionString: url,
      ssl: url.includes("sslmode=") ? undefined : { rejectUnauthorized: false },
      max: 2,
    });
  }
  return sharedPool;
}

function resolveQueryable(): AtomQueryable | null {
  if (injectedQueryable !== undefined) return injectedQueryable;
  return atomsQueryableFromEnv();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function prefixOfEntityId(
  entityId: string,
  prefixes: WellFactBindPrefixes,
): string | null {
  if (entityId.startsWith(`${prefixes[0]}:`)) return prefixes[0];
  if (entityId.startsWith(`${prefixes[1]}:`)) return prefixes[1];
  return null;
}

function wellKeyOfEntityId(
  entityId: string,
  prefixes: WellFactBindPrefixes,
): string | null {
  const prefix = prefixOfEntityId(entityId, prefixes);
  if (!prefix) return null;
  return entityId.slice(prefix.length + 1);
}

function bodyLooksAbsent(rec: Record<string, unknown>): boolean {
  return (
    Boolean(asRecord(rec.absence)) ||
    rec.sourceTier === "absent" ||
    rec.verifiedAbsence != null
  );
}

function asParcelRelation(
  value: unknown,
): "on-parcel" | "near-parcel" | null {
  if (value === "on-parcel" || value === "near-parcel") return value;
  return null;
}

function asSurfaceLocation(
  value: unknown,
): { lat: number; lng: number } | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const lat = asNullableNumber(rec.lat);
  const lng = asNullableNumber(rec.lng);
  if (lat == null || lng == null) return null;
  return { lat, lng };
}

function presentWellFromRow(
  entityId: string,
  body: unknown,
  prefixes: WellFactBindPrefixes,
): WellFactWell | { malformed: string } | { absent: true } {
  const rec = asRecord(body);
  if (!rec) {
    return { malformed: `well-fact entity_id ${entityId} has a non-object body.` };
  }
  if (rec.entityType != null && rec.entityType !== WELL_FACT_ENTITY_TYPE) {
    return {
      malformed: `well-fact entity_id ${entityId} body.entityType is ${String(rec.entityType)}, not well-fact.`,
    };
  }
  const wellKey =
    asNullableString(rec.wellKey) ?? wellKeyOfEntityId(entityId, prefixes);
  if (wellKey === ABSENCE_WELL_KEY || bodyLooksAbsent(rec)) {
    return { absent: true };
  }
  const parcelRelation = asParcelRelation(rec.parcelRelation);
  if (!parcelRelation) {
    return {
      malformed: `well-fact entity_id ${entityId} is neither a present on-or-near well nor a typed absence.`,
    };
  }
  return {
    entityId,
    wellKey: wellKey ?? entityId,
    apiNumber14: asNullableString(rec.apiNumber14),
    wellStatus: asNullableString(rec.wellStatus),
    wellType: asNullableString(rec.wellType),
    orphaned: asNullableBoolean(rec.orphaned),
    operatorName: asNullableString(rec.operatorName),
    parcelRelation,
    proximityRadiusMeters: asNullableNumber(rec.proximityRadiusMeters),
    proximityDistanceMeters: asNullableNumber(rec.proximityDistanceMeters),
    surfaceLocation: asSurfaceLocation(rec.surfaceLocation),
  };
}

function leadWell(wells: WellFactWell[]): WellFactWell {
  return [...wells].sort((a, b) => {
    if (a.parcelRelation !== b.parcelRelation) {
      return a.parcelRelation === "on-parcel" ? -1 : 1;
    }
    const da = a.proximityDistanceMeters;
    const db = b.proximityDistanceMeters;
    if (da != null && db != null && da !== db) return da - db;
    if (da != null && db == null) return 1;
    if (da == null && db != null) return -1;
    return a.wellKey.localeCompare(b.wellKey);
  })[0];
}

function wellKeySet(wells: WellFactWell[]): string {
  return [...new Set(wells.map((w) => w.wellKey))].sort().join("|");
}

function interpretAbsence(
  entityId: string,
  body: unknown,
  tried: WellFactBindPrefixes,
): WellFactTypedAbsence | WellFactRefusal {
  const rec = asRecord(body);
  if (!rec) {
    return {
      state: "refused",
      code: "malformed-atom",
      source: WELL_FACT_SOURCE,
      tried,
      reason: `well-fact entity_id ${entityId} has a non-object body. Refusing rather than inventing a well.`,
    };
  }
  const absence = asRecord(rec.absence);
  const kind = asNullableString(absence?.kind);
  const reason = asNullableString(absence?.reason);
  return {
    state: "absent",
    source: WELL_FACT_SOURCE,
    boundAs: entityId,
    tried,
    entityId,
    absence: kind && reason ? { kind, reason } : null,
    verifiedAbsence: rec.verifiedAbsence ?? null,
    sourceTier: asNullableString(rec.sourceTier),
    sourceAdapter: asNullableString(rec.sourceAdapter),
    sourceVintage: asNullableString(rec.sourceVintage),
  };
}

function presentFromWells(
  wells: WellFactWell[],
  bodyByEntityId: Map<string, Record<string, unknown>>,
  tried: WellFactBindPrefixes,
): WellFactPresent | WellFactRefusal {
  if (wells.length === 0) {
    return {
      state: "refused",
      code: "malformed-atom",
      source: WELL_FACT_SOURCE,
      tried,
      reason:
        "well-fact present set was empty after filtering. Refusing rather than inventing a well.",
    };
  }
  const lead = leadWell(wells);
  const rec = bodyByEntityId.get(lead.entityId) ?? {};
  return {
    state: "present",
    source: WELL_FACT_SOURCE,
    boundAs: lead.entityId,
    tried,
    entityId: lead.entityId,
    wellKey: lead.wellKey,
    apiNumber14: lead.apiNumber14,
    wellStatus: lead.wellStatus,
    wellType: lead.wellType,
    orphaned: lead.orphaned,
    operatorName: lead.operatorName,
    parcelRelation: lead.parcelRelation,
    proximityRadiusMeters: lead.proximityRadiusMeters,
    proximityDistanceMeters: lead.proximityDistanceMeters,
    surfaceLocation: lead.surfaceLocation,
    wells,
    sourceAdapter: asNullableString(rec.sourceAdapter),
    sourceVintage: asNullableString(rec.sourceVintage),
    evaluatedAt: asNullableString(rec.evaluatedAt),
  };
}

/**
 * Interpret already-fetched atom rows. Pure. Tests drive this with fixtures
 * so a miss, a padded-only hit, gold empty, Crane on-parcel, and a conflict
 * are observed without a store.
 */
export function interpretWellFactRows(
  parcelNodeId: string,
  rows: ReadonlyArray<AtomRow>,
): WellFactRead {
  const tried = wellFactBindPrefixes(parcelNodeId);
  const hits = rows.filter((r) =>
    entityIdInWellFactPrefixRange(r.entity_id, tried),
  );
  if (hits.length === 0) {
    return {
      state: "refused",
      code: "atom-miss",
      source: WELL_FACT_SOURCE,
      tried,
      reason: `No well-fact atom for parcel prefix ${tried[0]} or ${tried[1]}. Atom miss, not a well determination.`,
    };
  }

  const integerPresent: WellFactWell[] = [];
  const paddedPresent: WellFactWell[] = [];
  const integerAbsent: AtomRow[] = [];
  const paddedAbsent: AtomRow[] = [];
  const bodyByEntityId = new Map<string, Record<string, unknown>>();

  for (const row of hits) {
    const rec = asRecord(row.body);
    if (rec) bodyByEntityId.set(row.entity_id, rec);
    const parsed = presentWellFromRow(row.entity_id, row.body, tried);
    if ("malformed" in parsed) {
      return {
        state: "refused",
        code: "malformed-atom",
        source: WELL_FACT_SOURCE,
        tried,
        reason: parsed.malformed,
      };
    }
    const prefix = prefixOfEntityId(row.entity_id, tried);
    if ("absent" in parsed) {
      if (prefix === tried[0]) integerAbsent.push(row);
      else paddedAbsent.push(row);
      continue;
    }
    if (prefix === tried[0]) integerPresent.push(parsed);
    else paddedPresent.push(parsed);
  }

  const integerHit = integerPresent.length > 0 || integerAbsent.length > 0;
  const paddedHit = paddedPresent.length > 0 || paddedAbsent.length > 0;

  if (integerPresent.length > 0 && paddedPresent.length > 0) {
    if (wellKeySet(integerPresent) !== wellKeySet(paddedPresent)) {
      return {
        state: "refused",
        code: "bind-conflict",
        source: WELL_FACT_SOURCE,
        tried,
        reason: `well-fact atoms at prefixes ${tried[0]} and ${tried[1]} disagree on wellKey set. Refusing rather than picking a well.`,
      };
    }
    return presentFromWells(integerPresent, bodyByEntityId, tried);
  }
  if (integerPresent.length > 0 && paddedHit && paddedPresent.length === 0) {
    return {
      state: "refused",
      code: "bind-conflict",
      source: WELL_FACT_SOURCE,
      tried,
      reason: `well-fact atoms at prefixes ${tried[0]} and ${tried[1]} disagree (present vs absence). Refusing rather than picking a well.`,
    };
  }
  if (paddedPresent.length > 0 && integerHit && integerPresent.length === 0) {
    return {
      state: "refused",
      code: "bind-conflict",
      source: WELL_FACT_SOURCE,
      tried,
      reason: `well-fact atoms at prefixes ${tried[0]} and ${tried[1]} disagree (present vs absence). Refusing rather than picking a well.`,
    };
  }
  if (integerPresent.length > 0) {
    return presentFromWells(integerPresent, bodyByEntityId, tried);
  }
  if (paddedPresent.length > 0) {
    return presentFromWells(paddedPresent, bodyByEntityId, tried);
  }

  const chosenAbsent =
    integerAbsent.find((r) => r.entity_id === `${tried[0]}:${ABSENCE_WELL_KEY}`) ??
    paddedAbsent.find((r) => r.entity_id === `${tried[1]}:${ABSENCE_WELL_KEY}`) ??
    integerAbsent[0] ??
    paddedAbsent[0];
  return interpretAbsence(chosenAbsent.entity_id, chosenAbsent.body, tried);
}

export async function loadWellFactAtom(
  parcelNodeId: string,
): Promise<WellFactRead> {
  const tried = wellFactBindPrefixes(parcelNodeId);
  const ranges = wellFactPrefixRanges(tried);
  const atoms = resolveQueryable();
  if (!atoms) {
    return {
      state: "refused",
      code: "atoms-store-not-configured",
      source: WELL_FACT_SOURCE,
      tried,
      reason:
        "well-fact lives in the ATOMS store (ATOMS_DATABASE_URL). That store is not configured. Refusing rather than reading place_layer_snapshots, texas-rrc GIS, tx_rrc_well, or emitting a silent null.",
    };
  }
  const result = await atoms.query<AtomRow>(SELECT_WELL_FACT, [
    WELL_FACT_ENTITY_TYPE,
    ranges.integerStart,
    ranges.integerEnd,
    ranges.paddedStart,
    ranges.paddedEnd,
  ]);
  return interpretWellFactRows(parcelNodeId, result.rows);
}

/** In-memory atoms table for tests. Refuses any query that is not this SELECT. */
export function memoryWellFactAtoms(
  rows: ReadonlyArray<{ entityId: string; body: Record<string, unknown> }>,
): AtomQueryable {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }> {
      if (text.includes("place_layer_snapshots")) {
        throw new Error(
          "memoryWellFactAtoms: place_layer_snapshots is not a well-fact source",
        );
      }
      if (text.includes("cad_property")) {
        throw new Error(
          "memoryWellFactAtoms: cad_property is not a well-fact source",
        );
      }
      if (text.includes("texas-rrc")) {
        throw new Error(
          "memoryWellFactAtoms: texas-rrc GIS is not a well-fact source",
        );
      }
      if (text.includes("tx_rrc_well")) {
        throw new Error(
          "memoryWellFactAtoms: tx_rrc_well is not a well-fact source",
        );
      }
      if (text.includes(":sd:")) {
        throw new Error(
          "memoryWellFactAtoms: special-district :sd: picker is not the well-fact bind",
        );
      }
      if (text.includes("entity_id = ANY")) {
        throw new Error(
          "memoryWellFactAtoms: pipeline-style entity_id = ANY(bare parcel) misses ${parcel}:${wellKey}",
        );
      }
      if (
        !text.includes("FROM atoms") ||
        !text.includes("entity_type") ||
        !text.includes("entity_id >= $2")
      ) {
        throw new Error(
          "memoryWellFactAtoms: refusing a query that is not the well-fact prefix-range SELECT",
        );
      }
      if (params?.[0] !== WELL_FACT_ENTITY_TYPE) {
        throw new Error(
          `memoryWellFactAtoms: expected entity_type well-fact, got ${String(params?.[0])}`,
        );
      }
      const integerStart = params?.[1];
      const integerEnd = params?.[2];
      const paddedStart = params?.[3];
      const paddedEnd = params?.[4];
      if (
        typeof integerStart !== "string" ||
        typeof integerEnd !== "string" ||
        typeof paddedStart !== "string" ||
        typeof paddedEnd !== "string"
      ) {
        throw new Error(
          "memoryWellFactAtoms: expected prefix-range bounds as $2..$5",
        );
      }
      return {
        rows: rows
          .filter(
            (r) =>
              (r.entityId >= integerStart && r.entityId < integerEnd) ||
              (r.entityId >= paddedStart && r.entityId < paddedEnd),
          )
          .map((r) => ({ entity_id: r.entityId, body: r.body })) as unknown as T[],
      };
    },
  };
}
