/**
 * The `render-output` atom registration — V1-4 / DA-RP-1.
 *
 * Per Spec 54 v2 §3, a *render output* is a single output file
 * produced by a `viewpoint-render`: the primary still for a `still`
 * parent, one of four cardinal images for an `elevation-set` parent,
 * the mp4 for a `video` parent, or the server-synthesized thumbnail
 * for the same. Identity is the `render_outputs.id` PK.
 *
 * V1-4 replaces DA-RP-0's shape-only registration with the DB-backed
 * implementation: `contextSummary` reads the row from
 * `render_outputs`, hydrates the typed payload (role, format,
 * resolution, sizeBytes, durationSeconds, sourceUrl,
 * mirroredObjectKey, …), and runs `resolveComposition` over the
 * single back-edge to the parent viewpoint-render.
 *
 * Composition (Spec 54 v2 §3): one parent edge, the
 * `viewpoint-render` row this output belongs to. Concrete (not
 * `forwardRef`); `viewpoint-render` registers in the same V1-4
 * sprint.
 *
 * Role discriminator (Spec 54 v2 §6.5 — note v2's `elevation-{n,e,s,w}`
 * naming, NOT v1's `elevation-{north,east,south,west}`):
 *
 *   - `primary`         — the single output of a `still` parent
 *   - `elevation-n/e/s/w` — the four outputs of an `elevation-set`
 *                          parent (route-tagged from
 *                          camera_direction)
 *   - `video-primary`   — the mp4 from a `video` parent
 *   - `video-thumbnail` — the ffmpeg-synthesized first-frame from
 *                          the same parent
 *
 * URL handling: `sourceUrl` is mnml's CDN address (ephemeral —
 * documented as expiring); `mirroredObjectKey` is our durable object-
 * storage key. The route's poll handler writes both in the same
 * transaction that marks the parent `ready`.
 *
 * supportedModes is **all five** per Spec 20 §10 anti-pattern.
 * `defaultMode: "compact"` per Spec 54 §3 — render-outputs primarily
 * appear as thumbnails in their parent viewpoint-render's gallery.
 */

import { eq } from "drizzle-orm";
import {
  db,
  renderOutputs,
  type RenderOutput as RenderOutputRow,
} from "@workspace/db";
import {
  resolveComposition,
  type AnyAtomRegistration,
  type AtomComposition,
  type AtomReference,
  type AtomRegistration,
  type CompositionRegistryView,
  type ContextSummary,
  type EventAnchoringService,
  type KeyMetric,
  type Scope,
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
 * Spec 54 v2 §3.
 */
export const RENDER_OUTPUT_EVENT_TYPES = [
  "render-output.persisted",
  "render-output.served",
  "render-output.regenerated",
] as const;

export type RenderOutputEventType =
  (typeof RENDER_OUTPUT_EVENT_TYPES)[number];

/**
 * Per Spec 54 v2 §6.5, `role` discriminates the slot a render-output
 * fills inside its parent viewpoint-render. The v2 naming uses the
 * compact `elevation-{n,e,s,w}` form (NOT the v1 `elevation-north`
 * form); the api-server's render_outputs.role column persists this
 * literal. Mirrors the {@link RenderOutputRole} type exported from
 * `@workspace/mnml-client` — kept here as a duplicate constant
 * primarily so the typed-payload doc surface stays self-describing
 * without a cross-package import in the .atom file's frontmatter.
 */
export type RenderOutputRole =
  | "primary"
  | "elevation-n"
  | "elevation-e"
  | "elevation-s"
  | "elevation-w"
  | "video-primary"
  | "video-thumbnail";

export interface RenderOutputTypedPayload {
  id: string;
  found: boolean;
  viewpointRenderId?: string;
  role?: RenderOutputRole;
  format?: string;
  resolution?: string | null;
  sizeBytes?: number | null;
  durationSeconds?: number | null;
  /** mnml's ephemeral URL — present for support / debugging only. */
  sourceUrl?: string;
  /** Our durable object-storage key. NULL during the brief unmirrored window. */
  mirroredObjectKey?: string | null;
  mnmlOutputId?: string | null;
  thumbnailUrl?: string | null;
  seed?: number | null;
  createdAt?: string;
}

/**
 * Dependencies of {@link makeRenderOutputAtom}. Same shape as
 * `ViewpointRenderAtomDeps` — `db` is required for the row lookup,
 * `registry` is needed to run `resolveComposition` over the parent
 * edge, `history` is best-effort optional.
 */
export interface RenderOutputAtomDeps {
  db?: typeof db;
  history?: EventAnchoringService;
  registry?: CompositionRegistryView;
}

/**
 * Build the render-output atom registration. Mirrors the
 * `parcel-briefing.atom.ts` resolveDb / lazy-DB pattern.
 */
export function makeRenderOutputAtom(
  deps: RenderOutputAtomDeps = {},
): AtomRegistration<"render-output", RenderOutputSupportedModes> {
  const resolveDb = () => deps.db ?? db;

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
      _scope: Scope,
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

      let row: RenderOutputRow | undefined;
      try {
        const found = await resolveDb()
          .select()
          .from(renderOutputs)
          .where(eq(renderOutputs.id, entityId))
          .limit(1);
        row = found[0];
      } catch {
        // Fall through to not-found envelope.
      }

      if (!row) {
        const proseRaw =
          `Render output ${entityId} could not be found. The output ` +
          `may have been deleted with its parent render, or the id may ` +
          `be from a stale reference.`;
        const prose =
          proseRaw.length > RENDER_OUTPUT_PROSE_MAX_CHARS
            ? proseRaw.slice(0, RENDER_OUTPUT_PROSE_MAX_CHARS - 1) + "…"
            : proseRaw;
        return {
          prose,
          typed: {
            id: entityId,
            found: false,
          } satisfies RenderOutputTypedPayload as unknown as Record<
            string,
            unknown
          >,
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: { latestEventId, latestEventAt },
          scopeFiltered: false,
        };
      }

      // resolveComposition — single parent edge to viewpoint-render.
      const parentRef: AtomReference = {
        kind: "atom",
        entityType: "render-output",
        entityId: row.id,
      };
      const relatedAtoms: AtomReference[] = [];
      if (deps.registry) {
        const resolved = resolveComposition(
          registration as unknown as AnyAtomRegistration,
          parentRef,
          { viewpointRender: { id: row.viewpointRenderId } },
          deps.registry,
        );
        if (resolved.ok) {
          for (const child of resolved.children) {
            relatedAtoms.push(child.reference);
          }
        }
      }

      const keyMetrics: KeyMetric[] = [
        { label: "role", value: row.role },
        { label: "format", value: row.format },
      ];
      if (row.resolution) {
        keyMetrics.push({ label: "resolution", value: row.resolution });
      }
      if (row.sizeBytes !== null) {
        keyMetrics.push({
          label: "size",
          value: row.sizeBytes,
          unit: "bytes",
        });
      }
      if (row.durationSeconds !== null) {
        keyMetrics.push({
          label: "duration",
          value: row.durationSeconds,
          unit: "seconds",
        });
      }
      keyMetrics.push({
        label: "mirrored",
        value: row.mirroredObjectKey ? "true" : "false",
      });

      const proseRaw =
        `Render output ${row.id} (role=${row.role}, format=${row.format}` +
        (row.resolution ? `, resolution=${row.resolution}` : "") +
        `).` +
        (row.mirroredObjectKey
          ? ` Mirrored to object storage at ${row.mirroredObjectKey}.`
          : ` Not yet mirrored — mnml URL is ephemeral.`);
      const prose =
        proseRaw.length > RENDER_OUTPUT_PROSE_MAX_CHARS
          ? proseRaw.slice(0, RENDER_OUTPUT_PROSE_MAX_CHARS - 1) + "…"
          : proseRaw;

      const typed = {
        id: row.id,
        found: true,
        viewpointRenderId: row.viewpointRenderId,
        role: row.role as RenderOutputRole,
        format: row.format,
        resolution: row.resolution,
        sizeBytes: row.sizeBytes,
        durationSeconds: row.durationSeconds,
        sourceUrl: row.sourceUrl,
        mirroredObjectKey: row.mirroredObjectKey,
        mnmlOutputId: row.mnmlOutputId,
        thumbnailUrl: row.thumbnailUrl,
        seed: row.seed,
        createdAt: row.createdAt.toISOString(),
      } satisfies RenderOutputTypedPayload;

      return {
        prose,
        typed: typed as unknown as Record<string, unknown>,
        keyMetrics,
        relatedAtoms,
        historyProvenance: { latestEventId, latestEventAt },
        scopeFiltered: false,
      };
    },
  };

  return registration;
}
