import { pgTable, text, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * User-profile lookup table for hydrating actor identities surfaced on
 * timeline / audit-trail responses.
 *
 * The `id` column is plain `text` (not a UUID, not an FK to anything) on
 * purpose: the api-server records actors as `{ kind, id }` where `id` is
 * whatever opaque identifier the upstream identity layer hands us — the
 * `pr_session` cookie carries arbitrary strings (`"u1"`, `"u_abc123"`,
 * eventually a Clerk/Replit Auth subject id), and the same id is later
 * written into `atom_events.actor.id`. We intentionally do NOT FK
 * `atom_events.actor.id → users.id` so a future identity-source swap or
 * a deleted profile cannot retroactively break the audit log — events
 * are the source of truth, the profile table is best-effort
 * presentation metadata.
 *
 * Only `kind === "user"` actors are looked up here. `agent` and `system`
 * actors carry their own stable display labels in code (e.g.
 * `snapshot-ingest`, `engagement-edit`) and are passed through unchanged
 * by the hydration helper.
 */
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    avatarUrl: text("avatar_url"),
    /**
     * DA-PI-6 — Optional per-architect override for the header text the
     * stakeholder-briefing PDF export prints on every page (default
     * "SmartCity Design Tools — Pre-Design Briefing"). The column is
     * deliberately not surfaced through any editor UI in this sprint:
     * the override is operator-set today (a single UPDATE in support
     * cases) and we want the schema slot reserved before the FE
     * settings surface lands so the PDF endpoint can read it without
     * waiting on the next migration window. Null → fall back to the
     * default header.
     */
    architectPdfHeader: text("architect_pdf_header"),
    /**
     * Track 1 — reviewer's ICC-aligned certification disciplines. Drives
     * the Inbox / Findings / CannedFindings / OutstandingRequests
     * default-filter ("show only my disciplines") with a "Show all"
     * toggle remembered per browser. Empty array on legacy rows /
     * non-reviewer accounts — the UI's "Show all" mode is the safe
     * fallback. CHECK constraint enforces the closed `PlanReviewDiscipline`
     * vocabulary at the DB layer; keep in lock-step with
     * `lib/api-zod/src/types/planReviewDiscipline.ts`.
     *
     * Distinct from `submissions.discipline` (4-value:
     * building/fire/zoning/civil) and the canned-findings library
     * `discipline` column (same 4-value tuple). The translation map
     * between this 7-value reviewer vocab and the 4-value canned-findings
     * vocab lives at query time on the canned-findings route — by
     * design, the three vocabularies coexist.
     */
    disciplines: text("disciplines")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    /**
     * Closed-set enforcement at the DB layer for the `PlanReviewDiscipline`
     * vocabulary. Kept literal because Drizzle's CHECK builder cannot
     * interpolate a TS array — pair this with the
     * `PLAN_REVIEW_DISCIPLINE_VALUES` tuple in `api-zod`.
     */
    disciplinesCheck: check(
      "users_disciplines_check",
      sql`${t.disciplines} <@ ARRAY['building','electrical','mechanical','plumbing','residential','fire-life-safety','accessibility']::text[]`,
    ),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
