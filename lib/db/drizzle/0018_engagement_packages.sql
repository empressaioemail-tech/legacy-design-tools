-- Cockpit IA — engagement deliverable packages + client share links.
-- Additive: CREATE TABLE only (engagement_packages, package_shares, package_share_comments).

CREATE TABLE IF NOT EXISTS "engagement_packages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "engagement_id" uuid NOT NULL,
  "template" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "title" text NOT NULL,
  "snapshot_id" uuid,
  "selection" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "form_snapshot" jsonb,
  "client_review_deadline" timestamp with time zone,
  "linked_submission_id" uuid,
  "exported_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "engagement_packages_engagement_id_engagements_id_fk"
    FOREIGN KEY ("engagement_id") REFERENCES "engagements"("id")
    ON DELETE CASCADE,
  CONSTRAINT "engagement_packages_snapshot_id_snapshots_id_fk"
    FOREIGN KEY ("snapshot_id") REFERENCES "snapshots"("id")
    ON DELETE SET NULL,
  CONSTRAINT "engagement_packages_linked_submission_id_submissions_id_fk"
    FOREIGN KEY ("linked_submission_id") REFERENCES "submissions"("id")
    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "engagement_packages_engagement_created_idx"
  ON "engagement_packages" ("engagement_id", "created_at");

CREATE TABLE IF NOT EXISTS "package_shares" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "package_id" uuid NOT NULL,
  "token" text NOT NULL,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "package_shares_package_id_engagement_packages_id_fk"
    FOREIGN KEY ("package_id") REFERENCES "engagement_packages"("id")
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "package_shares_token_uniq"
  ON "package_shares" ("token");

CREATE INDEX IF NOT EXISTS "package_shares_package_idx"
  ON "package_shares" ("package_id");

CREATE TABLE IF NOT EXISTS "package_share_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "share_id" uuid NOT NULL,
  "author_name" text NOT NULL,
  "body" text NOT NULL,
  "sheet_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "package_share_comments_share_id_package_shares_id_fk"
    FOREIGN KEY ("share_id") REFERENCES "package_shares"("id")
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "package_share_comments_share_created_idx"
  ON "package_share_comments" ("share_id", "created_at");
