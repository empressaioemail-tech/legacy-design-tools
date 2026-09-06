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

import type { BuildableEnvelopeProps, BuildableEnvelopeResult } from "./derive";

export interface AtomBuildableEnvelopeOutcome {
  kind?: string;
  areaSqFt?: number;
  reason?: string;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

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
 */
export function reconcileWithAtomEnvelope(
  derived: BuildableEnvelopeResult,
  atomOutcome: AtomBuildableEnvelopeOutcome | null | undefined,
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
      !derived.empty && Math.round(props.buildableAreaSqFt) === Math.round(atomArea);
    if (alreadyAgrees) return derived;

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

    const reason = atomOutcome.reason ?? "Setbacks consume the lot — no buildable area remains.";
    const disclosure =
      `No buildable area: ${reason} (property atom chain, engine source of truth). ` +
      `Approximate — verify with a survey and the city.`;

    const newProps: BuildableEnvelopeProps = {
      ...withoutEmptyFields(props),
      approximate: true,
      buildableAreaSqFt: 0,
      buildableAreaPct: 0,
      maxFootprintSqFt: 0,
      disclosure,
      emptyReason: reason,
      emptyKind: "consumed",
    };

    return {
      ...derived,
      empty: true,
      emptyKind: "consumed",
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
