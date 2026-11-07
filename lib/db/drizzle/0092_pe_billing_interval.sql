-- P-98 next-action rail: the billing interval a paid subscription is on.
--
-- The rail's highest-value rung, `annual_upgrade`, was STARVED: nothing in
-- pe_user_entitlements could tell it whether a subscriber pays monthly.
-- The columns were ownerUserId, tenantId, accessTier, devRole,
-- entitlementSource, stripeCustomerId, updatedAt, subscriptionTier,
-- seatsPurchased. None of them carries an interval.
--
-- NULLABLE, AND NEVER DEFAULTED.
-- Absent means unknown, and unknown is a real and common state here: every
-- row written before this migration has one, and nothing backfills them
-- (a backfill would have to call Stripe, which this card refuses). A DDL
-- default of 'month' would fabricate a fact about somebody's billing, and
-- the rail would then offer "switch to annual" to annual subscribers --
-- the single worst output this column can produce. Absent, monthly, and
-- annual are three different states and this column keeps them apart.
--
-- WHY THE CHECK IS IN DDL.
-- The grammar is closed at two values and does not grow: it mirrors
-- Stripe's `month` / `year` recurring intervals for the two price groups we
-- configure (STRIPE_*_PRICE_ID and STRIPE_*_ANNUAL_PRICE_ID), and there is
-- no third price group to add. Freezing it here refuses writers the
-- TypeScript union never sees -- a raw connection, a future job, a psql
-- session -- and in particular refuses 'monthly', the plausible-looking
-- string a hand-written UPDATE would reach for. NULL is admitted because
-- unknown is legitimate; the empty string is not admitted, because a blank
-- must never be able to impersonate a measurement. Same shape and same
-- reasoning as pe_saved_properties_crm_status_chk in 0088.
--
-- The value is DERIVED, never read off a Stripe API field. The webhook maps
-- the billed price id back through our own configured env price ids
-- (`peBillingIntervalForPriceId` in pePaywallStripe.ts, the inverse of
-- `stripePriceIdForPeTier`). A price id matching nothing we configured
-- writes NULL. This deliberately avoids current_period_end and
-- price.recurring.interval, whose shapes track the Stripe API version, and
-- nothing in this repo pins one.

ALTER TABLE pe_user_entitlements
  ADD COLUMN IF NOT EXISTS billing_interval text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pe_user_entitlements_billing_interval_chk'
  ) THEN
    ALTER TABLE pe_user_entitlements
      ADD CONSTRAINT pe_user_entitlements_billing_interval_chk
      CHECK (
        billing_interval IS NULL
        OR billing_interval IN ('month', 'year')
      );
  END IF;
END $$;
