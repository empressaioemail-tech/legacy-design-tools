/**
 * parcel_record -> FloodHazardFactRead adapter (F-01, PARCEL-FLOOD-CUTOVER,
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`).
 *
 * Reuses loadParcelRecordFloodFact (parcelRecordFactRead.ts, built by
 * PARCEL-C-REPORT for the direct-read GTM reports) as the raw cell reader
 * -- the SAME already-tested, already-deployed flood cell read, not a
 * fourth re-implementation. This module's own job is purely translation:
 * ParcelRecordFloodRead's five-state shape (value/absent-verified/
 * not-applicable/unaccounted/refused) into FloodHazardFactRead's legacy
 * three-state shape (present/absent/refused), matching this card's own
 * B-allowlist-gated cutover mechanism -- a DIFFERENT consumer than
 * PARCEL-C-REPORT's own direct, ungated reads.
 *
 * inSpecialFloodHazardArea is DERIVED from the zone string alone (parcel_
 * record's flood cell carries no separate SFHA_TF flag) using the same
 * zone-prefix rule nodeFacetBakeTier2.ts's own isSfhaZone already applies
 * (A/V prefixed zones are SFHA; X/D are not) -- reproduced here rather than
 * importing a private, unexported function from a bake-time module this
 * serve-time adapter has no other reason to depend on.
 */

import { loadParcelRecordFloodFact, FLOOD_RAIL_KEY } from "./parcelRecordFactRead";
import { FLOOD_HAZARD_FACT_SOURCE, type FloodHazardFactRead } from "./floodHazardFactRead";

export { FLOOD_RAIL_KEY };

const SFHA_ZONE_PREFIXES = ["A", "V"] as const;

function isSfhaZone(zone: string | null): boolean {
  if (!zone) return false;
  const z = zone.trim().toUpperCase();
  if (z === "X" || z === "D" || z.startsWith("X")) return false;
  return SFHA_ZONE_PREFIXES.some((p) => z.startsWith(p));
}

function reasonFromBasis(basis: Record<string, unknown> | null): string {
  if (basis) {
    const finding = basis.finding;
    if (typeof finding === "string" && finding.trim()) return finding;
    return JSON.stringify(basis);
  }
  return "parcel_record marked this cell absent-verified with no basis recorded.";
}

export async function floodHazardFactFromParcelRecord(
  parcelNodeId: string,
): Promise<FloodHazardFactRead> {
  const cell = await loadParcelRecordFloodFact(parcelNodeId);
  const placeKey = cell.placeKey ?? parcelNodeId;
  const tried: readonly [string, string] = [placeKey, placeKey];

  switch (cell.state) {
    case "refused": {
      const codeMap = {
        "invalid-parcel-node-id": "invalid-parcel-node-id",
        "cell-miss": "parcel-record-cell-miss",
        "factory-store-not-configured": "parcel-record-store-not-configured",
        "malformed-cell": "parcel-record-malformed-cell",
      } as const;
      return {
        state: "refused",
        code: codeMap[cell.code],
        source: FLOOD_HAZARD_FACT_SOURCE,
        tried,
        reason: `parcel_record flood (${cell.code}): ${cell.reason}`,
      };
    }
    case "unaccounted": {
      return {
        state: "refused",
        code: "parcel-record-unaccounted",
        source: FLOOD_HAZARD_FACT_SOURCE,
        tried,
        reason: `parcel_record has not yet examined flood for ${placeKey}. Refusing rather than serving a pipeline word.`,
      };
    }
    case "not-applicable": {
      return {
        state: "absent",
        source: FLOOD_HAZARD_FACT_SOURCE,
        boundAs: placeKey,
        tried,
        entityId: placeKey,
        absence: { kind: "not-applicable", reason: cell.reason ?? "parcel_record marked flood not-applicable for this parcel." },
        verifiedAbsence: null,
        sourceTier: null,
        sourceAdapter: "parcel_record",
        sourceVintage: null,
      };
    }
    case "absent-verified": {
      return {
        state: "absent",
        source: FLOOD_HAZARD_FACT_SOURCE,
        boundAs: placeKey,
        tried,
        entityId: placeKey,
        absence: { kind: "absent-verified", reason: reasonFromBasis(cell.basis) },
        verifiedAbsence: true,
        sourceTier: (cell.basis?.method as string | undefined) ?? null,
        sourceAdapter: "parcel_record",
        sourceVintage: (cell.basis?.vintage as string | undefined) ?? null,
      };
    }
    case "value": {
      return {
        state: "present",
        source: FLOOD_HAZARD_FACT_SOURCE,
        boundAs: placeKey,
        tried,
        entityId: placeKey,
        inSpecialFloodHazardArea: isSfhaZone(cell.floodZone),
        floodZone: cell.floodZone,
        zoneSubtype: null,
        baseFloodElevation: cell.baseFloodElevation,
        sourceAdapter: "parcel_record",
        sourceVintage: cell.sourceVintage,
        sourceCitation: cell.method,
        evaluatedAt: cell.sourceVintage,
      };
    }
    default: {
      // Exhaustiveness guard -- ParcelRecordFloodRead's own state union is
      // closed; a new state added there without a matching case here is a
      // compile error, not a silent fallthrough.
      const _exhaustive: never = cell;
      throw new Error(`floodHazardFactFromParcelRecord: unreachable state ${JSON.stringify(_exhaustive)}`);
    }
  }
}
