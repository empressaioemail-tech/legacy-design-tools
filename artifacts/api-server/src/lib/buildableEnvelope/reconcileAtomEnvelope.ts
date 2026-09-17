/**
 * Reconcile a live-derived buildable envelope against the property atom
 * chain's own buildable-envelope outcome (boundary-envelope atom program,
 * item 2 — see doc_repo _decisions/2026-09-06_boundary_envelope_atom_program_scope.md).
 *
 * The engine's buildable-envelope atom never carries geometry (its
 * EnvelopeHonestOutcome type is only `{kind:"buildable", areaSqFt}` or a
 * decline reason — see hauska-engine packages/atoms/src/property-instances.ts),
 * so derive.ts's live geometry stays the only source of a drawable polygon.
 * What the atom DOES carry, when present, is the authoritative buildable-area
 * number/outcome. Before this module, the production route fetched the atom
 * chain but only ever read its confidence estimate and atomDid — never this
 * outcome — so a parcel with a real, computed atom could still be served a
 * different, independently re-derived area with no reconciliation at all.
 * This module is the one place that reconciles the two so the route never
 * silently serves a live-derived number that disagrees with the atom's.
 *
 * A validation-failed empty result is never overridden: it means derive.ts's
 * own geometry gates declined the ring — a fact about OUR polygon, not a
 * measurement the atom's number could correct (derive.ts's own module header
 * already treats this class as fail-closed for the same reason).
 */

import type { InsetEmptyKind } from "./geometry";
import type { BuildableEnvelopeProps, BuildableEnvelopeResult } from "./derive";

export interface AtomBuildableEnvelopeOutcome {
  kind?: string;
  areaSqFt?: number;
  reason?: string;
}

/**
 * P-249 (2026-09-16) — the verification signal, named correctly.
 *
 * The atom field is `depthWarmPromotion`; the value `"depth-warm-promoted-v1"`
 * means the envelope passed ground-truth (depth-warm) verification. There is NO
 * `depthWarmPromoted` field on the atom — hauska-map writes a flag by that name
 * into its own output and nothing reads it (A-184). Four predicates read this
 * one fact across three repos; this is LDT's leg (the others: hauska-map's
 * `isDepthWarmPromoted`, `isMachineVerifyDiagnostic` below, and doc_repo's
 * `scripts/envelope-draw-gap.mjs`), and all four answer to the shared fixture
 * set in `__fixtures__/envelope-verification.json`.
 */
export const DEPTH_WARM_PROMOTION_MARKER = "depth-warm-promoted-v1";

/** The two wire fields the verification predicate reads, in precedence order. */
export interface EnvelopeAtomPromotion {
  depthWarmPromotion?: string | null;
  sourceCitation?: string | null;
}

/**
 * Is this buildable-envelope atom ground-truth VERIFIED?
 *
 * Precedence, stated once:
 *   1. `depthWarmPromotion === "depth-warm-promoted-v1"` — exact match, the
 *      marker the engine writes when it promotes a depth-warm envelope.
 *   2. ONLY when the marker is absent, the `sourceCitation` fallback: a
 *      citation string containing `depth-warm-verified`. Same fallback and same
 *      order as hauska-map's `isDepthWarmPromoted`, so the two cannot disagree.
 * Anything else — no fields, a reason-only zero, a version-shifted marker
 * (`...-v2`), a near-miss citation (`depth-warm-verify`) — is NOT verified.
 * Absent promotion fields therefore read as unverified, which is the
 * conservative direction for every caller below.
 */
export function isEnvelopeAtomVerified(
  atom: EnvelopeAtomPromotion | null | undefined,
): boolean {
  if (!atom || typeof atom !== "object") return false;
  if (atom.depthWarmPromotion === DEPTH_WARM_PROMOTION_MARKER) return true;
  const citation = atom.sourceCitation;
  return typeof citation === "string" && citation.includes("depth-warm-verified");
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * hauska-engine's honest-decline atoms (packages/engine-core/src/depth-warm/
 * honest-decline-promote.ts, `buildHonestVerifyDeclineAtom`) sometimes carry
 * a RAW mechanical-verify diagnostic as `outcome.reason` — internal
 * per-edge/per-road gate text joined with "; ", full-precision floats
 * included. It was written for an engineer reading a cert-failure log, never
 * for a customer (P-214, live 2026-09-15 on 48021:8723767: "edge 1: R32
 * 35.02831192164916ft != expected 5ft for role side; edge 4: R32
 * 53.60964475445567ft != expected 25ft for role rear"). Detect that shape so
 * it never reaches a served string. The three signals below are independent
 * of any one gate's wording (R32 is only one of several mechanical gates
 * that feed this same field) and match how `honest-decline-promote.ts`
 * actually assembles the string: `verifyReasons.slice(0, 3).join("; ")`.
 */
export function isMachineVerifyDiagnostic(reason: string): boolean {
  if (reason.includes("; ")) return true;
  if (/\b(edge|road)\s+\S+:/i.test(reason)) return true;
  if (/\d+\.\d{4,}/.test(reason)) return true;
  return false;
}

const ENVELOPE_UNVERIFIED_DISCLOSURE =
  "The property atom chain's last geometry certification for this parcel failed its own mechanical checks and could not confirm a buildable envelope. Withheld rather than shown as a possibly-stale figure — verify with a survey and the city.";

function withoutEmptyFields(
  props: BuildableEnvelopeProps,
): Omit<BuildableEnvelopeProps, "emptyReason" | "emptyKind"> {
  const { emptyReason: _emptyReason, emptyKind: _emptyKind, ...rest } = props;
  return rest;
}

/**
 * Returns `derived` unchanged (same reference) when there is nothing to
 * reconcile, so callers can cheaply detect "did reconciliation change
 * anything" via reference equality.
 *
 * P-249 (2026-09-16): reconciliation is now gated on VERIFICATION, not merely
 * on the atom having an outcome. An envelope atom that never passed depth-warm
 * ground-truth promotion — 490,185 of them sit in the six counties, mostly
 * July breadth-bake records meaning "unzoned" (208,868), "not onboarded"
 * (153,775) or a reason-less zero (123,706) — has nothing trustworthy to
 * correct a live derivation WITH, exactly like the mechanical-verify
 * diagnostic P-214 already treated that way. So it no longer empties a good
 * live envelope (the polygon) and no longer substitutes its own area for the
 * live one (the figure): operator ruling A-180 allows a buildable-area figure
 * only when a VERIFIED atom backs it, and the 2026-09-11 R-2 ruling reversed
 * Ruling B for the polygon only — draw it wherever a district and a setback
 * table exist, and let the area wait. A VERIFIED zero still wins.
 */
export function reconcileWithAtomEnvelope(
  derived: BuildableEnvelopeResult,
  atomOutcome: AtomBuildableEnvelopeOutcome | null | undefined,
  atomPromotion?: EnvelopeAtomPromotion | null,
): BuildableEnvelopeResult {
  if (!atomOutcome || typeof atomOutcome.kind !== "string") return derived;
  const feature = derived.geojson.features[0];
  if (!feature) return derived;
  const props = feature.properties;

  // A geometry-gate decline is a fact about our own ring, never a measurement
  // the atom's number can correct — never let it masquerade as a real outcome.
  if (derived.empty && props.emptyKind === "validation-failed") return derived;

  if (
    atomOutcome.kind === "buildable" &&
    typeof atomOutcome.areaSqFt === "number" &&
    Number.isFinite(atomOutcome.areaSqFt) &&
    atomOutcome.areaSqFt >= 0
  ) {
    const atomArea = atomOutcome.areaSqFt;
    const alreadyAgrees =
      !derived.empty &&
      typeof props.buildableAreaSqFt === "number" &&
      Math.round(props.buildableAreaSqFt) === Math.round(atomArea);
    if (alreadyAgrees) return derived;

    // P-249 (A-180): an UNVERIFIED atom's area is exactly as unfounded as its
    // zero. It does not replace the live derivation's own figure — the served
    // number, when one is served, stays the local labelEdges+derive one with
    // its own disclosure, and the atom's figure is never quoted ("Buildable
    // area from the property atom chain … 5027 sq ft" was the live Pflugerville
    // symptom on an atom that had not passed ground-truth verification).
    const verified = isEnvelopeAtomVerified(atomPromotion);
    if (!verified) return derived;

    const keepsGeometry = !derived.empty && feature.geometry !== null;
    const parcelAreaSqFt = props.parcelAreaSqFt;
    const buildableAreaPct =
      parcelAreaSqFt > 0 ? round1((atomArea / parcelAreaSqFt) * 100) : 0;
    const coverageCap =
      typeof props.maxLotCoveragePct === "number"
        ? (props.maxLotCoveragePct / 100) * parcelAreaSqFt
        : null;
    const maxFootprintSqFt =
      coverageCap != null
        ? Math.round(Math.min(atomArea, coverageCap))
        : Math.round(atomArea);
    const disclosure =
      `Buildable area from the property atom chain (engine source of truth): ` +
      `${Math.round(atomArea)} sq ft. ` +
      (keepsGeometry
        ? "Approximate — verify with a survey and the city."
        : "Local map geometry unavailable for this outcome — area shown without a drawn shape. " +
          "Approximate — verify with a survey and the city.");

    const newProps: BuildableEnvelopeProps = {
      ...withoutEmptyFields(props),
      approximate: true,
      buildableAreaSqFt: Math.round(atomArea),
      buildableAreaPct,
      maxFootprintSqFt,
      disclosure,
    };

    return {
      ...derived,
      empty: false,
      emptyKind: undefined,
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: keepsGeometry ? feature.geometry : null,
            properties: newProps,
          },
        ],
      },
    };
  }

  if (atomOutcome.kind === "no-buildable-area") {
    const alreadyAgrees = derived.empty && props.emptyKind === "consumed";
    if (alreadyAgrees) return derived;

    const rawReason = atomOutcome.reason ?? null;
    const isDiagnostic = rawReason != null && isMachineVerifyDiagnostic(rawReason);

    // A mechanical-verify failure is a fact about the ENGINE's own stale
    // certification, never a genuine "setbacks consume the lot" geometric
    // finding (P-214). When derive.ts's own live pass already produced a
    // real, drawable envelope, that live result is the more-current answer
    // (it consumes today's setback table, the same one this route already
    // served) — the atom has nothing trustworthy to correct it WITH, so
    // treat it the same as the pending/unknown-kind case below and keep the
    // live result rather than clobbering a good envelope with a false zero.
    if (isDiagnostic && !derived.empty) return derived;

    // P-249: the same reasoning now covers every UNVERIFIED atom, not only the
    // mechanical-verify diagnostic. A `no-buildable-area` outcome that never
    // passed depth-warm promotion is a shape-only computation (no confirmed
    // road-frontage edge labeling); a ring can mislabel GIS-artifact vertices
    // as `side` and collapse a long narrow lot to a false zero — confirmed live
    // on 48209:97658 (P-216). It may not empty a live envelope that has a
    // district and a setback table, whatever its reason text says.
    //
    // Precedence, stated once: the DIAGNOSTIC branch is checked first and keeps
    // its P-214 behavior for verified and unverified atoms alike (a raw
    // mechanical-verify string never reaches a customer string, and when the
    // live pass has nothing to fall back on either, the sanitized
    // `validation-failed` decline below is what gets served — a named failure,
    // never a silent empty). The verification gate then applies to every other
    // reason: a reason-less zero, "unzoned", "not onboarded", or a
    // human-authored engine sentence.
    //
    // Scope note, so this cannot silently over-reach: what this branch keeps is
    // OUR live pass's own finding (its own reason, its own geometry gates) or
    // the named decline above — it never fabricates an envelope.
    const verified = isEnvelopeAtomVerified(atomPromotion);
    if (!isDiagnostic && !verified) return derived;

    const emptyKind: InsetEmptyKind = isDiagnostic
      ? "validation-failed"
      : "consumed";
    const reason = isDiagnostic
      ? ENVELOPE_UNVERIFIED_DISCLOSURE
      : (rawReason ?? "Setbacks consume the lot — no buildable area remains.");
    const disclosure = isDiagnostic
      ? reason
      : `No buildable area: ${reason} (property atom chain, engine source of truth). ` +
        `Approximate — verify with a survey and the city.`;

    const newProps: BuildableEnvelopeProps = {
      ...withoutEmptyFields(props),
      approximate: true,
      buildableAreaSqFt: 0,
      buildableAreaPct: 0,
      maxFootprintSqFt: 0,
      disclosure,
      emptyReason: reason,
      emptyKind,
    };

    return {
      ...derived,
      empty: true,
      emptyKind,
      geojson: {
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry: null, properties: newProps }],
      },
    };
  }

  // Unknown/pending kind (e.g. "provisional-front-edge" carries no area) —
  // the atom has no usable number to reconcile against; keep the live result.
  return derived;
}

/**
 * P-304 (2026-09-17) — WITHHOLD THE AREA FIGURE WITHOUT A VERIFIED ATOM.
 *
 * A-180 (`_decisions/2026-09-11_ruling_b_reversed_polygon_only.md`): only a
 * ground-truth VERIFIED envelope atom entitles a caller to a buildable-area
 * figure. A polygon modelled from the setback table on record (no verified
 * atom) may still DRAW — the reader can see the shape the instruments imply —
 * but the figure must not be printed, because it is not measured. The figure
 * is legitimate business information that the parcel owner / a licensed
 * caller is entitled to obtain elsewhere; it is not something an anonymous
 * reader of a public map is entitled to print as a fact.
 *
 * The predicate is P-249's own: `isEnvelopeAtomVerified`, one definition for
 * both modules, so "verified" can never mean two things.
 *
 * Withholding is ABSENCE, not zero, and never a fake number:
 *   - the two keys are DELETED from the properties (a consumer that reads
 *     them gets `undefined`, which is what downstream already treats as
 *     "no figure available": the PE wire mapper `?? null`, the map card's
 *     `num()`, `live-envelope-augment`'s "no atom area" branch);
 *   - a zero would be read as a MEASURED result ("this lot can't be built on")
 *     — a different, false claim, so a withheld figure never becomes a zero;
 *   - no stand-in polygon area is substituted: the atom's own area is still
 *     not quoted (P-249's stance), and re-deriving one from our own ring on
 *     the way out would be the same unfounded figure wearing a new label;
 *   - the geometry is untouched, so the draw is unaffected;
 *   - `disclosure` names the withholding (the honest-partial slot the draw
 *     block already carries for declined envelopes), so a reader is told WHY
 *     the figure is missing rather than left to guess.
 *
 * Idempotent: an already-withheld (or atom-zero) payload has both keys absent
 * and comes back unchanged, so calling it twice can never delete a figure that
 * a verified atom put there.
 */
export const AREA_FIGURE_WITHHELD_DISCLOSURE =
  "Buildable area withheld — this parcel's buildable-envelope outcome has no " +
  "ground-truth verified atom (depth-warm promoted) backing it. The envelope " +
  "outline is modelled from the setback table on record; the area figure stays " +
  "withheld until a verified atom backs it.";

export function withholdUnverifiedAreaFigure(
  derived: BuildableEnvelopeResult,
  atomPromotion?: EnvelopeAtomPromotion | null,
): BuildableEnvelopeResult {
  if (isEnvelopeAtomVerified(atomPromotion)) return derived;

  const feature = derived.geojson.features[0];
  if (!feature) return derived;

  const props = feature.properties;
  const carriesFigure =
    props.buildableAreaSqFt !== undefined || props.buildableAreaPct !== undefined;
  if (!carriesFigure) return derived;

  const {
    buildableAreaSqFt: _withheldSqFt,
    buildableAreaPct: _withheldPct,
    ...rest
  } = props;

  // An empty result's disclosure is the decline reason for the RING (e.g. our
  // own geometry gates) — that is a different fact and it keeps its words. A
  // drawn envelope gets the withholding disclosure, replacing the mild
  // "approximate" caveat, which understated the situation.
  const withheldProps: BuildableEnvelopeProps = derived.empty
    ? rest
    : { ...rest, disclosure: AREA_FIGURE_WITHHELD_DISCLOSURE };

  return {
    ...derived,
    geojson: {
      type: "FeatureCollection",
      features: [{ ...feature, properties: withheldProps }],
    },
  };
}
