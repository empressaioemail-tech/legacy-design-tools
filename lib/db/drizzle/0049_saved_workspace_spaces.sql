-- Phase 2 (shell experience) — server-persisted, shareable workspace spaces.
-- Replaces the localStorage-only saved-spaces store with a durable, per-owner
-- store so a named workspace layout survives a browser and can be shared.
--
-- Tenancy-ready by design. Tenancy/auth is NOT live yet (anonymous default
-- tenant), so rows are keyed today by the default tenant + the resolved
-- (anonymous or internal) owner id. The (tenant_id, owner_user_id) columns and
-- the uniqueness constraint are shaped so that when the auth build lands this
-- table becomes tenant-private cleanly (tenant-private accessPolicy) WITHOUT a
-- destructive migration: existing rows already carry a tenant + owner, and
-- per-user isolation is a WHERE-clause tightening, not a schema change.
--
-- `snapshot` holds the full SpaceSnapshot (tileIds, layoutId, colFr, rowFr,
-- layoutMode) as JSONB — the shell's persisted layout template (NamedLayout
-- model: named, updatable). `share_token` is nullable and unique; a non-null
-- token makes the space fetchable read-only by anyone holding the link.
CREATE TABLE saved_workspace_spaces (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL DEFAULT 'default',
  owner_user_id   text NOT NULL,
  name            text NOT NULL,
  snapshot        jsonb NOT NULL,
  share_token     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One space per (tenant, owner, name): save-by-name is an upsert. When auth
-- lands, isolation is already keyed on owner within tenant.
CREATE UNIQUE INDEX saved_workspace_spaces_owner_name_uidx
  ON saved_workspace_spaces (tenant_id, owner_user_id, name);

-- List a given owner's spaces newest-first.
CREATE INDEX saved_workspace_spaces_owner_idx
  ON saved_workspace_spaces (tenant_id, owner_user_id, updated_at);

-- Share-link lookup: fetch a space read-only by its token. Plain unique index
-- on a nullable column — Postgres treats NULLs as distinct, so un-shared rows
-- (share_token NULL) coexist while any minted token is unique. Matches the
-- drizzle schema so the fixture-drift check (which pushes the drizzle schema)
-- stays in sync.
CREATE UNIQUE INDEX saved_workspace_spaces_share_token_uidx
  ON saved_workspace_spaces (share_token);
