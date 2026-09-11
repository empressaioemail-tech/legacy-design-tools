/**
 * Serve-layer reader for the Factory's parcel_record store (F-01, decision
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`, PARCEL-B-READER).
 *
 * REPOINTED (P-152, `_dispatches/2026-09-11_p152-reader_dispatch.md`):
 * this module no longer opens a connection to the Factory store itself.
 * `parcelRecordQueryableFromEnv` below is now a `ParcelRecordQueryable`-
 * shaped adapter over `parcelRecordReaderClient.ts`'s HTTP client for the
 * Hauska retrieval service's `GET /property-nodes/:id/record` (and the
 * companion `/parcel-record-gate-verdict/:county/:rail` for
 * `parcelGateVerdictRead.ts`'s county-scoped verdict lookups). Every other
 * export in this file -- the types, `interpretParcelRecordCell`'s
 * interpretation logic, `loadParcelRecordCell`'s public contract, the
 * in-memory test fixtures -- is UNCHANGED, so every one of the 18
 * `<rail>FactFromParcelRecord.ts` call sites and their existing tests
 * (which inject their own store via `setParcelRecordQueryableForTests` and
 * never reach this function) needed no edits. `FACTORY_DATABASE_URL_RO` is
 * no longer read anywhere in this repo (R-8: cortex holds no factory
 * credential) -- the adapter's "not configured" check below now looks for
 * `HAUSKA_RETRIEVAL_API_KEY`/`RETRIEVAL_API_KEY` instead.
 *
 * Per-parcel reads ONLY -- one (place_key, rail_key) pair per call. County
 * materialization is a named dead-end (the cell-ledger close measured
 * 101.5s to materialize the SMALLEST county's cells; a Travis single-shot
 * would run 25+ minutes). This module never issues a county-scoped query.
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
 *
 * `raw` ON A "value" CELL (added F-01, serve/prod cutover for ACQUIRE-GIS
 * wave 1 + PARCEL wave 2, 2026-09-04): a "value" cell_state can carry rail-
 * specific sibling fields beyond the generic {value, source, vintage,
 * disposition, rowCount} shape this reader already lifts out -- e.g.
 * schoolDistrict's own cell_state carries `districtCode` and `geoid`
 * alongside `value` (parcel-school-district.mjs's schoolDistrictCellState),
 * and maxImperviousCoverPct's carries `watershedType`, `inRechargeZone`,
 * and `crosswalkCitation` (parcel-max-impervious-cover.mjs's
 * maxImperviousCoverCellState). Every rail adapter up to this card only
 * ever needed companion rows for "more than the bare scalar" data, so this
 * gap was invisible until a rail's own extra data lived on the CELL itself
 * rather than in a companion row. `raw` carries the full decoded cell_state
 * object so a per-rail adapter (e.g. schoolDistrictFactFromParcelRecord.ts)
 * can read its own extra fields without this shared reader needing to know
 * every rail's private shape. Purely additive: every existing field is
 * unchanged, and no existing adapter reads `raw`.
 */

import { fetchGateVerdict, fetchParcelRecord } from "./parcelRecordReaderClient.js";

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
  /** The full decoded cell_state object, for a rail whose own extra fields live on the cell itself. See module doc. */
  raw: Record<string, unknown>;
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

/** Test seam. `null` means store not configured. `undefined` (reset) means env. */
export function setParcelRecordQueryableForTests(
  queryable: ParcelRecordQueryable | null,
): void {
  injectedQueryable = queryable;
}

export function resetParcelRecordQueryableForTests(): void {
  injectedQueryable = undefined;
}

/**
 * Exported for reuse by parcelGateVerdictRead.ts: this one adapter answers
 * both the per-parcel cell/companion-row queries (via `fetchParcelRecord`)
 * and the county-scoped verdict query (via `fetchGateVerdict`) by
 * inspecting the query text, exactly as the in-memory test fixtures below
 * already dispatch by text. This is the RAW env-resolved store only, with
 * no test-injection seam of its own; callers apply their own injection
 * override first.
 *
 * A query that cannot be answered -- the upstream fetch failed (network,
 * non-200, missing credential) or the parcel is crosswalk-ambiguous --
 * THROWS, matching what a real Postgres connection failure already did
 * here before P-152: `loadParcelRecordCell` does not wrap its `store.query`
 * calls in a try/catch, so this is not a new failure mode for its callers.
 */
export function parcelRecordQueryableFromEnv(): ParcelRecordQueryable | null {
  const key =
    process.env.HAUSKA_RETRIEVAL_API_KEY?.trim() || process.env.RETRIEVAL_API_KEY?.trim();
  if (!key) return null;

  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }> {
      if (text.includes("FROM parcel_record_cell")) {
        const [placeKey, railKey] = params as [string, string];
        const record = await fetchParcelRecord(placeKey);
        if (record === null) {
          throw new Error(
            `parcel_record cell read via the retrieval service failed for ${placeKey}/${railKey}`,
          );
        }
        if (record.refused) {
          throw new Error(
            `parcel_record refuses ${placeKey} (${record.refused.reason}); cannot serve any rail`,
          );
        }
        const rail = record.rails[railKey];
        if (!rail || rail.cell === null) return { rows: [] as unknown as T[] };
        return { rows: [{ cell_state: rail.cell }] as unknown as T[] };
      }
      if (text.includes("FROM parcel_record_companion_row")) {
        const [placeKey, railKey] = params as [string, string];
        const record = await fetchParcelRecord(placeKey);
        if (record === null) {
          throw new Error(
            `parcel_record companion-row read via the retrieval service failed for ${placeKey}/${railKey}`,
          );
        }
        if (record.refused) {
          throw new Error(
            `parcel_record refuses ${placeKey} (${record.refused.reason}); cannot serve any rail`,
          );
        }
        const companions = record.rails[railKey]?.companions ?? [];
        return {
          rows: (
            companions as Array<{ rowIndex: number; payload: unknown; source: string; vintage: string }>
          ).map((c) => ({
            row_index: c.rowIndex,
            payload: c.payload,
            source: c.source,
            vintage: c.vintage,
          })) as unknown as T[],
        };
      }
      if (text.includes("FROM parcel_gate_verdict")) {
        const [countyFips, railKey] = params as [string, string];
        const verdict = await fetchGateVerdict(countyFips, railKey);
        if (verdict === undefined) {
          throw new Error(
            `parcel_gate_verdict read via the retrieval service failed for ${countyFips}/${railKey}`,
          );
        }
        if (verdict === null) return { rows: [] as unknown as T[] };
        return {
          rows: [
            {
              county_fips: countyFips,
              rail_key: railKey,
              verdict: verdict.verdict,
              // Not surfaced by the retrieval service's gate-verdict
              // endpoint today; unused by resolveAllowlistState (which
              // reads only .verdict) and by every current caller.
              unaccounted_count: 0,
              evaluated_at: verdict.evaluatedAt,
              run_id: "hauska-retrieval-api",
            },
          ] as unknown as T[],
        };
      }
      throw new Error(
        `parcelRecordQueryableFromEnv adapter: unrecognized query shape: ${text.slice(0, 80)}`,
      );
    },
  };
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
        raw: rec,
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
        // P-124 CTX-MIRROR (2026-09-09): the engine writes this key as
        // `reason`, not `refusal` -- confirmed live against the real store
        // (549 of 549 Caldwell zoningDistrict refused cells, and 0 of 0
        // anywhere carrying a `refusal` key). Reading the wrong key meant
        // every refused cell, on every rail, served the generic fallback
        // below instead of the engine's real, specific refusal string.
        reason:
          asNullableString(rec.reason) ??
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
        "parcel_record is read via the Hauska retrieval service (P-152); no RETRIEVAL_API_KEY/HAUSKA_RETRIEVAL_API_KEY is configured in this process. Refusing rather than reading a legacy store under this name.",
    };
  }
  let cellResult: { rows: CellRow[] };
  let companionResult: { rows: CompanionRow[] };
  try {
    [cellResult, companionResult] = await Promise.all([
      store.query<CellRow>(SELECT_CELL, [placeKey, railKey]),
      store.query<CompanionRow>(SELECT_COMPANION_ROWS, [placeKey, railKey]),
    ]);
  } catch (err) {
    // LIVE FINDING (P-152, 2026-09-11): this call was never wrapped before
    // the retrieval-service swap because a live Postgres connection
    // essentially never threw mid-query in practice; an HTTP call to
    // another service fails far more routinely (a 404 during this exact
    // traffic-shift transition crashed the whole facets route with an
    // uncaught exception here, discovered live via resolveValueBasisFrom
    // ParcelRecord's own unconditional, unguarded call into this
    // function). A declared refusal, never a crash -- and never a
    // fabricated absence either: this is honestly "the read failed", not
    // "no such row".
    return {
      state: "refused",
      source: PARCEL_RECORD_SOURCE,
      placeKey,
      railKey,
      code: "store-not-configured",
      reason: `parcel_record read via the retrieval service failed for ${placeKey}/${railKey}: ${err instanceof Error ? err.message : String(err)}. Refusing rather than crashing or fabricating an absence.`,
    };
  }
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
