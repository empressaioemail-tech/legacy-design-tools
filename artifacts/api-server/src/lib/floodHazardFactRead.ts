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

/**
 * One zone's share of the parcel, as the whole-parcel flood wire carries it
 * (card F1/F2, `2026-10-12_whole_parcel_flood_design.md` §3.C). `bfe` is the
 * wire's own field name (matching the companion row payload's own `bfe`),
 * not `baseFloodElevation` -- the top-level scalar below keeps that name
 * for compatibility; this is the new array, free to match the rail payload.
 */
export type FloodHazardFactZone = {
  zone: string | null;
  subtype: string | null;
  /**
   * `null` when neither the writer's own SFHA_TF nor a decisive zone letter
   * (A/V prefix true; B/C/X prefix false) can answer it -- D, "unmapped",
   * blank, or any unrecognized code (2026-10-12 tristate fix, operator
   * ruling D1 extended: genuinely unknown is never defaulted to false).
   * See `floodHazardFactFromParcelRecord.ts`'s `resolveZoneIsSfha`, the one
   * shared function every surface (brief, map/card overlay) resolves this
   * through.
   */
  isSfha: boolean | null;
  floodway: boolean;
  bfe: number | null;
  areaShare: number | null;
};

export type FloodHazardFactPresent = {
  state: "present";
  source: typeof FLOOD_HAZARD_FACT_SOURCE;
  boundAs: string;
  tried: FloodHazardFactBindKeys;
  entityId: string;
  /**
   * Whole-parcel D1: true when any zone RESOLVES true (via
   * `resolveZoneIsSfha`) with a real `areaShare > 0`, EXCEPT a qualifying
   * zone whose own `overlap` is "sliver" -- that touch sets
   * `touchesSfhaEdge` instead (below), never this flag, and never silently
   * drops the touch. `null` (2026-10-12 tristate fix) when no zone resolves
   * true but at least one qualifying zone resolves genuinely unknown (D,
   * "unmapped", blank, or an unrecognized code with no stated SFHA_TF) --
   * never defaulted to false. The atom path's own body always states a
   * definite boolean (see `interpretBody` below), so this is only ever
   * `null` for a parcel_record-sourced read.
   */
  inSpecialFloodHazardArea: boolean | null;
  /** Row 0 -- the largest-share zone. Kept for compatibility; a new reader should use `zones`. */
  floodZone: string | null;
  zoneSubtype: string | null;
  baseFloodElevation: number | null;
  sourceAdapter: string | null;
  sourceVintage: string | null;
  sourceCitation: string | null;
  evaluatedAt: string | null;
  /** EVERY zone touching the parcel, row 0 first (the largest share). The old payload maps to one entry, `areaShare: null`. */
  zones: FloodHazardFactZone[];
  /** Row 0's own overlap classification. "single" for the atom path and the old payload (one point, one zone). */
  overlap: "single" | "partial" | "sliver";
  /**
   * Operator ruling D1: an SFHA zone whose only qualifying touch is a
   * sliver (below the writer's 1%-of-parcel-and-50m² threshold) is never
   * "in" the flood zone and never hidden -- it sets this instead. True only
   * when `inSpecialFloodHazardArea` is false and at least one zone has
   * `isSfha` with a sliver `overlap`.
   */
  touchesSfhaEdge: boolean;
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
    | "malformed-atom"
    /**
     * PARCEL-FLOOD-CUTOVER (F-01): floodHazardFactFromParcelRecord.ts's own
     * refusal codes, distinct from the atom-store codes above -- a
     * parcel_record cell miss/store-not-configured/malformed-cell/
     * unaccounted/invalid-id is a different failure mode than an atom-store
     * miss and must not be collapsed into "atom-miss" (that would
     * misrepresent which store failed), matching the same discipline
     * PARCEL-B-SLATE1's own wells/specialDistricts adapters used.
     */
    | "invalid-parcel-node-id"
    | "parcel-record-cell-miss"
    | "parcel-record-unaccounted"
    | "parcel-record-store-not-configured"
    | "parcel-record-malformed-cell";
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

  const floodZone = typeof rec.floodZone === "string" ? rec.floodZone : null;
  const zoneSubtype = typeof rec.zoneSubtype === "string" ? rec.zoneSubtype : null;
  const baseFloodElevation = asNullableNumber(rec.baseFloodElevation);
  return {
    state: "present",
    source: FLOOD_HAZARD_FACT_SOURCE,
    boundAs: entityId,
    tried,
    entityId,
    inSpecialFloodHazardArea: rec.inSpecialFloodHazardArea,
    floodZone,
    zoneSubtype,
    baseFloodElevation,
    sourceAdapter: asNullableString(rec.sourceAdapter),
    sourceVintage: asNullableString(rec.sourceVintage),
    sourceCitation: asNullableString(rec.sourceCitation),
    evaluatedAt: asNullableString(rec.evaluatedAt),
    // The atom path is always a single point, one zone: the same "old
    // payload" shape the whole-parcel design maps to `overlap: "single"`,
    // `areaShare: null`. Atoms carry no floodway field (parcel_record's
    // flood companion does; see that module's own header comment), so
    // this is always false here, never guessed from the free-text zone label.
    zones: [
      {
        zone: floodZone,
        subtype: zoneSubtype,
        isSfha: rec.inSpecialFloodHazardArea,
        floodway: false,
        bfe: baseFloodElevation,
        areaShare: null,
      },
    ],
    overlap: "single",
    touchesSfhaEdge: false,
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
