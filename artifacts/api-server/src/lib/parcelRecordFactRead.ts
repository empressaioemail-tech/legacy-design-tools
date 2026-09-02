/**
 * Per-parcel flood READ from parcel_record (the record's first consumer).
 *
 * Decision doc_repo:_decisions/2026-09-02_step7_consumer_c_then_b.md: the two
 * GTM-live reports -- "Smart Site X-ray" and "Flood and Drainage" (one generator
 * in code, buildR1Brief in r1BriefCompose.ts; the naming split is a GTM framing,
 * not two code paths -- confirmed against doc_repo's own glossary) -- read
 * parcel_record directly. This module is the flood rail's read path. There is no
 * "drainage" rail in parcel_record's rail set; the drainage section is untouched.
 *
 * A THIRD store: FACTORY_DATABASE_URL, never DATABASE_URL (deployment) or
 * ATOMS_DATABASE_URL (flood-hazard-fact atoms, floodHazardFactRead.ts's own
 * store). SELECT-only: no login-capable read-only Postgres role exists on the
 * Factory Neon project (verified live before writing this file), so this module
 * is structurally read-only by construction -- it never builds anything but a
 * SELECT, regardless of what the underlying credential could technically do.
 *
 * Cell-state vocabulary mirrors parcel_record's own five states exactly (never
 * translated here): value / absent-verified / not-applicable / unaccounted /
 * refused (doc_repo:_decisions/2026-09-01_every_parcel_starts_with_a_full_record.md).
 * The conversion of "unaccounted" to the customer-facing phrase "not-verified"
 * belongs at the serve boundary (r1BriefCompose.ts), not here -- this module's
 * job is a faithful read of source truth, matching the "conversion belongs at
 * the serve boundary" architecture in
 * doc_repo:_decisions/2026-09-01_serve_path_never_emits_pipeline_state.md.
 *
 * parcelNodeId identity: "{fips}:{normalizeCadPropId(propId)}" (parcelNodeId.ts)
 * is the SAME county_fips:prop_id shape as parcel_record.place_key, verified live
 * against all six program counties (zero leading-zero prop_ids exist today, so
 * there is no current case where the two systems' ids diverge -- documented as a
 * verified-for-current-data fact, not a structural guarantee).
 */

import pg from "pg";
import { parseParcelNodeId } from "./parcelNodeId";

export const PARCEL_RECORD_FLOOD_SOURCE = "parcel_record" as const;
export const FLOOD_RAIL_KEY = "flood" as const;

export interface ParcelRecordQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export type ParcelRecordFloodValue = {
  state: "value";
  source: typeof PARCEL_RECORD_FLOOD_SOURCE;
  placeKey: string;
  floodZone: string | null;
  floodway: boolean;
  baseFloodElevation: number | null;
  method: string | null;
  sourceVintage: string | null;
};

export type ParcelRecordFloodAbsentVerified = {
  state: "absent-verified";
  source: typeof PARCEL_RECORD_FLOOD_SOURCE;
  placeKey: string;
  basis: Record<string, unknown> | null;
};

export type ParcelRecordFloodNotApplicable = {
  state: "not-applicable";
  source: typeof PARCEL_RECORD_FLOOD_SOURCE;
  placeKey: string;
  reason: string | null;
};

/** Nothing has looked yet. Honest and countable, per the parcel_record contract -- never rendered as a fabricated absence. */
export type ParcelRecordFloodUnaccounted = {
  state: "unaccounted";
  source: typeof PARCEL_RECORD_FLOOD_SOURCE;
  placeKey: string;
};

export type ParcelRecordFloodRefusal = {
  state: "refused";
  code:
    | "invalid-parcel-node-id"
    | "cell-miss"
    | "factory-store-not-configured"
    | "malformed-cell";
  source: typeof PARCEL_RECORD_FLOOD_SOURCE;
  placeKey: string | null;
  reason: string;
};

export type ParcelRecordFloodRead =
  | ParcelRecordFloodValue
  | ParcelRecordFloodAbsentVerified
  | ParcelRecordFloodNotApplicable
  | ParcelRecordFloodUnaccounted
  | ParcelRecordFloodRefusal;

type CellRow = { cell_state: unknown; payload: unknown };

const SELECT_FLOOD_CELL = `
SELECT c.cell_state, cr.payload
  FROM parcel_record_cell c
  LEFT JOIN parcel_record_companion_row cr
    ON cr.place_key = c.place_key AND cr.rail_key = c.rail_key AND cr.row_index = 0
 WHERE c.place_key = $1 AND c.rail_key = $2
`;

let injectedQueryable: ParcelRecordQueryable | null | undefined;
let sharedPool: pg.Pool | null = null;

/** Test seam. `null` means store not configured. `undefined` (reset) means env. */
export function setParcelRecordQueryableForTests(
  queryable: ParcelRecordQueryable | null,
): void {
  injectedQueryable = queryable;
}

export function resetParcelRecordQueryableForTests(): void {
  injectedQueryable = undefined;
}

function factoryQueryableFromEnv(): ParcelRecordQueryable | null {
  const url = process.env.FACTORY_DATABASE_URL?.trim();
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

function resolveQueryable(): ParcelRecordQueryable | null {
  if (injectedQueryable !== undefined) return injectedQueryable;
  return factoryQueryableFromEnv();
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

/**
 * Interpret an already-fetched cell row. Pure. Tests drive this with fixtures
 * so every cell kind is observed without a store.
 */
export function interpretFloodCellRow(
  placeKey: string,
  row: CellRow | undefined,
): ParcelRecordFloodRead {
  if (!row) {
    return {
      state: "refused",
      code: "cell-miss",
      source: PARCEL_RECORD_FLOOD_SOURCE,
      placeKey,
      reason: `No parcel_record_cell row for ${placeKey} rail flood. This parcel is not in parcel_record -- not a flood determination.`,
    };
  }
  const cellState = asRecord(row.cell_state);
  const kind = cellState?.kind;
  if (typeof kind !== "string") {
    return {
      state: "refused",
      code: "malformed-cell",
      source: PARCEL_RECORD_FLOOD_SOURCE,
      placeKey,
      reason: `parcel_record_cell for ${placeKey} rail flood has a malformed cell_state. Refusing rather than inventing a zone.`,
    };
  }
  if (kind === "unaccounted") {
    return { state: "unaccounted", source: PARCEL_RECORD_FLOOD_SOURCE, placeKey };
  }
  if (kind === "not-applicable") {
    return {
      state: "not-applicable",
      source: PARCEL_RECORD_FLOOD_SOURCE,
      placeKey,
      reason: asNullableString(cellState?.reason),
    };
  }
  if (kind === "refused") {
    return {
      state: "refused",
      code: "malformed-cell",
      source: PARCEL_RECORD_FLOOD_SOURCE,
      placeKey,
      reason:
        asNullableString(cellState?.reason) ??
        `parcel_record itself refused flood for ${placeKey}.`,
    };
  }
  if (kind === "absent-verified") {
    return {
      state: "absent-verified",
      source: PARCEL_RECORD_FLOOD_SOURCE,
      placeKey,
      basis: asRecord(cellState?.basis),
    };
  }
  if (kind === "value") {
    const payload = asRecord(row.payload);
    if (!payload) {
      return {
        state: "refused",
        code: "malformed-cell",
        source: PARCEL_RECORD_FLOOD_SOURCE,
        placeKey,
        reason: `parcel_record_cell for ${placeKey} rail flood is kind=value but its companion row payload is missing or malformed. Refusing rather than inventing a zone.`,
      };
    }
    return {
      state: "value",
      source: PARCEL_RECORD_FLOOD_SOURCE,
      placeKey,
      floodZone: asNullableString(payload.zone),
      floodway: payload.floodway === true,
      baseFloodElevation: asNullableNumber(payload.bfe),
      method: asNullableString(payload.method),
      sourceVintage: asNullableString(payload.sourceVintage),
    };
  }
  return {
    state: "refused",
    code: "malformed-cell",
    source: PARCEL_RECORD_FLOOD_SOURCE,
    placeKey,
    reason: `parcel_record_cell for ${placeKey} rail flood has an unrecognized kind "${kind}". Refusing rather than inventing a zone.`,
  };
}

export async function loadParcelRecordFloodFact(
  parcelNodeId: string,
): Promise<ParcelRecordFloodRead> {
  const parsed = parseParcelNodeId(parcelNodeId);
  if (!parsed) {
    return {
      state: "refused",
      code: "invalid-parcel-node-id",
      source: PARCEL_RECORD_FLOOD_SOURCE,
      placeKey: null,
      reason: `"${parcelNodeId}" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.`,
    };
  }
  const placeKey = `${parsed.countyFips}:${parsed.propId}`;
  const factory = resolveQueryable();
  if (!factory) {
    return {
      state: "refused",
      code: "factory-store-not-configured",
      source: PARCEL_RECORD_FLOOD_SOURCE,
      placeKey,
      reason:
        "parcel_record lives in the Factory store (FACTORY_DATABASE_URL). That store is not configured. Refusing rather than emitting a silent null.",
    };
  }
  const result = await factory.query<CellRow>(SELECT_FLOOD_CELL, [placeKey, FLOOD_RAIL_KEY]);
  return interpretFloodCellRow(placeKey, result.rows[0]);
}

/** In-memory parcel_record for tests. Refuses any query that is not this SELECT, and any write. */
export function memoryParcelRecordFlood(
  rows: ReadonlyArray<{
    placeKey: string;
    cellState: Record<string, unknown>;
    payload?: Record<string, unknown> | null;
  }>,
): ParcelRecordQueryable {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }> {
      if (/INSERT|UPDATE|DELETE/i.test(text)) {
        throw new Error(
          "memoryParcelRecordFlood: refusing a write -- this module is SELECT-only",
        );
      }
      if (!text.includes("FROM parcel_record_cell") || !text.includes("rail_key")) {
        throw new Error(
          "memoryParcelRecordFlood: refusing a query that is not the flood cell SELECT",
        );
      }
      const placeKey = params?.[0];
      const railKey = params?.[1];
      if (railKey !== FLOOD_RAIL_KEY) {
        throw new Error(`memoryParcelRecordFlood: expected rail_key flood, got ${String(railKey)}`);
      }
      const hit = rows.find((r) => r.placeKey === placeKey);
      return {
        rows: hit
          ? ([{ cell_state: hit.cellState, payload: hit.payload ?? null }] as unknown as T[])
          : ([] as T[]),
      };
    },
  };
}
