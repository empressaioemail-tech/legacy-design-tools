/**
 * Serve-layer reader for the Factory's parcel_record store (F-01, decision
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`, PARCEL-B-READER).
 *
 * Per-parcel reads ONLY -- one (place_key, rail_key) pair per call. County
 * materialization is a named dead-end (the cell-ledger close measured
 * 101.5s to materialize the SMALLEST county's cells; a Travis single-shot
 * would run 25+ minutes). This module never issues a county-scoped query.
 *
 * Structurally read-only: every pooled connection runs
 * `SET default_transaction_read_only = on` immediately on connect, so
 * Postgres itself refuses any write attempt at the protocol level
 * regardless of what the underlying credential is granted to do.
 * FACTORY_DATABASE_URL is the only Factory credential provisioned today
 * (verified via `gcloud secrets list`, 2026-09-02) -- a dedicated
 * SELECT-only DB role would be stronger defense-in-depth and is named as a
 * leave_behind, not built here.
 *
 * `unaccounted` never reaches the wire as a word. It is a REFUSAL (code
 * "unaccounted"), matching this repo's own house convention in every
 * sibling *FactRead.ts module (wellFactRead, floodHazardFactRead, ...):
 * "the pipeline has not examined this yet" is a refused facet, never a
 * fifth absence-verdict layered onto LayerAbsenceVerdict
 * (`_decisions/2026-09-01_serve_path_never_emits_pipeline_state.md`).
 * `refused` (the engine's own cell kind) is a distinct refusal code,
 * carrying the engine's own refusal string.
 *
 * Companion rails are never special-cased here: every rail's cell_state is
 * the one authoritative state (per the engine's own doc comment on
 * CompanionCellState); a rail's companion rows are fetched unconditionally
 * and are simply empty for a scalar rail. No rail-metadata duplication of
 * hauska-engine's PARCEL_RECORD_RAIL_META, which is not published for
 * cross-repo consumption.
 */

import pg from "pg";

export const PARCEL_RECORD_SOURCE = "parcel_record" as const;

export interface ParcelRecordQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export type ParcelRecordCompanionRow = {
  rowIndex: number;
  payload: unknown;
  source: string;
  vintage: string;
};

export type ParcelRecordCellPresent = {
  state: "present";
  source: typeof PARCEL_RECORD_SOURCE;
  placeKey: string;
  railKey: string;
  cellSource: string;
  vintage: string;
  value: string | number | boolean | null;
  disposition: "rows" | "empty-set" | null;
  rowCount: number | null;
  companionRows: ParcelRecordCompanionRow[];
};

export type ParcelRecordCellAbsent = {
  state: "absent";
  source: typeof PARCEL_RECORD_SOURCE;
  placeKey: string;
  railKey: string;
  verdict: "absent-verified" | "not-applicable";
  basis: string | Record<string, unknown> | null;
};

export type ParcelRecordCellRefusalCode =
  | "unaccounted"
  | "engine-refused"
  | "no-such-parcel-or-rail"
  | "malformed-cell"
  | "store-not-configured";

export type ParcelRecordCellRefusal = {
  state: "refused";
  source: typeof PARCEL_RECORD_SOURCE;
  placeKey: string;
  railKey: string;
  code: ParcelRecordCellRefusalCode;
  reason: string;
};

export type ParcelRecordCellRead =
  | ParcelRecordCellPresent
  | ParcelRecordCellAbsent
  | ParcelRecordCellRefusal;

type CellRow = { cell_state: unknown };
type CompanionRow = { row_index: number; payload: unknown; source: string; vintage: string };

const SELECT_CELL = `
SELECT cell_state
  FROM parcel_record_cell
 WHERE place_key = $1
   AND rail_key = $2
`;

const SELECT_COMPANION_ROWS = `
SELECT row_index, payload, source, vintage
  FROM parcel_record_companion_row
 WHERE place_key = $1
   AND rail_key = $2
 ORDER BY row_index
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

function parcelRecordQueryableFromEnv(): ParcelRecordQueryable | null {
  const url = process.env.FACTORY_DATABASE_URL?.trim();
  if (!url) return null;
  if (!sharedPool) {
    sharedPool = new pg.Pool({
      connectionString: url,
      ssl: url.includes("sslmode=") ? undefined : { rejectUnauthorized: false },
      max: 2,
    });
    // Structural read-only: refuse at the Postgres protocol level, not just
    // by omission of write code. Fires on every physical connection, so a
    // pooled connection reused across requests stays read-only for its
    // whole lifetime.
    sharedPool.on("connect", (client) => {
      client.query("SET default_transaction_read_only = on").catch(() => {
        // If this SET itself fails, every subsequent query on this client
        // fails too (a broken connection surfaces as a query error, which
        // resolveCellRead below already converts to a refusal). No
        // separate handling needed -- swallow here only to avoid an
        // unhandled promise rejection on the pool's own connect event.
      });
    });
  }
  return sharedPool;
}

function resolveQueryable(): ParcelRecordQueryable | null {
  if (injectedQueryable !== undefined) return injectedQueryable;
  return parcelRecordQueryableFromEnv();
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

function interpretCompanionRows(
  rows: ReadonlyArray<CompanionRow>,
): ParcelRecordCompanionRow[] {
  return rows.map((r) => ({
    rowIndex: r.row_index,
    payload: r.payload,
    source: r.source,
    vintage: r.vintage,
  }));
}

/**
 * Interpret an already-fetched cell_state plus its companion rows. Pure.
 * Tests drive this with fixtures so every cell kind (value scalar, value
 * companion, absent-verified with a string basis, absent-verified with a
 * CadNullVerifiedBasis object, not-applicable, refused, unaccounted, and a
 * malformed/missing-kind body) is observed without a store.
 */
export function interpretParcelRecordCell(
  placeKey: string,
  railKey: string,
  cellState: unknown,
  companionRows: ReadonlyArray<CompanionRow>,
): ParcelRecordCellRead {
  const rec = asRecord(cellState);
  const kind = rec ? asNullableString(rec.kind) : null;
  if (!rec || !kind) {
    return {
      state: "refused",
      source: PARCEL_RECORD_SOURCE,
      placeKey,
      railKey,
      code: "malformed-cell",
      reason: `parcel_record_cell ${placeKey}/${railKey} has no readable 'kind'. Refusing rather than inventing a state.`,
    };
  }

  switch (kind) {
    case "value": {
      const disposition = asNullableString(rec.disposition) as
        | "rows"
        | "empty-set"
        | null;
      return {
        state: "present",
        source: PARCEL_RECORD_SOURCE,
        placeKey,
        railKey,
        cellSource: asNullableString(rec.source) ?? "parcel_record",
        vintage: asNullableString(rec.vintage) ?? "",
        value:
          typeof rec.value === "string" ||
          typeof rec.value === "number" ||
          typeof rec.value === "boolean" ||
          rec.value === null
            ? (rec.value as string | number | boolean | null)
            : null,
        disposition,
        rowCount: asNullableNumber(rec.rowCount),
        companionRows: interpretCompanionRows(companionRows),
      };
    }
    case "absent-verified": {
      const basis = rec.basis;
      return {
        state: "absent",
        source: PARCEL_RECORD_SOURCE,
        placeKey,
        railKey,
        verdict: "absent-verified",
        basis:
          typeof basis === "string"
            ? basis
            : asRecord(basis) ?? null,
      };
    }
    case "not-applicable": {
      return {
        state: "absent",
        source: PARCEL_RECORD_SOURCE,
        placeKey,
        railKey,
        verdict: "not-applicable",
        basis: asNullableString(rec.reason),
      };
    }
    case "refused": {
      return {
        state: "refused",
        source: PARCEL_RECORD_SOURCE,
        placeKey,
        railKey,
        code: "engine-refused",
        reason:
          asNullableString(rec.refusal) ??
          "parcel_record marked this cell refused with no reason recorded.",
      };
    }
    case "unaccounted": {
      return {
        state: "refused",
        source: PARCEL_RECORD_SOURCE,
        placeKey,
        railKey,
        code: "unaccounted",
        reason:
          "parcel_record has not yet examined this rail for this parcel. Refusing rather than serving a pipeline word.",
      };
    }
    default: {
      return {
        state: "refused",
        source: PARCEL_RECORD_SOURCE,
        placeKey,
        railKey,
        code: "malformed-cell",
        reason: `parcel_record_cell ${placeKey}/${railKey} has kind '${kind}', not one of value/absent-verified/not-applicable/refused/unaccounted. Refusing rather than guessing.`,
      };
    }
  }
}

/**
 * Read one (county, rail) cell for one parcel. Never a county-scoped query.
 */
export async function loadParcelRecordCell(
  countyFips: string,
  propId: string,
  railKey: string,
): Promise<ParcelRecordCellRead> {
  const placeKey = `${countyFips}:${propId}`;
  const store = resolveQueryable();
  if (!store) {
    return {
      state: "refused",
      source: PARCEL_RECORD_SOURCE,
      placeKey,
      railKey,
      code: "store-not-configured",
      reason:
        "parcel_record lives in the Factory store (FACTORY_DATABASE_URL). That credential is not configured. Refusing rather than reading a legacy store under this name.",
    };
  }
  const [cellResult, companionResult] = await Promise.all([
    store.query<CellRow>(SELECT_CELL, [placeKey, railKey]),
    store.query<CompanionRow>(SELECT_COMPANION_ROWS, [placeKey, railKey]),
  ]);
  const cellRow = cellResult.rows[0];
  if (!cellRow) {
    return {
      state: "refused",
      source: PARCEL_RECORD_SOURCE,
      placeKey,
      railKey,
      code: "no-such-parcel-or-rail",
      reason: `No parcel_record_cell row for ${placeKey}/${railKey}. Either the parcel is outside the program's landing population, or the rail key is not one of the 65.`,
    };
  }
  return interpretParcelRecordCell(
    placeKey,
    railKey,
    cellRow.cell_state,
    companionResult.rows,
  );
}

/** In-memory parcel_record store for tests. Refuses any query shape it does not recognize. */
export function memoryParcelRecordStore(fixture: {
  cells: ReadonlyArray<{ placeKey: string; railKey: string; cellState: unknown }>;
  companionRows?: ReadonlyArray<{
    placeKey: string;
    railKey: string;
    rowIndex: number;
    payload: unknown;
    source: string;
    vintage: string;
  }>;
}): ParcelRecordQueryable {
  const companionRows = fixture.companionRows ?? [];
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }> {
      const placeKey = params?.[0];
      const railKey = params?.[1];
      if (typeof placeKey !== "string" || typeof railKey !== "string") {
        throw new Error(
          "memoryParcelRecordStore: expected (placeKey, railKey) as $1, $2",
        );
      }
      if (text.includes("FROM parcel_record_cell")) {
        const row = fixture.cells.find(
          (c) => c.placeKey === placeKey && c.railKey === railKey,
        );
        return { rows: (row ? [{ cell_state: row.cellState }] : []) as unknown as T[] };
      }
      if (text.includes("FROM parcel_record_companion_row")) {
        const rows = companionRows
          .filter((r) => r.placeKey === placeKey && r.railKey === railKey)
          .sort((a, b) => a.rowIndex - b.rowIndex)
          .map((r) => ({
            row_index: r.rowIndex,
            payload: r.payload,
            source: r.source,
            vintage: r.vintage,
          }));
        return { rows: rows as unknown as T[] };
      }
      throw new Error(
        "memoryParcelRecordStore: refusing a query that is not the per-parcel cell or companion-row SELECT",
      );
    },
  };
}
