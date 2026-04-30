/**
 * Declarative atom composition.
 *
 * An atom may declare zero or more children — each describing a child
 * entity type, the render mode the child should be drawn in by the parent,
 * and the key under which the parent's `data` exposes the child rows. The
 * registry **consumes** this declaration: it validates referenced child
 * types at registration time and again on `validate()`, and the resolver
 * (`resolveComposition`) produces a typed children list ready for render.
 *
 * Recon D1/D2: Empressa Demo declared composition as a single child and
 * never read it; A0 makes it multi-child and consumed.
 */

import type { AtomMode, AtomReference, AnyAtomRegistration } from "./registration";

/**
 * One edge of the composition graph.
 */
export interface AtomComposition {
  /**
   * Entity type of the child atom. Must resolve in the registry by the
   * time {@link resolveComposition} is called; the boot-time
   * `AtomRegistry.validate()` step also asserts the child is registered
   * unless {@link forwardRef} is `true`.
   */
  childEntityType: string;

  /** Mode the parent renders each child in (typically `"compact"`). */
  childMode: AtomMode;

  /**
   * Key on the parent's `data` payload where the child rows live. The
   * resolver looks up `parentData[dataKey]` and expects an array.
   */
  dataKey: string;

  /**
   * Opt-out of presence validation for this edge. When `true`:
   *   - `AtomRegistry.validate()` does not require {@link childEntityType}
   *     to be registered, so a parent can ship a composition declaration
   *     that names a child atom slated for a later sprint without
   *     crashing the boot.
   *   - {@link resolveComposition} silently produces zero children for
   *     this edge while the child remains unregistered, so the parent's
   *     `contextSummary` keeps returning `ok: true` (instead of erroring
   *     and forcing a hand-rolled fallback in every consumer).
   *   - Once the child atom is registered, both checks resolve normally
   *     and child references begin surfacing without further changes to
   *     the parent atom's code.
   *
   * Use sparingly — most edges should reference an already-registered
   * child so a typo in `childEntityType` continues to fail the boot
   * validator (the per-edge scope of this opt-out is deliberate so a
   * sibling forward-ref edge doesn't silently mask a typo elsewhere on
   * the same parent).
   *
   * Spec 20 locked decision #3 says composition declarations should be
   * allowed to reference atom types that aren't registered yet; this
   * field is the opt-in expression of that allowance.
   */
  forwardRef?: boolean;
}

/**
 * Single resolved child returned by {@link resolveComposition}.
 */
export interface ResolvedChild {
  /** The composition edge that produced this child. */
  composition: AtomComposition;

  /** The child registration in the registry. */
  registration: AnyAtomRegistration;

  /** Stable atom reference suitable for handing to a render binding. */
  reference: AtomReference;

  /** The raw data row from `parentData[dataKey][i]`. */
  data: Record<string, unknown>;
}

/**
 * Minimal registry surface the resolver needs. Declared structurally so
 * `composition.ts` doesn't have to import `registry.ts` and create a
 * circular dependency.
 */
export interface CompositionRegistryView {
  resolve: (
    entityType: string,
  ) =>
    | { ok: true; registration: AnyAtomRegistration }
    | { ok: false; error: { entityType: string; message: string } };
}

function pickIdFrom(row: Record<string, unknown>, fallback: string): string {
  const candidate = row.id ?? row.entityId ?? row.slug ?? row.name;
  if (typeof candidate === "string" && candidate.length > 0) return candidate;
  if (typeof candidate === "number") return String(candidate);
  return fallback;
}

/**
 * Resolve a parent registration's composition edges against `parentData`.
 *
 * For each declared child:
 * - looks up the child entity type in the registry (returns an error
 *   variant if missing — never throws),
 * - reads `parentData[dataKey]` (must be an array; missing → empty),
 * - synthesizes a stable {@link AtomReference} per row using `id`,
 *   `entityId`, `slug`, or `name` (in that order), falling back to
 *   `${parentRef.entityId}-${dataKey}-${index}`.
 *
 * Edges marked `forwardRef: true` whose child is still unregistered at
 * lookup time produce zero children silently rather than contributing
 * an error — the parent has explicitly opted in to that behavior so its
 * declaration can ship before the child catalog atom does.
 *
 * @returns A list of {@link ResolvedChild} on success, or `{ ok: false,
 *   errors }` enumerating every missing non-forward-ref child entity
 *   type. The caller decides whether to dev-warn or hard-fail.
 */
export function resolveComposition(
  parentRegistration: AnyAtomRegistration,
  parentRef: AtomReference,
  parentData: Record<string, unknown>,
  registry: CompositionRegistryView,
):
  | { ok: true; children: ResolvedChild[] }
  | {
      ok: false;
      errors: ReadonlyArray<{ childEntityType: string; message: string }>;
    } {
  const composition = parentRegistration.composition;
  const errors: Array<{ childEntityType: string; message: string }> = [];
  const children: ResolvedChild[] = [];

  for (const edge of composition) {
    const resolved = registry.resolve(edge.childEntityType);
    if (!resolved.ok) {
      if (edge.forwardRef) {
        // Forward-ref edges are allowed to point at an unregistered
        // child (Spec 20 decision #3). When the child still isn't
        // registered at lookup time, the resolver silently produces
        // zero children for that edge instead of erroring — the parent
        // atom's prose / keyMetrics path already runs without it.
        continue;
      }
      errors.push({
        childEntityType: edge.childEntityType,
        message: resolved.error.message,
      });
      continue;
    }
    const raw = parentData[edge.dataKey];
    const rows: Array<Record<string, unknown>> = Array.isArray(raw)
      ? (raw as Array<Record<string, unknown>>)
      : [];
    rows.forEach((row, i) => {
      if (row === null || typeof row !== "object") return;
      const childId = pickIdFrom(
        row,
        `${parentRef.entityId}-${edge.dataKey}-${i}`,
      );
      children.push({
        composition: edge,
        registration: resolved.registration,
        reference: {
          kind: "atom",
          entityType: edge.childEntityType,
          entityId: childId,
          mode: edge.childMode,
        },
        data: row,
      });
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, children };
}
