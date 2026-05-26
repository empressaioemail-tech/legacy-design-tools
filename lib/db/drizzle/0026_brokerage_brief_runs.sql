-- Hauska Property Brief Chrome extension — persisted brief runs for research chat.

CREATE TABLE IF NOT EXISTS "brokerage_brief_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_slug" text DEFAULT 'default' NOT NULL,
  "listing_key" text NOT NULL,
  "address" text NOT NULL,
  "payload_json" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "brokerage_brief_runs_listing_key_idx"
  ON "brokerage_brief_runs" ("listing_key", "created_at" DESC);
