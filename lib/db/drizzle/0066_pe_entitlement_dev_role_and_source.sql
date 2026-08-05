-- WDLL 2026-08-05 (pe_paywall_stripe_promo_dev_role) item 1 — server-side
-- dev role + entitlement provenance + Stripe customer linkage on
-- pe_user_entitlements.
--
-- dev_role: operator-grantable boolean, checked by hasPeDevPaidBypass instead
-- of the PE_DEV_PAID_EMAILS / PE_DEV_PAID_SUBJECTS env allowlists. Grant/
-- revoke via the internal service-key route, no deploy required.
--
-- entitlement_source: records WHY a user is entitled — 'stripe_sub'
-- (subscription checkout), 'stripe_promo' (subscription checkout with a
-- 100%-off promo code applied), 'stripe_unlock' (one-time $15 property
-- unlock — informational only, the row of record for unlock is still
-- pe_property_unlocks.source), 'dev' (operator dev_role), null for free.
--
-- stripe_customer_id: links the PE user row to its Stripe Customer object
-- so subsequent checkouts reuse the same customer instead of minting a new
-- one per session (mirrors brokerage_wallets.stripe_customer_id).

ALTER TABLE pe_user_entitlements
  ADD COLUMN IF NOT EXISTS dev_role boolean NOT NULL DEFAULT false;

ALTER TABLE pe_user_entitlements
  ADD COLUMN IF NOT EXISTS entitlement_source text;

ALTER TABLE pe_user_entitlements
  ADD COLUMN IF NOT EXISTS stripe_customer_id text;
