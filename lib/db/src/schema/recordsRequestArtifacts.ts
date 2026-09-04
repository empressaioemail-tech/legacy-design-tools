import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { recordsRequestJobs } from "./recordsRequestJobs";

export type RecordsAcquisitionMethod =
  | "download"
  | "purchase"
  | "capture"
  | "human";

/** P-85 WDLL item 6 — hashed instrument artifact from a Records Request run. */
export const recordsRequestArtifacts = pgTable(
  "records_request_artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => recordsRequestJobs.id, { onDelete: "cascade" }),
    portalId: text("portal_id").notNull(),
    recordingRef: text("recording_ref"),
    documentType: text("document_type"),
    recordingDate: text("recording_date"),
    parties: text("parties"),
    acquisitionMethod: text("acquisition_method")
      .notNull()
      .$type<RecordsAcquisitionMethod>(),
    contentSha256: text("content_sha256").notNull(),
    byteSize: integer("byte_size"),
    purchaseCostCents: integer("purchase_cost_cents"),
    detailUrl: text("detail_url"),
    storagePath: text("storage_path"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    jobIdx: index("records_request_artifacts_job_idx").on(t.jobId, t.createdAt),
    sha256Idx: index("records_request_artifacts_sha256_idx").on(t.contentSha256),
  }),
);

export const recordsRequestArtifactsRelations = relations(
  recordsRequestArtifacts,
  ({ one }) => ({
    job: one(recordsRequestJobs, {
      fields: [recordsRequestArtifacts.jobId],
      references: [recordsRequestJobs.id],
    }),
  }),
);

export type RecordsRequestArtifact =
  typeof recordsRequestArtifacts.$inferSelect;
export type NewRecordsRequestArtifact =
  typeof recordsRequestArtifacts.$inferInsert;
