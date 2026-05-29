-- PB-301 R4 — brokerage property-workspace encumbrances (listing_key + install_id).

ALTER TABLE "recorded_instruments" ALTER COLUMN "engagement_id" DROP NOT NULL;

ALTER TABLE "recorded_instruments" ADD COLUMN IF NOT EXISTS "listing_key" text;
ALTER TABLE "recorded_instruments" ADD COLUMN IF NOT EXISTS "install_id" text;

CREATE INDEX IF NOT EXISTS "recorded_instruments_listing_install_idx"
  ON "recorded_instruments" ("install_id", "listing_key");

ALTER TABLE "recorded_instruments" DROP CONSTRAINT IF EXISTS "recorded_instruments_scope_check";
ALTER TABLE "recorded_instruments" ADD CONSTRAINT "recorded_instruments_scope_check"
  CHECK (
    "engagement_id" IS NOT NULL
    OR ("listing_key" IS NOT NULL AND "install_id" IS NOT NULL)
  );
