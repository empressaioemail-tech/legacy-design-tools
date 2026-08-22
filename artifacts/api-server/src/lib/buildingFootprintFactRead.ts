/**
 * Inspect-card building-footprint READ from building-footprint atoms.
 *
 * Writer seam `building-footprint-writer.ts` (cover-p17-roads, live store)
 * stores entity_id = `${parcelNodeId}:footprint:${footprintId}`. The first
 * attached slot is footprintId `primary`; later slots are `accessory-N`.
 * structureRole lives on the body (overlap class at WRITE). Do not parse
 * the last entity_id token as identity or as the role. Absence today also
 * uses `:footprint:primary` with body.absence.kind=no-footprint-feature.
 *
 * IDENT 356 (unmerged) would mint `{canonical}:footprint` plus
 * body.structureRole. That shape is not on the store. This module must
 * work on today's keys by reading the body.
 *
 * Dual grammar (R-07 Q8): the parcel PREFIX is stored as both
 * `{fips}:{prop}` and `{fips}:{prop}.00000000`. Bind tries both as
 * prefix-ranges `[prefix:, prefix;)`. Miss on both is a typed refusal
 * that names the prefixes, never a silent null. Q8 footprint bind rate
 * is UNMEASURED; this file invents no percent.
 *
 * Spatial attach (staged tx_building_footprint overlap) happens at WRITE.
 * This module never queries bake / place_layer_snapshots / CAD / GIS /
 * tx_building_footprint.
 *
 * TWO STORES. Atoms live in hauska_mcp (ATOMS_DATABASE_URL). The inspect
 * route's drizzle `db` is the deployment store. DATABASE_URL in api-server
 * means deployment, not atoms — this module does not read that name.
 */

import pg from "pg";

const PADDED_SUFFIX = ".00000000";
export const BUILDING_FOOTPRINT_ENTITY_TYPE = "building-footprint" as const;
export const BUILDING_FOOTPRINT_SOURCE = "building-footprint" as const;

export interface AtomQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export type BuildingFootprintFactBindPrefixes = readonly [string, string];

export type BuildingFootprintFactPrefixRanges = {
  integerStart: string;
  integerEnd: string;
  paddedStart: string;
  paddedEnd: string;
};

/**
 * Both parcel-prefix grammars, always, in stable order: integer then padded.
 * Inbound `{fips}:{prop}.00000000` inverts to the integer prefix; inbound
 * integer appends the suffix. Never returns one prefix. Never appends
 * :footprint: or :primary. Never appends :sd:.
 */
export function buildingFootprintFactBindPrefixes(
  parcelNodeId: string,
): BuildingFootprintFactBindPrefixes {
  if (parcelNodeId.endsWith(PADDED_SUFFIX)) {
    const integerForm = parcelNodeId.slice(0, -PADDED_SUFFIX.length);
    return [integerForm, parcelNodeId];
  }
  return [parcelNodeId, `${parcelNodeId}${PADDED_SUFFIX}`];
}

/** Writer-derived prefix-range bounds. `:` then `;` closes the suffix. */
export function buildingFootprintFactPrefixRanges(
  prefixes: BuildingFootprintFactBindPrefixes,
): BuildingFootprintFactPrefixRanges {
  return {
    integerStart: `${prefixes[0]}:`,
    integerEnd: `${prefixes[0]};`,
    paddedStart: `${prefixes[1]}:`,
    paddedEnd: `${prefixes[1]};`,
  };
}

export function entityIdInBuildingFootprintPrefixRange(
  entityId: string,
  prefixes: BuildingFootprintFactBindPrefixes,
): boolean {
  const ranges = buildingFootprintFactPrefixRanges(prefixes);
  return (
    (entityId >= ranges.integerStart && entityId < ranges.integerEnd) ||
    (entityId >= ranges.paddedStart && entityId < ranges.paddedEnd)
  );
}

export type StructureRole = "primary" | "accessory" | "unknown";

export type BuildingFootprintItem = {
  entityId: string;
  footprintId: string | null;
  structureRole: StructureRole | null;
  sourceTier: string | null;
  verificationStatus: string | null;
  confidence: number | null;
  footprintGeometry: { type: "Polygon"; coordinates: unknown } | null;
};

export type BuildingFootprintFactPresent = {
  state: "present";
  source: typeof BUILDING_FOOTPRINT_SOURCE;
  boundAs: string;
  tried: BuildingFootprintFactBindPrefixes;
  entityId: string;
  footprintId: string | null;
  structureRole: StructureRole | null;
  sourceTier: string | null;
  verificationStatus: string | null;
  confidence: number | null;
  footprintGeometry: { type: "Polygon"; coordinates: unknown } | null;
  footprints: BuildingFootprintItem[];
  sourceAdapter: string | null;
  sourceVintage: string | null;
  evaluatedAt: string | null;
};

export type BuildingFootprintFactTypedAbsence = {
  state: "absent";
  source: typeof BUILDING_FOOTPRINT_SOURCE;
  boundAs: string;
  tried: BuildingFootprintFactBindPrefixes;
  entityId: string;
  footprintId: string | null;
  structureRole: StructureRole | null;
  absence: { kind: string; reason: string } | null;
  verifiedAbsence: unknown;
  sourceTier: string | null;
  sourceAdapter: string | null;
};

export type BuildingFootprintFactRefusal = {
  state: "refused";
  code:
    | "atom-miss"
    | "bind-conflict"
    | "atoms-store-not-configured"
    | "malformed-atom";
  source: typeof BUILDING_FOOTPRINT_SOURCE;
  tried: BuildingFootprintFactBindPrefixes | [];
  reason: string;
};

export type BuildingFootprintFactRead =
  | BuildingFootprintFactPresent
  | BuildingFootprintFactTypedAbsence
  | BuildingFootprintFactRefusal;

type AtomRow = { entity_id: string; body: unknown };

const SELECT_BUILDING_FOOTPRINT_FACT = `
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
export function setBuildingFootprintFactAtomQueryableForTests(
  queryable: AtomQueryable | null,
): void {
  injectedQueryable = queryable;
}

export function resetBuildingFootprintFactAtomQueryableForTests(): void {
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

function prefixOfEntityId(
  entityId: string,
  prefixes: BuildingFootprintFactBindPrefixes,
): string | null {
  if (entityId.startsWith(`${prefixes[0]}:`)) return prefixes[0];
  if (entityId.startsWith(`${prefixes[1]}:`)) return prefixes[1];
  return null;
}

function asStructureRole(value: unknown): StructureRole | null {
  if (value === "primary" || value === "accessory" || value === "unknown") {
    return value;
  }
  return null;
}

function asFootprintGeometry(
  value: unknown,
): { type: "Polygon"; coordinates: unknown } | null {
  const rec = asRecord(value);
  if (!rec) return null;
  if (rec.type !== "Polygon") return null;
  return { type: "Polygon", coordinates: rec.coordinates };
}

function bodyLooksAbsent(rec: Record<string, unknown>): boolean {
  return (
    Boolean(asRecord(rec.absence)) ||
    rec.sourceTier === "absent" ||
    rec.verifiedAbsence != null
  );
}

/**
 * Role and slot come from the body. The last entity_id token is a writer
 * slot name on today's keys (`primary`, `accessory-N`) and is not identity.
 */
function presentFootprintFromRow(
  entityId: string,
  body: unknown,
): BuildingFootprintItem | { malformed: string } | { absent: true } {
  const rec = asRecord(body);
  if (!rec) {
    return {
      malformed: `building-footprint entity_id ${entityId} has a non-object body.`,
    };
  }
  if (rec.entityType != null && rec.entityType !== BUILDING_FOOTPRINT_ENTITY_TYPE) {
    return {
      malformed: `building-footprint entity_id ${entityId} body.entityType is ${String(rec.entityType)}, not building-footprint.`,
    };
  }
  if (bodyLooksAbsent(rec)) {
    return { absent: true };
  }
  const footprintId = asNullableString(rec.footprintId);
  const structureRole = asStructureRole(rec.structureRole);
  const footprintGeometry = asFootprintGeometry(rec.footprintGeometry);
  if (!footprintId && !structureRole && !footprintGeometry) {
    return {
      malformed: `building-footprint entity_id ${entityId} is neither a present footprint nor a typed absence.`,
    };
  }
  return {
    entityId,
    footprintId,
    structureRole,
    sourceTier: asNullableString(rec.sourceTier),
    verificationStatus: asNullableString(rec.verificationStatus),
    confidence: asNullableNumber(rec.confidence),
    footprintGeometry,
  };
}

function leadFootprint(items: BuildingFootprintItem[]): BuildingFootprintItem {
  return [...items].sort((a, b) => {
    const aRole = a.structureRole === "primary" ? 0 : 1;
    const bRole = b.structureRole === "primary" ? 0 : 1;
    if (aRole !== bRole) return aRole - bRole;
    const aPrimarySlot = a.footprintId === "primary" ? 0 : 1;
    const bPrimarySlot = b.footprintId === "primary" ? 0 : 1;
    if (aPrimarySlot !== bPrimarySlot) return aPrimarySlot - bPrimarySlot;
    const aSlot = a.footprintId ?? "";
    const bSlot = b.footprintId ?? "";
    if (aSlot !== bSlot) return aSlot.localeCompare(bSlot);
    return a.entityId.localeCompare(b.entityId);
  })[0];
}

function footprintIdSet(items: BuildingFootprintItem[]): string {
  return [...new Set(items.map((f) => f.footprintId ?? ""))].sort().join("|");
}

function interpretAbsence(
  entityId: string,
  body: unknown,
  tried: BuildingFootprintFactBindPrefixes,
): BuildingFootprintFactTypedAbsence | BuildingFootprintFactRefusal {
  const rec = asRecord(body);
  if (!rec) {
    return {
      state: "refused",
      code: "malformed-atom",
      source: BUILDING_FOOTPRINT_SOURCE,
      tried,
      reason: `building-footprint entity_id ${entityId} has a non-object body. Refusing rather than inventing a footprint.`,
    };
  }
  const absence = asRecord(rec.absence);
  const kind = asNullableString(absence?.kind);
  const reason = asNullableString(absence?.reason);
  return {
    state: "absent",
    source: BUILDING_FOOTPRINT_SOURCE,
    boundAs: entityId,
    tried,
    entityId,
    footprintId: asNullableString(rec.footprintId),
    structureRole: asStructureRole(rec.structureRole),
    absence: kind && reason ? { kind, reason } : null,
    verifiedAbsence: rec.verifiedAbsence ?? null,
    sourceTier: asNullableString(rec.sourceTier),
    sourceAdapter: asNullableString(rec.sourceAdapter),
  };
}

function presentFromItems(
  items: BuildingFootprintItem[],
  bodyByEntityId: Map<string, Record<string, unknown>>,
  tried: BuildingFootprintFactBindPrefixes,
): BuildingFootprintFactPresent | BuildingFootprintFactRefusal {
  if (items.length === 0) {
    return {
      state: "refused",
      code: "malformed-atom",
      source: BUILDING_FOOTPRINT_SOURCE,
      tried,
      reason:
        "building-footprint present set was empty after filtering. Refusing rather than inventing a footprint.",
    };
  }
  const lead = leadFootprint(items);
  const rec = bodyByEntityId.get(lead.entityId) ?? {};
  return {
    state: "present",
    source: BUILDING_FOOTPRINT_SOURCE,
    boundAs: lead.entityId,
    tried,
    entityId: lead.entityId,
    footprintId: lead.footprintId,
    structureRole: lead.structureRole,
    sourceTier: lead.sourceTier,
    verificationStatus: lead.verificationStatus,
    confidence: lead.confidence,
    footprintGeometry: lead.footprintGeometry,
    footprints: items,
    sourceAdapter: asNullableString(rec.sourceAdapter),
    sourceVintage: asNullableString(rec.sourceVintage),
    evaluatedAt: asNullableString(rec.evaluatedAt),
  };
}

/**
 * Interpret already-fetched atom rows. Pure. Tests drive this with fixtures
 * so a miss, a padded-only hit, gold empty, Anderson present, an accessory
 * slot whose body.structureRole is primary, and a :primary key whose body
 * role is accessory are observed without a store.
 */
export function interpretBuildingFootprintFactRows(
  parcelNodeId: string,
  rows: ReadonlyArray<AtomRow>,
): BuildingFootprintFactRead {
  const tried = buildingFootprintFactBindPrefixes(parcelNodeId);
  const hits = rows.filter((r) =>
    entityIdInBuildingFootprintPrefixRange(r.entity_id, tried),
  );
  if (hits.length === 0) {
    return {
      state: "refused",
      code: "atom-miss",
      source: BUILDING_FOOTPRINT_SOURCE,
      tried,
      reason: `No building-footprint atom for parcel prefix ${tried[0]} or ${tried[1]}. Atom miss, not a footprint determination.`,
    };
  }

  const integerPresent: BuildingFootprintItem[] = [];
  const paddedPresent: BuildingFootprintItem[] = [];
  const integerAbsent: AtomRow[] = [];
  const paddedAbsent: AtomRow[] = [];
  const bodyByEntityId = new Map<string, Record<string, unknown>>();

  for (const row of hits) {
    const rec = asRecord(row.body);
    if (rec) bodyByEntityId.set(row.entity_id, rec);
    const parsed = presentFootprintFromRow(row.entity_id, row.body);
    if ("malformed" in parsed) {
      return {
        state: "refused",
        code: "malformed-atom",
        source: BUILDING_FOOTPRINT_SOURCE,
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
    if (footprintIdSet(integerPresent) !== footprintIdSet(paddedPresent)) {
      return {
        state: "refused",
        code: "bind-conflict",
        source: BUILDING_FOOTPRINT_SOURCE,
        tried,
        reason: `building-footprint atoms at prefixes ${tried[0]} and ${tried[1]} disagree on footprintId set. Refusing rather than picking a footprint.`,
      };
    }
    return presentFromItems(integerPresent, bodyByEntityId, tried);
  }
  if (integerPresent.length > 0 && paddedHit && paddedPresent.length === 0) {
    return {
      state: "refused",
      code: "bind-conflict",
      source: BUILDING_FOOTPRINT_SOURCE,
      tried,
      reason: `building-footprint atoms at prefixes ${tried[0]} and ${tried[1]} disagree (present vs absence). Refusing rather than picking a footprint.`,
    };
  }
  if (paddedPresent.length > 0 && integerHit && integerPresent.length === 0) {
    return {
      state: "refused",
      code: "bind-conflict",
      source: BUILDING_FOOTPRINT_SOURCE,
      tried,
      reason: `building-footprint atoms at prefixes ${tried[0]} and ${tried[1]} disagree (present vs absence). Refusing rather than picking a footprint.`,
    };
  }
  if (integerPresent.length > 0) {
    return presentFromItems(integerPresent, bodyByEntityId, tried);
  }
  if (paddedPresent.length > 0) {
    return presentFromItems(paddedPresent, bodyByEntityId, tried);
  }

  const chosenAbsent = integerAbsent[0] ?? paddedAbsent[0];
  return interpretAbsence(chosenAbsent.entity_id, chosenAbsent.body, tried);
}

export async function loadBuildingFootprintFactAtom(
  parcelNodeId: string,
): Promise<BuildingFootprintFactRead> {
  const tried = buildingFootprintFactBindPrefixes(parcelNodeId);
  const ranges = buildingFootprintFactPrefixRanges(tried);
  const atoms = resolveQueryable();
  if (!atoms) {
    return {
      state: "refused",
      code: "atoms-store-not-configured",
      source: BUILDING_FOOTPRINT_SOURCE,
      tried,
      reason:
        "building-footprint lives in the ATOMS store (ATOMS_DATABASE_URL). That store is not configured. Refusing rather than reading place_layer_snapshots, CAD, GIS, tx_building_footprint, or emitting a silent null.",
    };
  }
  const result = await atoms.query<AtomRow>(SELECT_BUILDING_FOOTPRINT_FACT, [
    BUILDING_FOOTPRINT_ENTITY_TYPE,
    ranges.integerStart,
    ranges.integerEnd,
    ranges.paddedStart,
    ranges.paddedEnd,
  ]);
  return interpretBuildingFootprintFactRows(parcelNodeId, result.rows);
}

/** In-memory atoms table for tests. Refuses any query that is not this SELECT. */
export function memoryBuildingFootprintFactAtoms(
  rows: ReadonlyArray<{ entityId: string; body: Record<string, unknown> }>,
): AtomQueryable {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }> {
      if (text.includes("place_layer_snapshots")) {
        throw new Error(
          "memoryBuildingFootprintFactAtoms: place_layer_snapshots is not a building-footprint source",
        );
      }
      if (text.includes("cad_property")) {
        throw new Error(
          "memoryBuildingFootprintFactAtoms: cad_property is not a building-footprint source",
        );
      }
      if (text.includes("tx_building_footprint")) {
        throw new Error(
          "memoryBuildingFootprintFactAtoms: tx_building_footprint is write-time staged GIS, not a serve source",
        );
      }
      if (/gis/i.test(text) || text.includes("texas-rrc")) {
        throw new Error(
          "memoryBuildingFootprintFactAtoms: GIS is not a building-footprint source",
        );
      }
      if (text.includes(":sd:")) {
        throw new Error(
          "memoryBuildingFootprintFactAtoms: special-district :sd: picker is not the building-footprint bind",
        );
      }
      if (text.includes("entity_id = ANY")) {
        throw new Error(
          "memoryBuildingFootprintFactAtoms: pipeline-style entity_id = ANY(bare parcel) misses ${parcel}:footprint:${footprintId}",
        );
      }
      if (text.includes("split_part") || text.includes(":primary")) {
        throw new Error(
          "memoryBuildingFootprintFactAtoms: :primary is a writer slot, not identity. Read body.structureRole.",
        );
      }
      if (
        !text.includes("FROM atoms") ||
        !text.includes("entity_type") ||
        !text.includes("entity_id >= $2")
      ) {
        throw new Error(
          "memoryBuildingFootprintFactAtoms: refusing a query that is not the building-footprint prefix-range SELECT",
        );
      }
      if (params?.[0] !== BUILDING_FOOTPRINT_ENTITY_TYPE) {
        throw new Error(
          `memoryBuildingFootprintFactAtoms: expected entity_type building-footprint, got ${String(params?.[0])}`,
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
          "memoryBuildingFootprintFactAtoms: expected prefix-range bounds as $2..$5",
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
