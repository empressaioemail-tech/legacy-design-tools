-- P-112 email leg: magic-link sign-in tokens for Property Explorer.
--
-- One row per "send me a link" request, consumed at most once by the verify
-- route. token_hash stores only the SHA-256 hex digest of the raw token,
-- never the token itself -- matching the hash-then-compare precedent this
-- same route family already uses for the session-exchange bearer secret.
--
-- consumed_at is the single-use guard: null = unredeemed, non-null = spent.
-- The verify path flips it with an atomic
-- `UPDATE ... WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > now()`
-- so two concurrent redemptions of the same link can never both succeed.
--
-- email is indexed, not unique -- the same address can have several
-- outstanding/expired/consumed rows over time, and the request route counts
-- recent rows for that address off this index to enforce the per-email rate
-- limit without a second table.

CREATE TABLE IF NOT EXISTS pe_magic_link_tokens (
  id text PRIMARY KEY,
  email text NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pe_magic_link_tokens_token_hash_uidx
  ON pe_magic_link_tokens (token_hash);

CREATE INDEX IF NOT EXISTS pe_magic_link_tokens_email_created_idx
  ON pe_magic_link_tokens (email, created_at);
