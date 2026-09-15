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
function isMachineVerifyDiagnostic(reason: string): boolean {
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
