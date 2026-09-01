/**
 * Inspect-card property-boundary-edge READ from property-boundary-edge atoms.
 *
 * Writer seam `boundaryEdgeIdFromParts` (ident-p55 boundary-instances.ts)
 * stores entity_id = `${countyFips}:${propId}:boundary:${edgeIndex}`.
 * Geometry lives on the atom body (interior.edgeEndpoints Local-ENU metres,
 * propertyLineTags with provenance.kind=gis-approximate). Do not SELECT
 * GIS parcel outline / txgio_parcel / bake ring as this field.
 *
 * Dual grammar (R-07 Q8): the parcel PREFIX is stored as both
 * `{fips}:{prop}` and `{fips}:{prop}.00000000`. Bind tries both as
 * prefix-ranges `[prefix:boundary:, prefix:boundary;)`. Miss on both is a
 * typed refusal that names the prefixes, never a silent null and never a
 * copied GIS outline. Q8 edge bind rate is UNMEASURED; this file invents
 * no percent.
 *
 * Ring tessellation happens at WRITE. This module never queries bake /
 * place_layer_snapshots / CAD / GIS / txgio_parcel.
 *
 * TWO STORES. Atoms live in hauska_mcp (ATOMS_DATABASE_URL). The inspect
 * route's drizzle `db` is the deployment store. DATABASE_URL in api-server
 * means deployment, not atoms — this module does not read that name.
 *
 * Do not copy special-district `:sd:` picker. Do not copy pipeline
 * `entity_id = ANY(bare parcel)` (that misses `:boundary:${n}`).
 */

import pg from "pg";
import {
  serveBoundaryEdgeSetback,
  type BoundaryEdgeSetbackServe,
} from "./setbackProvenanceDisposition";

export type { BoundaryEdgeSetbackServe };

const PADDED_SUFFIX = ".00000000";
export const BOUNDARY_EDGE_ENTITY_TYPE = "property-boundary-edge" as const;
export const BOUNDARY_EDGE_SOURCE = "property-boundary-edge" as const;

const ROLES = ["front", "side", "rear", "side_corner"] as const;
export type BoundaryEdgeRole = (typeof ROLES)[number];

const ADJACENCY_KINDS = ["ROW", "alley", "neighbor-parcel", "unmapped"] as const;
export type BoundaryAdjacencyKind = (typeof ADJACENCY_KINDS)[number];

export interface AtomQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export type BoundaryEdgeFactBindPrefixes = readonly [string, string];

export type BoundaryEdgeFactPrefixRanges = {
  integerStart: string;
  integerEnd: string;
  paddedStart: string;
  paddedEnd: string;
};

/**
 * Both parcel-prefix grammars, always, in stable order: integer then padded.
 * Inbound `{fips}:{prop}.00000000` inverts to the integer prefix; inbound
 * integer appends the suffix. Never returns one prefix. Never appends
 * :boundary: or :sd:.
 */
export function boundaryEdgeFactBindPrefixes(
  parcelNodeId: string,
): BoundaryEdgeFactBindPrefixes {
  if (parcelNodeId.endsWith(PADDED_SUFFIX)) {
    const integerForm = parcelNodeId.slice(0, -PADDED_SUFFIX.length);
    return [integerForm, parcelNodeId];
  }
  return [parcelNodeId, `${parcelNodeId}${PADDED_SUFFIX}`];
}

/** Writer-derived prefix-range bounds. `:boundary:` then `:boundary;` closes. */
export function boundaryEdgeFactPrefixRanges(
  prefixes: BoundaryEdgeFactBindPrefixes,
): BoundaryEdgeFactPrefixRanges {
  return {
    integerStart: `${prefixes[0]}:boundary:`,
    integerEnd: `${prefixes[0]}:boundary;`,
    paddedStart: `${prefixes[1]}:boundary:`,
    paddedEnd: `${prefixes[1]}:boundary;`,
  };
}

export function entityIdInBoundaryEdgePrefixRange(
  entityId: string,
  prefixes: BoundaryEdgeFactBindPrefixes,
): boolean {
  const ranges = boundaryEdgeFactPrefixRanges(prefixes);
  return (
    (entityId >= ranges.integerStart && entityId < ranges.integerEnd) ||
    (entityId >= ranges.paddedStart && entityId < ranges.paddedEnd)
  );
}

export type BoundaryFacingRoad = {
  roadNodeId: string | null;
  classification: string | null;
  provenance: string | null;
  osmHighwayTag: string | null;
};

export type BoundaryInterior = {
  ringCcw: boolean | null;
  centroidInside: boolean | null;
  inwardNormal: { x: number; y: number } | null;
  edgeEndpoints: unknown;
};

export type BoundaryPropertyLineTags = {
  bearing: string | null;
  distanceFeet: number | null;
  provenance: {
    kind: string | null;
    honesty: string | null;
    source: string | null;
  } | null;
};

export type BoundaryEdgeItem = {
  entityId: string;
  edgeIndex: number;
  role: BoundaryEdgeRole | null;
  adjacencyKind: BoundaryAdjacencyKind | null;
  parcelNeighborPropId: string | null;
  facingRoad: BoundaryFacingRoad | null;
  frontBasis: string | null;
  setback: BoundaryEdgeSetbackServe;
  interior: BoundaryInterior | null;
  propertyLineTags: BoundaryPropertyLineTags | null;
  status: string | null;
  sourceAdapter: string | null;
};

export type BoundaryEdgeFactPresent = {
  state: "present";
  source: typeof BOUNDARY_EDGE_SOURCE;
  boundAs: string;
  tried: BoundaryEdgeFactBindPrefixes;
  entityId: string;
  edgeIndex: number;
  role: BoundaryEdgeRole | null;
  adjacencyKind: BoundaryAdjacencyKind | null;
  parcelNeighborPropId: string | null;
  facingRoad: BoundaryFacingRoad | null;
  frontBasis: string | null;
  setback: BoundaryEdgeSetbackServe;
  interior: BoundaryInterior | null;
  propertyLineTags: BoundaryPropertyLineTags | null;
  edges: BoundaryEdgeItem[];
  sourceAdapter: string | null;
  extractedAt: string | null;
};

export type BoundaryEdgeFactRefusal = {
  state: "refused";
  code:
    | "atom-miss"
    | "bind-conflict"
    | "atoms-store-not-configured"
    | "malformed-atom";
  source: typeof BOUNDARY_EDGE_SOURCE;
  tried: BoundaryEdgeFactBindPrefixes | [];
  reason: string;
};

export type BoundaryEdgeFactRead =
  | BoundaryEdgeFactPresent
  | BoundaryEdgeFactRefusal;

type AtomRow = { entity_id: string; body: unknown };

const SELECT_BOUNDARY_EDGE_FACT = `
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
export function setBoundaryEdgeFactAtomQueryableForTests(
  queryable: AtomQueryable | null,
): void {
  injectedQueryable = queryable;
}

export function resetBoundaryEdgeFactAtomQueryableForTests(): void {
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
  prefixes: BoundaryEdgeFactBindPrefixes,
): string | null {
  if (entityId.startsWith(`${prefixes[0]}:boundary:`)) return prefixes[0];
  if (entityId.startsWith(`${prefixes[1]}:boundary:`)) return prefixes[1];
  return null;
}

function asRole(value: unknown): BoundaryEdgeRole | null {
  if (typeof value !== "string") return null;
  return (ROLES as readonly string[]).includes(value)
    ? (value as BoundaryEdgeRole)
    : null;
}

function asAdjacencyKind(value: unknown): BoundaryAdjacencyKind | null {
  if (typeof value !== "string") return null;
  return (ADJACENCY_KINDS as readonly string[]).includes(value)
    ? (value as BoundaryAdjacencyKind)
    : null;
}

function asFacingRoad(value: unknown): BoundaryFacingRoad | null {
  const rec = asRecord(value);
  if (!rec) return null;
  return {
    roadNodeId: asNullableString(rec.roadNodeId),
    classification: asNullableString(rec.classification),
    provenance: asNullableString(rec.provenance),
    osmHighwayTag: asNullableString(rec.osmHighwayTag),
  };
}

function asInterior(value: unknown): BoundaryInterior | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const normal = asRecord(rec.inwardNormal);
  return {
    ringCcw: asNullableBoolean(rec.ringCcw),
    centroidInside: asNullableBoolean(rec.centroidInside),
    inwardNormal:
      normal &&
      typeof normal.x === "number" &&
      typeof normal.y === "number"
        ? { x: normal.x, y: normal.y }
        : null,
    edgeEndpoints: rec.edgeEndpoints ?? null,
  };
}

function asPropertyLineTags(value: unknown): BoundaryPropertyLineTags | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const provenance = asRecord(rec.provenance);
  return {
    bearing: asNullableString(rec.bearing),
    distanceFeet: asNullableNumber(rec.distanceFeet),
    provenance: provenance
      ? {
          kind: asNullableString(provenance.kind),
          honesty: asNullableString(provenance.honesty),
          source: asNullableString(provenance.source),
        }
      : null,
  };
}

function presentEdgeFromRow(
  entityId: string,
  body: unknown,
): BoundaryEdgeItem | { malformed: string } {
  const rec = asRecord(body);
  if (!rec) {
    return {
      malformed: `property-boundary-edge entity_id ${entityId} has a non-object body.`,
    };
  }
  if (rec.entityType != null && rec.entityType !== BOUNDARY_EDGE_ENTITY_TYPE) {
    return {
      malformed: `property-boundary-edge entity_id ${entityId} body.entityType is ${String(rec.entityType)}, not property-boundary-edge.`,
    };
  }
  const edgeIndex = asNullableNumber(rec.edgeIndex);
  if (edgeIndex == null) {
    return {
      malformed: `property-boundary-edge entity_id ${entityId} is missing body.edgeIndex. Refusing rather than inventing an edge or copying a GIS ring.`,
    };
  }
  return {
    entityId,
    edgeIndex,
    role: asRole(rec.role),
    adjacencyKind: asAdjacencyKind(rec.adjacencyKind),
    parcelNeighborPropId: asNullableString(rec.parcelNeighborPropId),
    facingRoad: asFacingRoad(rec.facingRoad),
    frontBasis: asNullableString(rec.frontBasis),
    setback: serveBoundaryEdgeSetback(rec.setback),
    interior: asInterior(rec.interior),
    propertyLineTags: asPropertyLineTags(rec.propertyLineTags),
    status: asNullableString(rec.status),
    sourceAdapter: asNullableString(rec.sourceAdapter),
  };
}

function leadEdge(items: BoundaryEdgeItem[]): BoundaryEdgeItem {
  return [...items].sort((a, b) => {
    const aFront = a.role === "front" ? 0 : 1;
    const bFront = b.role === "front" ? 0 : 1;
    if (aFront !== bFront) return aFront - bFront;
    if (a.edgeIndex !== b.edgeIndex) return a.edgeIndex - b.edgeIndex;
    return a.entityId.localeCompare(b.entityId);
  })[0];
}

function edgeIndexSet(items: BoundaryEdgeItem[]): string {
  return [...new Set(items.map((e) => String(e.edgeIndex)))].sort().join("|");
}

function presentFromItems(
  items: BoundaryEdgeItem[],
  bodyByEntityId: Map<string, Record<string, unknown>>,
  tried: BoundaryEdgeFactBindPrefixes,
): BoundaryEdgeFactPresent | BoundaryEdgeFactRefusal {
  if (items.length === 0) {
    return {
      state: "refused",
      code: "malformed-atom",
      source: BOUNDARY_EDGE_SOURCE,
      tried,
      reason:
        "property-boundary-edge present set was empty after filtering. Refusing rather than inventing an edge or copying a GIS ring.",
    };
  }
  const lead = leadEdge(items);
  const rec = bodyByEntityId.get(lead.entityId) ?? {};
  return {
    state: "present",
    source: BOUNDARY_EDGE_SOURCE,
    boundAs: lead.entityId,
    tried,
    entityId: lead.entityId,
    edgeIndex: lead.edgeIndex,
    role: lead.role,
    adjacencyKind: lead.adjacencyKind,
    parcelNeighborPropId: lead.parcelNeighborPropId,
    facingRoad: lead.facingRoad,
    frontBasis: lead.frontBasis,
    // Already classified at presentEdgeFromRow. Do not recopy raw body.setback.
    setback: lead.setback,
    interior: lead.interior,
    propertyLineTags: lead.propertyLineTags,
    edges: [...items].sort((a, b) => {
      if (a.edgeIndex !== b.edgeIndex) return a.edgeIndex - b.edgeIndex;
      return a.entityId.localeCompare(b.entityId);
    }),
    sourceAdapter: asNullableString(rec.sourceAdapter),
    extractedAt: asNullableString(rec.extractedAt),
  };
}

/**
 * Interpret already-fetched atom rows. Pure. Tests drive this with fixtures
 * so a miss, a padded-only hit, gold present, and a GIS-junk snapshot leak
 * are observed without a store.
 */
export function interpretBoundaryEdgeFactRows(
  parcelNodeId: string,
  rows: ReadonlyArray<AtomRow>,
): BoundaryEdgeFactRead {
  const tried = boundaryEdgeFactBindPrefixes(parcelNodeId);
  const hits = rows.filter((r) =>
    entityIdInBoundaryEdgePrefixRange(r.entity_id, tried),
  );
  if (hits.length === 0) {
    return {
      state: "refused",
      code: "atom-miss",
      source: BOUNDARY_EDGE_SOURCE,
      tried,
      reason: `No property-boundary-edge atom for parcel prefix ${tried[0]} or ${tried[1]}. Atom miss, not a GIS parcel outline.`,
    };
  }

  const integerPresent: BoundaryEdgeItem[] = [];
  const paddedPresent: BoundaryEdgeItem[] = [];
  const bodyByEntityId = new Map<string, Record<string, unknown>>();
  let retiredDropped = 0;

  for (const row of hits) {
    const rec = asRecord(row.body);
    if (rec) bodyByEntityId.set(row.entity_id, rec);
    const parsed = presentEdgeFromRow(row.entity_id, row.body);
    if ("malformed" in parsed) {
      return {
        state: "refused",
        code: "malformed-atom",
        source: BOUNDARY_EDGE_SOURCE,
        tried,
        reason: parsed.malformed,
      };
    }
    if ((parsed.status ?? "").trim() === "retired") {
      retiredDropped += 1;
      continue;
    }
    const prefix = prefixOfEntityId(row.entity_id, tried);
    if (prefix === tried[0]) integerPresent.push(parsed);
    else paddedPresent.push(parsed);
  }

  if (
    integerPresent.length === 0 &&
    paddedPresent.length === 0 &&
    retiredDropped > 0
  ) {
    return presentFromItems([], bodyByEntityId, tried);
  }

  if (integerPresent.length > 0 && paddedPresent.length > 0) {
    if (edgeIndexSet(integerPresent) !== edgeIndexSet(paddedPresent)) {
      return {
        state: "refused",
        code: "bind-conflict",
        source: BOUNDARY_EDGE_SOURCE,
        tried,
        reason: `property-boundary-edge atoms at prefixes ${tried[0]} and ${tried[1]} disagree on edgeIndex set. Refusing rather than picking a ring.`,
      };
    }
    return presentFromItems(integerPresent, bodyByEntityId, tried);
  }
  if (integerPresent.length > 0) {
    return presentFromItems(integerPresent, bodyByEntityId, tried);
  }
  if (paddedPresent.length > 0) {
    return presentFromItems(paddedPresent, bodyByEntityId, tried);
  }

  return {
    state: "refused",
    code: "atom-miss",
    source: BOUNDARY_EDGE_SOURCE,
    tried,
    reason: `No property-boundary-edge atom for parcel prefix ${tried[0]} or ${tried[1]}. Atom miss, not a GIS parcel outline.`,
  };
}

export async function loadBoundaryEdgeFactAtom(
  parcelNodeId: string,
): Promise<BoundaryEdgeFactRead> {
  const tried = boundaryEdgeFactBindPrefixes(parcelNodeId);
  const ranges = boundaryEdgeFactPrefixRanges(tried);
  const atoms = resolveQueryable();
  if (!atoms) {
    return {
      state: "refused",
      code: "atoms-store-not-configured",
      source: BOUNDARY_EDGE_SOURCE,
      tried,
      reason:
        "property-boundary-edge lives in the ATOMS store (ATOMS_DATABASE_URL). That store is not configured. Refusing rather than reading place_layer_snapshots, CAD, GIS, txgio_parcel, or emitting a silent null.",
    };
  }
  const result = await atoms.query<AtomRow>(SELECT_BOUNDARY_EDGE_FACT, [
    BOUNDARY_EDGE_ENTITY_TYPE,
    ranges.integerStart,
    ranges.integerEnd,
    ranges.paddedStart,
    ranges.paddedEnd,
  ]);
  return interpretBoundaryEdgeFactRows(parcelNodeId, result.rows);
}

/** In-memory atoms table for tests. Refuses any query that is not this SELECT. */
export function memoryBoundaryEdgeFactAtoms(
  rows: ReadonlyArray<{ entityId: string; body: Record<string, unknown> }>,
): AtomQueryable {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }> {
      if (text.includes("place_layer_snapshots")) {
        throw new Error(
          "memoryBoundaryEdgeFactAtoms: place_layer_snapshots is not a property-boundary-edge source",
        );
      }
      if (text.includes("cad_property")) {
        throw new Error(
          "memoryBoundaryEdgeFactAtoms: cad_property is not a property-boundary-edge source",
        );
      }
      if (text.includes("txgio_parcel")) {
        throw new Error(
          "memoryBoundaryEdgeFactAtoms: txgio_parcel is GIS parcel outline, not this atom",
        );
      }
      if (/gis/i.test(text) || text.includes("texas-rrc")) {
        throw new Error(
          "memoryBoundaryEdgeFactAtoms: GIS is not a property-boundary-edge source",
        );
      }
      if (text.includes(":sd:")) {
        throw new Error(
          "memoryBoundaryEdgeFactAtoms: special-district :sd: picker is not the property-boundary-edge bind",
        );
      }
      if (text.includes("entity_id = ANY")) {
        throw new Error(
          "memoryBoundaryEdgeFactAtoms: pipeline-style entity_id = ANY(bare parcel) misses ${parcel}:boundary:${edgeIndex}",
        );
      }
      if (
        !text.includes("FROM atoms") ||
        !text.includes("entity_type") ||
        !text.includes("entity_id >= $2")
      ) {
        throw new Error(
          "memoryBoundaryEdgeFactAtoms: refusing a query that is not the property-boundary-edge prefix-range SELECT",
        );
      }
      if (params?.[0] !== BOUNDARY_EDGE_ENTITY_TYPE) {
        throw new Error(
          `memoryBoundaryEdgeFactAtoms: expected entity_type property-boundary-edge, got ${String(params?.[0])}`,
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
          "memoryBoundaryEdgeFactAtoms: expected prefix-range bounds as $2..$5",
        );
      }
      if (
        !integerStart.endsWith(":boundary:") ||
        !integerEnd.endsWith(":boundary;") ||
        !paddedStart.endsWith(":boundary:") ||
        !paddedEnd.endsWith(":boundary;")
      ) {
        throw new Error(
          "memoryBoundaryEdgeFactAtoms: expected :boundary: suffix ranges, not a bare-parcel range",
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
