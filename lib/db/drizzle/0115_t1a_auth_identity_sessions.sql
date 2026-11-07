-- T1-A (Smart Site mobile, 2026-10-22) — auth and identity backend.
--
-- Schema only. Nothing here merges accounts: the one-time duplicate-account
-- merge is a separate, operator-run script
-- (artifacts/api-server/src/peAccountMergeCli.ts, dry run by default;
-- artifacts/api-server/sql/pe_account_merge_DRY_RUN.sql prints counts only).
--
-- 1. pe_user_identities.email_verified — account linking keys on verified
--    emails only (ruling 3). Backfill:
--      * provider 'email' rows are verified by construction (the address
--        redeemed a link sent to it);
--      * provider 'google' rows on gmail.com / googlemail.com are verified:
--        Google always reports email_verified=true for those addresses;
--      * every other row (other Google domains, all Microsoft rows) stays
--        false until a sign-in proves it (Google's email_verified claim).
-- 2. pe_magic_link_tokens: 6-digit code hash, attempt counter, sent_at (the
--    rate limit counts only successful sends), validated return_to.
-- 3. pe_sessions / pe_session_cutoffs — server-side revocation and sliding
--    expiry for the HMAC session token.
-- 4. pe_account_merges / pe_account_merge_rows — the merge log that makes
--    the duplicate-account merge auditable, reversible and idempotent.

ALTER TABLE pe_user_identities
  ADD COLUMN IF NOT EXISTS email_verified boolean DEFAULT false NOT NULL;

UPDATE pe_user_identities
   SET email_verified = true
 WHERE email_verified = false
   AND email IS NOT NULL
   AND (
     provider = 'email'
     OR (provider = 'google' AND lower(email) ~ '@(gmail|googlemail)\.com$')
   );

ALTER TABLE pe_magic_link_tokens
  ADD COLUMN IF NOT EXISTS code_hash text,
  ADD COLUMN IF NOT EXISTS attempts integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS sent_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS return_to text;

-- Rows minted before this migration were all handed to Resend before the
-- route answered 200 (a failed send answered 502 and is indistinguishable
-- here), so treat them as sent for the rate-limit window they are still in.
UPDATE pe_magic_link_tokens
   SET sent_at = created_at
 WHERE sent_at IS NULL;

CREATE TABLE IF NOT EXISTS pe_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  revoked_at timestamp with time zone,
  revoked_reason text
);

CREATE INDEX IF NOT EXISTS pe_sessions_user_idx ON pe_sessions (user_id);

CREATE TABLE IF NOT EXISTS pe_session_cutoffs (
  user_id text PRIMARY KEY,
  not_before timestamp with time zone NOT NULL,
  reason text NOT NULL
);

CREATE TABLE IF NOT EXISTS pe_account_merges (
  merged_user_id text PRIMARY KEY,
  survivor_user_id text NOT NULL
    CONSTRAINT pe_account_merges_survivor_user_id_users_id_fk
    REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL,
  run_id text NOT NULL,
  reason text NOT NULL,
  merged_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS pe_account_merges_survivor_idx
  ON pe_account_merges (survivor_user_id);

CREATE TABLE IF NOT EXISTS pe_account_merge_rows (
  id bigserial PRIMARY KEY,
  merged_user_id text NOT NULL,
  table_name text NOT NULL,
  action text NOT NULL,
  before jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS pe_account_merge_rows_merged_idx
  ON pe_account_merge_rows (merged_user_id);
