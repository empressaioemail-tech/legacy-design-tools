-- WDLL 2026-08-05 (pe_paywall_stripe_promo_dev_role) item 6 — anonymous
-- claim: per-user workbench UI-state upload target for `claim-local-state`.
-- One row per user; overwritten wholesale on each claim call (UI state, not
-- user content — unlike pe_saved_properties, which is merged not replaced).

CREATE TABLE IF NOT EXISTS pe_workbench_state (
  owner_user_id   text NOT NULL PRIMARY KEY,
  tenant_id       text NOT NULL DEFAULT 'default',
  state           jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_workbench_state_owner_user_id_users_id_fk
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);
