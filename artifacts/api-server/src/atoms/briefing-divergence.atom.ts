/**
 * The `briefing-divergence` atom registration — DA-PI-5 / Spec 51a §2.2.
 *
 * A *briefing divergence* is the audit-trail row produced when an
 * architect modifies a locked materializable element in Revit. The
 * C# add-in calls `POST /api/bim-models/:id/divergence` whenever its
 * element-watcher detects an unpin / geometry edit / deletion against
 * a locked element; design-tools surfaces these on the engagement
 * timeline ("the architect overrode the briefing here") and on the
 * affected materializable-element's expanded view.
 *
 * Identity is the row UUID. Append-only — there is no update path;
 * a subsequent "the architect re-pinned" signal lands as a separate
 * row of its own so the chain preserves the back-and-forth.
 *
 * Composition (Spec 51a §2.2):
 *   - `bim-model`              (1, dataKey: bimModel)
 *   - `materializable-element` (1, dataKey: element)
 *   - `parcel-briefing`        (1, dataKey: briefing)
 *
 * All three are concrete (their atoms register alongside this one
 * in DA-PI-5 or earlier).
 *
 * supportedModes: all five per Spec 20 §10. `defaultMode: "compact"`
 * — divergences appear as line items inside their parent
 * bim-model / element timelines.
 *
 * Event types per Spec 51a §2.2:
 *   - `briefing-divergence.recorded` — emitted on each insert.
 *
 * VDA wrapping (`wrapForStorage`) intentionally not invoked.
 */

import { eq } from "drizzle-orm";
import { briefingDivergences } from "@workspace/db";
import {
  type AtomComposition,
  type AtomRegistration,
  type ContextSummary,
  type EventAnchoringService,
  type KeyMetric,
} from "@workspace/empressa-atom";
import type { db as ProdDb } from "@workspace/db";

/** Hard cap on the prose summary. */
export const BRIEFING_DIVERGENCE_PROSE_MAX_CHARS = 400;

/** All five Spec 20 §5 render modes — registration-level contract. */
export const BRIEFING_DIVERGENCE_SUPPORTED_MODES = [
  "inline",
  "compact",
  "card",
  "expanded",
  "focus",
] as const;

export type BriefingDivergenceSupportedModes =
  typeof BRIEFING_DIVERGENCE_SUPPORTED_MODES;

/**
 * Single source of truth for briefing-divergence-domain event types
 * per Spec 51a §2.2. The divergence-record route in this sprint
 * imports this constant.
 */
export const BRIEFING_DIVERGENCE_EVENT_TYPES = [
  "briefing-divergence.recorded",
] as const;

export type BriefingDivergenceEventType =
  (typeof BRIEFING_DIVERGENCE_EVENT_TYPES)[number];

/**
 * Typed payload returned by `briefing-divergence`'s
 * `contextSummary.typed`.
 */
export interface BriefingDivergenceTypedPayload {
  id: string;
  found: boolean;
  bimModelId?: string;
  materializableElementId?: string;
  briefingId?: string;
  reason?: string;
  note?: string | null;
  createdAt?: string;
}

export interface BriefingDivergenceAtomDeps {
  db: typeof ProdDb;
  history?: EventAnchoringService;
}

/**
 * Build the briefing-divergence atom registration.
 */
export function makeBriefingDivergenceAtom(
  deps: BriefingDivergenceAtomDeps,
): AtomRegistration<
  "briefing-divergence",
  BriefingDivergenceSupportedModes
> {
  const composition: ReadonlyArray<AtomComposition> = [
    {
      childEntityType: "bim-model",
      childMode: "compact",
      dataKey: "bimModel",
    },
    {
      childEntityType: "materializable-element",
      childMode: "compact",
      dataKey: "element",
    },
    {
      childEntityType: "parcel-briefing",
      childMode: "compact",
      dataKey: "briefing",
    },
  ];

  const registration: AtomRegistration<
    "briefing-divergence",
    BriefingDivergenceSupportedModes
  > = {
    entityType: "briefing-divergence",
    domain: "plan-review",
    supportedModes: BRIEFING_DIVERGENCE_SUPPORTED_MODES,
    defaultMode: "compact",
    composition,
    eventTypes: BRIEFING_DIVERGENCE_EVENT_TYPES,
    async contextSummary(
      entityId: string,
      _scope,
    ): Promise<ContextSummary<"briefing-divergence">> {
      const rows = await deps.db
        .select()
        .from(briefingDivergences)
        .where(eq(briefingDivergences.id, entityId))
        .limit(1);
      const row = rows[0];

      let latestEventId = "";
      let latestEventAt = new Date(0).toISOString();
      if (deps.history) {
        try {
          const latest = await deps.history.latestEvent({
            kind: "atom",
            entityType: "briefing-divergence",
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

      if (!row) {
        return {
          prose: `Briefing divergence ${entityId} could not be found.`,
          typed: {
            id: entityId,
            found: false,
          } satisfies BriefingDivergenceTypedPayload as unknown as Record<
            string,
            unknown
          >,
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: { latestEventId, latestEventAt },
          scopeFiltered: false,
        };
      }

      const noteFragment = row.note ? ` Note: "${row.note}".` : "";
      const proseRaw =
        `Architect divergence (${row.reason}) recorded against element ${row.materializableElementId} ` +
        `for briefing ${row.briefingId}.${noteFragment}`;
      const prose =
        proseRaw.length > BRIEFING_DIVERGENCE_PROSE_MAX_CHARS
          ? proseRaw.slice(0, BRIEFING_DIVERGENCE_PROSE_MAX_CHARS - 1) + "…"
          : proseRaw;

      const keyMetrics: KeyMetric[] = [
        { label: "Reason", value: row.reason },
        { label: "Recorded at", value: row.createdAt.toISOString() },
      ];

      const typed = {
        id: row.id,
        found: true,
        bimModelId: row.bimModelId,
        materializableElementId: row.materializableElementId,
        briefingId: row.briefingId,
        reason: row.reason,
        note: row.note,
        createdAt: row.createdAt.toISOString(),
      } satisfies BriefingDivergenceTypedPayload;

      if (!latestEventId) {
        latestEventAt = row.createdAt.toISOString();
      }

      return {
        prose,
        typed: typed as unknown as Record<string, unknown>,
        keyMetrics,
        relatedAtoms: [],
        historyProvenance: { latestEventId, latestEventAt },
        scopeFiltered: false,
      };
    },
  };

  return registration;
}
