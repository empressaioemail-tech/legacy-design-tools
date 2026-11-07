/**
 * PARCEL-B-SLATE1 (F-01, `_decisions/2026-09-02_step7_consumer_c_then_b.md`)
 * serve-layer cutover wrapper for cityLimits, adapted for cityLimits'
 * different legacy signature (point-based, not parcelNodeId-only) and its own
 * call-order dependency: brokerageNodeFacets.ts's own contract test
 * (cityLimitsFactRoute.contract.test.ts) asserts loadCityLimitsFact runs
 * BEFORE zoningVerdictFromCityLimits BEFORE enrichLandUseFactWithZoningVerdict
 * -- this wrapper is a drop-in replacement at that exact call site,
 * preserving that order (it still resolves and returns before the caller
 * proceeds to the next step).
 *
 * P-297 (2026-09-16, operator ruling A-193) replaced the county-verdict gate
 * this file used to apply. The wrapper now decides from PARCEL_RECORD_SLATE
 * and the parcel's own cell through the one rule in `cellServeRule.ts`:
 * an unslated (county, "cityLimits") pair runs `loadCityLimitsFact` exactly
 * as it did before this file existed, short-circuiting before any I/O; a
 * slated pair serves this parcel's own cell through the record adapter,
 * including the adapter's own typed refusal. A slated county with a `refuse`
 * gate verdict no longer drags every parcel back to the legacy read.
 *
 * P-296 (2026-09-17): ETJ is overlaid here, on BOTH branches above.
 *
 * WHY HERE AND NOT IN THE READERS. Both city-limits answers -- the point-based
 * `loadCityLimitsFact` and the slated parcel_record adapter -- were built with
 * no ETJ input at all, and both hardcode `etjStatus: "unresolved"` for that
 * reason. `tx_etj_boundary` + `tx_etj_source` (P-241's acquisition; applied and
 * ingested to staging by P-296) are a DIFFERENT source answering a different
 * question at the same WGS84 query point, so the ETJ determination is made once
 * where the wire is assembled rather than duplicated into each reader. Neither
 * reader gains an ETJ dependency, and there is still exactly one answer per
 * served fact.
 *
 * The three ETJ values stay distinct end to end. `present` and `absent` are
 * determinations read from the published rings -- an `absent` carries the
 * publishers whose own extent covered the point and the ring count tested, so
 * a checked absence is readable as checked -- and `unresolved` is "no source to
 * check", which is what both readers already served. The overlay never turns an
 * unread rail into a finding, and never collapses `absent` into `unresolved`.
 *
 * WHY AN `absent` NEEDS THE CONTAINING CITY, AND WHAT HAPPENS WITHOUT IT.
 * `resolveEtjAtPoint` answers `absent` from a publisher's published EXTENT box
 * only when nothing better is known, and its own header names the trap: Round
 * Rock sits inside Austin's published ETJ extent box but publishes no ETJ layer
 * at all, so a box-only `absent` there is a confirmed absence of ETJ in a city
 * whose ETJ was never published. When the containing city IS known, its own
 * register row decides instead (city_limits_only -> unresolved).
 *
 * So the containing city is only passed when the city-limits answer POSITIVELY
 * identified one. `incorporated` names the containing city and is passed
 * through. `unincorporated` is the positive determination that no city contains
 * the point, which is exactly the precondition the box rule documents for
 * itself, so its `absent` stands. `unmeasured` (or any refused parcel_record
 * cell, which also serves as `unmeasured`) determines NOTHING about the
 * containing city, and a miss read against the box there could be a city whose
 * ETJ is unread -- the one case the mission forbids reporting as `absent`. On
 * that branch the overlay keeps the check (the miss happened, and its
 * `coveredBy`/`ringsConsulted` travel) but serves `unresolved`, naming why.
 * `present` is a ring containment and is unaffected on every branch: it does
 * not depend on the containing city at all.
 *
 * P-376 — AND AN INCORPORATED PARCEL IS NOT IN AN ETJ AT ALL. `incorporated` is
 * not only a containing city: it is the determination that the parcel is INSIDE
 * a city, and a Texas ETJ is, by definition, the UNINCORPORATED area contiguous
 * to one (Tex. Loc. Gov't Code ch. 42). So the same fact that names the
 * containing city also settles the ETJ question, and this wrapper passes that
 * determination on as an `incorporation` settlement. The reader answers
 * `absent` with `settledBy: "incorporation"` from it, before any ring is
 * consulted — which is why an incorporated parcel can no longer be served
 * `unresolved` because a published ring had to be refused. The settlement is
 * built from the fact's OWN city, source and basis (`incorporationSettlesEtj`);
 * `unmeasured` and `unincorporated` settle nothing, and their ring test is
 * unchanged, refusal branch included.
 */

import { loadCellServeDecision } from "./cellServeRule";
import { parseParcelNodeId } from "./parcelNodeId";
import { cityLimitsFactFromParcelRecord } from "./cityLimitsFactFromParcelRecord";
import { incorporationSettlesEtj } from "@workspace/cad-ingest/city-limits";
import { loadEtjFact, type EtjFactWire } from "./etjFactRead";
import {
  loadCityLimitsFact,
  type CityLimitsFactWire,
  type CityLimitsQueryPoint,
} from "./cityLimitsFactRead";

const CITY_LIMITS_RAIL_KEY = "cityLimits";

/**
 * The served city-limits fact, with the ETJ determination behind `etjStatus`
 * attached verbatim (publishers consulted, rings tested, basis). Present only
 * when a usable query point existed to read ETJ at -- a null-point fact has no
 * ETJ read to disclose.
 */
export type CityLimitsFactServed = CityLimitsFactWire & {
  etjFact?: EtjFactWire;
};

/**
 * Overlay the ETJ read onto an assembled city-limits fact.
 *
 * The base fact's own `etjStatus` is `unresolved` on both branches, so this is
 * where the three-valued disposition is actually decided. `basis` is composed
 * rather than replaced: the city-limits basis answers a different question
 * (incorporation) and dropping it would lose it.
 */
async function overlayEtjStatus(
  fact: CityLimitsFactWire,
): Promise<CityLimitsFactServed> {
  const point = fact.queryPoint;
  if (!point) {
    // No usable query point: ETJ is not readable, there is no claim to attach,
    // and the base fact already carries `unresolved`. Not a silent fallback --
    // nothing was readable and the value does not move.
    return fact;
  }

  // The containing city is only known when the city-limits answer says so.
  // `incorporated` names it; `unincorporated` positively says there is none;
  // `unmeasured` says nothing at all.
  const containingCityKnown = fact.status === "incorporated";
  const containingCityRuledOut = fact.status === "unincorporated";

  // P-376: when the city-limits fact POSITIVELY determines incorporation, that
  // determination also settles the ETJ answer — a Texas ETJ is unincorporated
  // area by definition, so no published ring has to be tested, or refused, for
  // this parcel. The settlement carries the fact's own city, source and basis
  // (which holds the source's vintage); a fact that is itself unmeasured or
  // unresolved settles nothing, and the ring test stands for it.
  const incorporation = incorporationSettlesEtj(fact);

  const etj = await loadEtjFact(
    point,
    undefined,
    containingCityKnown
      ? {
          cityName: fact.cityName ?? null,
          geoId: fact.geoId ?? null,
          incorporation,
        }
      : null,
  );

  // A miss against a publisher's extent box is only a checked absence when the
  // containing city is settled (named, or positively none). With the
  // containing city unread, a city that publishes no ETJ layer could be sitting
  // on this point, so the same miss is NOT a verified absence -- serving it as
  // one is the false negative `resolveEtjAtPoint` lives to prevent.
  //
  // A P-376 settled absence never reaches this rewrite, and that is structural
  // rather than lucky: the settlement exists only when the fact reads
  // `incorporated`, which is exactly when `containingCityKnown` is true.
  if (etj.status === "absent" && !containingCityKnown && !containingCityRuledOut) {
    const unresolved: EtjFactWire = {
      ...etj,
      status: "unresolved",
      basis:
        `${etj.basis}; BUT the containing city is unread here (city limits ` +
        `served ${fact.status} with no city), so whether this point sits in a ` +
        `city whose ETJ layer was never published cannot be ruled out. The ` +
        `miss is recorded, the disposition stays unmeasured rather than a ` +
        `verified absence.`,
    };
    return {
      ...fact,
      etjStatus: unresolved.status,
      basis: `${fact.basis} ETJ: ${unresolved.basis}`,
      etjFact: unresolved,
    };
  }

  return {
    ...fact,
    etjStatus: etj.status,
    basis: `${fact.basis} ETJ: ${etj.basis}`,
    etjFact: etj,
  };
}

export async function loadCityLimitsFactForServe(
  parcelNodeId: string,
  point: CityLimitsQueryPoint | null,
): Promise<CityLimitsFactServed> {
  const parsed = parseParcelNodeId(parcelNodeId);
  if (!parsed) {
    // Malformed parcelNodeId: unchanged behavior, let loadCityLimitsFact's
    // own point-only logic produce its existing unmeasured shape.
    return overlayEtjStatus(await loadCityLimitsFact(point));
  }
  const decision = await loadCellServeDecision(
    parsed.countyFips,
    parsed.propId,
    CITY_LIMITS_RAIL_KEY,
  );
  if (decision.serve === "current-path") {
    return overlayEtjStatus(await loadCityLimitsFact(point));
  }
  return overlayEtjStatus(await cityLimitsFactFromParcelRecord(parcelNodeId, point));
}
