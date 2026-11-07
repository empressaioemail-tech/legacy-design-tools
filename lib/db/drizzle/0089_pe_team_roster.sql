-- P-94 Team roster server half.
-- seats_purchased is nullable on purpose: unknown is absent, never 0.
-- Written by a future Stripe grant; this card reads and enforces it.
-- Membership tables are not a second user store — they point at users.

ALTER TABLE pe_user_entitlements
  ADD COLUMN IF NOT EXISTS seats_purchased integer;

CREATE TABLE IF NOT EXISTS pe_team_members (
  account_owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_team_members_role_chk CHECK (role IN ('owner', 'member'))
);

CREATE UNIQUE INDEX IF NOT EXISTS pe_team_members_account_member_uidx
  ON pe_team_members (account_owner_user_id, member_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS pe_team_members_account_email_uidx
  ON pe_team_members (account_owner_user_id, email);

CREATE UNIQUE INDEX IF NOT EXISTS pe_team_members_member_uidx
  ON pe_team_members (member_user_id);

CREATE INDEX IF NOT EXISTS pe_team_members_account_idx
  ON pe_team_members (account_owner_user_id);

CREATE TABLE IF NOT EXISTS pe_team_invitations (
  id text PRIMARY KEY,
  account_owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_team_invitations_role_chk CHECK (role IN ('owner', 'member'))
);

CREATE UNIQUE INDEX IF NOT EXISTS pe_team_invitations_account_email_uidx
  ON pe_team_invitations (account_owner_user_id, email);

CREATE INDEX IF NOT EXISTS pe_team_invitations_account_idx
  ON pe_team_invitations (account_owner_user_id);
