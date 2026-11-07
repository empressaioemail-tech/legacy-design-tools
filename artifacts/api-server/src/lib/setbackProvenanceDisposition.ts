/**
 * F-11 — LDT serve of the engine setback disposition.
 *
 * Three populations stay three populations. A road class is not a setback.
 * A storage-port proof DID is not a dimensional record. Collapsing either
 * into `value` or `absent-verified` is the defect this module refuses.
 *
 * Discriminated union on `state` (P2b DrawEdge shape). A caller that
 * reads `.feet` without narrowing is a type error, not a runtime fallback.
 *
 * Atoms are not rewritten here. The serve path marks and decides.
 */

export const ROAD_CLASS_SETBACK_PROVENANCE = "road-class-setback-table" as const;
export const PLACEHOLDER_SETBACK_PROVENANCE = "storage-port-proof/phase-1a" as const;

/**
 * Basis names the derivation in prose. It must not embed the Gate 8 C7
 * tokens (`road-class-setback-table`, `storage-port-proof/phase-1a`,
 * `descriptor-fixture`): C7 walks every string on the served body, so
 * putting the retired token into the refusal basis keeps C7 red after
 * the value is already refused.
 */
export const RETIRED_ROAD_CLASS_SETBACK_BASIS =
  "refused: retired road-class derivation — a road class is not a setback";

export const PLACEHOLDER_SETBACK_UNKNOWN_BASIS =
  "unknown: source cites the phase-1a storage-port proof — nobody looked";

const PLACEHOLDER_MARKERS = [
  PLACEHOLDER_SETBACK_PROVENANCE,
  `did:hauska:code-section:${PLACEHOLDER_SETBACK_PROVENANCE}`,
] as const;

function citesPlaceholder(raw: string | null | undefined): boolean {
  if (typeof raw !== "string" || raw.trim() === "") return false;
  const n = raw.toLowerCase();
  return PLACEHOLDER_MARKERS.some((m) => n.includes(m.toLowerCase()));
}

function citesRoadClass(raw: string | null | undefined): boolean {
  if (typeof raw !== "string" || raw.trim() === "") return false;
  return raw.trim() === ROAD_CLASS_SETBACK_PROVENANCE;
}

export type BoundaryEdgeSetbackValue = {
  state: "value";
  feet: number;
  provenance: string | null;
  atomCitation: string | null;
  basis: string;
};

export type BoundaryEdgeSetbackRefused = {
  state: "refused";
  basis: string;
};

export type BoundaryEdgeSetbackUnknown = {
  state: "unknown";
  basis: string;
};

export type BoundaryEdgeSetbackAbsent = {
  state: "absent";
  basis: string;
};

/**
 * Served setback. `value` is the only arm that carries feet.
 * `unknown` is never `absent-verified`.
 */
export type BoundaryEdgeSetbackServe =
  | BoundaryEdgeSetbackValue
  | BoundaryEdgeSetbackRefused
  | BoundaryEdgeSetbackUnknown
  | BoundaryEdgeSetbackAbsent;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Interpret a stored edge `setback` into the serve union.
 * Do not fall back to a prior value, road class, district default, or zero.
 */
export function serveBoundaryEdgeSetback(
  setback: unknown,
): BoundaryEdgeSetbackServe {
  const rec = asRecord(setback);
  if (!rec) {
    return { state: "absent", basis: "no setback object on edge" };
  }

  if (typeof rec.kind === "string") {
    return {
      state: "absent",
      basis:
        asNullableString(rec.reason) ??
        asNullableString(rec.kind) ??
        "unmapped setback kind",
    };
  }

  const provenance = asNullableString(rec.provenance);
  const atomCitation = asNullableString(rec.atomCitation);

  if (citesRoadClass(provenance) || citesRoadClass(atomCitation)) {
    return { state: "refused", basis: RETIRED_ROAD_CLASS_SETBACK_BASIS };
  }
  if (citesPlaceholder(provenance) || citesPlaceholder(atomCitation)) {
    return { state: "unknown", basis: PLACEHOLDER_SETBACK_UNKNOWN_BASIS };
  }

  const feet = asFiniteNumber(rec.feet);
  if (feet == null) {
    return {
      state: "refused",
      basis: "malformed setback object — not a dimensional record",
    };
  }

  return {
    state: "value",
    feet,
    provenance,
    atomCitation,
    basis: provenance
      ? `value: edge provenance ${provenance}`
      : "value: resolved setback with no retired or placeholder provenance",
  };
}
