import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { bimModels } from "./bimModels";
import { materializableElements } from "./materializableElements";
import { parcelBriefings } from "./parcelBriefings";

/**
 * The reason buckets the C# Revit add-in is allowed to record when
 * the architect modifies a locked element. Mirrors Spec 51a §2.2:
 * `unpinned` (the architect literally unpinned the element to move
 * it), `geometry-edited` (a vertex was nudged inside the locked
 * mass), `deleted` (the element was removed from the model), and
 * `other` (catch-all for engine-side detections we have not
 * categorized).
 */
export const BRIEFING_DIVERGENCE_REASONS = [
  "unpinned",
  "geometry-edited",
  "deleted",
  "other",
] as const;

export type BriefingDivergenceReason =
  (typeof BRIEFING_DIVERGENCE_REASONS)[number];

/**
 * A *briefing-divergence* (DA-PI-5 / Spec 51a §2.2) is the audit-
 * trail row produced when an architect modifies a locked
 * materializable element in Revit. The C# add-in calls
 * `POST /api/bim-models/:id/divergence` whenever its element-watcher
 * detects an unpin / geometry edit / deletion against a locked
 * element; this table is what design-tools reads back when surfacing
 * "the architect overrode the briefing here" badges.
 *
 * Compositionally a divergence is owned by the bim-model, points at
 * the materializable-element it diverged from, and references the
 * briefing version it was diverging against. All three are required:
 * a divergence with no anchor would be untraceable, defeating the
 * audit-trail point.
 *
 * The row is append-only — there is no update path. A subsequent
 * "the architect re-pinned the element" signal lands as a separate
 * row (with the matching reason bucket) so the chain preserves the
 * full back-and-forth.
 */
export const briefingDivergences = pgTable(
  "briefing_divergences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    bimModelId: uuid("bim_model_id")
      .notNull()
      .references(() => bimModels.id, { onDelete: "cascade" }),
    materializableElementId: uuid("materializable_element_id")
      .notNull()
      .references(() => materializableElements.id, { onDelete: "cascade" }),
    /**
     * The briefing the divergence is being measured against. Captured
     * explicitly (rather than walked through bim-model) so the row
     * stays meaningful after a re-materialization swaps the bim-
     * model's `activeBriefingId`.
     */
    briefingId: uuid("briefing_id")
      .notNull()
      .references(() => parcelBriefings.id, { onDelete: "cascade" }),
    /**
     * One of {@link BRIEFING_DIVERGENCE_REASONS}. The route layer
     * validates against the closed tuple before insert.
     */
    reason: text("reason").notNull(),
    /**
     * Optional architect-supplied note explaining the divergence
     * (e.g. "moved property line to match surveyor's mark-up").
     */
    note: text("note"),
    /**
     * Free-form bag the C# side may attach to the divergence —
     * before/after geometry digests, the Revit element id that
     * fired the trigger, etc. Defaults to `{}` so a minimal divergence
     * (just the reason bucket) is valid.
     */
    detail: jsonb("detail").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /**
     * Operator acknowledgement (Task #191). Set the first time an
     * architect-audience caller marks the divergence resolved via
     * `POST /bim-models/:id/divergences/:divergenceId/resolve`.
     * Null while the row is still Open.
     *
     * Resolution is a *soft* acknowledgement on top of the append-
     * only record — the row is never removed, and a follow-up
     * recording for the same element lands as a fresh row of its
     * own. A re-resolve is a no-op (the route is idempotent and
     * leaves the original timestamp + requestor in place).
     */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /**
     * The session-bound requestor (`{kind, id}`) that recorded the
     * resolve. Stored as `text` (not an FK to `users.id`) for the
     * same reason `users.id` itself is `text` — the api-server
     * accepts arbitrary opaque ids from the upstream identity layer
     * and nothing here should retroactively break the audit trail
     * if the identity source is swapped or a profile row is removed.
     *
     * `kind` is one of {"user", "agent"} matching
     * `SessionUser.requestor.kind` in the api-server's session
     * middleware. Null when the resolve was performed without a
     * session-bound caller (in which case `resolvedAt` is still set
     * so the row still moves out of the Open list).
     */
    resolvedByRequestorKind: text("resolved_by_requestor_kind"),
    resolvedByRequestorId: text("resolved_by_requestor_id"),
  },
  (t) => ({
    bimModelIdx: index("briefing_divergences_bim_model_idx").on(t.bimModelId),
    elementIdx: index("briefing_divergences_element_idx").on(
      t.materializableElementId,
    ),
    briefingIdx: index("briefing_divergences_briefing_idx").on(t.briefingId),
  }),
);

export const briefingDivergencesRelations = relations(
  briefingDivergences,
  ({ one }) => ({
    bimModel: one(bimModels, {
      fields: [briefingDivergences.bimModelId],
      references: [bimModels.id],
    }),
    materializableElement: one(materializableElements, {
      fields: [briefingDivergences.materializableElementId],
      references: [materializableElements.id],
    }),
    briefing: one(parcelBriefings, {
      fields: [briefingDivergences.briefingId],
      references: [parcelBriefings.id],
    }),
  }),
);

export type BriefingDivergence = typeof briefingDivergences.$inferSelect;
export type NewBriefingDivergence = typeof briefingDivergences.$inferInsert;
