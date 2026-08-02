-- Phase A7 — performance fields on county_facet_coverage
-- (feat/ledger-performance-fields).
--
-- Extends the coverage/correctness ledger (0060) into the rewarmable-factory
-- PERFORMANCE layer: per-jurisdiction recipe version, cert progression,
-- rewarm/refresh timestamps, staleness + rewarm-safety flags, onboarding
-- cost, and onboarded status. Additive only — every column is nullable or
-- carries a default, so every pre-existing row stays valid with no backfill.
--
-- recipe_version    the recipe version the jurisdiction's atoms were warmed
--                    under (the rewarm trigger). NULL for rows predating
--                    recipe-version tracking.
-- cert_state        'uncerted' | 'mechanical-pass' | 'r6-pass' | 'certified'.
--                    NULL for rows predating cert tracking.
-- last_rewarm_at     when this jurisdiction was last rewarmed. NULL if never.
-- last_refresh_at    when this jurisdiction's sources were last re-acquired.
-- staleness_flag     true when source_vintage has aged past the refresh
--                    cadence. Defaults false.
-- rewarm_unsafe      true when an unfrozen sticky-part decision blocks a
--                    safe rewarm. Defaults false.
-- cost_usd           compute + human-review cost to onboard this
--                    jurisdiction, in USD, scored against the
--                    $200/jurisdiction hard-kill commitment. NULL until
--                    recorded.
-- onboarded          whether this jurisdiction has been through the
--                    onboarding line at all. Defaults false.

ALTER TABLE "county_facet_coverage"
  ADD COLUMN IF NOT EXISTS "recipe_version" text,
  ADD COLUMN IF NOT EXISTS "cert_state" text,
  ADD COLUMN IF NOT EXISTS "last_rewarm_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_refresh_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "staleness_flag" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "rewarm_unsafe" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "cost_usd" numeric(10, 2),
  ADD COLUMN IF NOT EXISTS "onboarded" boolean NOT NULL DEFAULT false;

ALTER TABLE "county_facet_coverage"
  ADD CONSTRAINT "county_facet_coverage_cert_state_check"
    CHECK ("cert_state" IS NULL OR "cert_state" IN
      ('uncerted', 'mechanical-pass', 'r6-pass', 'certified'));
