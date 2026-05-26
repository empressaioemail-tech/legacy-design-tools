import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  numeric,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { engagements } from "./engagements";

/** ADR-020 recorded instrument row (Phase 1 R4 upload). */
export const recordedInstruments = pgTable(
  "recorded_instruments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    instrumentDid: text("instrument_did").notNull(),
    instrumentType: text("instrument_type").notNull(),
    recording: jsonb("recording"),
    issuerActorDid: text("issuer_actor_did").notNull(),
    sourceDocumentCid: text("source_document_cid").notNull(),
    appliesTo: jsonb("applies_to").notNull(),
    accessPolicy: text("access_policy").notNull().default("tenant-private"),
    legalWeight: text("legal_weight").notNull().default("recorded"),
    verificationStatus: text("verification_status").notNull().default("machine"),
    extractedAt: timestamp("extracted_at", { withTimezone: true }).notNull(),
    sourceAdapter: text("source_adapter").notNull(),
    sourceObjectPath: text("source_object_path").notNull(),
    uploadOriginalFilename: text("upload_original_filename"),
    uploadContentType: text("upload_content_type"),
    uploadByteSize: integer("upload_byte_size"),
    extractMetadata: jsonb("extract_metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    engagementIdx: index("recorded_instruments_engagement_idx").on(t.engagementId),
  }),
);

export const restrictionClauses = pgTable(
  "restriction_clauses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => recordedInstruments.id, { onDelete: "cascade" }),
    clauseDid: text("clause_did").notNull(),
    parentInstrumentCid: text("parent_instrument_cid").notNull(),
    clausePath: text("clause_path").notNull(),
    bodyText: text("body_text").notNull(),
    structuredFields: jsonb("structured_fields"),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    extractedBy: text("extracted_by").notNull(),
    humanVerifiedAt: timestamp("human_verified_at", { withTimezone: true }),
    verifiedByActorDid: text("verified_by_actor_did"),
    accessPolicy: text("access_policy").notNull().default("tenant-private"),
    legalWeight: text("legal_weight").notNull().default("recorded"),
    reasoningSummary: text("reasoning_summary"),
    sourceCitation: text("source_citation").notNull(),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull(),
    sourcePage: integer("source_page"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    instrumentIdx: index("restriction_clauses_instrument_idx").on(t.instrumentId),
  }),
);

export const recordedInstrumentsRelations = relations(
  recordedInstruments,
  ({ one, many }) => ({
    engagement: one(engagements, {
      fields: [recordedInstruments.engagementId],
      references: [engagements.id],
    }),
    clauses: many(restrictionClauses),
  }),
);

export const restrictionClausesRelations = relations(
  restrictionClauses,
  ({ one }) => ({
    instrument: one(recordedInstruments, {
      fields: [restrictionClauses.instrumentId],
      references: [recordedInstruments.id],
    }),
  }),
);

export type RecordedInstrument = typeof recordedInstruments.$inferSelect;
export type NewRecordedInstrument = typeof recordedInstruments.$inferInsert;
export type RestrictionClause = typeof restrictionClauses.$inferSelect;
export type NewRestrictionClause = typeof restrictionClauses.$inferInsert;
