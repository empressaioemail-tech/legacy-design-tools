/**
 * parcel_record -> CityLimitsFactWire adapter (F-01, PARCEL-B-SLATE1,
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`).
 *
 * REAL, DISCLOSED LOSSINESS: CityLimitsFact (lib/cad-ingest/src/boundary/
 * cityLimitsFact.ts) has exactly three states -- incorporated / unincorporated
 * / unmeasured -- and no refusal variant at all. Every parcel_record refusal
 * (unaccounted, malformed-cell, no-such-parcel-or-rail, store-not-configured,
 * engine-refused, invalid parcel node id) therefore collapses to
 * status:"unmeasured", the type's own "no usable determination" state. This
 * is an honest simplification, not a fabrication -- unmeasured already means
 * "nothing usable was determined" in this type -- but it does discard which
 * REFUSAL it was; the `basis` string carries that detail for a human/log
 * reader even though the structured `status` cannot. etjStatus is always
 * "unresolved" on BOTH the legacy source and this adapter (the legacy
 * containment logic has no buffer/offset path either -- see cad-ingest's own
 * module comment), so this is not a coverage narrowing.
 *
 * Reads via loadParcelRecordCell (parcelRecordCellRead.ts). cityLimits is a
 * pure scalar rail -- no companion rows (live-verified 2026-09-02): a
 * present cell's `value` is the city name string directly; an absent-
 * verified cell's basis carries {disposition: "unincorporated", ...}, not
 * the {finding: "..."} shape wells/specialDistricts use.
 */

import { loadParcelRecordCell } from "./parcelRecordCellRead";
import { parseParcelNodeId } from "./parcelNodeId";
import {
  CITY_LIMITS_FACT_SOURCE,
  type CityLimitsFactWire,
  type CityLimitsQueryPoint,
} from "./cityLimitsFactRead";

export const CITY_LIMITS_RAIL_KEY = "cityLimits" as const;
const ETJ_UNRESOLVED = "unresolved" as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** cityLimits' own absent-verified basis shape carries `disposition`, not `finding` (distinct from wells/specialDistricts). */
function unincorporatedBasis(basis: string | Record<string, unknown> | null): string {
  if (typeof basis === "string") return basis;
  const rec = asRecord(basis);
  if (rec) {
    const disposition = asNullableString(rec.disposition);
    const source = asNullableString(rec.source);
    if (disposition) {
      return `parcel_record cityLimits: ${disposition}${source ? ` (source: ${source})` : ""}.`;
    }
    return JSON.stringify(rec);
  }
  return "parcel_record marked this parcel's jurisdiction absent-verified with no basis recorded.";
}

function unmeasured(basis: string, queryPoint: CityLimitsQueryPoint | null): CityLimitsFactWire {
  return {
    status: "unmeasured",
    etjStatus: ETJ_UNRESOLVED,
    source: CITY_LIMITS_FACT_SOURCE,
    basis,
    queryPoint,
  };
}

export async function cityLimitsFactFromParcelRecord(
  parcelNodeId: string,
  queryPoint: CityLimitsQueryPoint | null,
): Promise<CityLimitsFactWire> {
  const parsed = parseParcelNodeId(parcelNodeId);
  if (!parsed) {
    return unmeasured(
      `"${parcelNodeId}" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.`,
      queryPoint,
    );
  }
  const cell = await loadParcelRecordCell(parsed.countyFips, parsed.propId, CITY_LIMITS_RAIL_KEY);

  if (cell.state === "refused") {
    return unmeasured(
      `parcel_record cityLimits refused (${cell.code}): ${cell.reason}`,
      queryPoint,
    );
  }

  if (cell.state === "absent") {
    // Live-verified: cityLimits' absent-verified is always a real
    // determination (unincorporated), never a sparse/pending gap for this
    // rail -- not-applicable has not been observed live, handled the same
    // way defensively (a real, not fabricated, absence).
    return {
      status: "unincorporated",
      etjStatus: ETJ_UNRESOLVED,
      source: CITY_LIMITS_FACT_SOURCE,
      basis: unincorporatedBasis(cell.basis),
      queryPoint,
    };
  }

  // cell.state === "present"
  const cityName = typeof cell.value === "string" ? cell.value : null;
  if (!cityName) {
    return unmeasured(
      `parcel_record_cell for ${cell.placeKey}/${CITY_LIMITS_RAIL_KEY} is kind=value but its value is not a usable city name (${JSON.stringify(cell.value)}). Refusing rather than inventing a city.`,
      queryPoint,
    );
  }
  return {
    status: "incorporated",
    etjStatus: ETJ_UNRESOLVED,
    source: CITY_LIMITS_FACT_SOURCE,
    basis: `parcel_record cityLimits: incorporated, city '${cityName}' (source: ${cell.cellSource}, vintage: ${cell.vintage || "unknown"}).`,
    cityName,
    queryPoint,
  };
}
