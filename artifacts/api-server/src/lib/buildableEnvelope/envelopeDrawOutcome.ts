/**
 * P-339 (Ruling 15, MCP half): the draw route owns the envelope's reason.
 *
 * WHY THIS IS ITS OWN MODULE. `parcelDrawEnvelopeModel.ts` reaches the live
 * parcel GIS, the property atom chain and the road service; `parcelDrawFromReads.ts`
 * is imported by the get_smart_site route and by tests that mock none of that.
 * The outcome shape and the single function that turns it into an overlay
 * reason are pure and dependency-free, so both files can read the SAME answer
 * without the assembler inheriting the orchestration module's import graph —
 * the same extraction reason `composeBuildableEnvelopeDerivation.ts` exists
 * (P-153 Step A's own note).
 *
 * THE DEFECT THIS CLOSES, measured 2026-09-18 on 48453:367134 / 48453:239852 /
 * 48309:103015 / 48453:445501 / 48055:27929 / 48209:145880. `computeTier1Envelope`
 * (nodeFacetBakeTier1.ts:93; the zoning guard at :104, the decline at :116)
 * declines EVERY zoned parcel with `declineReason: "atom_path_pending"`. That is the anti-zombie
 * marker meaning "the Tier-1 bake no longer authors product envelope confidence
 * — go read the atom route", but it travels as a REASON TOKEN, and
 * `envelopeHuman("atom_path_pending")` renders it "Withheld, setbacks unruled"
 * (its VOCABULARY `meaning`: "have not been ruled or baked for this
 * jurisdiction yet; no distance or polygon exists to report"). So a parcel whose
 * own payload rules 25/5/10/15 told the customer its setbacks were unruled, and
 * `scripts/surface-probe.mjs` grades exactly that:
 *
 *   - RULE_REFUSAL_PHRASES (:1926) contains "unruled"
 *     -> SAYS-RULES-UNRULED-BESIDE-RULED-TABLE when the payload rules >= 3 axes
 *        (RULED_TABLE_MIN_AXES, :247)
 *   - GEOMETRY_REFUSAL_PHRASES (:1927) contains "atom_path_pending"
 *     -> SAYS-GEOMETRY-WITHHELD-BESIDE-DRAWN-GEOMETRY when the route drew
 *        (contradictions(), :1980-1991)
 *
 * THE RULE THIS MODULE ENFORCES. One token meant two things and the customer
 * read the wrong one. `atom_path_pending` is now reachable only when there is
 * no property atom chain to read at all — which is the only case where its
 * vocabulary meaning is true. Every other outcome carries the step the route
 * itself stopped at, so the surface can no longer claim "unruled" about a
 * determination it never made.
 *
 * NO NEW VOCABULARY TOKEN is minted here. `no-zoning-stamp` and
 * `atom_path_pending` are existing rows of
 * `@empressaio/atom-contract/display`'s VOCABULARY (36 `token:` rows,
 * verified in the installed `dist/display/wire.js`); the remaining
 * step names travel as raw `reason` values, exactly as `no-buildable-area` and
 * `geometry-validation-failed` already do (`envelopeHuman` passes an unknown
 * token through unchanged). The package has no other humanised envelope-refusal
 * row, and inventing a claim to fill that gap would be the same defect in a new
 * costume; the close names this as the one place the dispatch's two constraints
 * (no new token, no `atom_path_pending` beside a chain) cannot both be met
 * verbatim.
 */

/** The buildable-envelope polygon the draw block serves, when the route drew one. */
export type EnvelopeModelledDraw = {
  /** WGS84 [lng, lat] outer-ring vertices of the buildable-envelope polygon. */
  ringLngLat: [number, number][];
  setbacks: {
    front_ft: number;
    side_ft: number;
    rear_ft: number;
    side_corner_ft?: number;
    district: string;
  };
  /** Human disclosure string off `deriveBuildableEnvelope`'s own props. */
  disclosure: string;
};

/**
 * The step of the point-seeded derivation that decided the outcome. A closed
 * set, so a caller (and a test) can name WHAT happened rather than only that
 * nothing was drawn — the property `tryComposeEnvelopeModelForDraw`'s
 * `null` return destroyed.
 */
export type EnvelopeDrawStep =
  /**
   * Nothing — ring stamp, spine, atom chain — named a district, so nothing was
   * resolved against. (P-374: this is the shared derivation's own terminal
   * answer, `no-zoning-stamp`, not the absence of one caller's own facet; the
   * route reaches it after reading all four signals, and a DECLINE.)
   */
  | "no-zoning-code"
  /** No `snapshot.queryPoint`, so the derivation cannot be seeded. */
  | "no-query-point"
  /** The parcel layer returned no usable ring at the seeded point. */
  | "parcel-ring-unavailable"
  /** The live parcel at the point stamps a DIFFERENT parcel_node_id. */
  | "parcel-identity-mismatch"
  /** No setback source covers the resolved district in this jurisdiction. */
  | "setbacks-unresolved"
  /**
   * `labelEdges` could not label the ring against the nearby roads (the route's
   * own 422 `ungeometric-parcel`; P-374). The old MCP copy of the derivation
   * returned `edge-labeling-unavailable` here — an unreached attempt — for a
   * condition the route had already answered.
   */
  | "edge-labeling-unavailable"
  /** The derivation ran and answered: `wireStatus` was not "ok". */
  | "derivation-not-drawn"
  /** A polygon came back, but with fewer than a triangle's worth of vertices. */
  | "ring-too-small"
  /**
   * The attempt threw before it reached an answer anywhere a more precise step
   * name would be true (a network/parse failure in the chain, road or
   * composition reach). Deliberately NOT `parcel-ring-unavailable`: reporting a
   * throw from a later stage as a missing ring would be the same defect as
   * reporting `atom_path_pending` beside a chain, one layer down.
   */
  | "derivation-threw";

/**
 * Whether a property atom chain existed for this parcel when the route ran.
 * `"unreached"` means the attempt stopped before the chain fetch — the state
 * that must never be reported as if the chain had been read and found empty.
 */
export type EnvelopeDrawChain = "present" | "absent" | "unreached";

/** A refusal the ROUTE reached. Distinguishes a real decline from an unreached attempt. */
export type EnvelopeDrawRefusal = {
  step: EnvelopeDrawStep;
  chain: EnvelopeDrawChain;
  /** The route's own answer when it reached one (`deriveBuildableEnvelope`'s `wireStatus`). */
  declinedBy?: string | null;
};

export type EnvelopeDrawOutcome =
  | { state: "modelled"; model: EnvelopeModelledDraw; chain: EnvelopeDrawChain }
  | { state: "declined"; refusal: EnvelopeDrawRefusal }
  | { state: "unreached"; refusal: EnvelopeDrawRefusal };

/**
 * THE ONE OWNER of the refused overlay's reason.
 *
 * The drawing route's own outcome decides it; a surface never composes its own.
 * Read by `parcelDrawFromReads.ts` for the overlay and by `propertyExplorer.ts`
 * for the route's own disposition, so the two can never be two sentences.
 *
 * `declinedBy` is preferred verbatim where the derivation produced it, because
 * `no-buildable-area` is a MEASUREMENT (setbacks genuinely consume the lot) and
 * `geometry-validation-failed` is a GATE decline — P60b's split, which must not
 * be flattened back into one token here.
 *
 * P-374 DID NOT WIDEN THIS. The lane that made the two callers share one
 * derivation was tempted to serve `setbacks-unresolved` for a null
 * jurisdiction key too, on the reading that "we could not find the city" is a
 * different claim from "nothing is ruled here". That reads well and is wrong
 * HERE: P-339's two directions are a contract the probe grades (chain present
 * -> `setbacks-unresolved`; chain ABSENT -> `atom_path_pending`), and a
 * caller's own missing city is not evidence about the chain at all. Changing
 * it broke both pre-registered falsifiers, which is how it was caught. The
 * residual (a card with no city at all, where a geocoded route drew) is named
 * in P-374's close as an INPUT gap, not patched over by weakening this rule.
 */
export function envelopeDrawRefusalReason(refusal: EnvelopeDrawRefusal): string {
  switch (refusal.step) {
    case "no-zoning-code":
      // The ledger cell's own sentence when the derivation supplied one
      // (P-465 / A-324). The token remains only for a caller that declined
      // without a cell reason.
      return refusal.declinedBy ?? "no-zoning-stamp";
    case "derivation-not-drawn":
      return refusal.declinedBy ?? "geometry-validation-failed";
    case "setbacks-unresolved":
      // The ledger cell's own sentence when the derivation supplied one.
      // `declinedBy` is that sentence (or, on the retired table path, P-257's
      // planned-development token). With neither, a missing chain is still
      // `atom_path_pending` and a present chain is `setbacks-unresolved`.
      return (
        refusal.declinedBy ??
        (refusal.chain === "absent" ? "atom_path_pending" : "setbacks-unresolved")
      );
    case "parcel-ring-unavailable":
    case "parcel-identity-mismatch":
    case "edge-labeling-unavailable":
    case "ring-too-small":
    case "no-query-point":
    case "derivation-threw":
      return refusal.step;
  }
}
