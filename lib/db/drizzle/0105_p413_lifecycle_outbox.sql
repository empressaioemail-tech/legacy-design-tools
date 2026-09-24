-- P-413: durable outbox for Smart Site lifecycle events E1–E6.
--
-- A row is the intent to tell GoHighLevel and Meta. The user's action is
-- never delayed or reverted by a send failure; the worker retries. `id` is
-- the Meta event_id returned to the browser as lifecycleEventId.

CREATE TABLE IF NOT EXISTS pe_lifecycle_outbox (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  idempotency_key text NOT NULL,
  email text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CONSTRAINT pe_lifecycle_outbox_event_type_chk CHECK (event_type <> ''),
  CONSTRAINT pe_lifecycle_outbox_email_chk CHECK (email <> ''),
  CONSTRAINT pe_lifecycle_outbox_status_chk CHECK (status IN ('pending', 'sent', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS pe_lifecycle_outbox_idempotency_uidx
  ON pe_lifecycle_outbox (idempotency_key);

CREATE INDEX IF NOT EXISTS pe_lifecycle_outbox_status_created_idx
  ON pe_lifecycle_outbox (status, created_at);

CREATE INDEX IF NOT EXISTS pe_lifecycle_outbox_owner_idx
  ON pe_lifecycle_outbox (owner_user_id, created_at);
