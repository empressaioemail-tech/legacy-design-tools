import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { submissions } from "./submissions";
import { findingRuns } from "./findingRuns";

/**
 * AIR-1 finding — one compliance issue produced by the AI plan reviewer
 * (or, post-override, by a human reviewer) against a single plan-review
 * submission. Mirrors the wire shape locked in
 * `artifacts/plan-review/src/lib/findingsMock.ts:82-103` so the V1-6
 * frontend swap collapses to a single re-export change.
 *
 * Identity:
 *   - `id` is the row primary key (uuid). Internal-only — every join
 *     and FK in the api-server uses this.
 *   - `atom_id` is the public, prefixed string `finding:{submissionId}:{rowUuid}`.
 *     It is the entityId the empressa-atom registry hands to
 *     `finding.atom.ts`'s `contextSummary`, and the `id` field on the
 *     wire envelope. Carrying the prefix in a separate column (rather
 *     than overloading the row pk) lets every other table FK to the
 *     uuid pk while preserving the FE deep-link grammar
 *     (`?finding=finding:abc:01H…` per
 *     `artifacts/plan-review/src/lib/findingUrl.ts:43-47`).
 *
 * Override semantics (recon §3, findingsMock.ts:424-461):
 *   An override does NOT mutate the original AI-produced row. The
 *   route's transactional handler:
 *     1. Stamps the original row's status to `"overridden"` (preserved
 *        in place so the drill-in's "See AI's original" affordance
 *        keeps reading it).
 *     2. Inserts a NEW row with the reviewer's text/severity/category,
 *        status `"overridden"`, and `revision_of` pointing at the
 *        original. The new row gets its own `atom_id`.
 *     3. Both writes commit in one transaction so an audit reader
 *        always sees a coherent pair.
 *
 * Citations:
 *   `citations` is a jsonb array carrying the `FindingCitation[]`
 *   discriminated union from `findingsMock.ts:65-74`:
 *     {kind: "code-section", atomId}
 *     {kind: "briefing-source", id, label}
 *   The engine validates citation tokens inside `text` against this
 *   list at generation time; the validator is shared with
 *   briefing-engine via re-export (decision Ask #1 — reuse). The
 *   placeholder `findings_code_atoms` join table (deleted in this same
 *   migration) is superseded by this column — there is no FK from
 *   citation atomIds to `code_atoms`. Validating that referenced atoms
 *   exist happens at engine time; treating citations as immutable
 *   metadata on the finding row keeps the wire shape mirror-flat with
 *   the FE mock.
 *
 * Reviewer status:
 *   `status` carries the closed enum `"ai-produced" | "accepted" |
 *   "rejected" | "overridden" | "promoted-to-architect"`. The
 *   `reviewer_status_*` columns describe the most recent reviewer
 *   action (FindingActor jsonb mirroring findingsMock.ts:76-80,
 *   timestamp, optional comment). Null while status is `"ai-produced"`.
 *
 * Element / source pointers:
 *   `element_ref` is an opaque string pointing at a bim-model element
 *   (e.g. `"wall:north-side-l2"`) so the drill-in's "Show in 3D viewer"
 *   affordance can highlight the offending geometry. `source_ref` is
 *   a small jsonb pointer at the backing briefing source (`{id, label}`).
 *   Both nullable — many findings cite via `citations` alone and
 *   don't anchor on a specific element.
 */

export const FINDING_SEVERITY_VALUES = [
  "blocker",
  "concern",
  "advisory",
] as const;
export type FindingSeverity = (typeof FINDING_SEVERITY_VALUES)[number];

/**
 * FIXED v1 category enum — see findingsMock.ts:48-56. Adding a category
 * is an event-modeled schema change (not a silent extension), so the
 * tuple here, the openapi enum, the engine's prompt instruction, and
 * the frontend label map all move together.
 */
export const FINDING_CATEGORY_VALUES = [
  "setback",
  "height",
  "coverage",
  "egress",
  "use",
  "overlay-conflict",
  "divergence-related",
  "other",
] as const;
export type FindingCategory = (typeof FINDING_CATEGORY_VALUES)[number];

export const FINDING_STATUS_VALUES = [
  "ai-produced",
  "accepted",
  "rejected",
  "overridden",
  "promoted-to-architect",
] as const;
export type FindingStatus = (typeof FINDING_STATUS_VALUES)[number];

export const findings = pgTable(
  "findings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /**
     * Public atom id `finding:{submissionId}:{rowUuid}`. Stamped by the
     * route's insert helper from the new row's id + parent submissionId.
     * UNIQUE so a misconstructed atom id never collides with an
     * unrelated row, and so the atom registry can use it as the
     * entityId verbatim.
     */
    atomId: text("atom_id").notNull(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    severity: text("severity").notNull(),
    category: text("category").notNull(),
    status: text("status").notNull().default("ai-produced"),
    /**
     * Free-text body containing inline citation tokens. The engine's
     * shared validator (re-exported from briefing-engine) strips any
     * token whose id does not appear in the `citations` array.
     */
    text: text("text").notNull(),
    /**
     * `FindingCitation[]` (discriminated `code-section | briefing-source`).
     * Stored verbatim from the engine output — see column docstring
     * above for the swap rationale.
     */
    citations: jsonb("citations").notNull().default(sql`'[]'::jsonb`),
    /**
     * 0..1 confidence emitted by the engine. Stored as `numeric` (no
     * precision constraint) so rounding is the renderer's problem; the
     * FE renders `confidence.toFixed(2)`.
     */
    confidence: numeric("confidence").notNull(),
    lowConfidence: boolean("low_confidence").notNull().default(false),
    /**
     * Most-recent reviewer action attribution. Null while status is
     * `"ai-produced"`. The shape mirrors `FindingActor` from
     * findingsMock.ts:76-80: `{kind:"user"|"agent"|"system", id, displayName?}`.
     */
    reviewerStatusBy: jsonb("reviewer_status_by"),
    reviewerStatusChangedAt: timestamp("reviewer_status_changed_at", {
      withTimezone: true,
    }),
    reviewerComment: text("reviewer_comment"),
    /** Opaque BIM element pointer (e.g. `"wall:north-side-l2"`). */
    elementRef: text("element_ref"),
    /** `{id, label}` pointer at the backing briefing source. */
    sourceRef: jsonb("source_ref"),
    /**
     * AI generation timestamp. Stamped at engine time, NOT at row
     * insert — a finding the engine produced at T0 but persisted at T1
     * surfaces T0 to consumers (matches the mock's `aiGeneratedAt`).
     */
    aiGeneratedAt: timestamp("ai_generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Track 1 — explicit AI-provenance flag for the "AI generated"
     * badge surface. `true` when the row was inserted by the
     * finding-engine; `false` for human-authored override-revisions
     * (the override route inserts a NEW row with this column false,
     * regardless of whether the row being revised was AI-produced —
     * the override is a human-authored finding, period).
     *
     * Distinct from `aiGeneratedAt` (which is non-nullable on every
     * row by historical schema; the `aiGenerated` boolean is the
     * source of truth for badge rendering, while `aiGeneratedAt` stays
     * useful as the engine's emit timestamp for AI-produced rows).
     *
     * Backfilled on existing rows via
     * `UPDATE findings SET ai_generated = (finding_run_id IS NOT NULL)`
     * in the migration.
     */
    aiGenerated: boolean("ai_generated").notNull().default(false),
    /**
     * Track 1 — bare reviewer id frozen at FIRST transition into
     * `'accepted'`. The badge surface composes
     * "AI generated · reviewer confirmed ({displayName}, {date})" by
     * joining this id against the `users` profile table at read time.
     *
     * Frozen at first acceptance: a row that cycles
     * `accepted → rejected → accepted` keeps the original
     * `accepted_by_reviewer_id` and `accepted_at` from the first
     * acceptance — the badge tracks "who first confirmed this
     * finding," not "who most-recently accepted it." Most-recent
     * action lives in `reviewerStatusBy` / `reviewerStatusChangedAt`.
     */
    acceptedByReviewerId: text("accepted_by_reviewer_id"),
    /**
     * Track 1 — wall-clock timestamp of the first acceptance. See
     * `acceptedByReviewerId` for the freeze semantics.
     */
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    /**
     * Self-FK for the override-creates-revision pattern. Null on the
     * original AI-produced row; set to the original's id on each
     * reviewer override. ON DELETE SET NULL so a deleted original
     * doesn't dangle the revision (deletion is intentionally
     * undefined for v1 — review-state mutations are append-only).
     */
    revisionOf: uuid("revision_of").references(
      (): AnyPgColumn => findings.id,
      { onDelete: "set null" },
    ),
    /**
     * Producing run row. Set when the engine inserts a row; nullable
     * for human-overridden rows that the reviewer creates outside an
     * AI run. ON DELETE SET NULL so the run-sweep does not orphan
     * findings (parallel to parcelBriefings.generationId at
     * lib/db/src/schema/parcelBriefings.ts:92-95).
     */
    findingRunId: uuid("finding_run_id").references(
      (): AnyPgColumn => findingRuns.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    /**
     * Drives the FE's "list current findings for this submission"
     * query (newest first). Composite index because every list call
     * filters by submissionId and orders by createdAt.
     */
    submissionCreatedIdx: index("findings_submission_created_idx").on(
      t.submissionId,
      t.createdAt,
    ),
    /**
     * Atom-id lookup for the empressa-atom registry. Unique because the
     * atom id encodes the row uuid (collision would be a generation
     * bug). Partial would be premature — every row carries an atom id.
     */
    atomIdUniq: uniqueIndex("findings_atom_id_uniq").on(t.atomId),
    /**
     * Closed-set enforcement at the DB layer per the reviewer-annotation
     * pattern (lib/db/src/schema/reviewerAnnotations.ts:194-201). Kept
     * in lock-step with the TS tuples above by literal copy — the
     * drizzle CHECK builder cannot interpolate a TS array.
     */
    severityCheck: check(
      "findings_severity_check",
      sql`${t.severity} IN ('blocker', 'concern', 'advisory')`,
    ),
    categoryCheck: check(
      "findings_category_check",
      sql`${t.category} IN ('setback', 'height', 'coverage', 'egress', 'use', 'overlay-conflict', 'divergence-related', 'other')`,
    ),
    statusCheck: check(
      "findings_status_check",
      sql`${t.status} IN ('ai-produced', 'accepted', 'rejected', 'overridden', 'promoted-to-architect')`,
    ),
  }),
);

export const findingsRelations = relations(findings, ({ one }) => ({
  submission: one(submissions, {
    fields: [findings.submissionId],
    references: [submissions.id],
  }),
  revisedFrom: one(findings, {
    fields: [findings.revisionOf],
    references: [findings.id],
    relationName: "findings_revision_of",
  }),
  run: one(findingRuns, {
    fields: [findings.findingRunId],
    references: [findingRuns.id],
    relationName: "findings_finding_run",
  }),
}));

export type Finding = typeof findings.$inferSelect;
export type NewFinding = typeof findings.$inferInsert;
