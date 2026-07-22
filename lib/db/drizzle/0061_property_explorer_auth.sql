-- Property Explorer Wave 2 — OIDC identity links, user entitlements, saved properties.

CREATE TABLE IF NOT EXISTS pe_user_identities (
  id              text PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        text NOT NULL,
  subject         text NOT NULL,
  email           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pe_user_identities_provider_subject_uidx
  ON pe_user_identities (provider, subject);

CREATE INDEX IF NOT EXISTS pe_user_identities_user_idx
  ON pe_user_identities (user_id);

CREATE TABLE IF NOT EXISTS pe_user_entitlements (
  owner_user_id   text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id       text NOT NULL DEFAULT 'default',
  access_tier     text NOT NULL DEFAULT 'free',
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pe_user_entitlements_tenant_idx
  ON pe_user_entitlements (tenant_id);

CREATE TABLE IF NOT EXISTS pe_saved_properties (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL DEFAULT 'default',
  owner_user_id   text NOT NULL,
  parcel_node_id  text NOT NULL,
  label           text,
  snapshot        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pe_saved_properties_owner_parcel_uidx
  ON pe_saved_properties (tenant_id, owner_user_id, parcel_node_id);

CREATE INDEX IF NOT EXISTS pe_saved_properties_owner_idx
  ON pe_saved_properties (tenant_id, owner_user_id, updated_at);
