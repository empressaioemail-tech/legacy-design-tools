import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * PLR-10 / SD-3 / SD-7 — tenant-scoped canned-finding library.
 *
 * Curated by tenant admins (gated on `settings:manage`), consumed by
 * reviewers as a "Library" picker on the FindingsTab. Each entry is
 * scoped to a single discipline and a single tenant; archived entries
 * are kept (soft-delete via `archivedAt`) so historic references stay
 * resolvable.
 *
 * Tenant model is a plain `text` column today: the project does not
 * yet have a `tenants` table, so the library is keyed by an opaque
 * tenant id (defaulting to `DEFAULT_TENANT_ID` below). When a real
 * tenants table lands the column flips to a uuid FK without a wire
 * change.
 */

export const CANNED_FINDING_DISCIPLINE_VALUES = [
  "building",
  "fire",
  "zoning",
  "civil",
] as const;
export type CannedFindingDiscipline =
  (typeof CANNED_FINDING_DISCIPLINE_VALUES)[number];

/**
 * Default tenant id used by the FE today. The route accepts any
 * tenant id string; this constant is the placeholder until a real
 * tenants table + session-bound tenant resolution lands.
 */
export const DEFAULT_TENANT_ID = "default";

export const cannedFindings = pgTable(
  "canned_findings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: text("tenant_id").notNull(),
    discipline: text("discipline").notNull(),
    title: text("title").notNull(),
    defaultBody: text("default_body").notNull(),
    severity: text("severity").notNull(),
    category: text("category").notNull(),
    /** Hex color (`#RRGGBB`) used by the picker chip. */
    color: text("color").notNull().default("#6b7280"),
    /**
     * Pre-loaded code-section citations. Array of
     * `{ kind: "code-section", atomId: string }`; matches the wire
     * shape `findings.citations` carries so the picker can copy the
     * array verbatim into a manual-add finding.
     */
    codeAtomCitations: jsonb("code_atom_citations")
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Soft-delete column. NULL = active, set = archived. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantDisciplineIdx: index("canned_findings_tenant_discipline_idx").on(
      t.tenantId,
      t.discipline,
    ),
    disciplineCheck: check(
      "canned_findings_discipline_check",
      sql`${t.discipline} IN ('building', 'fire', 'zoning', 'civil')`,
    ),
    severityCheck: check(
      "canned_findings_severity_check",
      sql`${t.severity} IN ('blocker', 'concern', 'advisory')`,
    ),
    categoryCheck: check(
      "canned_findings_category_check",
      sql`${t.category} IN ('setback', 'height', 'coverage', 'egress', 'use', 'overlay-conflict', 'divergence-related', 'other')`,
    ),
  }),
);

export type CannedFinding = typeof cannedFindings.$inferSelect;
export type NewCannedFinding = typeof cannedFindings.$inferInsert;
