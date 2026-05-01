/**
 * The `render-output` atom registration — DA-RP-0 sprint, shape-only.
 *
 * Per Spec 54 §3, a *render output* is a single output file produced by
 * a viewpoint-render — decoupled from `viewpoint-render` so an
 * elevation set's four images can each be addressed individually, and
 * so video frames or alternate resolutions can be added later without
 * changing the parent atom. Identity is render-scoped + monotonic:
 *
 *   render-output:{viewpointRenderId}:{ulid}
 *
 * Sprint scope (DA-RP-0) is registration-only. The render_outputs
 * persistence layer, the streaming download endpoint, and the gallery
 * UI all land in DA-RP-1+. Until then `contextSummary` returns the
 * not-found envelope, mirroring `briefing-source.atom.ts`'s pre-DA-PI-1B
 * placeholder pattern.
 *
 * Composition (Spec 54 §3):
 *
 *   - `viewpoint-render` (1, required)
 *
 * Concrete (not `forwardRef`) — `viewpoint-render` registers alongside
 * this atom in the same DA-RP-0 sprint so the boot validator finds it.
 *
 * Role discriminator: each render-output carries a `role` per Spec 54 §3
 * — `"primary"` for stills, `"elevation-{north|east|south|west}"` for
 * an elevation set's four images, and `"video-primary"` /
 * `"video-thumbnail"` for video renders. The discriminator surfaces in
 * Layer 2 typed payload `subtype` once the persistence layer ships in
 * DA-RP-1; in DA-RP-0 it's documented on the typed-payload interface
 * but not exercised in the not-found envelope.
 *
 * supportedModes is **all five** per Spec 20 §10 anti-pattern (Spec 54
 * §3 lists "compact, card, expanded" as the modes the spec author
 * considered primary; that is a renderer concern, not an atom-contract
 * concern). `defaultMode: "compact"` per Spec 54 §3's
 * "compact (thumbnail in galleries)" presentation guidance — a
 * render-output primarily appears as a thumbnail in its parent
 * viewpoint-render's gallery / output list.
 *
 * Event types per Spec 54 §3.
 *
 * VDA wrapping (`wrapForStorage`) intentionally not invoked — matches
 * the snapshot/engagement convention.
 */

import {
  type AtomComposition,
  type AtomRegistration,
  type ContextSummary,
  type EventAnchoringService,
} from "@workspace/empressa-atom";

/** Hard cap on the prose summary. */
export const RENDER_OUTPUT_PROSE_MAX_CHARS = 400;

/** All five Spec 20 §5 render modes — registration-level contract. */
export const RENDER_OUTPUT_SUPPORTED_MODES = [
  "inline",
  "compact",
  "card",
  "expanded",
  "focus",
] as const;

export type RenderOutputSupportedModes =
  typeof RENDER_OUTPUT_SUPPORTED_MODES;

/**
 * Single source of truth for render-output-domain event types per
 * Spec 54 §3. Producers (the persisted-output writer, the streaming
 * download endpoint's audit-log emit, the regeneration flow) wire
 * these in DA-RP-1+.
 */
export const RENDER_OUTPUT_EVENT_TYPES = [
  "render-output.persisted",
  "render-output.served",
  "render-output.regenerated",
] as const;

export type RenderOutputEventType =
  (typeof RENDER_OUTPUT_EVENT_TYPES)[number];

/**
 * Per Spec 54 §3, `role` discriminates the slot a render-output fills
 * inside its parent viewpoint-render. Documented here so DA-RP-1's
 * persistence layer has the canonical vocabulary inline; the not-found
 * envelope DA-RP-0 ships does not exercise the field.
 */
export type RenderOutputRole =
  | "primary"
  | "elevation-north"
  | "elevation-east"
  | "elevation-south"
  | "elevation-west"
  | "video-primary"
  | "video-thumbnail";

/**
 * Typed payload returned by `render-output`'s `contextSummary.typed`.
 * Only `id` + `found` populated in DA-RP-0; the full Layer 3 surface
 * (role, format, resolution, durationSeconds, sizeBytes, downloadUrl,
 * thumbnailUrl, mnmlOutputId) lands with the render_outputs table in
 * DA-RP-1.
 */
export interface RenderOutputTypedPayload {
  id: string;
  found: boolean;
  role?: RenderOutputRole;
}

export interface RenderOutputAtomDeps {
  history?: EventAnchoringService;
}

/**
 * Build the render-output atom registration. Shape-only in DA-RP-0.
 */
export function makeRenderOutputAtom(
  deps: RenderOutputAtomDeps = {},
): AtomRegistration<"render-output", RenderOutputSupportedModes> {
  const composition: ReadonlyArray<AtomComposition> = [
    {
      childEntityType: "viewpoint-render",
      childMode: "compact",
      dataKey: "viewpointRender",
    },
  ];

  const registration: AtomRegistration<
    "render-output",
    RenderOutputSupportedModes
  > = {
    entityType: "render-output",
    domain: "plan-review",
    supportedModes: RENDER_OUTPUT_SUPPORTED_MODES,
    defaultMode: "compact",
    composition,
    eventTypes: RENDER_OUTPUT_EVENT_TYPES,
    async contextSummary(
      entityId: string,
      _scope,
    ): Promise<ContextSummary<"render-output">> {
      let latestEventId = "";
      let latestEventAt = new Date(0).toISOString();
      if (deps.history) {
        try {
          const latest = await deps.history.latestEvent({
            kind: "atom",
            entityType: "render-output",
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
        `Render output ${entityId} is registered as a catalog atom but the render-outputs ` +
        `persistence layer is not wired yet (ships with the mnml.ai pipeline in DA-RP-1). ` +
        `The composition edge to viewpoint-render and the Spec 54 §3 event vocabulary are ` +
        `declared so producers and the inline-reference resolver can recognize this type.`;
      const prose =
        proseRaw.length > RENDER_OUTPUT_PROSE_MAX_CHARS
          ? proseRaw.slice(0, RENDER_OUTPUT_PROSE_MAX_CHARS - 1) + "…"
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
