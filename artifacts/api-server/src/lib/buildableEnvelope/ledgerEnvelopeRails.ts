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
import {
  type SetbacksFactRead,
} from "../setbacksFactFromParcelRecord";
import { loadZoningFactForServe } from "../zoningFactServeCutover";
import {
  type ZoningFactRead,
} from "../zoningFactFromParcelRecord";

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
  return { ledgerReason: read.reason, ledgerCode: read.code };
}

function decline(
  read: ZoningFactRead | SetbacksFactRead | null,
  rail: LedgerEnvelopeDecline["rail"],
): LedgerEnvelopeDecline {
  if (!read) {
    return { state: "declined", ledgerReason: UNSERVED, ledgerCode: "unserved", rail };
  }
  if (read.state === "present") {
    return {
      state: "declined",
      ledgerReason: UNSERVED,
      ledgerCode: "unserved",
      rail,
    };
  }
  const named = reasonOf(read);
  return { state: "declined", ...named, rail };
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
    };
  }

  const [zoning, setbacks] = await Promise.all([
    loadZoningFactForServe(parcelNodeId),
    loadSetbacksFactForServe(parcelNodeId),
  ]);

  if (!zoning || zoning.state !== "present") {
    return decline(zoning, "zoningDistrict");
  }
  if (!setbacks || setbacks.state !== "present") {
    return decline(setbacks, "setbackFrontFt");
  }
  if (setbacks.sideFt == null) {
    return {
      state: "declined",
      ledgerReason: `parcel_record_cell ${setbacks.entityId}/setbackSideFt is not a readable number. Refusing rather than inventing one.`,
      ledgerCode: "parcel-record-malformed-cell",
      rail: "setbackSideFt",
    };
  }
  if (setbacks.rearFt == null) {
    return {
      state: "declined",
      ledgerReason: `parcel_record_cell ${setbacks.entityId}/setbackRearFt is not a readable number. Refusing rather than inventing one.`,
      ledgerCode: "parcel-record-malformed-cell",
      rail: "setbackRearFt",
    };
  }

  const cornerFt = setbacks.cornerFt;
  const districtRow: SetbackDistrict = {
    district_name: zoning.district,
    front_ft: setbacks.frontFt,
    side_ft: setbacks.sideFt,
    rear_ft: setbacks.rearFt,
    side_corner_ft: cornerFt ?? 0,
    // 999 is derive.ts's stated-absence sentinel, not a height.
    max_height_ft: 999,
    max_lot_coverage_pct: 0,
    max_impervious_pct: 0,
    citation_url: zoning.provenance ?? "",
    provenance: {
      ...(cornerFt == null ? { side_corner_ft: { not_specified: true } } : {}),
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
      (cornerFt == null ? "" : `/${cornerFt}`) +
      " ft read from parcel_record.",
    zoningCode: zoning.district,
  };
  const vintage = setbacks.sourceVintage ?? zoning.sourceVintage ?? "unreadable";
  const resolved: AuthoritativeSetbackResolution = {
    scalars: {
      front_ft: setbacks.frontFt,
      side_ft: setbacks.sideFt,
      rear_ft: setbacks.rearFt,
      ...(cornerFt == null ? {} : { side_corner_ft: cornerFt }),
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
