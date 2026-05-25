import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

/**
 * Pilot workspace branding — single default row (`id = 'default'`).
 * QA-57: firm display name (+ optional logo URL) for Cortex workspace.
 */
export const workspaceSettings = pgTable("workspace_settings", {
  id: text("id").primaryKey().notNull().default("default"),
  firmDisplayName: text("firm_display_name")
    .notNull()
    .default("Cortex Workspace"),
  logoUrl: text("logo_url"),
  /** Hex accent (#RGB / #RRGGBB). Null = theme default (--cyan). */
  primaryColor: text("primary_color"),
  /** Jurisdiction, presentation, and storage defaults (see workspacePreferences). */
  preferences: jsonb("preferences")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  /** US state codes (uppercase), e.g. `["TX","UT"]`. Max 10. */
  practiceStates: jsonb("practice_states")
    .$type<string[]>()
    .notNull()
    .default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type WorkspaceSettings = typeof workspaceSettings.$inferSelect;
export type NewWorkspaceSettings = typeof workspaceSettings.$inferInsert;
