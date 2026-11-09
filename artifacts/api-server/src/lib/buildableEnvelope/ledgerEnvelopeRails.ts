/**
 * P-465 / OPS-16 A-324. The envelope's district and setbacks come from the
 * parcel-record rails, through the one serving path
 * (`loadZoningFactForServe`, `loadSetbacksFactForServe`).
 *
 * Retired from this derivation, and named so the next reader does not put
 * them back: `resolveAuthoritativeSetbacks` (codified table + atom rule,
 * most-current-source), `firstResolvableDistrictCode` probing
 * `getSetbackTableForZoning`, and `resolveSpineZoningWhenGisAbsent` (GIS
 * `zoningCode` first, then the bake, then the atom chain). A GIS stamp is
 * not a setback source. A refusal is the cell's own declared reason.
 */

import type { SetbackDistrict, SetbackTable } from "@workspace/adapters";
import type { EngineHonesty } from "@workspace/engine-core";

import {
  type AuthoritativeSetbackResolution,
} from "./authoritativeSetbackSource";
import type { DistrictMappingResult } from "./districtMapping";
import { loadSetbacksFactForServe } from "../setbacksFactServeCutover";
import { setbackRefusalWords } from "./setbackRefusalWords";
import {
  type SetbacksFactRead,
} from "../setbacksFactFromParcelRecord";
import { loadZoningFactForServe } from "../zoningFactServeCutover";
import {
  type ZoningFactRead,
} from "../zoningFactFromParcelRecord";
import { NOT_SPECIFIED_MAX_HEIGHT_FT } from "./derive";

export type LedgerEnvelopeValues = {
  state: "values";
  district: string;
  jurisdictionKey: string | null;
  resolved: AuthoritativeSetbackResolution;
  districtMapping: DistrictMappingResult;
};

export type LedgerEnvelopeDecline = {
  state: "declined";
  /** The cell's own reason, verbatim. This is the customer sentence. */
  ledgerReason: string;
  /** The cell's own kind or refusal code. Not a re-worded token. */
  ledgerCode: string;
  rail: "zoningDistrict" | "setbackFrontFt" | "setbackSideFt" | "setbackRearFt";
  /**
   * The zoning district the zoningDistrict rail served, when it served one and
   * a LATER rail (a setback) is what declined. Null when the zoning rail itself
   * declined or was never read. Carried so the answer can name the district the
   * decline sentence is about instead of reporting the parcel's zoning as empty
   * beside a reason that says it is on file. Never derived; only the cell's value.
   */
  ledgerDistrict: string | null;
};

export type LedgerEnvelopeDecision = LedgerEnvelopeValues | LedgerEnvelopeDecline;

const UNSERVED =
  "The ledger serving path did not serve this parcel. Zoning and setbacks were not re-derived.";

function reasonOf(read: ZoningFactRead | SetbacksFactRead): {
  ledgerReason: string;
  ledgerCode: string;
} {
  if (read.state === "absent") {
    return { ledgerReason: read.absence.reason, ledgerCode: read.absence.kind };
  }
  if (read.state === "refused") {
    return { ledgerReason: read.reason, ledgerCode: read.code };
  }
  return { ledgerReason: UNSERVED, ledgerCode: "unserved" };
}

function decline(
  read: ZoningFactRead | SetbacksFactRead | null,
  rail: LedgerEnvelopeDecline["rail"],
  ledgerDistrict: string | null,
): LedgerEnvelopeDecline {
  if (!read) {
    return { state: "declined", ledgerReason: UNSERVED, ledgerCode: "unserved", rail, ledgerDistrict };
  }
  if (read.state === "present") {
    return {
      state: "declined",
      ledgerReason: UNSERVED,
      ledgerCode: "unserved",
      rail,
      ledgerDistrict,
    };
  }
  const named = reasonOf(read);
  return { state: "declined", ...named, rail, ledgerDistrict };
}

/**
 * Read the rails and either hand back the cells' own numbers or the cell's
 * own refusal. Never calls the codified setback table.
 */
export async function decideEnvelopeFromLedger(
  parcelNodeId: string | null,
): Promise<LedgerEnvelopeDecision> {
  if (!parcelNodeId) {
    return {
      state: "declined",
      ledgerReason:
        "No parcel identity, so the ledger rails were not read. Zoning and setbacks were not re-derived.",
      ledgerCode: "no-parcel-identity",
      rail: "zoningDistrict",
      ledgerDistrict: null,
    };
  }

  const [zoning, setbacks] = await Promise.all([
    loadZoningFactForServe(parcelNodeId),
    loadSetbacksFactForServe(parcelNodeId),
  ]);

  if (!zoning || zoning.state !== "present") {
    return decline(zoning, "zoningDistrict", null);
  }
  if (!setbacks || setbacks.state !== "present") {
    return decline(setbacks, "setbackFrontFt", zoning.district);
  }
  if (setbacks.sideFt == null) {
    return {
      state: "declined",
      // Re-walk 2026-11-09: the city's own words and, for Bastrop, the current code's rule (setbackRefusalWords.ts).
      ledgerReason: setbackRefusalWords({ dimension: "side", entityId: setbacks.entityId, district: zoning.district, refusal: setbacks.refusals?.side }),
      ledgerCode: "parcel-record-malformed-cell",
      rail: "setbackSideFt",
      ledgerDistrict: zoning.district,
    };
  }
  if (setbacks.rearFt == null) {
    return {
      state: "declined",
      ledgerReason: setbackRefusalWords({ dimension: "rear", entityId: setbacks.entityId, district: zoning.district, refusal: setbacks.refusals?.rear }),
      ledgerCode: "parcel-record-malformed-cell",
      rail: "setbackRearFt",
      ledgerDistrict: zoning.district,
    };
  }

  const frontFt = setbacks.frontFt;
  if (frontFt == null) {
    return {
      state: "declined",
      ledgerReason: `parcel_record_cell ${setbacks.entityId}/setbackFrontFt is not a readable number. Refusing rather than inventing one.`,
      ledgerCode: "parcel-record-malformed-cell",
      rail: "setbackFrontFt",
      ledgerDistrict: zoning.district,
    };
  }
  const cornerFt = setbacks.cornerFt;
  // The setback corpus writes 999 on side_corner_ft when the ordinance states
  // no separate street-side yard. That is the same not-specified sentinel as
  // max height, not a 999-foot setback. Lakeway R-1 records it that way
  // (lib/adapters/src/local/setbacks/lakeway-tx.json: the quote says "999 is
  // the not_specified sentinel, not a standard"). The ledger cell keeps the
  // bare number. Measured on 48453:832328: treating 999 as feet consumed the
  // lot. A null corner and a 999 corner are the same absence.
  const cornerForDistrict =
    cornerFt != null && cornerFt !== NOT_SPECIFIED_MAX_HEIGHT_FT ? cornerFt : 0;
  const cornerSpecified =
    cornerFt != null && cornerFt !== NOT_SPECIFIED_MAX_HEIGHT_FT;
  const districtRow: SetbackDistrict = {
    district_name: zoning.district,
    front_ft: frontFt,
    side_ft: setbacks.sideFt,
    rear_ft: setbacks.rearFt,
    side_corner_ft: cornerForDistrict,
    // 999 is derive.ts's stated-absence sentinel, not a height.
    max_height_ft: NOT_SPECIFIED_MAX_HEIGHT_FT,
    max_lot_coverage_pct: 0,
    max_impervious_pct: 0,
    citation_url: zoning.provenance ?? "",
    provenance: {
      ...(cornerSpecified ? {} : { side_corner_ft: { not_specified: true } }),
      max_lot_coverage_pct: { not_specified: true },
    },
  };
  const table: SetbackTable = {
    jurisdictionKey: zoning.jurisdictionKey ?? "parcel-record",
    jurisdictionDisplayName: "parcel record",
    districts: [districtRow],
    note: "Setbacks read from parcel_record cells. Not a codified table lookup.",
  };
  const districtMapping: DistrictMappingResult = {
    district: districtRow,
    kind: "ledger",
    confidence: 1,
    note:
      `District ${zoning.district} and setbacks ` +
      `${setbacks.frontFt}/${setbacks.sideFt}/${setbacks.rearFt}` +
      (cornerSpecified ? `/${cornerFt}` : "") +
      " ft read from parcel_record.",
    zoningCode: zoning.district,
  };
  const vintage = setbacks.sourceVintage ?? zoning.sourceVintage ?? "unreadable";
  const resolved: AuthoritativeSetbackResolution = {
    scalars: {
      front_ft: frontFt,
      side_ft: setbacks.sideFt,
      rear_ft: setbacks.rearFt,
      ...(cornerSpecified ? { side_corner_ft: cornerForDistrict } : {}),
    },
    districtCode: zoning.district,
    sourceKind: "parcel-record",
    sourceLabel: "parcel_record setbackFrontFt/setbackSideFt/setbackRearFt/setbackCornerFt",
    effectiveDate: vintage,
    dateBasis: "unreadable",
    citationUrl: zoning.provenance,
    table,
    district: districtMapping,
  };
  return {
    state: "values",
    district: zoning.district,
    jurisdictionKey: zoning.jurisdictionKey,
    resolved,
    districtMapping,
  };
}

export function ledgerDeclineHonesty(reason: string): EngineHonesty {
  return {
    confidence: { value: 0, kind: "asserted" },
    dataVintage: new Date().toISOString().slice(0, 10),
    coverage: { degraded: true, reason },
    source: { adapter: "brokerage:buildable-envelope:parcel-record", citationIds: [] },
  };
}
