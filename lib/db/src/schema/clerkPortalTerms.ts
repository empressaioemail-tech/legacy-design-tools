import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export type ClerkPortalAutomatedSearch =
  | "permitted"
  | "tolerated"
  | "prohibited"
  | "unknown";

export type ClerkPortalCanaryStatus = "ok" | "lookup-failed";

/** P-85 WDLL item 1 — clerk portal terms and operator ruling. */
export const clerkPortalTerms = pgTable(
  "clerk_portal_terms",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    countyFips: text("county_fips").notNull(),
    portalId: text("portal_id").notNull(),
    portalUrl: text("portal_url").notNull(),
    termsUrl: text("terms_url"),
    termsText: text("terms_text").notNull(),
    termsFetchedAt: timestamp("terms_fetched_at", {
      withTimezone: true,
    }).notNull(),
    automatedSearch: text("automated_search")
      .notNull()
      .default("unknown")
      .$type<ClerkPortalAutomatedSearch>(),
    loginRequired: boolean("login_required").notNull().default(false),
    imagePurchase: jsonb("image_purchase").notNull().default({}),
    operatorRuledAt: timestamp("operator_ruled_at", { withTimezone: true }),
    operatorRulingNotes: text("operator_ruling_notes"),
    /** P-85 item 14 — daily canary selector drift; lookup-failed blocks new runs. */
    canaryStatus: text("canary_status").$type<ClerkPortalCanaryStatus>(),
    canaryCheckedAt: timestamp("canary_checked_at", { withTimezone: true }),
    canaryFailureReason: text("canary_failure_reason"),
    canaryRecipeVersion: text("canary_recipe_version"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    countyIdx: index("clerk_portal_terms_county_idx").on(t.countyFips),
    portalIdx: index("clerk_portal_terms_portal_idx").on(t.portalId),
    countyPortalUniq: uniqueIndex("clerk_portal_terms_county_portal_uniq").on(
      t.countyFips,
      t.portalId,
    ),
  }),
);

export type ClerkPortalTermsRow = typeof clerkPortalTerms.$inferSelect;
export type NewClerkPortalTermsRow = typeof clerkPortalTerms.$inferInsert;
