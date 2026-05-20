import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { engagements } from "./engagements";

/**
 * L2b — `attached-document` atom persistence (Cortex Lane C.4 / C.4.2).
 *
 * A supporting document attached to an engagement (specification
 * section, structural calculation, product-data sheet, design
 * narrative), carrying the parsed text plus a reference to the stored
 * original blob.
 *
 * Read-only on the L2 surface: the endpoint contract exposes only
 * list + fetch — `attached-document` atoms are produced by the
 * sheet-ingest pipeline (coupled at the producer with
 * `sheet-content-extraction`), not by an HTTP create. C.4.2 ships the
 * table + the read endpoints; the producer is separate (see the C.4.2
 * PR's open-items note).
 *
 * Endpoint contract:
 * `doc_repo/_research/2026-05-19_l_surface_endpoint_contracts_cc-agent-M.md`
 * §L2. Atom shape: `ATTACHED_DOCUMENT_SCHEMA` in
 * `@workspace/atoms-l-surface`.
 */

export const ATTACHED_DOCUMENT_TYPE_VALUES = [
  "specification",
  "calculation",
  "product-data",
  "narrative",
] as const;
export type AttachedDocumentTypeValue =
  (typeof ATTACHED_DOCUMENT_TYPE_VALUES)[number];

export const attachedDocuments = pgTable(
  "attached_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    /** Human document title. */
    title: text("title").notNull(),
    /** Document category. */
    documentType: text("document_type").notNull(),
    /** Parsed text content. */
    extractedText: text("extracted_text").notNull().default(""),
    /** Reference to the stored original blob (CID / storage key). */
    originalBlobRef: text("original_blob_ref").notNull(),
    /** Architect / staff member who attached the document (ADR-015). */
    actorId: text("actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    engagementIdx: index("attached_documents_engagement_idx").on(
      t.engagementId,
    ),
    /**
     * Closed-set enforcement at the DB layer. Kept literal — the
     * drizzle CHECK builder cannot interpolate a TS array; keep in
     * lock-step with `ATTACHED_DOCUMENT_TYPE_VALUES`.
     */
    documentTypeCheck: check(
      "attached_documents_document_type_check",
      sql`${t.documentType} IN ('specification', 'calculation', 'product-data', 'narrative')`,
    ),
  }),
);

export type AttachedDocument = typeof attachedDocuments.$inferSelect;
export type NewAttachedDocument = typeof attachedDocuments.$inferInsert;
