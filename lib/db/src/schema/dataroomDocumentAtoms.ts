import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { engagements } from "./engagements";
import { attachedDocuments } from "./attachedDocuments";

/**
 * Dataroom document -> atom association (Phase 2 Dataroom/Files tile).
 *
 * When a dataroom file is ingested by the engine `POST /v1/document-ingest`
 * pipeline, the returned `atoms[]` are the CLAIMS extracted from that file.
 * This table persists that ingest result so the Dataroom tile re-renders the
 * cited, confidence-graded atom chips WITHOUT re-ingesting on every open.
 *
 * Point-to model (matches the engine's document-ingest contract): the file
 * bytes remain the source of truth in `attached_documents.original_blob_ref`;
 * each row here is one extracted atom pointing back to its
 * `source_document_cid` (the pinned blob the engine returned) plus the engine's
 * `atom_did`, `entity_type`, `access_policy`, `storage_relation`, an asserted
 * widthed `confidence` (the `{ kind, value, intervalWidth, n }` shape — never a
 * bare number), and `verification_status`.
 *
 * The FIREWALL is expressed in the data, not just the call: a user's private
 * upload is ingested WITHOUT an `accessPolicy` on the ingest call, so the engine
 * defaults + clamps to `tenant-private` and returns that; we persist exactly
 * what the engine returned, so no row here can carry a public policy the engine
 * did not itself grant. `access_policy` is displayed on the chip; it is never
 * user-editable from this surface.
 *
 * Idempotency: the engine mints a deterministic `atomDid` from the source blob
 * CID plus the atom's own content hash, so re-ingesting the same file returns
 * the same DIDs. The unique index on `(document_id, atom_did)` lets the
 * persist path upsert-on-conflict so a re-ingest updates rather than duplicates.
 * `atom_did` is NOT NULL, so the plain unique index behaves as intended (there
 * are no NULL-distinct surprises).
 */
export const dataroomDocumentAtoms = pgTable(
  "dataroom_document_atoms",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The dataroom file this atom was extracted from. */
    documentId: uuid("document_id")
      .notNull()
      .references(() => attachedDocuments.id, { onDelete: "cascade" }),
    /** Denormalized engagement scope for a cheap per-engagement list. */
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    /** The engine-minted deterministic atom DID. */
    atomDid: text("atom_did").notNull(),
    /** The extracted atom's domain type (e.g. `survey-record`). */
    entityType: text("entity_type").notNull(),
    /** The engine-resolved access policy for this atom (clamped server-side). */
    accessPolicy: text("access_policy").notNull(),
    /** `point-to` | `embed-with` — the source-of-truth relation. */
    storageRelation: text("storage_relation").notNull(),
    /**
     * Asserted widthed confidence exactly as the engine returned it:
     * `{ kind: "asserted", value, intervalWidth, n }`. Stored whole so the chip
     * never presents a bare number.
     */
    confidence: jsonb("confidence").notNull(),
    /** `extracted-unverified` | `unverified-web-source` | `human-verified`. */
    verificationStatus: text("verification_status").notNull(),
    /** The pinned source-document CID this atom points back to (the citation). */
    sourceDocumentCid: text("source_document_cid").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    engagementIdx: index("dataroom_document_atoms_engagement_idx").on(
      t.engagementId,
    ),
    documentIdx: index("dataroom_document_atoms_document_idx").on(
      t.documentId,
    ),
    documentAtomUniq: uniqueIndex("dataroom_document_atoms_doc_atom_uniq").on(
      t.documentId,
      t.atomDid,
    ),
  }),
);

export const dataroomDocumentAtomsRelations = relations(
  dataroomDocumentAtoms,
  ({ one }) => ({
    attachedDocument: one(attachedDocuments, {
      fields: [dataroomDocumentAtoms.documentId],
      references: [attachedDocuments.id],
    }),
    engagement: one(engagements, {
      fields: [dataroomDocumentAtoms.engagementId],
      references: [engagements.id],
    }),
  }),
);

export type DataroomDocumentAtom = typeof dataroomDocumentAtoms.$inferSelect;
export type NewDataroomDocumentAtom = typeof dataroomDocumentAtoms.$inferInsert;
