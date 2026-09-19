/**
 * Typed ETJ serve DTO (feat/p241-etj-acquisition, P-241 acquisition half).
 *
 * Mirrors `cityLimitsFact.ts`. Not an atom family. Point-in-polygon against
 * `tx_etj_boundary` rings, bounded by each publisher's own published extent
 * from `tx_etj_source`. There is no buffer path here and no §42.021
 * derivation anywhere: a ring that was not published is a ring this module
 * cannot see, and a fabricated ring would contradict the real layer.
 *
 * The disposition is three-valued and the middle value is the whole point:
 *
 *   present    a published ring contains the point;
 *   absent     a registered publisher's published extent covers the point and
 *              none of its rings contains it — checked, and the ETJ really
 *              does not reach here;
 *   unresolved there is no source to check (nothing ingested, the point is
 *              outside every registered extent, or the city is enumerated as
 *              publishing no ETJ layer).
 *
 * `absent` and `unresolved` are never collapsed. Folding them together is the
 * defect this DTO exists to prevent: it turns "we looked and it is not there"
 * into "we could not look", and the customer cannot tell which they were told.
 *
 * P-359 adds two things to the same DTO, both additive:
 *
 *   - a `present` says HOW the containing ring was served (`servedStatus`:
 *     `verbatim`, `derived` or `repaired`) and carries the derivation's own
 *     sentence when it wrote one. An ETJ answer that rests on a ring from which
 *     the city's own limits were subtracted is a derived answer, and it says so;
 *   - an `unresolved` that is unresolved BECAUSE a ring was refused carries
 *     `refusedRings`, each with its status and the derivation's reason. A ring
 *     nobody could test is not a ring that was tested and missed.
 */

import type {
  EtjContainmentResult,
  EtjStatus,
} from "./containment";

export const ETJ_SOURCE = "tx_etj_boundary" as const;

export type EtjDisposition = EtjStatus;

export type EtjFact = {
  status: EtjDisposition;
  source: typeof ETJ_SOURCE;
  basis: string;
  /** The ETJ city, when a published ring contains the point. */
  cityKey?: string;
  cityName?: string;
  /** The publisher's own ring label, verbatim. */
  ringLabel?: string;
  /** `<cityKey>:<publisher object id>`. */
  etjId?: string;
  /** The publisher's layer URL the ring came from. */
  sourceCitation?: string;
  /** Publishers whose own published extent covered the query point. */
  coveredBy?: string[];
  /** Rings actually tested by point-in-polygon. */
  ringsConsulted?: number;
  /**
   * How the containing ring was served (P-359): `verbatim`, `derived` (the ring
   * minus its own city's limits) or `repaired`. A `present` that rests on a
   * derived geometry names the derivation rather than looking like any other ring.
   */
  servedStatus?: "verbatim" | "derived" | "repaired";
  /** The derivation's own sentence about that ring, when it wrote one. */
  derivationNote?: string;
  /**
   * Rings the reader refused to test whose publisher's extent covers the point
   * (P-359), present exactly when the refusal is why the answer is
   * `unresolved`. A refused ring is not a ring that was measured and missed.
   */
  refusedRings?: Array<{
    etjId: string;
    servedStatus: string;
    reason: string;
  }>;
};

export function etjFactFromContainment(result: EtjContainmentResult): EtjFact {
  if (result.status === "present") {
    return {
      status: "present",
      source: ETJ_SOURCE,
      basis: result.basis,
      cityKey: result.cityKey,
      cityName: result.cityName,
      ringLabel: result.ringLabel,
      etjId: result.etjId,
      sourceCitation: result.sourceCitation,
      servedStatus: result.servedStatus,
      // Omitted, not `null`: an absent note is an absent field, so a consumer
      // cannot print "derivation: null" as if a derivation had run.
      ...(typeof result.derivationNote === "string" &&
      result.derivationNote.length > 0
        ? { derivationNote: result.derivationNote }
        : {}),
    };
  }
  if (result.status === "absent") {
    return {
      status: "absent",
      source: ETJ_SOURCE,
      basis: result.basis,
      coveredBy: result.coveredBy,
      ringsConsulted: result.ringsConsulted,
    };
  }
  return {
    status: "unresolved",
    source: ETJ_SOURCE,
    basis: result.basis,
    ...(result.refusedRings !== undefined
      ? { refusedRings: result.refusedRings }
      : {}),
  };
}

export function unmeasuredEtjFact(basis: string): EtjFact {
  return { status: "unresolved", source: ETJ_SOURCE, basis };
}

/** Degenerate bake centroid (0,0) and non-finite coords are not a query point. */
export function usableEtjQueryPoint(
  longitude: number,
  latitude: number,
): { longitude: number; latitude: number } | null {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  if (longitude === 0 && latitude === 0) return null;
  return { longitude, latitude };
}
