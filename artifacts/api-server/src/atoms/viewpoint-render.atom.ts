/**
 * The `viewpoint-render` atom registration — V1-4 / DA-RP-1.
 *
 * Per Spec 54 v2 §3, a *viewpoint render* is the photorealistic still,
 * cardinal-elevation set, or 5/10-second video clip the architect
 * requested from mnml.ai for an engagement that has both a
 * `parcel-briefing` and a `bim-model`. Identity is the
 * `viewpoint_renders.id` PK assigned at row insert.
 *
 * V1-4 replaces DA-RP-0's shape-only registration with the DB-backed
 * implementation: `contextSummary` reads the row from
 * `viewpoint_renders`, hydrates the typed payload (kind, status,
 * outputs, freshness verdict, error fields), and runs
 * `resolveComposition` over the four upstream edges plus the many-
 * cardinality `outputs` edge to surface child render-outputs.
 *
 * Composition (Spec 54 v2 §6.2):
 *
 *   - `engagement`             (1, required)
 *   - `parcel-briefing`        (1, required, dataKey `briefingAtRender`)
 *   - `bim-model`              (1, required, dataKey `bimModelAtRender`)
 *   - `neighboring-context`    (0..1, dataKey `neighboringContextAtRender`)
 *   - `render-output`          (many, dataKey `outputs`)
 *
 * The four upstream edges are concrete (not `forwardRef`) — every
 * child type registers at boot. The `render-output` edge is
 * structurally a back-reference (render-output declares
 * viewpoint-render as ITS composition target) and is also concrete;
 * the framework treats both directions as "related atoms" without
 * caring which side is the persistence-FK parent.
 *
 * Snapshot semantics (Spec 54 v2 §6.2 / V1-4 recon §6 freshness
 * mechanic): `briefingId` and `bimModelId` capture WHICH upstream
 * row was the source-of-truth at trigger time. Alongside,
 * `briefingAtomEventId` and `bimModelAtomEventId` capture the
 * upstream's `latestEvent.id` snapshot. `contextSummary` re-fetches
 * each upstream's current `latestEvent` and surfaces a per-edge
 * verdict (`"current" | "stale" | "unknown"`) on the typed payload's
 * `freshness` field; downstream UI surfaces a "regenerate" badge
 * when either edge is stale.
 *
 * Status lifecycle (mirrors `RenderStatus` from
 * `@workspace/mnml-client`): `queued` → `rendering` → `ready` |
 * `failed` | `cancelled`. The `cancelled` branch is server-side only
 * (mnml has no public cancel — Spec 54 v2 §6.1).
 *
 * supportedModes is **all five** per Spec 20 §10 anti-pattern.
 * `defaultMode: "card"` per Spec 54 §3's "card — primary view: full
 * thumbnail + viewpoint metadata + download/share affordances".
 *
 * Event types per Spec 54 v2 §3 + the new
 * `viewpoint-render.unexpected-output-shape` event (V1-4 Phase 1A
 * decision): emitted when mnml's status response surfaces more than
 * one URL in `message[]` for a single archdiffusion or video call,
 * so the drift is visible to operators.
 */

import { eq, asc } from "drizzle-orm";
import {
  db,
  viewpointRenders,
  renderOutputs,
  type ViewpointRender as ViewpointRenderRow,
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

/** Hard cap on the prose summary so we don't blow up token budget. */
export const VIEWPOINT_RENDER_PROSE_MAX_CHARS = 600;

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
 * Single source of truth for viewpoint-render-domain event types.
 * Spec 54 v2 §3 + V1-4 Phase 1A's `unexpected-output-shape` audit
 * event for the multi-URL drift case.
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
  "viewpoint-render.unexpected-output-shape",
] as const;

export type ViewpointRenderEventType =
  (typeof VIEWPOINT_RENDER_EVENT_TYPES)[number];

/** Per-edge freshness verdict on the typed payload. */
export type FreshnessVerdict = "current" | "stale" | "unknown";

/**
 * Output-row projection on the typed payload. Subset of
 * `render_outputs` columns the FE / chat needs to render the gallery
 * row without a second round-trip; the full
 * {@link renderOutputs.$inferSelect} shape lives on the `render-output`
 * atom's typed payload.
 */
export interface ViewpointRenderOutputProjection {
  id: string;
  role: string;
  format: string;
  resolution: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  mirroredObjectKey: string | null;
  sourceUrl: string;
}

export interface ViewpointRenderTypedPayload {
  id: string;
  found: boolean;
  engagementId?: string;
  briefingId?: string | null;
  bimModelId?: string | null;
  briefingAtomEventId?: string | null;
  bimModelAtomEventId?: string | null;
  /** `still` | `elevation-set` | `video` (api-server domain). */
  kind?: string;
  /** `queued` | `rendering` | `ready` | `failed` | `cancelled`. */
  status?: string;
  /** mnml's render id for single-call kinds; null for `elevation-set`. */
  mnmlJobId?: string | null;
  outputs?: ViewpointRenderOutputProjection[];
  errorCode?: string | null;
  errorMessage?: string | null;
  errorDetails?: Record<string, unknown> | null;
  /** Per-upstream-edge freshness verdict; computed at read time. */
  freshness?: { briefing: FreshnessVerdict; bimModel: FreshnessVerdict };
  requestedBy?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
}

/**
 * Dependencies of {@link makeViewpointRenderAtom}. `db` is required
 * to read the row in `contextSummary`; passing it in (rather than
 * importing the singleton inside this module) keeps tests in control
 * of which schema the atom reads from. `registry` is needed to run
 * `resolveComposition` over the upstream edges and the many-output
 * back-edge; `history` is best-effort and stays optional.
 */
export interface ViewpointRenderAtomDeps {
  db?: typeof db;
  history?: EventAnchoringService;
  registry?: CompositionRegistryView;
}

/**
 * Build the viewpoint-render atom registration. Mirrors the
 * `parcel-briefing.atom.ts:178-298` resolveDb / lazy-DB pattern so
 * `vi.mock`'d test setups that throw on access to the un-set test
 * schema before any test body runs do not capture the singleton
 * `db` import at module load time.
 */
export function makeViewpointRenderAtom(
  deps: ViewpointRenderAtomDeps = {},
): AtomRegistration<"viewpoint-render", ViewpointRenderSupportedModes> {
  const resolveDb = () => deps.db ?? db;

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
    // Many-cardinality edge to the per-output rows. Bidirectional
    // with render-output's own composition (which declares the
    // viewpoint-render parent) — both sides surface in
    // `relatedAtoms` so the chat / FE walking either direction
    // finds the relations.
    {
      childEntityType: "render-output",
      childMode: "compact",
      dataKey: "outputs",
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
      _scope: Scope,
    ): Promise<ContextSummary<"viewpoint-render">> {
      // History first — best-effort, mirrors parcel-briefing's
      // pattern. Falls back to the epoch sentinel when the chain has
      // no event for this entity yet (which is the case for the
      // brief window between row insert and the first
      // `viewpoint-render.queued` emit).
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
          // History is best-effort; transient read failures must not
          // break the chat path. Fallback already populated above.
        }
      }

      // Row + child outputs lookup. A DB failure falls through to the
      // not-found envelope so the chat inline-reference resolver does
      // not crash a turn — same contract as parcel-briefing.atom.ts.
      let row: ViewpointRenderRow | undefined;
      let outputRows: RenderOutputRow[] = [];
      try {
        const found = await resolveDb()
          .select()
          .from(viewpointRenders)
          .where(eq(viewpointRenders.id, entityId))
          .limit(1);
        row = found[0];
        if (row) {
          outputRows = await resolveDb()
            .select()
            .from(renderOutputs)
            .where(eq(renderOutputs.viewpointRenderId, row.id))
            .orderBy(asc(renderOutputs.createdAt));
        }
      } catch {
        // Fall through to not-found envelope.
      }

      if (!row) {
        const proseRaw =
          `Viewpoint render ${entityId} could not be found. The render ` +
          `may have been archived, the renders sweep may have aged it out, ` +
          `or the id may be from a stale chat-history reference.`;
        const prose =
          proseRaw.length > VIEWPOINT_RENDER_PROSE_MAX_CHARS
            ? proseRaw.slice(0, VIEWPOINT_RENDER_PROSE_MAX_CHARS - 1) + "…"
            : proseRaw;
        return {
          prose,
          typed: {
            id: entityId,
            found: false,
          } satisfies ViewpointRenderTypedPayload as unknown as Record<
            string,
            unknown
          >,
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: { latestEventId, latestEventAt },
          scopeFiltered: false,
        };
      }

      // Freshness verdict — compare snapshot atom_event_id to the
      // upstream's CURRENT latestEvent.id. Spec 54 v2 §6.2 freshness
      // mechanic. The verdict is `"unknown"` whenever:
      //   - history service is unavailable
      //   - the upstream FK is null (e.g. briefing was deleted post-
      //     render, FK set null'd)
      //   - the snapshot column is null (e.g. legacy rows pre-V1-4)
      //   - history.latestEvent throws or returns null
      // The over-eager-staleness caveat (any event on the upstream
      // bumps latestEvent, including pure audit events like
      // `parcel-briefing.exported`) is documented as a known
      // limitation; a content-version-based check is V1-5 work.
      const freshness = await computeFreshness(row, deps.history);

      // resolveComposition — the framework synthesizes one
      // AtomReference per `{id}`-bearing entry in parentData. We
      // populate every declared edge:
      //   - upstream singletons via `{ id }` for the FK columns
      //   - `outputs` via the array of child rows
      //   - `neighboringContextAtRender` is left unpopulated (V1-4
      //     does not capture a neighboring-context FK on the row;
      //     a future sprint can add it)
      const parentRef: AtomReference = {
        kind: "atom",
        entityType: "viewpoint-render",
        entityId: row.id,
      };
      const relatedAtoms: AtomReference[] = [];
      if (deps.registry) {
        const parentData: Record<string, unknown> = {
          engagement: { id: row.engagementId },
          outputs: outputRows.map((o) => ({ id: o.id })),
        };
        if (row.briefingId) {
          parentData["briefingAtRender"] = { id: row.briefingId };
        }
        if (row.bimModelId) {
          parentData["bimModelAtRender"] = { id: row.bimModelId };
        }
        const resolved = resolveComposition(
          registration as unknown as AnyAtomRegistration,
          parentRef,
          parentData,
          deps.registry,
        );
        if (resolved.ok) {
          for (const child of resolved.children) {
            relatedAtoms.push(child.reference);
          }
        }
      }

      const keyMetrics: KeyMetric[] = [
        { label: "kind", value: row.kind },
        { label: "status", value: row.status },
        { label: "outputs", value: outputRows.length },
        { label: "freshness_briefing", value: freshness.briefing },
        { label: "freshness_bim_model", value: freshness.bimModel },
      ];
      if (row.completedAt) {
        keyMetrics.push({
          label: "completed_at",
          value: row.completedAt.toISOString(),
        });
      }
      if (row.errorCode) {
        keyMetrics.push({ label: "error_code", value: row.errorCode });
      }

      const errorFragment = row.errorCode
        ? ` Error: ${row.errorCode}${row.errorMessage ? ` — ${row.errorMessage}` : ""}.`
        : "";
      const proseRaw =
        `Viewpoint render of kind=${row.kind}, status=${row.status}. ` +
        `${outputRows.length} output${outputRows.length === 1 ? "" : "s"} mirrored.` +
        ` Freshness: briefing=${freshness.briefing}, bim-model=${freshness.bimModel}.` +
        errorFragment;
      const prose =
        proseRaw.length > VIEWPOINT_RENDER_PROSE_MAX_CHARS
          ? proseRaw.slice(0, VIEWPOINT_RENDER_PROSE_MAX_CHARS - 1) + "…"
          : proseRaw;

      const outputs: ViewpointRenderOutputProjection[] = outputRows.map((o) => ({
        id: o.id,
        role: o.role,
        format: o.format,
        resolution: o.resolution,
        sizeBytes: o.sizeBytes,
        durationSeconds: o.durationSeconds,
        mirroredObjectKey: o.mirroredObjectKey,
        sourceUrl: o.sourceUrl,
      }));

      const typed = {
        id: row.id,
        found: true,
        engagementId: row.engagementId,
        briefingId: row.briefingId,
        bimModelId: row.bimModelId,
        briefingAtomEventId: row.briefingAtomEventId,
        bimModelAtomEventId: row.bimModelAtomEventId,
        kind: row.kind,
        status: row.status,
        mnmlJobId: row.mnmlJobId,
        outputs,
        errorCode: row.errorCode,
        errorMessage: row.errorMessage,
        errorDetails: row.errorDetails as Record<string, unknown> | null,
        freshness,
        requestedBy: row.requestedBy,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      } satisfies ViewpointRenderTypedPayload;

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

/**
 * Compute the per-upstream-edge freshness verdict by comparing the
 * snapshot atom_event_id captured at trigger time to the upstream's
 * CURRENT latestEvent.id. Returns `"unknown"` whenever the inputs
 * are insufficient (no history service, no FK, no snapshot, or the
 * lookup throws/returns null).
 */
async function computeFreshness(
  row: ViewpointRenderRow,
  history?: EventAnchoringService,
): Promise<{ briefing: FreshnessVerdict; bimModel: FreshnessVerdict }> {
  if (!history) return { briefing: "unknown", bimModel: "unknown" };

  let briefing: FreshnessVerdict = "unknown";
  if (row.briefingId && row.briefingAtomEventId) {
    try {
      const latest = await history.latestEvent({
        kind: "atom",
        entityType: "parcel-briefing",
        entityId: row.briefingId,
      });
      if (latest) {
        briefing = latest.id === row.briefingAtomEventId ? "current" : "stale";
      }
    } catch {
      // Best-effort; leave as "unknown".
    }
  }

  let bimModel: FreshnessVerdict = "unknown";
  if (row.bimModelId && row.bimModelAtomEventId) {
    try {
      const latest = await history.latestEvent({
        kind: "atom",
        entityType: "bim-model",
        entityId: row.bimModelId,
      });
      if (latest) {
        bimModel = latest.id === row.bimModelAtomEventId ? "current" : "stale";
      }
    } catch {
      // Best-effort; leave as "unknown".
    }
  }

  return { briefing, bimModel };
}
