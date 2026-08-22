/**
 * Inspect-card pipeline READ from rrc-pipeline-fact atoms.
 *
 * Writer seam `rrc-pipeline-fact-writer.ts` stores entity_id = bare
 * parcelNodeId. Spatial attach (parcel-edge buffer-intersect against staged
 * tx_rrc_pipeline, 152.4 m, dedupe t4permit|p5_num) happens at WRITE. This
 * module is a NEW sibling lookup of those atoms, never a live GIS near
 * query and never a special-district :sd: picker.
 *
 * Dual grammar (R-07 Q8): entity_id is stored as both `{fips}:{prop}` and
 * `{fips}:{prop}.00000000`. Bind tries both. Miss on both is a typed
 * refusal that names the keys, never a silent null. Q8 pipeline bind rate
 * is UNMEASURED; this file invents no percent.
 *
 * Outside the buffer is PRESENT nearPipeline=false, not absence.
 *
 * Never SELECT bake / place_layer_snapshots / CAD / texas-rrc /
 * tx_rrc_pipeline for this field.
 *
 * TWO STORES. Atoms live in hauska_mcp (ATOMS_DATABASE_URL). The inspect
 * route's drizzle `db` is the deployment store. DATABASE_URL in api-server
 * means deployment, not atoms — this module does not read that name.
 */

import pg from "pg";

const PADDED_SUFFIX = ".00000000";
export const RRC_PIPELINE_FACT_ENTITY_TYPE = "rrc-pipeline-fact" as const;
export const RRC_PIPELINE_FACT_SOURCE = "rrc-pipeline-fact" as const;

export interface AtomQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export type PipelineFactBindKeys = readonly [string, string];

/**
 * Both grammars, always, in stable order: integer then padded.
 * Inbound `{fips}:{prop}.00000000` inverts to the integer prefix; inbound
 * integer appends the suffix. Never returns one key. Never invents a third.
 * Never appends a pipeline id.
 */
export function pipelineFactBindKeys(parcelNodeId: string): PipelineFactBindKeys {
  if (parcelNodeId.endsWith(PADDED_SUFFIX)) {
    const integerForm = parcelNodeId.slice(0, -PADDED_SUFFIX.length);
    return [integerForm, parcelNodeId];
  }
  return [parcelNodeId, `${parcelNodeId}${PADDED_SUFFIX}`];
}

export type PipelineFactPresent = {
  state: "present";
  source: typeof RRC_PIPELINE_FACT_SOURCE;
  boundAs: string;
  tried: PipelineFactBindKeys;
  entityId: string;
  nearPipeline: boolean;
  bufferMeters: number | null;
  nearestPipelineDistanceMeters: number | null;
  t4permit: string | null;
  p5Num: string | null;
  operatorName: string | null;
  systemName: string | null;
  commodity: string | null;
  commodityDescription: string | null;
  systemType: string | null;
  status: string | null;
  diameter: number | null;
  interstate: boolean | string | null;
  sourceAdapter: string | null;
  sourceVintage: string | null;
  evaluatedAt: string | null;
};

export type PipelineFactTypedAbsence = {
  state: "absent";
  source: typeof RRC_PIPELINE_FACT_SOURCE;
  boundAs: string;
  tried: PipelineFactBindKeys;
  entityId: string;
  absence: { kind: string; reason: string } | null;
  verifiedAbsence: unknown;
  sourceTier: string | null;
  sourceAdapter: string | null;
};

export type PipelineFactRefusal = {
  state: "refused";
  code:
    | "atom-miss"
    | "bind-conflict"
    | "atoms-store-not-configured"
    | "malformed-atom";
  source: typeof RRC_PIPELINE_FACT_SOURCE;
  tried: PipelineFactBindKeys | [];
  reason: string;
};

export type PipelineFactRead =
  | PipelineFactPresent
  | PipelineFactTypedAbsence
  | PipelineFactRefusal;

type AtomRow = { entity_id: string; body: unknown };

const SELECT_PIPELINE_FACT = `
SELECT entity_id, body
  FROM atoms
 WHERE entity_type = $1
   AND entity_id = ANY($2::text[])
`;

let injectedQueryable: AtomQueryable | null | undefined;
let sharedPool: pg.Pool | null = null;

/** Test seam. `null` means store not configured. `undefined` (reset) means env. */
export function setPipelineFactAtomQueryableForTests(
  queryable: AtomQueryable | null,
): void {
  injectedQueryable = queryable;
}

export function resetPipelineFactAtomQueryableForTests(): void {
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

function asInterstate(value: unknown): boolean | string | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && value.trim()) return value;
  return null;
}

function claimFingerprint(body: Record<string, unknown>): string {
  const absence = asRecord(body.absence);
  return JSON.stringify({
    sourceTier: body.sourceTier ?? null,
    nearPipeline: body.nearPipeline ?? null,
    bufferMeters: body.bufferMeters ?? null,
    nearestPipelineDistanceMeters: body.nearestPipelineDistanceMeters ?? null,
    t4permit: body.t4permit ?? null,
    p5Num: body.p5Num ?? null,
    absenceKind: absence?.kind ?? null,
    absenceReason: absence?.reason ?? null,
  });
}

function interpretBody(
  entityId: string,
  body: unknown,
  tried: PipelineFactBindKeys,
): PipelineFactPresent | PipelineFactTypedAbsence | PipelineFactRefusal {
  const rec = asRecord(body);
  if (!rec) {
    return {
      state: "refused",
      code: "malformed-atom",
      source: RRC_PIPELINE_FACT_SOURCE,
      tried,
      reason: `rrc-pipeline-fact entity_id ${entityId} has a non-object body. Refusing rather than inventing a pipeline.`,
    };
  }
  if (rec.entityType != null && rec.entityType !== RRC_PIPELINE_FACT_ENTITY_TYPE) {
    return {
      state: "refused",
      code: "malformed-atom",
      source: RRC_PIPELINE_FACT_SOURCE,
      tried,
      reason: `rrc-pipeline-fact entity_id ${entityId} body.entityType is ${String(rec.entityType)}, not rrc-pipeline-fact.`,
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
      source: RRC_PIPELINE_FACT_SOURCE,
      boundAs: entityId,
      tried,
      entityId,
      absence: kind && reason ? { kind, reason } : null,
      verifiedAbsence: rec.verifiedAbsence ?? null,
      sourceTier: asNullableString(rec.sourceTier),
      sourceAdapter: asNullableString(rec.sourceAdapter),
    };
  }

  if (typeof rec.nearPipeline !== "boolean") {
    return {
      state: "refused",
      code: "malformed-atom",
      source: RRC_PIPELINE_FACT_SOURCE,
      tried,
      reason: `rrc-pipeline-fact entity_id ${entityId} is neither a present nearPipeline finding nor a typed absence.`,
    };
  }

  return {
    state: "present",
    source: RRC_PIPELINE_FACT_SOURCE,
    boundAs: entityId,
    tried,
    entityId,
    nearPipeline: rec.nearPipeline,
    bufferMeters: asNullableNumber(rec.bufferMeters),
    nearestPipelineDistanceMeters: asNullableNumber(
      rec.nearestPipelineDistanceMeters,
    ),
    t4permit: asNullableString(rec.t4permit),
    p5Num: asNullableString(rec.p5Num),
    operatorName: asNullableString(rec.operatorName),
    systemName: asNullableString(rec.systemName),
    commodity: asNullableString(rec.commodity),
    commodityDescription: asNullableString(rec.commodityDescription),
    systemType: asNullableString(rec.systemType),
    status: asNullableString(rec.status),
    diameter: asNullableNumber(rec.diameter),
    interstate: asInterstate(rec.interstate),
    sourceAdapter: asNullableString(rec.sourceAdapter),
    sourceVintage: asNullableString(rec.sourceVintage),
    evaluatedAt: asNullableString(rec.evaluatedAt),
  };
}

function pickPreferredRow(
  rows: AtomRow[],
  tried: PipelineFactBindKeys,
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
 * so a miss, a padded-only hit, gold outside-buffer, and a conflict are
 * observed without a store.
 */
export function interpretPipelineFactRows(
  parcelNodeId: string,
  rows: ReadonlyArray<AtomRow>,
): PipelineFactRead {
  const tried = pipelineFactBindKeys(parcelNodeId);
  const hits = rows.filter(
    (r) => r.entity_id === tried[0] || r.entity_id === tried[1],
  );
  if (hits.length === 0) {
    return {
      state: "refused",
      code: "atom-miss",
      source: RRC_PIPELINE_FACT_SOURCE,
      tried,
      reason: `No rrc-pipeline-fact atom for ${tried[0]} or ${tried[1]}. Atom miss, not a pipeline determination.`,
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
        source: RRC_PIPELINE_FACT_SOURCE,
        tried,
        reason: `rrc-pipeline-fact atoms at ${tried[0]} and ${tried[1]} disagree. Refusing rather than picking a pipeline.`,
      };
    }
  }
  const chosen = pickPreferredRow(hits, tried);
  return interpretBody(chosen.entity_id, chosen.body, tried);
}

export async function loadPipelineFactAtom(
  parcelNodeId: string,
): Promise<PipelineFactRead> {
  const tried = pipelineFactBindKeys(parcelNodeId);
  const atoms = resolveQueryable();
  if (!atoms) {
    return {
      state: "refused",
      code: "atoms-store-not-configured",
      source: RRC_PIPELINE_FACT_SOURCE,
      tried,
      reason:
        "rrc-pipeline-fact lives in the ATOMS store (ATOMS_DATABASE_URL). That store is not configured. Refusing rather than reading place_layer_snapshots, texas-rrc GIS, or emitting a silent null.",
    };
  }
  const result = await atoms.query<AtomRow>(SELECT_PIPELINE_FACT, [
    RRC_PIPELINE_FACT_ENTITY_TYPE,
    [...tried],
  ]);
  return interpretPipelineFactRows(parcelNodeId, result.rows);
}

/** In-memory atoms table for tests. Refuses any query that is not this SELECT. */
export function memoryPipelineFactAtoms(
  rows: ReadonlyArray<{ entityId: string; body: Record<string, unknown> }>,
): AtomQueryable {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }> {
      if (text.includes("place_layer_snapshots")) {
        throw new Error(
          "memoryPipelineFactAtoms: place_layer_snapshots is not a rrc-pipeline-fact source",
        );
      }
      if (text.includes("cad_property")) {
        throw new Error(
          "memoryPipelineFactAtoms: cad_property is not a rrc-pipeline-fact source",
        );
      }
      if (text.includes("texas-rrc")) {
        throw new Error(
          "memoryPipelineFactAtoms: texas-rrc GIS is not a rrc-pipeline-fact source",
        );
      }
      if (text.includes("tx_rrc_pipeline")) {
        throw new Error(
          "memoryPipelineFactAtoms: tx_rrc_pipeline is not a rrc-pipeline-fact source",
        );
      }
      if (text.includes(":sd:")) {
        throw new Error(
          "memoryPipelineFactAtoms: special-district :sd: picker is not the rrc-pipeline-fact bind",
        );
      }
      if (!text.includes("FROM atoms") || !text.includes("entity_type")) {
        throw new Error(
          "memoryPipelineFactAtoms: refusing a query that is not the rrc-pipeline-fact atoms SELECT",
        );
      }
      if (params?.[0] !== RRC_PIPELINE_FACT_ENTITY_TYPE) {
        throw new Error(
          `memoryPipelineFactAtoms: expected entity_type rrc-pipeline-fact, got ${String(params?.[0])}`,
        );
      }
      const ids = params?.[1];
      if (!Array.isArray(ids)) {
        throw new Error("memoryPipelineFactAtoms: expected entity_id array as $2");
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
