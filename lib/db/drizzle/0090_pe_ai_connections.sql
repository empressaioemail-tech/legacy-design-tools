-- P-87 Claude Sync: the connected signal.
--
-- The Smart Site MCP server knew who every caller was and threw it away, so
-- "is Claude connected to this account" was not a knowable fact and the card
-- had nothing honest to render. One row per (account, MCP client name),
-- written only when the client NAMES ITSELF on the JSON-RPC initialize.
--
-- client_name is NOT NULL and has no default on purpose. An initialize that
-- carries no resolvable clientInfo.name writes NOTHING rather than a
-- placeholder: a row saying "connected to something" would flip the card to
-- its Sync state on a client we cannot name, which is the same defect as
-- asserting a connection we never observed. Absent and unnamed stay absent.
--
-- first_seen_at is the connect. last_seen_at is the most recent initialize,
-- which Claude performs per session, so it reads as "last seen" and never as
-- "last used" -- a tools/call is not what stamps this row.

-- The FK is NAMED. An inline unnamed REFERENCES gets Postgres's `_fkey`
-- default, while `drizzle-kit push` (which is what CI's schema fixture is
-- dumped from) names it `_users_id_fk`. Same constraint, two names, and the
-- production database would then differ from every test database by a string
-- nobody would look at until it mattered. Naming it here makes them agree.
CREATE TABLE IF NOT EXISTS pe_ai_connections (
  owner_user_id text NOT NULL
    CONSTRAINT pe_ai_connections_owner_user_id_users_id_fk
    REFERENCES users(id) ON DELETE CASCADE,
  client_name text NOT NULL,
  client_version text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pe_ai_connections_owner_client_uidx
  ON pe_ai_connections (owner_user_id, client_name);

CREATE INDEX IF NOT EXISTS pe_ai_connections_owner_idx
  ON pe_ai_connections (owner_user_id);
