-- P-100 share-loop and funnel instrumentation. Three tables, three subjects.
--
-- NONE of these is a second gtm_events store. gtm_events keeps its single
-- writer set and keeps recording funnel events; what is added here is (1) the
-- join that credits a signup to a sharer, (2) the once-per-account activation
-- milestone, and (3) the durable record of an event this system REFUSED to
-- write. Each is a fact gtm_events cannot express, not a copy of one it can.
--
-- The FKs are NAMED, per the note in migrations 0090 and 0091: an inline
-- unnamed REFERENCES gets Postgres's `_fkey` default while `drizzle-kit push`
-- (which is what the CI schema fixture is dumped from) names it
-- `_users_id_fk`. Same constraint, two names, production silently differing
-- from every test database.

-- ---------------------------------------------------------------------------
-- 1. pe_share_attributions -- which sharer does this account belong to
-- ---------------------------------------------------------------------------
--
-- WHAT A ROW MEANS. This account was created by someone who arrived through
-- that share grant. Nothing else. It is not a purchase, not a referral
-- payment, and not a claim that the share caused the signup -- it records the
-- path, and the path is the only thing observable.
--
-- WHY THE GRANT ID AND NOT A SHARER ID FROM THE CLIENT. `pe_share_grants`
-- already holds `grantor_user_id`, written server-side by the mint route
-- (P-86). The recipient's browser holds the grant id because it is in the URL
-- it was handed; it does not, and must not, get to say WHO the sharer is.
-- The route resolves the grantor from the grant row. A request body that
-- names a sharer is refused rather than ignored, because ignoring it leaves
-- the caller believing it set one.
--
-- WHY grantor_user_id IS NOT STORED HERE. It is one join away and storing it
-- would create two values that must agree and can drift. The grant row is the
-- single source of truth for who shared.
--
-- FIRST TOUCH WINS, AND THE DATABASE ENFORCES IT. recipient_user_id is the
-- PRIMARY KEY, so a second attribution for the same account cannot be
-- written -- not by a race, not by a retry, not by a raw connection. A
-- read-then-write "check if already attributed" would have lost that race.
--
-- SELF-ATTRIBUTION IS A CHECK, NOT A ROUTE RULE. A sharer opening their own
-- link and signing in again must never credit themselves. The route refuses
-- it too, but the constraint is what makes the refusal unbypassable.
--
-- ON DELETE CASCADE on grant_id: `pe_share_grants.grantor_user_id` cascades
-- off `users`, so deleting a sharer's account removes their grants. This row
-- must go with them -- an attribution to a deleted sharer is an orphan, and
-- RESTRICT here would instead BLOCK the account deletion, which is worse.
--
-- REVOKED AND EXPIRED GRANTS STILL ATTRIBUTE. Revocation and expiry govern
-- ACCESS to the shared property, not the historical fact that this recipient
-- arrived through this link. Refusing attribution on a revoked grant would
-- silently drop a real signup, which is the failure this table exists to
-- prevent.

CREATE TABLE IF NOT EXISTS pe_share_attributions (
  recipient_user_id text PRIMARY KEY
    CONSTRAINT pe_share_attributions_recipient_user_id_users_id_fk
    REFERENCES users(id) ON DELETE CASCADE,
  grant_id text NOT NULL
    CONSTRAINT pe_share_attributions_grant_id_pe_share_grants_id_fk
    REFERENCES pe_share_grants(id) ON DELETE CASCADE,
  -- Where the attribution was captured. NULLABLE WITH NO DEFAULT: an
  -- attribution whose surface was not sent is UNMEASURED, which is a
  -- different fact from one captured on a surface named 'api'.
  surface text,
  attributed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_share_attributions_surface_chk
    CHECK (surface IS NULL OR surface <> '')
);

-- "How many signups does this sharer have" -- the share-loop readout's join.
CREATE INDEX IF NOT EXISTS pe_share_attributions_grant_id_idx
  ON pe_share_attributions (grant_id);

CREATE INDEX IF NOT EXISTS pe_share_attributions_attributed_at_idx
  ON pe_share_attributions (attributed_at);

-- ---------------------------------------------------------------------------
-- 2. pe_account_activations -- the first time an account did a thing
-- ---------------------------------------------------------------------------
--
-- WHY THIS IS NOT pe_activation_events. That table (migration 0091) records
-- "a next-action ladder rung was SHOWN, or its control was ACTED on", many
-- rows per account per rung, with event_type frozen at shown/acted. A
-- once-per-account milestone is a different subject, and folding it in would
-- make every P-98 shown/acted ratio wrong by counting milestones as
-- impressions. Two subjects, two tables.
--
-- ONCE PER ACCOUNT IS THE COMPOSITE PRIMARY KEY. Not a route check, not a
-- SELECT-then-INSERT. The writer uses ON CONFLICT DO NOTHING and reads the
-- surviving row back, so a re-fire returns the ORIGINAL first_at and reports
-- that it was not the first time. A second row is unrepresentable.
--
-- THE MILESTONE SET IS CLOSED IN DDL, unlike pe_activation_events.action_id.
-- The asymmetry is deliberate and is the same reasoning inverted: the ladder's
-- action vocabulary grows once per rung added, so a DDL list there would
-- silently drop a new rung's events until a migration landed. This vocabulary
-- is three values fixed by the card that asked for it (P-100 item 4) and is
-- not expected to grow. Freezing it here stops writers the TypeScript union
-- never sees: a raw connection, a future job, a psql session.

CREATE TABLE IF NOT EXISTS pe_account_activations (
  owner_user_id text NOT NULL
    CONSTRAINT pe_account_activations_owner_user_id_users_id_fk
    REFERENCES users(id) ON DELETE CASCADE,
  milestone text NOT NULL,
  surface text,
  first_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_account_activations_pkey PRIMARY KEY (owner_user_id, milestone),
  CONSTRAINT pe_account_activations_milestone_chk
    CHECK (milestone IN (
      'first_parcel_inspected',
      'first_property_saved',
      'first_report_opened'
    )),
  CONSTRAINT pe_account_activations_surface_chk
    CHECK (surface IS NULL OR surface <> '')
);

-- "How many accounts reached each milestone, and when" -- the activation read.
CREATE INDEX IF NOT EXISTS pe_account_activations_milestone_first_at_idx
  ON pe_account_activations (milestone, first_at);

-- ---------------------------------------------------------------------------
-- 3. gtm_event_refusals -- the events this system declined to fabricate
-- ---------------------------------------------------------------------------
--
-- WHY A REFUSAL NEEDS A TABLE. `recordGtmEvent` stamped `consent_version`
-- from `input.consentVersion ?? null` and none of its fourteen call sites
-- passed one, so 741 of 11,518 rows in production carry a null consent that
-- can never be filled in -- consent flags cannot be retrofitted. The fix is
-- that the writer resolves consent from `gtm_consent` and REFUSES when there
-- is none. A refusal that leaves no name is how an unattributed non-write
-- becomes unanswerable, so the refusal is itself a durable record naming the
-- event type, the install, the reason and the time.
--
-- Measured before the change (2026-09-01, production): of the 741 null-consent
-- rows, 459 (62%) belong to installs that DO have a consent row and will now
-- be stamped correctly; 282 (38%, 94 distinct installs) do not and will now
-- land here instead of entering the table as a fabricated null.
--
-- NO FK ON install_id, matching gtm_events: an install id is a client-minted
-- identifier, not an account, and a refusal for an unknown install is exactly
-- the case worth recording.
--
-- reason IS NOT VALUE-CHECKED IN DDL, and the asymmetry is the same one
-- migration 0091 records for action_id: the reason vocabulary grows whenever a
-- new refusal condition is added, and a DDL list would mean a new refusal
-- reason is itself silently refused. The closed set lives at the writer, where
-- it is a compile error. What is frozen here is narrower and permanent: the
-- reason may not be the empty string, which is the value a plain NOT NULL
-- would admit.

CREATE TABLE IF NOT EXISTS gtm_event_refusals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  install_id text NOT NULL,
  event_type text NOT NULL,
  source_surface text NOT NULL,
  reason text NOT NULL,
  refused_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gtm_event_refusals_reason_chk CHECK (reason <> ''),
  CONSTRAINT gtm_event_refusals_event_type_chk CHECK (event_type <> ''),
  CONSTRAINT gtm_event_refusals_install_id_chk CHECK (install_id <> '')
);

-- "What is this system declining to record, and is that number moving" --
-- the readout's refusal count.
CREATE INDEX IF NOT EXISTS gtm_event_refusals_refused_at_idx
  ON gtm_event_refusals (refused_at);

CREATE INDEX IF NOT EXISTS gtm_event_refusals_event_type_refused_at_idx
  ON gtm_event_refusals (event_type, refused_at);
