-- Investor radar per-user profile (tenant-private, keyed by owner_user_id).

CREATE TABLE IF NOT EXISTS "brokerage_user_profiles" (
  "owner_user_id" text PRIMARY KEY NOT NULL,
  "tenant_slug" text DEFAULT 'default' NOT NULL,
  "package_tier" text DEFAULT 'free' NOT NULL,
  "buy_box_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "investor_profile_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "dialogue_by_clip_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "depth_meter_remaining" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "brokerage_user_profiles_package_tier_check"
    CHECK ("package_tier" IN ('free', 'pro', 'max'))
);

CREATE INDEX IF NOT EXISTS "brokerage_user_profiles_tenant_idx"
  ON "brokerage_user_profiles" ("tenant_slug");
