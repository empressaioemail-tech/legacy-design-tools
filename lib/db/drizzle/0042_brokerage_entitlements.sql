-- Brokerage entitlements: free-brief cap + Stripe subscription state on install wallet.

ALTER TABLE "brokerage_wallets"
  ADD COLUMN IF NOT EXISTS "free_briefs_used" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "subscription_tier" text,
  ADD COLUMN IF NOT EXISTS "subscription_status" text,
  ADD COLUMN IF NOT EXISTS "subscription_period_end" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "stripe_customer_id" text,
  ADD COLUMN IF NOT EXISTS "stripe_subscription_id" text;

-- Ledger kinds: top_up | compute_debit | auto_refill | adjustment | free_brief
