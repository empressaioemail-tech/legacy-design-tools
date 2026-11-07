-- P-98 next-action rail: the activation event store, scoped to the PE user.
--
-- gtm_events is keyed on install_id, the browser extension's anonymous
-- install. A signed-in funnel is not measurable on it: two installs are one
-- account, one install is two accounts after a sign-out, and neither maps to
-- the pe_user_entitlements row the ladder reads to decide what to show. This
-- is therefore a separate table on the account spine, not a column bolted to
-- a store built for a different subject.
--
-- A row means one rung of the ladder was SHOWN, or its control was ACTED on.
-- It is not a conversion. The purchase is recorded by Stripe and by
-- pe_property_unlocks; reading `acted` as revenue counts an intent as an
-- outcome.

-- The FK is NAMED. An inline unnamed REFERENCES gets Postgres's `_fkey`
-- default, while `drizzle-kit push` (which is what CI's schema fixture is
-- dumped from) names it `_users_id_fk`. Same constraint, two names, and the
-- production database would then differ from every test database by a string
-- nobody would look at until it mattered. Naming it here makes them agree.
-- Migration 0090 carries the same note for the same reason.

-- WHY event_type IS CHECKED IN DDL AND action_id IS NOT.
-- The event grammar is closed at two values and is not expected to grow, so
-- freezing it here is safe and it stops writers the TypeScript union never
-- sees: a raw connection, a future job, a psql session.
-- The ladder's action vocabulary DOES grow, once per rung added. A value list
-- here would mean a new rung's events are refused until a migration lands,
-- and because the client drops failed activation events on purpose, that loss
-- would be silent -- the exact failure this table exists to prevent. The
-- closed action_id set is enforced at the route, where a refusal is a 400 the
-- caller can read. What IS frozen here is narrower and permanent: the id may
-- not be the empty string, which is the value a plain NOT NULL would admit.
--
-- surface is NULLABLE WITH NO DEFAULT. gtm_events.source_surface defaults to
-- 'api', which invents an attribution for every event that never carried one.
-- An event whose surface was not sent is UNMEASURED, and that is a different
-- fact from one that happened on a surface called 'api'. The check permits
-- null and forbids the empty string, so absent and present are the only two
-- states and a blank cannot impersonate a measurement.

CREATE TABLE IF NOT EXISTS pe_activation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id text NOT NULL
    CONSTRAINT pe_activation_events_owner_user_id_users_id_fk
    REFERENCES users(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  action_id text NOT NULL,
  surface text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_activation_events_event_type_chk
    CHECK (event_type IN ('shown', 'acted')),
  CONSTRAINT pe_activation_events_action_id_chk
    CHECK (action_id <> ''),
  CONSTRAINT pe_activation_events_surface_chk
    CHECK (surface IS NULL OR surface <> '')
);

-- "What has this account done recently" -- the ladder's own read.
CREATE INDEX IF NOT EXISTS pe_activation_events_owner_user_id_created_at_idx
  ON pe_activation_events (owner_user_id, created_at);

-- "How is this rung performing over time" -- the shown/acted ratio per action.
CREATE INDEX IF NOT EXISTS pe_activation_events_action_id_created_at_idx
  ON pe_activation_events (action_id, created_at);
