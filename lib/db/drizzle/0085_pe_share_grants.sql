-- P-86 share grant registry. Resolvable URL is /s/{id}. No HMAC column.

CREATE TABLE IF NOT EXISTS pe_share_grants (
  id text PRIMARY KEY,
  grantor_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grantor_tenant_id text NOT NULL,
  parcel_node_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS pe_share_grants_grantor_idx
  ON pe_share_grants (grantor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS pe_share_grants_parcel_idx
  ON pe_share_grants (parcel_node_id);
