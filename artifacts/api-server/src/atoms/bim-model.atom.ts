/**
 * The `bim-model` atom registration — DA-PI-5 / Spec 51a §2.1, Spec 53 §3.
 *
 * A *bim-model* is the design-tools-side record of the architect's
 * active Revit model: which engagement it is bound to, which parcel
 * briefing was last materialized into it, when, and at what briefing
 * version. It is the design-tools-side counterpart to the connector
 * binding rows the C# Revit add-in maintains in its own storage.
 *
 * Identity is the engagement id (one bim-model per engagement; see
 * the `engagement_id` unique constraint on the `bim_models` table).
 * The C# add-in calls `POST /api/engagements/:id/bim-model`
 * idempotently — a re-push updates `activeBriefingId` /
 * `materializedAt` / `briefingVersion` rather than inserting a new
 * row. The atom's `entityId` is the bim-model row's UUID; the
 * `engagementId` lives in the typed payload so the FE card can
 * cross-link without an additional fetch.
 *
 * Composition (Spec 51a §2.1):
 *   - `engagement`        (1)            — the parent engagement
 *   - `parcel-briefing`   (0..1, dataKey: activeBriefing) — the
 *      currently materialized briefing; null pre-first-push
 *   - `materializable-element` (many)    — every element the C# side
 *      should materialize; resolved through `parcel-briefing` →
 *      `materializable-element` rows in DA-PI-3+, declared as a
 *      forward-ref edge here so validate() does not require
 *      element-list materialization on the bim-model contextSummary
 *      surface
 *   - `briefing-divergence` (many, forwardRef) — divergences ride
 *      on `briefing-divergence` itself which is registered alongside
 *      this atom; the edge is declared so the FE card can list
 *      divergences as related atoms
 *   - `connector-binding` (many, forwardRef) — the C# Revit add-in
 *      maintains its own connector-binding rows pointing back at
 *      this bim-model. The atom is owned by the connector / Revit
 *      service and not registered in api-server today, so the edge
 *      is declared as `forwardRef: true` (locked decision #2 of
 *      DA-PI-5: keep the bim-model contract aware of the connector
 *      side without coupling boot validation to its registration).
 *
 * supportedModes: all five per Spec 20 §10. `defaultMode: "card"` —
 * the bim-model card is the primary surface in the Site Context
 * tab's "Push to Revit" affordance.
 *
 * Event types per Spec 51a §2.1:
 *   - `bim-model.materialized`  — emitted when a push succeeds
 *   - `bim-model.refreshed`     — emitted when refresh diff is
 *      computed (Spec 53 §3 calls this out separately so a refresh
 *      that returns "current" still leaves an audit-trail row).
 *   - `bim-model.diverged`      — fan-in event mirroring divergence
 *      writes; a parallel `briefing-divergence.recorded` is emitted
 *      against the divergence row itself so both the bim-model
 *      timeline and the per-element timeline pick it up.
 *
 * VDA wrapping (`wrapForStorage`) intentionally not invoked — matches
 * snapshot/engagement convention.
 */

import { eq, desc } from "drizzle-orm";
import {
  bimModels,
  briefingDivergences,
  parcelBriefings,
} from "@workspace/db";
import {
  type AtomComposition,
  type AtomRegistration,
  type ContextSummary,
  type EventAnchoringService,
  type KeyMetric,
} from "@workspace/empressa-atom";
import type { db as ProdDb } from "@workspace/db";

/** Hard cap on the prose summary. */
export const BIM_MODEL_PROSE_MAX_CHARS = 600;

/** All five Spec 20 §5 render modes — registration-level contract. */
export const BIM_MODEL_SUPPORTED_MODES = [
  "inline",
  "compact",
  "card",
  "expanded",
  "focus",
] as const;

export type BimModelSupportedModes = typeof BIM_MODEL_SUPPORTED_MODES;

/**
 * Single source of truth for bim-model-domain event types per Spec
 * 51a §2.1. Producers (the materialize / refresh / divergence routes
 * in this sprint) import this constant so a rename here flows
 * through the catalog and every emit site at once.
 */
export const BIM_MODEL_EVENT_TYPES = [
  "bim-model.materialized",
  "bim-model.refreshed",
  "bim-model.diverged",
] as const;

export type BimModelEventType = (typeof BIM_MODEL_EVENT_TYPES)[number];

/**
 * The three states the Site Context "Push to Revit" affordance can
 * surface, mirroring Spec 53 §3's refresh-diff contract:
 *   - `current`         — bim-model is materialized and the briefing
 *     has not been regenerated since the push.
 *   - `stale`           — briefing has been regenerated (or its
 *     `updatedAt` is newer than the bim-model's `materializedAt`)
 *     since the last push, so the architect's model is out of date.
 *   - `not-pushed`      — no bim-model row exists for this engagement,
 *     or `materializedAt` is null.
 */
export const BIM_MODEL_REFRESH_STATUSES = [
  "current",
  "stale",
  "not-pushed",
] as const;

export type BimModelRefreshStatus = (typeof BIM_MODEL_REFRESH_STATUSES)[number];

/**
 * Typed payload returned by `bim-model`'s `contextSummary.typed`.
 */
export interface BimModelTypedPayload {
  id: string;
  found: boolean;
  engagementId?: string;
  activeBriefingId?: string | null;
  briefingVersion?: number;
  materializedAt?: string | null;
  refreshStatus?: BimModelRefreshStatus;
  divergenceCount?: number;
  revitDocumentPath?: string | null;
}

export interface BimModelAtomDeps {
  db: typeof ProdDb;
  history?: EventAnchoringService;
}

/**
 * Build the bim-model atom registration. DA-PI-5 wires the data
 * lookup against the `bim_models` table; the four routes added in
 * this sprint emit the event vocabulary declared above.
 */
export function makeBimModelAtom(
  deps: BimModelAtomDeps,
): AtomRegistration<"bim-model", BimModelSupportedModes> {
  // Composition edges per Spec 51a §2.1.
  //   - `engagement`: registered alongside this atom; concrete edge.
  //   - `parcel-briefing` (dataKey "activeBriefing"): the currently
  //     materialized briefing. Concrete because parcel-briefing is
  //     already registered (DA-PI-1).
  //   - `materializable-element` (forwardRef-style): the bim-model
  //     does NOT enumerate elements directly — they hang off the
  //     active briefing. The edge is declared as `forwardRef: true`
  //     so the framework's `validate()` does not require this atom's
  //     `contextSummary` to populate `parentData["elements"]`.
  //   - `briefing-divergence`: registered alongside this atom in
  //     DA-PI-5; concrete edge. The contextSummary below populates
  //     `parentData["divergences"]` with the divergence rows so the
  //     framework can synthesize child references through
  //     `resolveComposition`-style consumers in a later sprint.
  const composition: ReadonlyArray<AtomComposition> = [
    {
      childEntityType: "engagement",
      childMode: "compact",
      dataKey: "engagement",
    },
    {
      childEntityType: "parcel-briefing",
      childMode: "card",
      dataKey: "activeBriefing",
    },
    {
      childEntityType: "materializable-element",
      childMode: "compact",
      dataKey: "elements",
      forwardRef: true,
    },
    {
      childEntityType: "briefing-divergence",
      childMode: "compact",
      dataKey: "divergences",
    },
    // Locked decision #2: the C# Revit add-in's connector-binding
    // rows are part of the bim-model's logical fan-out, but the
    // `connector-binding` atom lives in the connector service (not
    // api-server) so we declare a forwardRef edge — boot validate()
    // skips it if the atom is not yet registered, but FE consumers
    // that DO have the connector atom registered can still resolve
    // through this edge.
    {
      childEntityType: "connector-binding",
      childMode: "compact",
      dataKey: "connectorBindings",
      forwardRef: true,
    },
  ];

  const registration: AtomRegistration<"bim-model", BimModelSupportedModes> = {
    entityType: "bim-model",
    domain: "plan-review",
    supportedModes: BIM_MODEL_SUPPORTED_MODES,
    defaultMode: "card",
    composition,
    eventTypes: BIM_MODEL_EVENT_TYPES,
    async contextSummary(
      entityId: string,
      _scope,
    ): Promise<ContextSummary<"bim-model">> {
      const rows = await deps.db
        .select()
        .from(bimModels)
        .where(eq(bimModels.id, entityId))
        .limit(1);
      const row = rows[0];

      // Best-effort history lookup is shared by both the not-found
      // and found branches so the timeline still surfaces a stale id
      // that has been seen by the event chain.
      let latestEventId = "";
      let latestEventAt = new Date(0).toISOString();
      if (deps.history) {
        try {
          const latest = await deps.history.latestEvent({
            kind: "atom",
            entityType: "bim-model",
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
          prose: `Bim-model ${entityId} could not be found. The architect may not have pushed any briefing to Revit for this engagement yet.`,
          typed: {
            id: entityId,
            found: false,
          } satisfies BimModelTypedPayload as unknown as Record<
            string,
            unknown
          >,
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: { latestEventId, latestEventAt },
          scopeFiltered: false,
        };
      }

      // Refresh-status diff. When no briefing is bound, status is
      // not-pushed regardless of materializedAt. When a briefing IS
      // bound but never materialized (materializedAt is null) we also
      // surface not-pushed — the row exists, but no push has landed.
      let refreshStatus: BimModelRefreshStatus = "not-pushed";
      let activeBriefingUpdatedAt: Date | null = null;
      if (row.activeBriefingId && row.materializedAt) {
        const briefingRows = await deps.db
          .select({ updatedAt: parcelBriefings.updatedAt })
          .from(parcelBriefings)
          .where(eq(parcelBriefings.id, row.activeBriefingId))
          .limit(1);
        const briefingRow = briefingRows[0];
        if (briefingRow) {
          activeBriefingUpdatedAt = briefingRow.updatedAt;
          refreshStatus =
            briefingRow.updatedAt > row.materializedAt ? "stale" : "current";
        } else {
          // Briefing was deleted out from under the bim-model. Treat
          // as not-pushed so the FE prompts a re-push against
          // whatever briefing is current now.
          refreshStatus = "not-pushed";
        }
      }

      const divergenceRows = await deps.db
        .select({ id: briefingDivergences.id })
        .from(briefingDivergences)
        .where(eq(briefingDivergences.bimModelId, row.id))
        .orderBy(desc(briefingDivergences.createdAt));

      const proseParts: string[] = [
        `Bim-model for engagement ${row.engagementId}.`,
      ];
      if (refreshStatus === "current" && row.materializedAt) {
        proseParts.push(
          `Materialized at ${row.materializedAt.toISOString()} against briefing v${row.briefingVersion}.`,
        );
      } else if (refreshStatus === "stale" && row.materializedAt) {
        proseParts.push(
          `Briefing has changed since last materialization at ${row.materializedAt.toISOString()} — re-push needed.`,
        );
      } else {
        proseParts.push("Not yet pushed to Revit.");
      }
      if (divergenceRows.length > 0) {
        proseParts.push(
          `${divergenceRows.length} architect divergence${divergenceRows.length === 1 ? "" : "s"} recorded.`,
        );
      }
      const proseRaw = proseParts.join(" ");
      const prose =
        proseRaw.length > BIM_MODEL_PROSE_MAX_CHARS
          ? proseRaw.slice(0, BIM_MODEL_PROSE_MAX_CHARS - 1) + "…"
          : proseRaw;

      const keyMetrics: KeyMetric[] = [
        { label: "Refresh status", value: refreshStatus },
        { label: "Briefing version", value: row.briefingVersion },
        { label: "Divergences", value: divergenceRows.length },
      ];
      if (row.materializedAt) {
        keyMetrics.push({
          label: "Materialized at",
          value: row.materializedAt.toISOString(),
        });
      }

      const typed = {
        id: row.id,
        found: true,
        engagementId: row.engagementId,
        activeBriefingId: row.activeBriefingId,
        briefingVersion: row.briefingVersion,
        materializedAt: row.materializedAt
          ? row.materializedAt.toISOString()
          : null,
        refreshStatus,
        divergenceCount: divergenceRows.length,
        revitDocumentPath: row.revitDocumentPath,
      } satisfies BimModelTypedPayload;

      // Fall back to the row's updatedAt (or the active briefing's
      // updatedAt, whichever is newer) when no atom event has landed
      // for this bim-model yet.
      if (!latestEventId) {
        const fallback =
          activeBriefingUpdatedAt && activeBriefingUpdatedAt > row.updatedAt
            ? activeBriefingUpdatedAt
            : row.updatedAt;
        latestEventAt = fallback.toISOString();
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
