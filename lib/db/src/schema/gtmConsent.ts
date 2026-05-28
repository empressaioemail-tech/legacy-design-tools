import { pgTable, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const gtmConsent = pgTable("gtm_consent", {
  installId: text("install_id").primaryKey(),
  consentVersion: text("consent_version").notNull(),
  termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true })
    .notNull(),
  graphOptIn: boolean("graph_opt_in").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
