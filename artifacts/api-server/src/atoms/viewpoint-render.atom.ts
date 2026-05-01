/**
 * The `viewpoint-render` atom registration — DA-RP-0 sprint, shape-only.
 *
 * Per Spec 54 §3, a *viewpoint render* is the photorealistic still,
 * cardinal-elevation set, or walkthrough video the architect requested
 * from mnml.ai for an engagement that already has a `parcel-briefing`
 * and a `bim-model`. Identity is engagement-scoped + monotonic:
 *
 *   viewpoint-render:{engagementId}:{ulid}
 *
 * Sprint scope (DA-RP-0) is registration-only. The renders / render-
 * outputs persistence layer, the trigger / polling endpoints, the
 * mnml.ai client invocation, and any UI surface in design-tools all
 * land in DA-RP-1 / DA-RP-2 / DA-RP-INFRA. Until then `contextSummary`
 * returns the not-found envelope, mirroring `briefing-source.atom.ts`'s
 * pre-DA-PI-1B placeholder pattern.
 *
 * Composition (Spec 54 §3 — "the renders compose the same atom graph
 * as everything else in the Design Accelerator"):
 *
 *   - `engagement`           (1, required)
 *   - `parcel-briefing`      (1, required, dataKey `briefingAtRender`)
 *   - `bim-model`            (1, required, dataKey `bimModelAtRender`)
 *   - `neighboring-context`  (0..1, dataKey `neighboringContextAtRender`)
 *
 * Snapshot semantics (Spec 54 §6): `briefingAtRender` and
 * `bimModelAtRender` capture the upstream atom-event-id at render time
 * so a later regeneration of the briefing or bim-model does not
 * silently rewrite history on the render. The `neighboringContextAtRender`
 * edge is optional — interior-only renders skip it.
 *
 * All four edges are concrete (not `forwardRef`) because every child
 * atom is registered at boot before the renders pipeline ships:
 * `engagement`, `parcel-briefing`, `bim-model`, and `neighboring-context`
 * all came online in earlier sprints (Spec 20 / DA-PI-1 / DA-PI-5).
 *
 * supportedModes is **all five** per Spec 20 §10 anti-pattern.
 * `defaultMode: "card"` per the catalog's "card-as-primary" convention
 * for surface atoms (a render is the architect's demonstration surface,
 * Spec 54 §1) and Spec 54 §3's "card — primary view: full thumbnail +
 * viewpoint metadata + download/share affordances".
 *
 * Event types per Spec 54 §3.
 *
 * VDA wrapping (`wrapForStorage`) intentionally not invoked — matches
 * the snapshot/engagement convention every atom registration in this
 * module follows.
 */

import {
  type AtomComposition,
  type AtomRegistration,
  type ContextSummary,
  type EventAnchoringService,
} from "@workspace/empressa-atom";

/** Hard cap on the prose summary. */
export const VIEWPOINT_RENDER_PROSE_MAX_CHARS = 400;

/** All five Spec 20 §5 render modes — registration-level contract. */
export const VIEWPOINT_RENDER_SUPPORTED_MODES = [
  "inline",
  "compact",
  "card",
  "expanded",
  "focus",
] as const;

export type ViewpointRenderSupportedModes =
  typeof VIEWPOINT_RENDER_SUPPORTED_MODES;

/**
 * Single source of truth for viewpoint-render-domain event types per
 * Spec 54 §3. Producers (the trigger endpoint, the mnml.ai polling
 * loop, the share/archive flows) wire these in DA-RP-1+.
 */
export const VIEWPOINT_RENDER_EVENT_TYPES = [
  "viewpoint-render.requested",
  "viewpoint-render.queued",
  "viewpoint-render.rendering",
  "viewpoint-render.ready",
  "viewpoint-render.failed",
  "viewpoint-render.regeneration-requested",
  "viewpoint-render.shared",
  "viewpoint-render.archived",
] as const;

export type ViewpointRenderEventType =
  (typeof VIEWPOINT_RENDER_EVENT_TYPES)[number];

/**
 * Typed payload returned by `viewpoint-render`'s `contextSummary.typed`.
 * Only `id` + `found` populated in DA-RP-0; the full Layer 3 surface
 * (kind, status, viewpoint, outputUrls, mnmlJobId, freshness, …) lands
 * with the renders table in DA-RP-1.
 */
export interface ViewpointRenderTypedPayload {
  id: string;
  found: boolean;
}

export interface ViewpointRenderAtomDeps {
  history?: EventAnchoringService;
}

/**
 * Build the viewpoint-render atom registration. Shape-only in DA-RP-0.
 */
export function makeViewpointRenderAtom(
  deps: ViewpointRenderAtomDeps = {},
): AtomRegistration<"viewpoint-render", ViewpointRenderSupportedModes> {
  const composition: ReadonlyArray<AtomComposition> = [
    {
      childEntityType: "engagement",
      childMode: "compact",
      dataKey: "engagement",
    },
    {
      childEntityType: "parcel-briefing",
      childMode: "compact",
      dataKey: "briefingAtRender",
    },
    {
      childEntityType: "bim-model",
      childMode: "compact",
      dataKey: "bimModelAtRender",
    },
    {
      childEntityType: "neighboring-context",
      childMode: "compact",
      dataKey: "neighboringContextAtRender",
    },
  ];

  const registration: AtomRegistration<
    "viewpoint-render",
    ViewpointRenderSupportedModes
  > = {
    entityType: "viewpoint-render",
    domain: "plan-review",
    supportedModes: VIEWPOINT_RENDER_SUPPORTED_MODES,
    defaultMode: "card",
    composition,
    eventTypes: VIEWPOINT_RENDER_EVENT_TYPES,
    async contextSummary(
      entityId: string,
      _scope,
    ): Promise<ContextSummary<"viewpoint-render">> {
      let latestEventId = "";
      let latestEventAt = new Date(0).toISOString();
      if (deps.history) {
        try {
          const latest = await deps.history.latestEvent({
            kind: "atom",
            entityType: "viewpoint-render",
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
        `Viewpoint render ${entityId} is registered as a catalog atom but the renders ` +
        `persistence layer is not wired yet (ships with the mnml.ai pipeline in DA-RP-1). ` +
        `Composition edges to engagement, parcel-briefing, bim-model, and neighboring-context, ` +
        `plus the Spec 54 §3 event vocabulary, are declared so producers and the inline-reference ` +
        `resolver can recognize this type.`;
      const prose =
        proseRaw.length > VIEWPOINT_RENDER_PROSE_MAX_CHARS
          ? proseRaw.slice(0, VIEWPOINT_RENDER_PROSE_MAX_CHARS - 1) + "…"
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
