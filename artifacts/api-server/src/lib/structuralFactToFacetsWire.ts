/**
 * Map structuralFact read result → doc 19 LayerWire on facets.livingAreaSqft.
 */

import type { LayerAbsenceWire } from "./verdictLayerServe";
import type { StructuralFactAbsent, StructuralFactPresent, StructuralFactRead } from "./structuralFactResolve";
import type { LivingAreaSqftFromParcelRecord } from "./cadRollFactFromParcelRecord";
import type { ZoningFactRead } from "./zoningFactFromParcelRecord";
import { gateBakedCadRollRecord } from "./cadRollValue";

export type LivingAreaSqftLayerWire =
  | { status: "populated"; value: number }
  | LayerAbsenceWire;

export function structuralFactToLivingAreaWire(
  fact: StructuralFactRead,
): LivingAreaSqftLayerWire | null {
  if ("state" in fact && fact.state === "present") {
    const sqft = fact.livingAreaSqft;
    if (typeof sqft === "number" && Number.isFinite(sqft) && sqft > 0) {
      return { status: "populated", value: sqft };
    }
    return null;
  }
  const { source: _source, ...absence } = fact as StructuralFactAbsent;
  return absence;
}

/**
 * PARCEL-B-SLATE2: when the allowlist resolved livingAreaSqft to "record"
 * for this county, `overlay` carries the parcel_record-sourced value (or
 * `null` if the cell itself does not resolve to a usable value -- keep
 * legacy in that case too, fail closed). `null` also covers "not cut over
 * at all" (the overlay resolver itself returns null for that case) -- there
 * is deliberately no way to distinguish the two from this function's own
 * inputs; the caller's allowlist resolution is the single source of truth
 * for which case applies, and either way the correct fallback is identical:
 * keep computing from the legacy structuralFact exactly as before.
 */
export function structuralFactToLivingAreaWireWithOverlay(
  fact: StructuralFactRead,
  overlay: LivingAreaSqftFromParcelRecord,
): LivingAreaSqftLayerWire | null {
  if (!overlay) return structuralFactToLivingAreaWire(fact);
  if (overlay.status === "populated") return { status: "populated", value: overlay.value };
  // "absent-in-record": still need SOME LayerAbsenceWire shape for the wire.
  // The legacy absence shape (authority/scopeSearched/basis/etc.) is the
  // correct one to keep -- parcel_record's own cell absence does not carry
  // those fields, and the wire contract requires them.
  return structuralFactToLivingAreaWire(fact);
}

function bakedZoningHasDistrict(zoning: unknown): boolean {
  if (!zoning || typeof zoning !== "object" || Array.isArray(zoning)) return false;
  const district = (zoning as { district?: unknown }).district;
  return typeof district === "string" && district.trim().length > 0;
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * `provenance.zoningSource` MIRRORED onto the zoning rail this function just
 * decided (P-124 CTX-LEAVES, 2026-09-08).
 *
 * WHY THIS IS HERE AND NOT IN THE BAKE. `provenance.zoningSource` is the
 * top-level twin of the zoning cell's own provenance, and it is a REQUIRED
 * leaf that `BP-CONTENT-01` grades as one of
 * `value | absent-verified | not-applicable | refused`. Measured on staging
 * 2026-09-08 it is a bare null on 486,218 Williamson and 267,076 Travis rows,
 * so it fails that contract wherever a parcel carries no zoning stamp.
 *
 * The bake CANNOT honestly fix it. The bake knows only whether a GIS stamp
 * joined; the zoning cell's actual state is decided HERE, from two inputs the
 * bake has no access to — the Factory's `parcel_record` zoningDistrict rail
 * and the city-limits containment verdict. `facets.zoning` is itself baked as
 * a bare null and only becomes a four-state on this line, which is exactly
 * the precedent: the twin has to be earned wherever the rail is earned.
 *
 * So this leaf never decides anything. It COPIES. A mirrored cell cannot
 * disagree with the cell it mirrors, and that is the entire requirement: one
 * question must not get two answers. It matters most where the answer is
 * uncomfortable — Elgin's zoning layer is declared incomplete, so
 * `parcel_record` keeps its unmatched parcels `unaccounted` (served here as
 * state `refused`), and a twin that decided for itself could quietly write
 * `absent-verified` over that. Copying cannot: if the rail refuses, the twin
 * refuses.
 *
 * IT ALSO CLOSES A LIVE CONTRADICTION. Since the 2026-09-07 parity fix, a
 * `parcel_record` determination wins UNCONDITIONALLY over the baked stamp —
 * but `provenance.zoningSource` kept citing the old GIS layer URL for the
 * district that no longer came from it. The payload disagreed with its own
 * rail. It now cites what the rail cites.
 *
 * Returns `undefined` when nothing has earned a state (no district, no
 * verdict, no record) — the baked value is then left exactly as it is, and
 * the leaf goes on failing the walk, which is the honest outcome rather than
 * a manufactured one.
 */
export function zoningSourceMirror(
  zoningCell: unknown,
  bakedZoningSource: unknown,
  asOf: string,
): unknown {
  const rec = asPlainRecord(zoningCell);
  if (!rec) return undefined;

  // 1. The cell is a VALUE: a district stands. Cite what THIS cell cites.
  if (bakedZoningHasDistrict(rec)) {
    const prov = rec.provenance;
    if (typeof prov === "string" && prov.trim()) return prov.trim();
    const provRec = asPlainRecord(prov);
    const sourceUrl = provRec?.sourceUrl;
    if (typeof sourceUrl === "string" && sourceUrl.trim()) return sourceUrl.trim();
    if (typeof bakedZoningSource === "string" && bakedZoningSource.trim()) {
      return bakedZoningSource.trim();
    }
    // A district with no recorded citation anywhere. Not an absence we
    // verified — we simply have no source on file, and saying which is the
    // difference between refusing and fabricating.
    return {
      status: "absent",
      verdict: "refused",
      authority: "unresolved",
      scopeSearched:
        "the served zoning cell's own provenance, and the baked " +
        "provenance.zoningSource twin",
      asOf,
      basis:
        `the zoning determination for ${String(rec.district)} carries no source ` +
        "citation on the cell it came from, so no source can be cited for it",
      mirrors: "zoning",
    };
  }

  // 2. The cell is a LayerAbsenceWire (city-limits verdict). Mirror verbatim —
  //    same verdict string, deliberately NOT normalised into the four-state
  //    vocabulary, because translating `stamp-missing` or `unmeasured` into
  //    something else would make the twin say what the rail does not.
  if (typeof rec.verdict === "string" && rec.status === "absent") {
    return { ...rec, mirrors: "zoning" };
  }

  // 3. The cell is a parcel_record ZoningFactAbsent ({state, absence:{kind,
  //    reason}}). Project its earned verdict and its own reason as the basis;
  //    nothing is added to what parcel_record already determined.
  const absence = asPlainRecord(rec.absence);
  if (rec.state === "absent" && absence && typeof absence.kind === "string") {
    return {
      status: "absent",
      verdict: absence.kind,
      authority: "hauska-factory parcel_record zoningDistrict rail",
      scopeSearched:
        `parcel_record_cell zoningDistrict for ${String(rec.entityId ?? "this parcel")}` +
        (rec.sourceVintage ? ` at vintage ${String(rec.sourceVintage)}` : ""),
      asOf,
      basis:
        typeof absence.reason === "string" && absence.reason.trim()
          ? absence.reason
          : `parcel_record recorded zoningDistrict as ${absence.kind} for ` +
            `${String(rec.entityId ?? "this parcel")} with no reason attached`,
      mirrors: "zoning",
    };
  }

  // 4. The cell is a parcel_record ZoningFactRefusal for the rail's OWN
  //    engine-level refusal ({state:"refused", code:"parcel-record-engine-
  //    refused", reason}) -- the Factory looked and declined, with a real,
  //    specific reason (P-124 CTX-MIRROR). Mirror verbatim, same as branch 2:
  //    the twin cannot assert either way when the rail itself would not.
  //    Every OTHER refusal code (unaccounted, invalid-parcel-node-id,
  //    parcel-record-cell-miss, malformed-cell, store-not-configured) never
  //    reaches here -- attachVerdictLayersToFacets keeps out.zoning on the
  //    city-limits fallback for those, unchanged.
  if (rec.state === "refused" && rec.code === "parcel-record-engine-refused") {
    return { ...rec, mirrors: "zoning" };
  }

  return undefined;
}

/**
 * Attach P-63 verdict wires onto baked facets for inspect (livingAreaSqft +
 * the zoning verdict).
 *
 * CTX card F (2026-08-28): the zoning verdict is passed in, derived by the
 * route from the city-limits containment fact (`zoningVerdictFromCityLimits`).
 * It is attached whenever the baked zoning carries no district, for all three
 * verdicts (`not-applicable`, `stamp-missing`, `unmeasured`). Before this card
 * the zoning absence was read back off the land-use fact, which had been
 * merged from a situsCity predicate; that coupling is gone.
 *
 * PE/MCP-vs-facets parity audit (2026-09-07, D5): `parcelRecordZoningFact`
 * carries the SAME precedence rule r1BriefCompose.ts's
 * composeZoningBriefSectionFromParcelRecord already applies for the
 * research/brief path -- OPS-16 A-096/A-097/A-098's parcel_record zoning
 * determination wins UNCONDITIONALLY over the baked stamp whenever it has
 * genuinely earned one (present, or a verified absence), never the reverse.
 * Before this fix this route had no path to the live ledger at all and the
 * baked stamp always won when present, so the two surfaces could report
 * different zoning districts for the same parcel. Checked BEFORE the
 * city-limits-verdict branch below and wins even over an existing stamp --
 * unlike that branch, which only ever fills a genuine absence.
 */
export function attachVerdictLayersToFacets(
  facets: Record<string, unknown>,
  structuralFact: StructuralFactRead,
  zoningVerdict: LayerAbsenceWire | null | undefined,
  livingAreaOverlay?: LivingAreaSqftFromParcelRecord,
  parcelRecordZoningFact?: ZoningFactRead | null,
): Record<string, unknown> {
  const out = { ...facets };
  const cov =
    out.facetCoverage && typeof out.facetCoverage === "object" && !Array.isArray(out.facetCoverage)
      ? { ...(out.facetCoverage as Record<string, unknown>) }
      : {};
  cov.structural = true;

  const livingWire = structuralFactToLivingAreaWireWithOverlay(
    structuralFact,
    livingAreaOverlay ?? null,
  );
  if (livingWire) {
    out.livingAreaSqft = livingWire;
  }

  if (parcelRecordZoningFact && parcelRecordZoningFact.state !== "refused") {
    if (parcelRecordZoningFact.state === "present") {
      out.zoning = {
        district: parcelRecordZoningFact.district,
        jurisdictionKey: parcelRecordZoningFact.jurisdictionKey,
        provenance: parcelRecordZoningFact.provenance,
      };
      cov.zoning = true;
    } else {
      // absent-verified / not-applicable -- same "data: fact" choice
      // composeZoningBriefSectionFromParcelRecord makes for its absent branch.
      out.zoning = parcelRecordZoningFact;
      cov.zoning = false;
    }
  } else if (
    parcelRecordZoningFact?.state === "refused" &&
    parcelRecordZoningFact.code === "parcel-record-engine-refused"
  ) {
    // P-124 CTX-MIRROR: the zoningDistrict rail's own cell is kind=refused --
    // the Factory engine looked and deliberately declined (e.g. "no
    // tx_zoning_district_staging base layer exists for Mustang Ridge yet").
    // That is an earned state with a real, specific reason, not a plumbing
    // failure -- project it exactly like the absent branch above, never the
    // generic city-limits fallback. Every OTHER refusal code (unaccounted,
    // invalid-parcel-node-id, parcel-record-cell-miss, malformed-cell,
    // store-not-configured) is left on the fallback below, unchanged.
    out.zoning = parcelRecordZoningFact;
    cov.zoning = false;
  } else if (zoningVerdict && !bakedZoningHasDistrict(out.zoning)) {
    out.zoning = zoningVerdict;
    cov.zoning = false;
  }

  // The twin follows the rail (see zoningSourceMirror). Copied, never decided.
  const prov = asPlainRecord(out.provenance);
  if (prov) {
    const mirrored = zoningSourceMirror(
      out.zoning,
      prov.zoningSource,
      zoningVerdict?.asOf ?? new Date().toISOString(),
    );
    if (mirrored !== undefined) {
      out.provenance = { ...prov, zoningSource: mirrored };
    }
  }

  out.facetCoverage = cov;
  return out;
}

/**
 * PARCEL-B-SLATE2: overlay the four dollar rails and yearBuilt onto the
 * baked snapshot's own baseFacts.cadRoll.* / baseFacts.yearBuilt, where the
 * allowlist resolved that rail to "record". A rail whose overlay is `null`
 * (not slated, verdict refused/excluded, or the cell itself did not
 * resolve) keeps whatever the bake already wrote -- untouched, not merged
 * field-by-field within cadRoll itself (a baked cadRoll object is already
 * whole; only the specific overlaid keys move).
 */
export function attachCadRollOverlaysToFacets(
  facets: Record<string, unknown>,
  overlay: {
    marketValue: unknown;
    assessedValue: unknown;
    landValue: unknown;
    improvementValue: unknown;
    yearBuilt: unknown;
  },
): Record<string, unknown> {
  const out = { ...facets };
  const base =
    out.baseFacts && typeof out.baseFacts === "object" && !Array.isArray(out.baseFacts)
      ? { ...(out.baseFacts as Record<string, unknown>) }
      : {};
  const cadRoll =
    base.cadRoll && typeof base.cadRoll === "object" && !Array.isArray(base.cadRoll)
      ? { ...(base.cadRoll as Record<string, unknown>) }
      : {};

  let cadRollChanged = false;
  for (const [key, value] of [
    ["marketValue", overlay.marketValue],
    ["assessedValue", overlay.assessedValue],
    ["landValue", overlay.landValue],
    ["improvementValue", overlay.improvementValue],
  ] as const) {
    if (value != null) {
      cadRoll[key] = value;
      cadRollChanged = true;
    }
  }
  if (cadRollChanged) base.cadRoll = cadRoll;

  if (overlay.yearBuilt != null) base.yearBuilt = overlay.yearBuilt;

  out.baseFacts = base;
  return out;
}

/**
 * Studio+ gate on the four CAD tax-assessed dollar rails (OPS-16 A-103 item
 * 5 / A-104), applied at the RESPONSE-SERIALIZATION BOUNDARY — after
 * {@link attachCadRollOverlaysToFacets} has already merged whatever live
 * overlay values exist onto the offline-baked `baseFacts.cadRoll`. Gating
 * only the overlay input is not enough: a separate offline patch job
 * (`nodeFacetPatchCadRollFromCadPropertyCli.ts`) can write real dollar
 * values directly into the baked snapshot, bypassing the overlay entirely,
 * so this must gate the FINAL merged value regardless of which of those two
 * sources produced it.
 *
 * `granted` is the caller's own `callerGrantsOwnerFact`-equivalent
 * predicate — this function makes no tier decision of its own (never a
 * fourth independent tier check, OPS-16 A-087). `livingAreaSqft` and every
 * other facet key are untouched; only the four dollar keys inside
 * `baseFacts.cadRoll` move.
 */
export function gateCadRollValuationOnFacets(
  facets: Record<string, unknown>,
  granted: boolean,
): Record<string, unknown> {
  if (granted) return facets;
  const base =
    facets.baseFacts && typeof facets.baseFacts === "object" && !Array.isArray(facets.baseFacts)
      ? (facets.baseFacts as Record<string, unknown>)
      : null;
  const cadRoll =
    base?.cadRoll && typeof base.cadRoll === "object" && !Array.isArray(base.cadRoll)
      ? (base.cadRoll as Record<string, unknown>)
      : null;
  if (!base || !cadRoll) return facets;
  return {
    ...facets,
    baseFacts: {
      ...base,
      cadRoll: gateBakedCadRollRecord(cadRoll, false),
    },
  };
}
