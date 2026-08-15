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
     * The DECLARED entityId (`smartfile:<jurisdictionFips>:<docSlug>`), stored
     * exactly as `buildSmartFileEntityId` produced it. Never reconstructed by a
     * reader (AGENT_CONTRACT 5, constraint 6): storage persists the value, and
     * consumers match on it verbatim.
     */
    entityId: text("entity_id").notNull(),
    /** Jurisdiction FIPS. The document's scope — a city file is not parcel-keyed. */
    jurisdictionFips: text("jurisdiction_fips").notNull(),
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
    jurisdictionIdx: index("smart_file_documents_jurisdiction_idx").on(
      t.jurisdictionFips,
      t.docSlug,
    ),
    accessPolicyIdx: index("smart_file_documents_access_policy_idx").on(
      t.accessPolicy,
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
export type SmartFilePlacementRow = typeof smartFilePlacements.$inferSelect;
export type NewSmartFilePlacementRow = typeof smartFilePlacements.$inferInsert;
