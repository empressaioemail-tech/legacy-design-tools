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
 * SFHA_TF flag when the writer stated one; a row that carries no flag at
 * all (the old single-point payload, or a legacy companion row) falls back
 * to `resolveZoneIsSfha` -- A/V-prefixed zones are SFHA, B/C/X-prefixed
 * zones are not, and anything else (D, "unmapped", blank) is honestly
 * `null`, never guessed. Parcel-level `inSpecialFloodHazardArea` is any
 * qualifying zone's resolved-true SFHA touch, EXCEPT a touch whose own
 * `overlap` is "sliver" (operator ruling D1): that sets `touchesSfhaEdge`
 * instead, never "in", never hidden. With no resolved-true touch at all, a
 * qualifying zone that resolves `null` makes the parcel-level answer `null`
 * too (2026-10-12 tristate fix, `2026-10-12_sfha_tristate_fix.md`): the
 * brief and the map/card overlay both read `resolveZoneIsSfha`/`resolveIsSfha`/
 * `resolveInSfha` from THIS module rather than each keeping its own rule, so
 * a legacy row with no SFHA_TF can no longer show "unknown" on one surface
 * and "no" on the other for the same parcel.
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

/** Decisive SFHA zone-letter prefixes: A, AE, AH, AO, AR, A99, A1-A30, V, VE, V1-V30. */
const SFHA_DECISIVE_TRUE_PREFIXES = ["A", "V"] as const;
/** Decisive NON-SFHA zone-letter prefixes: B, C, X (any subtype). */
const SFHA_DECISIVE_FALSE_PREFIXES = ["B", "C", "X"] as const;

/**
 * THE ONE SHARED FUNCTION (2026-10-12 tristate fix): every surface that
 * turns a parcel_record flood row's `isSfha`/zone letter into a customer-
 * facing SFHA answer calls THIS, not its own copy -- the brief
 * (`r1BriefCompose.ts`) and the map/card overlay (`floodHazardFactFromParcelRecord.ts`'s
 * own `toWireZone` below, `panel-lib.ts`) disagreed before this fix because
 * each had its own rule for a legacy row with no SFHA_TF: one kept `null`,
 * the other (the naive `isSfhaZone` this replaces) inferred a zone-letter
 * boolean for EVERY zone, turning "unknown" into "no".
 *
 * - A stated boolean `isSfha` (the writer's own SFHA_TF) always wins --
 *   never second-guessed by a zone-letter heuristic.
 * - `null`/`undefined` infers ONLY from a DECISIVE zone letter: an A/V-
 *   prefixed code is SFHA (true); a B/C/X-prefixed code (any subtype) is
 *   NOT SFHA (false).
 * - Everything else -- D, "unmapped", blank, or any code this rule does not
 *   recognize -- is genuinely unknown and returns `null`. Never defaulted
 *   to false.
 */
export function resolveZoneIsSfha(
  isSfha: boolean | null | undefined,
  zone: string | null | undefined,
): boolean | null {
  if (typeof isSfha === "boolean") return isSfha;
  const z = zone?.trim().toUpperCase();
  if (!z) return null;
  if (SFHA_DECISIVE_TRUE_PREFIXES.some((p) => z.startsWith(p))) return true;
  if (SFHA_DECISIVE_FALSE_PREFIXES.some((p) => z.startsWith(p))) return false;
  return null;
}

/**
 * Whole-parcel D1 (operator ruling, `2026-10-12_whole_parcel_flood_design.md`
 * §3.C/§6): per zone row, `isSfha` comes from the row's own flag when the
 * writer stated one (new payload); the old single-point payload carries no
 * flag at all, so ONLY THEN does this fall back to the zone-letter rule
 * (`resolveZoneIsSfha`) -- which itself stays honestly `null` for a
 * non-decisive letter (D, unmapped, ...) rather than guessing. Never applied
 * when `isSfha` is already a stated boolean -- the writer's SFHA_TF
 * determination is not second-guessed by a zone-letter heuristic.
 */
export function resolveIsSfha(row: ParcelRecordFloodZoneRow): boolean | null {
  return resolveZoneIsSfha(row.isSfha, row.zone);
}

export type FloodInSfhaResult = { inSfha: boolean | null; touchesSfhaEdge: boolean };

/**
 * Parcel-level `inSfha`/`touchesSfhaEdge` from every zone row (D1): any zone
 * that RESOLVES true and has a real area share (null share -- the old
 * payload's one row -- counts as the whole parcel) makes the parcel "in",
 * UNLESS every such touch is a sliver, in which case the parcel is NOT in
 * the SFHA and instead "touches the flood zone at the edge" -- never "in",
 * never hidden (checked FIRST, so a sliver touch never gets reclassified as
 * "unknown" just because another zone on the same parcel is unresolved).
 * Only once there is no qualifying true zone at all does an unresolved
 * (`null`) qualifying zone make the PARCEL-level answer `null` -- genuinely
 * unknown, never silently "no".
 */
export function resolveInSfha(rows: ReadonlyArray<ParcelRecordFloodZoneRow>): FloodInSfhaResult {
  const qualifies = (r: ParcelRecordFloodZoneRow): boolean =>
    r.areaShare === null || r.areaShare > 0;
  const trueRows = rows.filter((r) => qualifies(r) && resolveZoneIsSfha(r.isSfha, r.zone) === true);
  const nonSliverTrue = trueRows.some((r) => r.overlap !== "sliver");
  if (nonSliverTrue) return { inSfha: true, touchesSfhaEdge: false };
  const sliverTrue = trueRows.some((r) => r.overlap === "sliver");
  if (sliverTrue) return { inSfha: false, touchesSfhaEdge: true };
  const hasUnknown = rows.some(
    (r) => qualifies(r) && resolveZoneIsSfha(r.isSfha, r.zone) === null,
  );
  if (hasUnknown) return { inSfha: null, touchesSfhaEdge: false };
  return { inSfha: false, touchesSfhaEdge: false };
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
