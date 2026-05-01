/**
 * The `neighboring-context` atom registration — DA-PI-1 sprint,
 * shape-only.
 *
 * Per Spec 51a §2.13, *neighboring context* is the radius-bounded
 * digest of nearby parcel facts (and the briefing sources that
 * supplied them) attached to a parcel for context queries. Identity
 * is parcel + radius:
 *
 *   neighboring-context:{parcelId}:{radiusFt}
 *
 * Sprint scope (DA-PI-1) is registration-only. The radius-walk
 * implementation lands later. Until then `contextSummary` returns the
 * not-found envelope.
 *
 * Composition (Spec 51a §2.13):
 *   - `parcel`          (1, forwardRef — registers in DA-PI-2 / 4)
 *   - `briefing-source` (many) — concrete; registers in DA-PI-1.
 *
 * supportedModes is **all five** per Spec 20 §10 anti-pattern.
 * `defaultMode: "compact"` per Spec 51a §2.13's "compact (line in
 * briefing)" presentation guidance — neighboring context primarily
 * appears as an inline line within a parent parcel briefing.
 *
 * Event types per Spec 51a §2.13.
 *
 * VDA wrapping (`wrapForStorage`) intentionally not invoked — matches
 * snapshot/engagement convention.
 */

import {
  type AtomComposition,
  type AtomRegistration,
  type ContextSummary,
  type EventAnchoringService,
} from "@workspace/empressa-atom";

/** Hard cap on the prose summary. */
export const NEIGHBORING_CONTEXT_PROSE_MAX_CHARS = 400;

/** All five Spec 20 §5 render modes — registration-level contract. */
export const NEIGHBORING_CONTEXT_SUPPORTED_MODES = [
  "inline",
  "compact",
  "card",
  "expanded",
  "focus",
] as const;

export type NeighboringContextSupportedModes =
  typeof NEIGHBORING_CONTEXT_SUPPORTED_MODES;

/**
 * Single source of truth for neighboring-context-domain event types
 * per Spec 51a §2.13. Producers wire these in a future sprint.
 */
export const NEIGHBORING_CONTEXT_EVENT_TYPES = [
  "neighboring-context.generated",
  "neighboring-context.regenerated",
] as const;

export type NeighboringContextEventType =
  (typeof NEIGHBORING_CONTEXT_EVENT_TYPES)[number];

/**
 * Typed payload returned by `neighboring-context`'s
 * `contextSummary.typed`. Only `id` + `found` populated in DA-PI-1.
 */
export interface NeighboringContextTypedPayload {
  id: string;
  found: boolean;
}

export interface NeighboringContextAtomDeps {
  history?: EventAnchoringService;
}

/**
 * Build the neighboring-context atom registration. Shape-only in
 * DA-PI-1.
 */
export function makeNeighboringContextAtom(
  deps: NeighboringContextAtomDeps = {},
): AtomRegistration<"neighboring-context", NeighboringContextSupportedModes> {
  const composition: ReadonlyArray<AtomComposition> = [
    {
      childEntityType: "parcel",
      childMode: "compact",
      dataKey: "parcel",
      forwardRef: true,
    },
    {
      childEntityType: "briefing-source",
      childMode: "compact",
      dataKey: "sources",
    },
  ];

  const registration: AtomRegistration<
    "neighboring-context",
    NeighboringContextSupportedModes
  > = {
    entityType: "neighboring-context",
    domain: "plan-review",
    supportedModes: NEIGHBORING_CONTEXT_SUPPORTED_MODES,
    defaultMode: "compact",
    composition,
    eventTypes: NEIGHBORING_CONTEXT_EVENT_TYPES,
    async contextSummary(
      entityId: string,
      _scope,
    ): Promise<ContextSummary<"neighboring-context">> {
      let latestEventId = "";
      let latestEventAt = new Date(0).toISOString();
      if (deps.history) {
        try {
          const latest = await deps.history.latestEvent({
            kind: "atom",
            entityType: "neighboring-context",
            entityId,
          });
          if (latest) {
            latestEventId = latest.id;
            latestEventAt = latest.occurredAt.toISOString();
          }
        } catch {
          // Best-effort.
        }
      }

      const proseRaw =
        `Neighboring context ${entityId} is registered as a catalog atom but the radius-walk ` +
        `implementation is not wired yet. Composition edges to parcel and briefing-source and the ` +
        `event vocabulary are declared so producers and the inline-reference resolver can recognize this type.`;
      const prose =
        proseRaw.length > NEIGHBORING_CONTEXT_PROSE_MAX_CHARS
          ? proseRaw.slice(0, NEIGHBORING_CONTEXT_PROSE_MAX_CHARS - 1) + "…"
          : proseRaw;

      return {
        prose,
        typed: { id: entityId, found: false } as unknown as Record<
          string,
          unknown
        >,
        keyMetrics: [],
        relatedAtoms: [],
        historyProvenance: { latestEventId, latestEventAt },
        scopeFiltered: false,
      };
    },
  };

  return registration;
}
