-- Task #29 / cc-agent-C — per-user ownership + shared identity (Cortex web + extension).
-- Backfill existing rows to the migration owner; new rows require an authenticated owner.

ALTER TABLE "engagements"
  ADD COLUMN IF NOT EXISTS "owner_user_id" text,
  ADD COLUMN IF NOT EXISTS "tenant_id" text NOT NULL DEFAULT 'default';

UPDATE "engagements"
SET "owner_user_id" = 'migration-owner'
WHERE "owner_user_id" IS NULL;

ALTER TABLE "engagements"
  ALTER COLUMN "owner_user_id" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "engagements_owner_user_id_idx"
  ON "engagements" ("owner_user_id");

CREATE INDEX IF NOT EXISTS "engagements_tenant_owner_idx"
  ON "engagements" ("tenant_id", "owner_user_id");

-- Extension anonymous brief history — install-scoped until claimed by a user.
ALTER TABLE "brokerage_brief_runs"
  ADD COLUMN IF NOT EXISTS "install_id" text,
  ADD COLUMN IF NOT EXISTS "owner_user_id" text;

CREATE INDEX IF NOT EXISTS "brokerage_brief_runs_install_id_idx"
  ON "brokerage_brief_runs" ("install_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "brokerage_brief_runs_owner_user_id_idx"
  ON "brokerage_brief_runs" ("owner_user_id", "created_at" DESC);

-- Workspace rows stay install-scoped; owner_user_id is set on sign-in claim only.
ALTER TABLE "brokerage_workspaces"
  ADD COLUMN IF NOT EXISTS "owner_user_id" text;

CREATE INDEX IF NOT EXISTS "brokerage_workspaces_owner_user_id_idx"
  ON "brokerage_workspaces" ("owner_user_id", "opened_at" DESC);

-- One install id may attach to exactly one user (sovereignty: no pooling).
CREATE TABLE IF NOT EXISTS "brokerage_install_claims" (
  "install_id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "brokerage_install_claims_owner_user_id_idx"
  ON "brokerage_install_claims" ("owner_user_id");

-- Per-user self-serve metering (usage count only — rail-quiet, not buyer-facing grade).
CREATE TABLE IF NOT EXISTS "user_usage_metering" (
  "owner_user_id" text NOT NULL,
  "meter_key" text NOT NULL,
  "period_start" date NOT NULL,
  "count" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("owner_user_id", "meter_key", "period_start")
);

-- Password credentials for cortex-api hosted login (no external IdP).
CREATE TABLE IF NOT EXISTS "user_auth_credentials" (
  "user_id" text PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "password_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_auth_credentials_email_uniq"
  ON "user_auth_credentials" ("email");
