-- 0083: Smart Site LOCKED 2026-08-10 pricing-ladder support.
--
-- pe_user_entitlements.subscription_tier — which ladder rung ('solo' |
-- 'studio' | 'team') a paid subscription is on. NULL for free users,
-- unlock-only users, and legacy pre-ladder subscriptions (read as solo,
-- never silently upgraded). access_tier stays the binary is-a-subscriber
-- flag every existing gate reads.
--
-- pe_property_unlocks.expires_at — the 30-day bound on the $15 per-property
-- unlock ("$15, 30 days — not forever"). NULL = no expiry (rows written
-- before this migration, and operator dev unlocks). Stripe-sourced unlocks
-- always carry unlocked_at + 30 days. Entitlement reads treat an expired
-- row as absent.

ALTER TABLE pe_user_entitlements
  ADD COLUMN IF NOT EXISTS subscription_tier text;

ALTER TABLE pe_property_unlocks
  ADD COLUMN IF NOT EXISTS expires_at timestamp with time zone;
