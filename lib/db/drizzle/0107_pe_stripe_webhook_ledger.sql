-- P-480 — append-only Stripe webhook delivery record + entitlement history.
--
-- Every state-changing Stripe delivery that touches pe_user_entitlements must
-- land a row here BEFORE the entitlement row changes. Replay is idempotent on
-- stripe_event_id. Prior entitlement states are copied to history with the
-- event that superseded them.

CREATE TABLE IF NOT EXISTS pe_stripe_webhook_events (
  stripe_event_id text PRIMARY KEY,
  event_type text NOT NULL,
  checkout_session_id text,
  amount_total_cents integer,
  currency text,
  livemode boolean NOT NULL,
  owner_user_id text
    CONSTRAINT pe_stripe_webhook_events_owner_user_id_users_id_fk
    REFERENCES users(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL,
  CONSTRAINT pe_stripe_webhook_events_stripe_event_id_chk
    CHECK (stripe_event_id <> ''),
  CONSTRAINT pe_stripe_webhook_events_event_type_chk
    CHECK (event_type <> ''),
  CONSTRAINT pe_stripe_webhook_events_outcome_chk
    CHECK (outcome <> '')
);

CREATE INDEX IF NOT EXISTS pe_stripe_webhook_events_owner_user_id_received_at_idx
  ON pe_stripe_webhook_events (owner_user_id, received_at);

CREATE TABLE IF NOT EXISTS pe_user_entitlement_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id text NOT NULL
    CONSTRAINT pe_user_entitlement_history_owner_user_id_users_id_fk
    REFERENCES users(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  access_tier text NOT NULL,
  dev_role boolean NOT NULL,
  entitlement_source text,
  stripe_customer_id text,
  subscription_tier text,
  seats_purchased integer,
  billing_interval text,
  superseded_at timestamptz NOT NULL DEFAULT now(),
  stripe_event_id text NOT NULL
    CONSTRAINT pe_user_entitlement_history_stripe_event_id_pe_stripe_webhook_e
    REFERENCES pe_stripe_webhook_events(stripe_event_id) ON DELETE RESTRICT,
  CONSTRAINT pe_user_entitlement_history_billing_interval_chk
    CHECK (billing_interval IS NULL OR billing_interval IN ('month', 'year'))
);

CREATE INDEX IF NOT EXISTS pe_user_entitlement_history_owner_user_id_superseded_at_idx
  ON pe_user_entitlement_history (owner_user_id, superseded_at);
