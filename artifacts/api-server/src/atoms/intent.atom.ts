/**
 * The `intent` atom registration — DA-PI-1 sprint, shape-only.
 *
 * Per Spec 51a §2.11, an *intent* is a persisted design intent
 * statement scoped to a parcel — the input that drives a parcel
 * briefing's content. Identity is parcel + monotonic id:
 *
 *   intent:{parcelId}:{ulid}
 *
 * Sprint scope (DA-PI-1) is registration-only. The persistence layer
 * (intent table + create-intent route) is not yet implemented; until
 * then `contextSummary` returns a structurally-complete not-found
 * envelope. The atom shape exists now so the chat inline-reference
 * resolver and any future producer can recognize the type.
 *
 * Composition (Spec 51a §2.11):
 *   - `parcel` (1, forwardRef — registers in DA-PI-2 / DA-PI-4)
 *
 * supportedModes is **all five** per Spec 20 §10 anti-pattern
 * (Spec 51a §2.11 lists "compact, card, expanded" as the modes the
 * spec author considered primary; that is a renderer concern, not an
 * atom-contract concern). `defaultMode: "card"` per the spec's
 * primary presentation guidance.
 *
 * Event types per Spec 51a §2.11. Spec 51 does not enumerate intent
 * events directly (intent is a composition of parcel-briefing in
 * Spec 51); the §1.4 precedence rule does not apply here because
 * there is no conflict.
 *
 * VDA wrapping (`wrapForStorage`) is intentionally not invoked —
 * matches snapshot/engagement convention.
 */

import {
  type AtomComposition,
  type AtomRegistration,
  type ContextSummary,
  type EventAnchoringService,
} from "@workspace/empressa-atom";

/** Hard cap on the prose summary. */
export const INTENT_PROSE_MAX_CHARS = 400;

/** All five Spec 20 §5 render modes — registration-level contract. */
export const INTENT_SUPPORTED_MODES = [
  "inline",
  "compact",
  "card",
  "expanded",
  "focus",
] as const;

export type IntentSupportedModes = typeof INTENT_SUPPORTED_MODES;

/**
 * Single source of truth for intent-domain event types. Per
 * Spec 51a §2.11. Producers wire these in a future sprint.
 */
export const INTENT_EVENT_TYPES = [
  "intent.created",
  "intent.persisted",
  "intent.discarded",
] as const;

export type IntentEventType = (typeof INTENT_EVENT_TYPES)[number];

/**
 * Typed payload returned by `intent`'s `contextSummary.typed`. Only
 * `id` + `found` are populated in DA-PI-1.
 */
export interface IntentTypedPayload {
  id: string;
  found: boolean;
}

export interface IntentAtomDeps {
  history?: EventAnchoringService;
}

/**
 * Build the intent atom registration. Shape-only in DA-PI-1.
 */
export function makeIntentAtom(
  deps: IntentAtomDeps = {},
): AtomRegistration<"intent", IntentSupportedModes> {
  // `parcel` is forward-ref because the parcel atom registers later
  // (DA-PI-2 / DA-PI-4 county GIS adapters). validate() skips the
  // edge; resolveComposition returns zero parcel children until then.
  const composition: ReadonlyArray<AtomComposition> = [
    {
      childEntityType: "parcel",
      childMode: "compact",
      dataKey: "parcel",
      forwardRef: true,
    },
  ];

  const registration: AtomRegistration<"intent", IntentSupportedModes> = {
    entityType: "intent",
    domain: "plan-review",
    supportedModes: INTENT_SUPPORTED_MODES,
    defaultMode: "card",
    composition,
    eventTypes: INTENT_EVENT_TYPES,
    async contextSummary(
      entityId: string,
      _scope,
    ): Promise<ContextSummary<"intent">> {
      let latestEventId = "";
      let latestEventAt = new Date(0).toISOString();
      if (deps.history) {
        try {
          const latest = await deps.history.latestEvent({
            kind: "atom",
            entityType: "intent",
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
        `Intent ${entityId} is registered as a catalog atom but the intent persistence layer ` +
        `is not implemented yet. The atom shape (composition edge to parcel, event vocabulary) ` +
        `is declared so producers and the inline-reference resolver can recognize this type.`;
      const prose =
        proseRaw.length > INTENT_PROSE_MAX_CHARS
          ? proseRaw.slice(0, INTENT_PROSE_MAX_CHARS - 1) + "…"
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
