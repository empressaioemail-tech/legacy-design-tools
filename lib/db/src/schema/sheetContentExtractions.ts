import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { sheets } from "./sheets";
import { engagements } from "./engagements";

/**
 * L2a — `sheet-content-extraction` atom persistence (Cortex Lane C.4 /
 * C.4.2).
 *
 * One row per sheet (`source_sheet_id` is UNIQUE — re-extraction
 * upserts) carrying the classified output of the sheet-content
 * extraction pass: OCR text segments plus structured annotations
 * (revision clouds, dimensions, schedule rows, callouts).
 *
 * The two array columns are JSONB:
 *   - `extracted_text_segments` — `[{ text, boundingBox, sourceConfidence }]`
 *   - `structured_annotations`  — `[{ kind, position, content, sourceConfidence }]`
 *
 * Endpoint contract:
 * `doc_repo/_research/2026-05-19_l_surface_endpoint_contracts_cc-agent-M.md`
 * §L2. Atom shape: `SHEET_CONTENT_EXTRACTION_SCHEMA` in
 * `@workspace/atoms-l-surface`. Base-atom provenance fields are derived
 * at read time by the route's row→atom mapper.
 */

export const sheetContentExtractions = pgTable(
  "sheet_content_extractions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /**
     * Source sheet. UNIQUE — one extraction atom per sheet; a
     * re-extraction overwrites the row in place (the contract's
     * "emit a sheet-content-extraction atom" is idempotent per sheet).
     */
    sourceSheetId: uuid("source_sheet_id")
      .notNull()
      .unique()
      .references(() => sheets.id, { onDelete: "cascade" }),
    /** Engagement the sheet belongs to (denormalized for the L2 list query). */
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    /** Sheet number / label (e.g. "A-101"). Empty when the sheet is unlabeled. */
    pageLabel: text("page_label").notNull().default(""),
    /** OCR text segments: `[{ text, boundingBox, sourceConfidence }]`. */
    extractedTextSegments: jsonb("extracted_text_segments")
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Structured annotations: `[{ kind, position, content, sourceConfidence }]`. */
    structuredAnnotations: jsonb("structured_annotations")
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Model that produced the OCR pass (provenance, e.g. "claude-sonnet-4-5"). */
    ocrModel: text("ocr_model").notNull(),
    /** Architect / staff member who uploaded the source sheet (ADR-015). */
    actorId: text("actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    engagementIdx: index("sheet_content_extractions_engagement_idx").on(
      t.engagementId,
    ),
  }),
);

export type SheetContentExtraction =
  typeof sheetContentExtractions.$inferSelect;
export type NewSheetContentExtraction =
  typeof sheetContentExtractions.$inferInsert;
