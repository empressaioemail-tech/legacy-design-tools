-- Wave 2 — conflict / resolution claim families share knowledge_atoms (no schema change).
-- Partial index accelerates unresolved conflict lookup by subject + original claim type.
CREATE INDEX IF NOT EXISTS "knowledge_atoms_conflict_subject_idx"
  ON "knowledge_atoms" ("subject_id")
  WHERE "claim_type" LIKE 'conflict.%';

CREATE INDEX IF NOT EXISTS "knowledge_atoms_resolution_conflict_idx"
  ON "knowledge_atoms" ((payload->>'conflict_atom_id'))
  WHERE "claim_type" LIKE 'resolution.%';
