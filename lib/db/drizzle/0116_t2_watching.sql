-- T2-WATCH (Smart Site mobile, 2026-10-22) — the Watching tab.
--
-- WRITTEN, NOT RUN by the lane. The integration seat applies it before the
-- cortex build that carries `artifacts/api-server/src/lib/peWatching.ts`
-- deploys (the detector and the /api/watching routes read these tables).
--
-- Every saved property is watched. The detector reads each saved parcel
-- through the one-door record read, compares the watched facts with the last
-- snapshot, and writes one row per change. Push subscriptions are Web Push
-- (VAPID) endpoints per device.
--
-- All three tables cascade off users (account delete clears them); the
-- duplicate-account merge moves them (peAccountMerge.ts TABLES).
-- Column order matches the drizzle schema (lib/db/src/schema/peWatching.ts),
-- which is what CI's `drizzle-kit push` + fixture drift check compares.

CREATE TABLE IF NOT EXISTS pe_watch_snapshots (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_user_id text NOT NULL
    CONSTRAINT pe_watch_snapshots_owner_user_id_users_id_fk
    REFERENCES users(id) ON DELETE CASCADE,
  parcel_node_id text NOT NULL,
  facts_hash text,
  facts jsonb DEFAULT '{}'::jsonb NOT NULL,
  checked_at timestamp with time zone DEFAULT now() NOT NULL,
  last_read_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS pe_watch_snapshots_owner_parcel_uidx
  ON pe_watch_snapshots (owner_user_id, parcel_node_id);
CREATE INDEX IF NOT EXISTS pe_watch_snapshots_checked_idx
  ON pe_watch_snapshots (checked_at);

CREATE TABLE IF NOT EXISTS pe_watch_changes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_user_id text NOT NULL
    CONSTRAINT pe_watch_changes_owner_user_id_users_id_fk
    REFERENCES users(id) ON DELETE CASCADE,
  parcel_node_id text NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  detected_at timestamp with time zone DEFAULT now() NOT NULL,
  seen_at timestamp with time zone,
  source_url text,
  CONSTRAINT pe_watch_changes_kind_chk CHECK (
    kind IN ('flood_map', 'zoning_case', 'appraisal', 'records_request', 'record_update')
  )
);

CREATE INDEX IF NOT EXISTS pe_watch_changes_owner_detected_idx
  ON pe_watch_changes (owner_user_id, detected_at);

CREATE TABLE IF NOT EXISTS pe_push_subscriptions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_user_id text NOT NULL
    CONSTRAINT pe_push_subscriptions_owner_user_id_users_id_fk
    REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  keys jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  last_ok_at timestamp with time zone,
  failures integer DEFAULT 0 NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS pe_push_subscriptions_endpoint_uidx
  ON pe_push_subscriptions (endpoint);
CREATE INDEX IF NOT EXISTS pe_push_subscriptions_owner_idx
  ON pe_push_subscriptions (owner_user_id);
