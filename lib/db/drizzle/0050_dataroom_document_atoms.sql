-- Phase 2 Dataroom/Files tile — document -> atom association.
--
-- Persists the engine `POST /v1/document-ingest` result per dataroom file so
-- the Dataroom tile re-renders cited, confidence-graded atom chips WITHOUT
-- re-ingesting on every open. Point-to model: the file bytes stay the source of
-- truth in `attached_documents.original_blob_ref`; each row here is one
-- extracted atom pointing back to its `source_document_cid` (the pinned blob)
-- with the engine-resolved (clamped) `access_policy`, `storage_relation`, an
-- asserted widthed `confidence` (the `{ kind, value, intervalWidth, n }` shape),
-- and `verification_status`.
--
-- Firewall in the data: we persist exactly what the engine returned. A private
-- upload is ingested without an accessPolicy, so the engine clamps to
-- tenant-private and no row here can carry a policy the engine did not grant.
--
-- Idempotency: the engine mints deterministic atom DIDs, so the unique index on
-- (document_id, atom_did) lets the persist path upsert-on-conflict.
CREATE TABLE dataroom_document_atoms (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES attached_documents(id) ON DELETE CASCADE,
  engagement_id         uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  atom_did              text NOT NULL,
  entity_type           text NOT NULL,
  access_policy         text NOT NULL,
  storage_relation      text NOT NULL,
  confidence            jsonb NOT NULL,
  verification_status   text NOT NULL,
  source_document_cid   text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dataroom_document_atoms_engagement_idx ON dataroom_document_atoms(engagement_id);
CREATE INDEX dataroom_document_atoms_document_idx ON dataroom_document_atoms(document_id);
CREATE UNIQUE INDEX dataroom_document_atoms_doc_atom_uniq ON dataroom_document_atoms(document_id, atom_did);
