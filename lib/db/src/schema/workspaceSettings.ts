import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type WorkspaceSettings = typeof workspaceSettings.$inferSelect;
export type NewWorkspaceSettings = typeof workspaceSettings.$inferInsert;
