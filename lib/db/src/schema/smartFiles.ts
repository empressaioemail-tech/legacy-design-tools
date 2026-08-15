import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql, relations } from "drizzle-orm";

/**
 * Smart Files — the city-file-system artifact store (OPS-17 PLAN-ROW G-14).
 *
 * A NEW family. It does NOT extend `brokerage_workspaces` (amendment A-012),
 * and nothing in this file references it. The brokerage rename is a separate
 * backlogged lane (`_catalog/repo_cleanup_backlog.md` item 25).
 *
 * WHY THREE TABLES INSTEAD OF ONE — the shape is forced by the promise.
 * `brokerage_workspace_attachments` (`brokerageWorkspaces.ts:54-76`, verified at
 * source on origin/main @ 4dfb118c) has 8 columns and a single `notNull` FK to
 * ONE workspace on cascade delete, with no `updated_at`, no `version`, no
 * `cid`, no `access_policy`. So on that shape:
 *   - "a document lives once and appears everywhere it belongs" is impossible —
 *     one row belongs to exactly one parent, so N placements means N copies;
 *   - "revise once, current everywhere, prior version still there" has no
 *     schema at all — only insert and delete exist.
 *
 * The split answers each directly:
 *   `smart_file_documents`  — identity. One row per document, ever. No content.
 *   `smart_file_versions`   — content, append-only. Revision INSERTS; nothing
 *                             is updated or deleted, so history survives.
 *   `smart_file_placements` — where it appears. Many-to-many, so placing a
 *                             document again adds a ROW HERE, never a copy of
 *                             the document or its bytes.
 *
 * Placements reference the DOCUMENT, never a version. That is what makes
 * revise-once-current-everywhere structural rather than a fan-out update across
 * placements that can partially fail.
 *
 * The same structural defect exists in `attached_documents` (single `notNull`
 * engagement FK, cascade, no `updated_at`/`version`/`access_policy`), so that
 * table was also not extendable. What IS reused is the engine's document-ingest
 * blob-pin MECHANISM (operator ruling OR-A2): `content_cid` below holds a CID
 * minted by that pipeline's content-hash-idempotent `pinBlob`, reached over the
 * `ENGINE_API_URL` seam exactly as `dataroomIngest.ts` reaches it. This repo has
 * no dependency on any `@hauska-engine/*` package, so the mechanism is consumed
 * over HTTP, not imported.
 *
 * Contract types, entityId shape, and the freshness evaluator live in
 * `artifacts/api-server/src/atoms/smart-file.contract.ts`, authored locally per
 * operator ruling OR-A1 and promoted to `@empressaio/atom-contract` when G-34
 * closes.
 */

/** Closed scope types for Smart Files identity (decision 2026-08-15). */
export const SMART_FILE_SCOPE_TYPES = [
  "jurisdiction",
  "tenant",
  "site",
] as const;
export type SmartFileScopeTypeValue = (typeof SMART_FILE_SCOPE_TYPES)[number];

/** WHERE a document can appear. Closed set; mirrors the contract type. */
export const SMART_FILE_PLACEMENT_TARGET_TYPES = [
  "folder",
  "parcel",
  "project",
  "asset",
  "permit",
  "meeting",
] as const;
export type SmartFilePlacementTargetType =
  (typeof SMART_FILE_PLACEMENT_TARGET_TYPES)[number];

/** The five-value union (ADR-017). Mirrors the atom contract. */
export const SMART_FILE_ACCESS_POLICIES = [
  "public-free",
  "public-paid",
  "platform-internal",
  "tenant-private",
  "tenant-shared",
] as const;
export type SmartFileAccessPolicyValue =
  (typeof SMART_FILE_ACCESS_POLICIES)[number];

/**
 * The two recordable determination verdicts (G-34). `not-sought` is NOT here:
 * never having looked is the ABSENCE of a determination row, not a verdict.
 */
export const SMART_FILE_ABSENCE_VERDICTS = [
  "absent-verified",
  "lookup-failed",
] as const;
export type SmartFileAbsenceVerdict =
  (typeof SMART_FILE_ABSENCE_VERDICTS)[number];

/**
 * The DOCUMENT — identity, deliberately carrying no content.
 *
 * This is the "lives once" half. A document in five places is ONE row here plus
 * five `smart_file_placements` rows.
 */
export const smartFileDocuments = pgTable(
  "smart_file_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /**
     * The DECLARED entityId (`smartfile:<scopeType>:<scopeId>:<docSlug>`), stored
     * exactly as `buildSmartFileEntityId` produced it. Never reconstructed by a
     * reader (AGENT_CONTRACT 5, constraint 6): storage persists the value, and
     * consumers match on it verbatim.
     */
    entityId: text("entity_id").notNull(),
    scopeType: text("scope_type")
      .notNull()
      .$type<SmartFileScopeTypeValue>(),
    scopeId: text("scope_id").notNull(),
    /**
     * Denormalized FIPS when scopeType is jurisdiction (value equals scopeId).
     * Null for tenant and site scopes.
     */
    jurisdictionFips: text("jurisdiction_fips"),
    /** Stable document identifier within the jurisdiction. Shared across revisions. */
    docSlug: text("doc_slug").notNull(),
    title: text("title").notNull(),
    /**
     * ADR-017 five-value union, resolved at READ time. Present as a COLUMN here;
     * per-tenant ENFORCEMENT is gated on the auth/tenancy leg (G-11 / S-1) and
     * is deliberately not claimed by this migration.
     */
    accessPolicy: text("access_policy")
      .notNull()
      .$type<SmartFileAccessPolicyValue>(),
    /**
     * Version identity that is CURRENT. Moved by a revision; the superseded
     * version row is never touched. This is the pointer that makes one write
     * make every placement current.
     */
    currentVersion: integer("current_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /**
     * The column `brokerage_workspace_attachments` provably lacks. Bumped on
     * revision, so "when did this document last change" is answerable.
     */
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    /**
     * The store-once guarantee, enforced by the DATABASE rather than by caller
     * discipline: one row per declared entityId. A second insert of the same
     * document conflicts instead of quietly creating a duplicate identity.
     */
    entityIdUniq: uniqueIndex("smart_file_documents_entity_id_uniq").on(
      t.entityId,
    ),
    scopeIdentityUniq: uniqueIndex("smart_file_documents_scope_identity_uniq").on(
      t.scopeType,
      t.scopeId,
      t.docSlug,
    ),
    jurisdictionIdx: index("smart_file_documents_jurisdiction_idx").on(
      t.jurisdictionFips,
      t.docSlug,
    ),
    scopeIdx: index("smart_file_documents_scope_idx").on(
      t.scopeType,
      t.scopeId,
      t.docSlug,
    ),
    accessPolicyIdx: index("smart_file_documents_access_policy_idx").on(
      t.accessPolicy,
    ),
    scopeTypeCheck: check(
      "smart_file_documents_scope_type_check",
      sql`${t.scopeType} IN ('jurisdiction', 'tenant', 'site')`,
    ),
    /** Closed-set enforcement at the DB layer. Keep literal, in lock-step with SMART_FILE_ACCESS_POLICIES. */
    accessPolicyCheck: check(
      "smart_file_documents_access_policy_check",
      sql`${t.accessPolicy} IN ('public-free', 'public-paid', 'platform-internal', 'tenant-private', 'tenant-shared')`,
    ),
    currentVersionPositive: check(
      "smart_file_documents_current_version_check",
      sql`${t.currentVersion} >= 1`,
    ),
  }),
);

/**
 * One VERSION of a document. APPEND-ONLY by contract.
 *
 * This is the "prior version is still there" half. A revision inserts a row and
 * moves `smart_file_documents.current_version`; it never updates or deletes a
 * row here. Nothing is silently overwritten, which is exactly what the
 * brokerage family could not express.
 */
export const smartFileVersions = pgTable(
  "smart_file_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => smartFileDocuments.id, { onDelete: "cascade" }),
    /** Denormalized declared entityId for a join-free lookup by document identity. */
    documentEntityId: text("document_entity_id").notNull(),
    /** Monotonic version identity, from 1. */
    version: integer("version").notNull(),
    /**
     * Content-addressed CID of the pinned bytes, minted by the engine
     * document-ingest `pinBlob` (content-hash idempotent: same bytes re-pinned
     * returns the same CID). Changes per revision, which is correct — and is
     * why the DOCUMENT is keyed by entityId and never by CID.
     */
    contentCid: text("content_cid").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    /**
     * Provenance, whole: `{ sourceUri, sourceLabel, retrievedAt, sourceVintage }`.
     * NOT NULL — an unsourced city document is a rumor, and an optional
     * provenance is how "nobody set it" becomes indistinguishable from
     * "there isn't one".
     */
    provenance: jsonb("provenance").notNull(),
    /**
     * When this version's content was established. Half of the freshness stamp;
     * `servedAt` is a property of the READ and is stamped there, never stored.
     */
    computedAt: timestamp("computed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /**
     * Set when a LATER version supersedes this one; NULL while current. A
     * POSITIVE record of supersession rather than an inference from the
     * document's pointer (DEV_PROCESS 4.3).
     */
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    /** One row per (document, version). Re-inserting a version conflicts, never duplicates history. */
    documentVersionUniq: uniqueIndex("smart_file_versions_doc_version_uniq").on(
      t.documentId,
      t.version,
    ),
    documentIdx: index("smart_file_versions_document_idx").on(
      t.documentId,
      t.version,
    ),
    /** Find every document sharing pinned bytes — the dedup question. */
    contentCidIdx: index("smart_file_versions_content_cid_idx").on(t.contentCid),
    versionPositive: check(
      "smart_file_versions_version_check",
      sql`${t.version} >= 1`,
    ),
  }),
);

/**
 * A PLACEMENT — one location where a document appears.
 *
 * Many-to-many by construction: many placements per document, many documents per
 * target. THIS is the structural difference from
 * `brokerage_workspace_attachments`, whose single `notNull` workspace FK forces
 * one attachment into exactly one parent and therefore forces a copy per
 * placement.
 *
 * References the DOCUMENT, not a version, so a revision is current at every
 * placement with no per-placement write.
 */
export const smartFilePlacements = pgTable(
  "smart_file_placements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => smartFileDocuments.id, { onDelete: "cascade" }),
    documentEntityId: text("document_entity_id").notNull(),
    targetType: text("target_type").notNull().$type<SmartFilePlacementTargetType>(),
    /**
     * The target's identifier AS THAT TARGET'S WRITER PERSISTS IT. entityId
     * shapes are not uniform across writers (AGENT_CONTRACT 5), so this is
     * opaque here: never parsed, never reconstructed by this family.
     */
    targetId: text("target_id").notNull(),
    placedAt: timestamp("placed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** NULL is a positive "no actor recorded", not "unknown". */
    placedBy: text("placed_by"),
  },
  (t) => ({
    /**
     * Idempotent placement: placing the same document at the same target twice
     * conflicts rather than creating a second placement. Without this, "placed
     * in three locations" could read as four.
     */
    placementUniq: uniqueIndex("smart_file_placements_uniq").on(
      t.documentId,
      t.targetType,
      t.targetId,
    ),
    documentIdx: index("smart_file_placements_document_idx").on(t.documentId),
    /** The reverse question: what appears at this target. */
    targetIdx: index("smart_file_placements_target_idx").on(
      t.targetType,
      t.targetId,
    ),
    targetTypeCheck: check(
      "smart_file_placements_target_type_check",
      sql`${t.targetType} IN ('folder', 'parcel', 'project', 'asset', 'permit', 'meeting')`,
    ),
  }),
);

/**
 * An ABSENCE DETERMINATION — the record that we LOOKED for a document and what
 * we concluded (OPS-17 PLAN-ROW G-34).
 *
 * WHY THIS IS A TABLE AND NOT A COMPUTED VERDICT. The inherited spine
 * constraint is that ONLY A POSITIVE DETERMINATION WRITES AN ABSENCE; an empty
 * or failed lookup re-enters the queue and does not become a recorded absence.
 * That rule is unenforceable if the read path can synthesize "absent" from a
 * zero-row query, because then every never-attempted lookup silently becomes a
 * verified absence. So the verdict lives in a row that something DELIBERATELY
 * WROTE, and the read path reports the never-looked state when no row is here.
 * Absence is a FINDING, not the failure to find.
 *
 * WHY THE BASIS IS NOT NULL AND CHECK-CONSTRAINED. "Not found" is not a basis;
 * WHY it is not found is. An absence without its citation is unfalsifiable, so
 * a later reader cannot tell a real determination from a placeholder. This
 * mirrors `county_facet_coverage.absence_basis`, which is required by check
 * constraint whenever `rail_state = 'satisfied-absent'` for exactly this
 * reason. The pattern is REUSED here, not reinvented; the county table itself
 * is not extendable for this because it is keyed (county, rail) and has no
 * document axis at all.
 *
 * WHY IT CARRIES `determined_at` RATHER THAN LEANING ON `created_at`. A
 * verified absence DECAYS exactly like a verified presence: "we checked in 2019
 * and Bastrop had no short-term-rental ordinance" is not evidence about today.
 * `determined_at` is the absence path's `computed_at` and feeds the SAME
 * freshness evaluator the present path uses, so one proven indicator covers
 * both paths rather than two indicators drifting apart.
 *
 * This table does NOT reference `smart_file_documents`. A determination is
 * about an entityId for which, in the absent case, no document row exists by
 * definition — an FK would make the common case unrepresentable.
 */
export const smartFileAbsenceDeterminations = pgTable(
  "smart_file_absence_determinations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /**
     * The DECLARED entityId this determination is about, stored exactly as
     * `buildSmartFileEntityId` produced it. Never reconstructed by a reader
     * (AGENT_CONTRACT 5, constraint 6): a reconstructed shape matches zero rows
     * and then reads as an honest absence, which is the precise failure this
     * whole family is built to prevent.
     */
    entityId: text("entity_id").notNull(),
    /** Denormalized from the entityId for jurisdiction-scoped queries. */
    jurisdictionFips: text("jurisdiction_fips").notNull(),
    docSlug: text("doc_slug").notNull(),
    /**
     * The VERDICT. Exactly two values, and the pair is the point:
     *   `absent-verified` — we looked and it is genuinely not there. A real
     *                       answer, renderable as one.
     *   `lookup-failed`   — we tried and the ATTEMPT failed. We know nothing
     *                       about whether the document exists.
     * Collapsing these is how a probe failure wears the costume of a data gap.
     * `not-sought` is deliberately NOT a value here: never having looked is the
     * ABSENCE of a row, and writing a row to say "we did nothing" would make
     * the table lie about what a determination is.
     */
    verdict: text("verdict").notNull().$type<SmartFileAbsenceVerdict>(),
    /**
     * WHY. Required, and required at the DATABASE rather than in application
     * code — a guardrail that does not survive a clone is not a guardrail. For
     * `absent-verified` this is the public-record citation (the index searched,
     * the clerk response, the ordinance list consulted). For `lookup-failed`
     * it is what failed.
     */
    basis: text("basis").notNull(),
    /**
     * WHEN the determination was made — the absence path's `computed_at`.
     * Feeds the same freshness evaluator as a present read.
     */
    determinedAt: timestamp("determined_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /**
     * WHAT did the determining (a CLI name, a sweep id, an operator handle),
     * so a determination is attributable. Mirrors the spine
     * `verified_by_instrument` column.
     */
    determinedBy: text("determined_by").notNull(),
    /**
     * Where the looking happened, when there is a URL for it. NULL is a
     * positive "the determination has no single source URL" (e.g. a phone call
     * to a clerk), not "unknown" — DEV_PROCESS 4.3.
     */
    sourceUri: text("source_uri"),
    /**
     * ADR-017 five-value union, resolved at READ time like any other record.
     * Present as a COLUMN; per-tenant ENFORCEMENT stays gated on G-11 / S-1 and
     * is not claimed here.
     */
    accessPolicy: text("access_policy")
      .notNull()
      .$type<SmartFileAccessPolicyValue>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    /**
     * One CURRENT determination per entityId. A re-determination UPDATES this
     * row (moving `determined_at` forward), so the freshness stamp reflects the
     * latest looking rather than the first.
     */
    entityIdUniq: uniqueIndex(
      "smart_file_absence_determinations_entity_id_uniq",
    ).on(t.entityId),
    jurisdictionIdx: index(
      "smart_file_absence_determinations_jurisdiction_idx",
    ).on(t.jurisdictionFips, t.docSlug),
    verdictIdx: index("smart_file_absence_determinations_verdict_idx").on(
      t.verdict,
    ),
    /** Closed-set enforcement at the DB. Keep in lock-step with SMART_FILE_ABSENCE_VERDICTS. */
    verdictCheck: check(
      "smart_file_absence_determinations_verdict_check",
      sql`${t.verdict} IN ('absent-verified', 'lookup-failed')`,
    ),
    /**
     * THE BASIS RULE, ENFORCED BY THE DATABASE. A determination with a blank or
     * whitespace-only basis is rejected by the engine itself, so no caller,
     * script, or future lane can record an uncited absence — including one
     * writing raw SQL. This is the mechanism that makes "an absence carries its
     * basis" true rather than merely documented.
     */
    basisNonEmpty: check(
      "smart_file_absence_determinations_basis_check",
      sql`length(btrim(${t.basis})) > 0`,
    ),
    instrumentNonEmpty: check(
      "smart_file_absence_determinations_determined_by_check",
      sql`length(btrim(${t.determinedBy})) > 0`,
    ),
    accessPolicyCheck: check(
      "smart_file_absence_determinations_access_policy_check",
      sql`${t.accessPolicy} IN ('public-free', 'public-paid', 'platform-internal', 'tenant-private', 'tenant-shared')`,
    ),
  }),
);

export const smartFileDocumentsRelations = relations(
  smartFileDocuments,
  ({ many }) => ({
    versions: many(smartFileVersions),
    placements: many(smartFilePlacements),
  }),
);

export const smartFileVersionsRelations = relations(
  smartFileVersions,
  ({ one }) => ({
    document: one(smartFileDocuments, {
      fields: [smartFileVersions.documentId],
      references: [smartFileDocuments.id],
    }),
  }),
);

export const smartFilePlacementsRelations = relations(
  smartFilePlacements,
  ({ one }) => ({
    document: one(smartFileDocuments, {
      fields: [smartFilePlacements.documentId],
      references: [smartFileDocuments.id],
    }),
  }),
);

export type SmartFileDocumentRow = typeof smartFileDocuments.$inferSelect;
export type NewSmartFileDocumentRow = typeof smartFileDocuments.$inferInsert;
export type SmartFileVersionRow = typeof smartFileVersions.$inferSelect;
export type NewSmartFileVersionRow = typeof smartFileVersions.$inferInsert;
export type SmartFileAbsenceDeterminationRow =
  typeof smartFileAbsenceDeterminations.$inferSelect;
export type NewSmartFileAbsenceDeterminationRow =
  typeof smartFileAbsenceDeterminations.$inferInsert;
export type SmartFilePlacementRow = typeof smartFilePlacements.$inferSelect;
export type NewSmartFilePlacementRow = typeof smartFilePlacements.$inferInsert;
