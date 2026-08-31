/**
 * Inspect-card flood READ from flood-hazard-fact atoms.
 *
 * SS-W16 retired the baked Tier-2 snapshot flood facet (tile-centre NFHL).
 * This module is the replacement: a NEW lookup of atoms, never a revival of
 * place_layer_snapshots.flood. Dual grammar (R-07 Q8): entity_id is stored as
 * both `{fips}:{prop}` and `{fips}:{prop}.00000000`. Bind tries both. Miss on
 * both is a typed refusal that names the keys, never a silent null.
 *
 * TWO STORES. Atoms live in hauska_mcp (ATOMS_DATABASE_URL). The inspect
 * route's drizzle `db` is the deployment store. DATABASE_URL in api-server
 * means deployment, not atoms — this module does not read that name.
 */

import pg from "pg";

const PADDED_SUFFIX = ".00000000";
export const FLOOD_HAZARD_FACT_ENTITY_TYPE = "flood-hazard-fact" as const;
export const FLOOD_HAZARD_FACT_SOURCE = "flood-hazard-fact" as const;

export interface AtomQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export type FloodHazardFactBindKeys = readonly [string, string];

/**
 * Both grammars, always, in stable order: integer then padded.
 * Inbound `{fips}:{prop}.00000000` inverts to the integer prefix; inbound
 * integer appends the suffix. Never returns one key. Never invents a third.
 */
export function floodHazardFactBindKeys(
  parcelNodeId: string,
): FloodHazardFactBindKeys {
  if (parcelNodeId.endsWith(PADDED_SUFFIX)) {
    const integerForm = parcelNodeId.slice(0, -PADDED_SUFFIX.length);
    return [integerForm, parcelNodeId];
  }
  return [parcelNodeId, `${parcelNodeId}${PADDED_SUFFIX}`];
}

export type FloodHazardFactPresent = {
  state: "present";
  source: typeof FLOOD_HAZARD_FACT_SOURCE;
  boundAs: string;
  tried: FloodHazardFactBindKeys;
  entityId: string;
  inSpecialFloodHazardArea: boolean;
  floodZone: string | null;
  zoneSubtype: string | null;
  baseFloodElevation: number | null;
  sourceAdapter: string | null;
  sourceVintage: string | null;
  sourceCitation: string | null;
  evaluatedAt: string | null;
};

export type FloodHazardFactTypedAbsence = {
  state: "absent";
  source: typeof FLOOD_HAZARD_FACT_SOURCE;
  boundAs: string;
  tried: FloodHazardFactBindKeys;
  entityId: string;
  absence: { kind: string; reason: string } | null;
  verifiedAbsence: unknown;
  sourceTier: string | null;
  sourceAdapter: string | null;
  sourceVintage: string | null;
};

export type FloodHazardFactRefusal = {
  state: "refused";
  code:
    | "atom-miss"
    | "bind-conflict"
    | "atoms-store-not-configured"
    | "malformed-atom";
  source: typeof FLOOD_HAZARD_FACT_SOURCE;
  tried: FloodHazardFactBindKeys | [];
  reason: string;
};

export type FloodHazardFactRead =
  | FloodHazardFactPresent
  | FloodHazardFactTypedAbsence
  | FloodHazardFactRefusal;

type AtomRow = { entity_id: string; body: unknown };

const SELECT_FLOOD_HAZARD_FACT = `
SELECT entity_id, body
  FROM atoms
 WHERE entity_type = $1
   AND entity_id = ANY($2::text[])
`;

let injectedQueryable: AtomQueryable | null | undefined;
let sharedPool: pg.Pool | null = null;

/** Test seam. `null` means store not configured. `undefined` (reset) means env. */
export function setFloodHazardAtomQueryableForTests(
  queryable: AtomQueryable | null,
): void {
  injectedQueryable = queryable;
}

export function resetFloodHazardAtomQueryableForTests(): void {
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

function claimFingerprint(body: Record<string, unknown>): string {
  const absence = asRecord(body.absence);
  return JSON.stringify({
    sourceTier: body.sourceTier ?? null,
    inSpecialFloodHazardArea: body.inSpecialFloodHazardArea ?? null,
    floodZone: body.floodZone ?? null,
    zoneSubtype: body.zoneSubtype ?? null,
    baseFloodElevation: body.baseFloodElevation ?? null,
    absenceKind: absence?.kind ?? null,
    absenceReason: absence?.reason ?? null,
  });
}

function interpretBody(
  entityId: string,
  body: unknown,
  tried: FloodHazardFactBindKeys,
): FloodHazardFactPresent | FloodHazardFactTypedAbsence | FloodHazardFactRefusal {
  const rec = asRecord(body);
  if (!rec) {
    return {
      state: "refused",
      code: "malformed-atom",
      source: FLOOD_HAZARD_FACT_SOURCE,
      tried,
      reason: `flood-hazard-fact entity_id ${entityId} has a non-object body. Refusing rather than inventing a zone.`,
    };
  }
  if (rec.entityType != null && rec.entityType !== FLOOD_HAZARD_FACT_ENTITY_TYPE) {
    return {
      state: "refused",
      code: "malformed-atom",
      source: FLOOD_HAZARD_FACT_SOURCE,
      tried,
      reason: `flood-hazard-fact entity_id ${entityId} body.entityType is ${String(rec.entityType)}, not flood-hazard-fact.`,
    };
  }

  const absence = asRecord(rec.absence);
  const hasAbsence =
    Boolean(absence) ||
    rec.sourceTier === "absent" ||
    rec.verifiedAbsence != null;

  if (hasAbsence) {
    const kind = asNullableString(absence?.kind);
    const reason = asNullableString(absence?.reason);
    return {
      state: "absent",
      source: FLOOD_HAZARD_FACT_SOURCE,
      boundAs: entityId,
      tried,
      entityId,
      absence:
        kind && reason
          ? { kind, reason }
          : null,
      verifiedAbsence: rec.verifiedAbsence ?? null,
      sourceTier: asNullableString(rec.sourceTier),
      sourceAdapter: asNullableString(rec.sourceAdapter),
      sourceVintage: asNullableString(rec.sourceVintage),
    };
  }

  if (typeof rec.inSpecialFloodHazardArea !== "boolean") {
    return {
      state: "refused",
      code: "malformed-atom",
      source: FLOOD_HAZARD_FACT_SOURCE,
      tried,
      reason: `flood-hazard-fact entity_id ${entityId} is neither a present SFHA finding nor a typed absence.`,
    };
  }

  return {
    state: "present",
    source: FLOOD_HAZARD_FACT_SOURCE,
    boundAs: entityId,
    tried,
    entityId,
    inSpecialFloodHazardArea: rec.inSpecialFloodHazardArea,
    floodZone: typeof rec.floodZone === "string" ? rec.floodZone : null,
    zoneSubtype: typeof rec.zoneSubtype === "string" ? rec.zoneSubtype : null,
    baseFloodElevation: asNullableNumber(rec.baseFloodElevation),
    sourceAdapter: asNullableString(rec.sourceAdapter),
    sourceVintage: asNullableString(rec.sourceVintage),
    sourceCitation: asNullableString(rec.sourceCitation),
    evaluatedAt: asNullableString(rec.evaluatedAt),
  };
}

function pickPreferredRow(
  rows: AtomRow[],
  tried: FloodHazardFactBindKeys,
): AtomRow {
  const [integerForm, paddedForm] = tried;
  return (
    rows.find((r) => r.entity_id === integerForm) ??
    rows.find((r) => r.entity_id === paddedForm) ??
    rows[0]
  );
}

/**
 * Interpret already-fetched atom rows. Pure. Tests drive this with fixtures
 * so a miss, a padded-only hit, and a conflict are observed without a store.
 */
export function interpretFloodHazardFactRows(
  parcelNodeId: string,
  rows: ReadonlyArray<AtomRow>,
): FloodHazardFactRead {
  const tried = floodHazardFactBindKeys(parcelNodeId);
  const hits = rows.filter(
    (r) => r.entity_id === tried[0] || r.entity_id === tried[1],
  );
  if (hits.length === 0) {
    return {
      state: "refused",
      code: "atom-miss",
      source: FLOOD_HAZARD_FACT_SOURCE,
      tried,
      reason: `No flood-hazard-fact atom for ${tried[0]} or ${tried[1]}. Atom miss, not a flood determination.`,
    };
  }
  if (hits.length > 1) {
    const fingerprints = new Set(
      hits.map((h) => {
        const rec = asRecord(h.body);
        return rec ? claimFingerprint(rec) : `non-object:${h.entity_id}`;
      }),
    );
    if (fingerprints.size > 1) {
      return {
        state: "refused",
        code: "bind-conflict",
        source: FLOOD_HAZARD_FACT_SOURCE,
        tried,
        reason: `flood-hazard-fact atoms at ${tried[0]} and ${tried[1]} disagree. Refusing rather than picking a zone.`,
      };
    }
  }
  const chosen = pickPreferredRow(hits, tried);
  return interpretBody(chosen.entity_id, chosen.body, tried);
}

export async function loadFloodHazardFactAtom(
  parcelNodeId: string,
): Promise<FloodHazardFactRead> {
  const tried = floodHazardFactBindKeys(parcelNodeId);
  const atoms = resolveQueryable();
  if (!atoms) {
    return {
      state: "refused",
      code: "atoms-store-not-configured",
      source: FLOOD_HAZARD_FACT_SOURCE,
      tried,
      reason:
        "flood-hazard-fact lives in the ATOMS store (ATOMS_DATABASE_URL). That store is not configured. Refusing rather than reading place_layer_snapshots or emitting a silent null.",
    };
  }
  const result = await atoms.query<AtomRow>(SELECT_FLOOD_HAZARD_FACT, [
    FLOOD_HAZARD_FACT_ENTITY_TYPE,
    [...tried],
  ]);
  return interpretFloodHazardFactRows(parcelNodeId, result.rows);
}

/** In-memory atoms table for tests. Refuses any query that is not this SELECT. */
export function memoryFloodHazardAtoms(
  rows: ReadonlyArray<{ entityId: string; body: Record<string, unknown> }>,
): AtomQueryable {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }> {
      if (!text.includes("FROM atoms") || !text.includes("entity_type")) {
        throw new Error(
          "memoryFloodHazardAtoms: refusing a query that is not the flood-hazard-fact atoms SELECT",
        );
      }
      if (text.includes("place_layer_snapshots")) {
        throw new Error(
          "memoryFloodHazardAtoms: place_layer_snapshots is not a flood-hazard-fact source",
        );
      }
      if (params?.[0] !== FLOOD_HAZARD_FACT_ENTITY_TYPE) {
        throw new Error(
          `memoryFloodHazardAtoms: expected entity_type flood-hazard-fact, got ${String(params?.[0])}`,
        );
      }
      const ids = params?.[1];
      if (!Array.isArray(ids)) {
        throw new Error("memoryFloodHazardAtoms: expected entity_id array as $2");
      }
      const wanted = new Set(ids.map(String));
      return {
        rows: rows
          .filter((r) => wanted.has(r.entityId))
          .map((r) => ({ entity_id: r.entityId, body: r.body })) as unknown as T[],
      };
    },
  };
}
