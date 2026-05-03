-- PLR-10: tenant-scoped canned-finding library.
CREATE TABLE IF NOT EXISTS "canned_findings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text NOT NULL,
  "discipline" text NOT NULL,
  "title" text NOT NULL,
  "default_body" text NOT NULL,
  "severity" text NOT NULL,
  "category" text NOT NULL,
  "color" text DEFAULT '#6b7280' NOT NULL,
  "code_atom_citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "canned_findings_discipline_check"
    CHECK ("discipline" IN ('building', 'fire', 'zoning', 'civil')),
  CONSTRAINT "canned_findings_severity_check"
    CHECK ("severity" IN ('blocker', 'concern', 'advisory')),
  CONSTRAINT "canned_findings_category_check"
    CHECK ("category" IN ('setback', 'height', 'coverage', 'egress',
                          'use', 'overlay-conflict',
                          'divergence-related', 'other'))
);

CREATE INDEX IF NOT EXISTS "canned_findings_tenant_discipline_idx"
  ON "canned_findings" ("tenant_id", "discipline");
