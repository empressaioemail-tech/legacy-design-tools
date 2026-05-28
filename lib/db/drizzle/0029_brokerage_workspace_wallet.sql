-- Brokerage V1: property workspaces, attachments, shares, wallet ledger.

CREATE TABLE IF NOT EXISTS "brokerage_workspaces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "install_id" text NOT NULL,
  "listing_key" text NOT NULL,
  "address" text NOT NULL,
  "source_listing_url" text,
  "latest_run_id" uuid,
  "opened_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "brokerage_workspaces_install_listing_key_uidx"
  ON "brokerage_workspaces" ("install_id", "listing_key");

CREATE INDEX IF NOT EXISTS "brokerage_workspaces_install_opened_idx"
  ON "brokerage_workspaces" ("install_id", "opened_at" DESC);

CREATE TABLE IF NOT EXISTS "brokerage_workspace_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "brokerage_workspaces"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "uri" text,
  "body" text,
  "title" text,
  "created_by_install_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "brokerage_workspace_attachments_workspace_idx"
  ON "brokerage_workspace_attachments" ("workspace_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "brokerage_workspace_shares" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "brokerage_workspaces"("id") ON DELETE CASCADE,
  "owner_install_id" text NOT NULL,
  "share_token" text NOT NULL,
  "collaborator_install_id" text,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "brokerage_workspace_shares_token_uidx"
  ON "brokerage_workspace_shares" ("share_token");

CREATE TABLE IF NOT EXISTS "brokerage_wallets" (
  "install_id" text PRIMARY KEY NOT NULL,
  "balance_cents" integer DEFAULT 0 NOT NULL,
  "auto_refill_enabled" boolean DEFAULT false NOT NULL,
  "auto_refill_failed_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "brokerage_wallet_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "install_id" text NOT NULL,
  "amount_cents" integer NOT NULL,
  "kind" text NOT NULL,
  "reference" text,
  "balance_after_cents" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "brokerage_wallet_ledger_install_created_idx"
  ON "brokerage_wallet_ledger" ("install_id", "created_at" DESC);
