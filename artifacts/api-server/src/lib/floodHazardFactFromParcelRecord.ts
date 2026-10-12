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
 * CARD F2 (`2026-10-12_whole_parcel_flood_design.md`): a flood cell now
 * carries EVERY zone touching the parcel (parcelRecordFactRead.ts's own
 * `zones[]`), not one point reading. `isSfha` comes from each row's own
 * SFHA_TF flag when the writer stated one; ONLY the old single-point
 * payload (which carries no such flag) falls back to the zone-prefix rule
 * nodeFacetBakeTier2.ts's own isSfhaZone already applies (A/V prefixed
 * zones are SFHA; X/D are not) -- reproduced here rather than importing a
 * private, unexported function from a bake-time module this serve-time
 * adapter has no other reason to depend on. Parcel-level
 * `inSpecialFloodHazardArea` is any qualifying zone's SFHA touch, EXCEPT a
 * touch whose own `overlap` is "sliver" (operator ruling D1): that sets
 * `touchesSfhaEdge` instead, never "in", never hidden.
 */

import {
  loadParcelRecordFloodFact,
  FLOOD_RAIL_KEY,
  type ParcelRecordFloodZoneRow,
} from "./parcelRecordFactRead";
import {
  FLOOD_HAZARD_FACT_SOURCE,
  type FloodHazardFactRead,
  type FloodHazardFactZone,
} from "./floodHazardFactRead";

export { FLOOD_RAIL_KEY };

const SFHA_ZONE_PREFIXES = ["A", "V"] as const;

export function isSfhaZone(zone: string | null): boolean {
  if (!zone) return false;
  const z = zone.trim().toUpperCase();
  if (z === "X" || z === "D" || z.startsWith("X")) return false;
  return SFHA_ZONE_PREFIXES.some((p) => z.startsWith(p));
}

/**
 * Whole-parcel D1 (operator ruling, `2026-10-12_whole_parcel_flood_design.md`
 * §3.C/§6): per zone row, `isSfha` comes from the row's own flag when the
 * writer stated one (new payload); the old single-point payload carries no
 * flag at all, so ONLY THEN does this fall back to today's zone-letter rule.
 * Never applied when `isSfha` is already a stated boolean -- the writer's
 * SFHA_TF determination is not second-guessed by a zone-letter heuristic.
 */
export function resolveIsSfha(row: ParcelRecordFloodZoneRow): boolean {
  return row.isSfha ?? isSfhaZone(row.zone);
}

export type FloodInSfhaResult = { inSfha: boolean; touchesSfhaEdge: boolean };

/**
 * Parcel-level `inSfha`/`touchesSfhaEdge` from every zone row (D1): any zone
 * with a resolved SFHA flag and a real area share (null share -- the old
 * payload's one row -- counts as the whole parcel) makes the parcel "in",
 * UNLESS every such touch is a sliver, in which case the parcel is NOT in
 * the SFHA and instead "touches the flood zone at the edge" -- never "in",
 * never hidden.
 */
export function resolveInSfha(rows: ReadonlyArray<ParcelRecordFloodZoneRow>): FloodInSfhaResult {
  const qualifying = rows.filter(
    (r) => resolveIsSfha(r) && (r.areaShare === null || r.areaShare > 0),
  );
  const nonSliver = qualifying.some((r) => r.overlap !== "sliver");
  if (nonSliver) return { inSfha: true, touchesSfhaEdge: false };
  const sliverTouch = qualifying.some((r) => r.overlap === "sliver");
  return { inSfha: false, touchesSfhaEdge: sliverTouch };
}

function toWireZone(row: ParcelRecordFloodZoneRow): FloodHazardFactZone {
  return {
    zone: row.zone,
    subtype: row.subtype,
    isSfha: resolveIsSfha(row),
    floodway: row.floodway,
    bfe: row.baseFloodElevation,
    areaShare: row.areaShare,
  };
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
      // EVERY zone row (card F2), never just the primary scalar fields.
      // `cell.zones` is always non-empty when state is "value"
      // (parcelRecordFactRead.ts refuses malformed-cell otherwise).
      const zones = cell.zones.map(toWireZone);
      const { inSfha, touchesSfhaEdge } = resolveInSfha(cell.zones);
      const primary = cell.zones[0];
      return {
        state: "present",
        source: FLOOD_HAZARD_FACT_SOURCE,
        boundAs: placeKey,
        tried,
        entityId: placeKey,
        inSpecialFloodHazardArea: inSfha,
        floodZone: cell.floodZone,
        zoneSubtype: primary.subtype,
        baseFloodElevation: cell.baseFloodElevation,
        sourceAdapter: "parcel_record",
        sourceVintage: cell.sourceVintage,
        sourceCitation: cell.method,
        evaluatedAt: cell.sourceVintage,
        zones,
        overlap: primary.overlap,
        touchesSfhaEdge,
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
