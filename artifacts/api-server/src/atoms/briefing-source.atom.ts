/**
 * The `briefing-source` atom registration — DA-PI-1 sprint, shape-only.
 *
 * Per Spec 51a §2.12, a *briefing source* is the cited overlay/snapshot
 * a parcel briefing pulled facts from (e.g. zoning overlay XYZ, ground-
 * snow-load adapter ABC, snapshot-date 2026-04-30). Identity is the
 * triple of (briefingId, overlayId, snapshotDate):
 *
 *   briefing-source:{briefingId}:{overlayId}:{snapshotDate}
 *
 * Sprint scope (DA-PI-1) is registration-only. The fetch/refresh layer
 * lands when DA-PI-3 wires the briefing engine. Until then
 * `contextSummary` returns the not-found envelope.
 *
 * Composition (Spec 51a §2.12):
 *   - `parcel-briefing` (1) — concrete; registers alongside this atom
 *     in DA-PI-1, so validate() finds it at boot.
 *   - `parcel`          (1, forwardRef — registers in DA-PI-2 / 4)
 *
 * supportedModes is **all five** per Spec 20 §10 anti-pattern.
 * `defaultMode: "compact"` per Spec 51a §2.12's "compact (in briefing
 * source list)" presentation guidance — a briefing source primarily
 * appears as a line item inside its parent briefing's source list.
 *
 * Event types per Spec 51a §2.12.
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
export const BRIEFING_SOURCE_PROSE_MAX_CHARS = 400;

/** All five Spec 20 §5 render modes — registration-level contract. */
export const BRIEFING_SOURCE_SUPPORTED_MODES = [
  "inline",
  "compact",
  "card",
  "expanded",
  "focus",
] as const;

export type BriefingSourceSupportedModes =
  typeof BRIEFING_SOURCE_SUPPORTED_MODES;

/**
 * Single source of truth for briefing-source-domain event types per
 * Spec 51a §2.12. Producers wire these in a future sprint.
 */
export const BRIEFING_SOURCE_EVENT_TYPES = [
  "briefing-source.fetched",
  "briefing-source.refreshed",
] as const;

export type BriefingSourceEventType =
  (typeof BRIEFING_SOURCE_EVENT_TYPES)[number];

/**
 * Typed payload returned by `briefing-source`'s `contextSummary.typed`.
 * Only `id` + `found` populated in DA-PI-1.
 */
export interface BriefingSourceTypedPayload {
  id: string;
  found: boolean;
}

export interface BriefingSourceAtomDeps {
  history?: EventAnchoringService;
}

/**
 * Build the briefing-source atom registration. Shape-only in DA-PI-1.
 */
export function makeBriefingSourceAtom(
  deps: BriefingSourceAtomDeps = {},
): AtomRegistration<"briefing-source", BriefingSourceSupportedModes> {
  const composition: ReadonlyArray<AtomComposition> = [
    {
      childEntityType: "parcel-briefing",
      childMode: "compact",
      dataKey: "briefing",
    },
    {
      childEntityType: "parcel",
      childMode: "compact",
      dataKey: "parcel",
      forwardRef: true,
    },
  ];

  const registration: AtomRegistration<
    "briefing-source",
    BriefingSourceSupportedModes
  > = {
    entityType: "briefing-source",
    domain: "plan-review",
    supportedModes: BRIEFING_SOURCE_SUPPORTED_MODES,
    defaultMode: "compact",
    composition,
    eventTypes: BRIEFING_SOURCE_EVENT_TYPES,
    async contextSummary(
      entityId: string,
      _scope,
    ): Promise<ContextSummary<"briefing-source">> {
      let latestEventId = "";
      let latestEventAt = new Date(0).toISOString();
      if (deps.history) {
        try {
          const latest = await deps.history.latestEvent({
            kind: "atom",
            entityType: "briefing-source",
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
        `Briefing source ${entityId} is registered as a catalog atom but the source fetch/refresh layer ` +
        `is not implemented yet (ships with the briefing engine in DA-PI-3). Composition edges to ` +
        `parcel-briefing and parcel and the event vocabulary are declared so producers and the inline-reference ` +
        `resolver can recognize this type.`;
      const prose =
        proseRaw.length > BRIEFING_SOURCE_PROSE_MAX_CHARS
          ? proseRaw.slice(0, BRIEFING_SOURCE_PROSE_MAX_CHARS - 1) + "…"
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
