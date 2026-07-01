/**
 * Subject-scoped knowledge / claim atoms — verified absence, positive claims,
 * conflict records, and resolution atoms (network-effects gaps 1 & 2).
 *
 * `claim_type` is an open text field validated at ingest (absence.*, conflict.*,
 * claim.*, resolution.* prefixes). No DB enum — scope changes without migration.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export interface KnowledgeAtomCheckScope {
  jurisdiction: string;
  record_type: string;
  date_range_start: string;
  date_range_end: string;
}

export interface VerifiedAbsencePayload {
  what_was_checked: string;
  checked_by: string;
  check_scope: KnowledgeAtomCheckScope;
  check_method: "api_query" | "public_record_pull" | "registry_lookup";
  result: "verified_absent";
}

export interface ConflictResolutionState {
  resolved: boolean;
  resolution_basis: "precedence_taxonomy" | "operator_adjudication" | null;
  winning_atom_id?: string | null;
  confidence?: number | null;
}

export interface ConflictAtomPayload {
  original_claim_type: string;
  conflicting_atom_ids: string[];
  detected_at: string;
  resolution: ConflictResolutionState;
}

export interface ResolutionAtomPayload {
  conflict_atom_id: string;
  resolved_by: string;
  resolution_type: "source_correction" | "operator_adjudication";
  resolved_at: string;
}

export const knowledgeAtoms = pgTable(
  "knowledge_atoms",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subjectId: text("subject_id").notNull(),
    claimType: text("claim_type").notNull(),
    sourceKey: text("source_key").notNull(),
    payload: jsonb("payload").notNull().default({}),
    accessPolicy: text("access_policy").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    knowledgeAt: timestamp("knowledge_at", { withTimezone: true }).notNull(),
    /** Dedup key for verified-absence deposits (source + scope + check date). */
    dedupKey: text("dedup_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    subjectClaimIdx: index("knowledge_atoms_subject_claim_idx").on(
      t.subjectId,
      t.claimType,
    ),
    dedupUniq: uniqueIndex("knowledge_atoms_dedup_key_uniq").on(t.dedupKey),
    knowledgeAtIdx: index("knowledge_atoms_knowledge_at_idx").on(t.knowledgeAt),
  }),
);

export type KnowledgeAtom = typeof knowledgeAtoms.$inferSelect;
export type NewKnowledgeAtom = typeof knowledgeAtoms.$inferInsert;
