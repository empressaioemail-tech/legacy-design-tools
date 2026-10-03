-- P-492: GoHighLevel retired from Smart Site. The lifecycle outbox writes to
-- our own contact record (ss_contact, the system of record) and to Resend;
-- its three legs (local, resend, meta) carry their own status, an attempt cap
-- ends in a counted `dead` state, and a scheduled drain claims rows with
-- FOR UPDATE SKIP LOCKED. Decision:
-- _decisions/2026-10-03_ghl_retired_lifecycle_to_resend.md (doc_repo).
--
-- Hard cut, no backfill: rows already in the outbox get local and resend
-- `skipped` (reason pre_p492_row); their Meta leg keeps its outcome.

CREATE TABLE IF NOT EXISTS ss_contact (
  user_id text PRIMARY KEY
    CONSTRAINT ss_contact_user_id_users_id_fk REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL,
  first_name text,
  stage text NOT NULL DEFAULT 'Explorer',
  plan text NOT NULL DEFAULT 'free',
  billing text NOT NULL DEFAULT 'none',
  source text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  saved_lots integer NOT NULL DEFAULT 0,
  shares integer NOT NULL DEFAULT 0,
  last_active date,
  quiet boolean NOT NULL DEFAULT false,
  quiet_since timestamptz,
  claude_connected boolean NOT NULL DEFAULT false,
  became_sharer_at timestamptz,
  resend_segment_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ss_contact_stage_chk CHECK (stage IN ('Explorer', 'Sharer', 'Unlock', 'Solo', 'Studio', 'Team')),
  CONSTRAINT ss_contact_plan_chk CHECK (plan IN ('free', 'unlock', 'solo', 'studio', 'team')),
  CONSTRAINT ss_contact_billing_chk CHECK (billing IN ('monthly', 'annual', 'none')),
  CONSTRAINT ss_contact_source_chk CHECK (source IS NULL OR source IN ('ad', 'group', 'page', 'share', 'direct')),
  CONSTRAINT ss_contact_email_chk CHECK (email <> '')
);

CREATE INDEX IF NOT EXISTS ss_contact_quiet_last_active_idx
  ON ss_contact (quiet, last_active);

CREATE TABLE IF NOT EXISTS affiliate_partner (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  first_name text,
  channel_url text,
  stage text NOT NULL,
  identified_at timestamptz,
  contacted_at timestamptz,
  applied_at timestamptz,
  approved_at timestamptz,
  link_issued_at timestamptz,
  first_conversion_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affiliate_partner_stage_chk CHECK (stage IN ('identified', 'contacted', 'applied', 'approved', 'link_issued', 'first_conversion')),
  CONSTRAINT affiliate_partner_email_chk CHECK (email <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS affiliate_partner_email_uidx
  ON affiliate_partner (email);

CREATE INDEX IF NOT EXISTS affiliate_partner_stage_idx
  ON affiliate_partner (stage);

CREATE TABLE IF NOT EXISTS ss_lifecycle_drain_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  claimed integer NOT NULL DEFAULT 0,
  sent integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  dead integer NOT NULL DEFAULT 0,
  quiet_enqueued integer NOT NULL DEFAULT 0,
  claude_enqueued integer NOT NULL DEFAULT 0,
  error text
);

CREATE INDEX IF NOT EXISTS ss_lifecycle_drain_run_started_idx
  ON ss_lifecycle_drain_run (started_at);

-- Outbox: subject may be an affiliate instead of a user.
ALTER TABLE pe_lifecycle_outbox ALTER COLUMN owner_user_id DROP NOT NULL;

ALTER TABLE pe_lifecycle_outbox
  ADD COLUMN IF NOT EXISTS affiliate_partner_id uuid
    CONSTRAINT pe_lifecycle_outbox_affiliate_partner_id_affiliate_partner_id_f
    REFERENCES affiliate_partner(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS local_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS local_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS local_error text,
  ADD COLUMN IF NOT EXISTS resend_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS resend_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS resend_error text,
  ADD COLUMN IF NOT EXISTS meta_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS meta_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS meta_error text,
  ADD COLUMN IF NOT EXISTS resend_event_json jsonb,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS claimed_until timestamptz;

-- Pre-P-492 rows: hard cut. Local and Resend never ran for them and will not.
UPDATE pe_lifecycle_outbox
SET local_status = 'skipped',
    local_error = 'pre_p492_row',
    resend_status = 'skipped',
    resend_error = 'pre_p492_row',
    meta_status = CASE WHEN status = 'sent' THEN 'sent' ELSE 'pending' END,
    meta_attempts = CASE WHEN status = 'sent' THEN attempts ELSE 0 END
WHERE created_at < now();

ALTER TABLE pe_lifecycle_outbox DROP CONSTRAINT IF EXISTS pe_lifecycle_outbox_status_chk;
ALTER TABLE pe_lifecycle_outbox
  ADD CONSTRAINT pe_lifecycle_outbox_status_chk
    CHECK (status IN ('pending', 'sent', 'failed', 'dead'));

ALTER TABLE pe_lifecycle_outbox
  ADD CONSTRAINT pe_lifecycle_outbox_local_status_chk
    CHECK (local_status IN ('pending', 'sent', 'failed', 'dead', 'skipped')),
  ADD CONSTRAINT pe_lifecycle_outbox_resend_status_chk
    CHECK (resend_status IN ('pending', 'sent', 'failed', 'dead', 'skipped')),
  ADD CONSTRAINT pe_lifecycle_outbox_meta_status_chk
    CHECK (meta_status IN ('pending', 'sent', 'failed', 'dead', 'skipped')),
  ADD CONSTRAINT pe_lifecycle_outbox_subject_chk
    CHECK ((owner_user_id IS NULL) <> (affiliate_partner_id IS NULL));

CREATE INDEX IF NOT EXISTS pe_lifecycle_outbox_due_idx
  ON pe_lifecycle_outbox (status, next_attempt_at);
