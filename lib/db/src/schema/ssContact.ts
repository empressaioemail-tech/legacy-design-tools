import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * P-492 — the Smart Site contact record, system of record for the lifecycle
 * (`_decisions/2026-10-03_ghl_retired_lifecycle_to_resend.md`).
 *
 * Written only by the outbox's `local` leg (the projection), one transaction
 * per event. Resend receives a copy of the contract properties; this row is
 * the truth they are read from.
 *
 * Nothing parcel-shaped lives here: counts, dates, plan, stage, source, first
 * name and first-touch UTMs only.
 */

export type SsStage = "Explorer" | "Sharer" | "Unlock" | "Solo" | "Studio" | "Team";
export type SsPlanValue = "free" | "unlock" | "solo" | "studio" | "team";
export type SsBillingValue = "monthly" | "annual" | "none";
export type SsSourceValue = "ad" | "group" | "page" | "share" | "direct";

export const ssContact = pgTable(
  "ss_contact",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    firstName: text("first_name"),
    stage: text("stage").notNull().$type<SsStage>().default("Explorer"),
    plan: text("plan").notNull().$type<SsPlanValue>().default("free"),
    billing: text("billing").notNull().$type<SsBillingValue>().default("none"),
    /** Null when first-touch UTMs matched no row of the source table. */
    source: text("source").$type<SsSourceValue>(),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmContent: text("utm_content"),
    savedLots: integer("saved_lots").notNull().default(0),
    shares: integer("shares").notNull().default(0),
    lastActive: date("last_active"),
    quiet: boolean("quiet").notNull().default(false),
    quietSince: timestamp("quiet_since", { withTimezone: true }),
    claudeConnected: boolean("claude_connected").notNull().default(false),
    becameSharerAt: timestamp("became_sharer_at", { withTimezone: true }),
    /** Set once the Resend leg has put this contact in the Smart Site segment. */
    resendSegmentAt: timestamp("resend_segment_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("ss_contact_quiet_last_active_idx").on(t.quiet, t.lastActive),
    check(
      "ss_contact_stage_chk",
      sql`${t.stage} IN ('Explorer', 'Sharer', 'Unlock', 'Solo', 'Studio', 'Team')`,
    ),
    check(
      "ss_contact_plan_chk",
      sql`${t.plan} IN ('free', 'unlock', 'solo', 'studio', 'team')`,
    ),
    check(
      "ss_contact_billing_chk",
      sql`${t.billing} IN ('monthly', 'annual', 'none')`,
    ),
    check(
      "ss_contact_source_chk",
      sql`${t.source} IS NULL OR ${t.source} IN ('ad', 'group', 'page', 'share', 'direct')`,
    ),
    check("ss_contact_email_chk", sql`${t.email} <> ''`),
  ],
);

export type SsContact = typeof ssContact.$inferSelect;
export type NewSsContact = typeof ssContact.$inferInsert;

/**
 * P-492 3f — affiliate recruiting pipeline. Not a Smart Site user: an
 * affiliate may never have an account. First name and email are the only
 * fields that leave for Resend (their own segment).
 */
export const AFFILIATE_STAGES = [
  "identified",
  "contacted",
  "applied",
  "approved",
  "link_issued",
  "first_conversion",
] as const;

export type AffiliateStage = (typeof AFFILIATE_STAGES)[number];

export const affiliatePartner = pgTable(
  "affiliate_partner",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    firstName: text("first_name"),
    /** Where they publish (a channel or site URL); operator context only. */
    channelUrl: text("channel_url"),
    stage: text("stage").notNull().$type<AffiliateStage>(),
    identifiedAt: timestamp("identified_at", { withTimezone: true }),
    contactedAt: timestamp("contacted_at", { withTimezone: true }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    linkIssuedAt: timestamp("link_issued_at", { withTimezone: true }),
    firstConversionAt: timestamp("first_conversion_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("affiliate_partner_email_uidx").on(t.email),
    index("affiliate_partner_stage_idx").on(t.stage),
    check(
      "affiliate_partner_stage_chk",
      sql`${t.stage} IN ('identified', 'contacted', 'applied', 'approved', 'link_issued', 'first_conversion')`,
    ),
    check("affiliate_partner_email_chk", sql`${t.email} <> ''`),
  ],
);

export type AffiliatePartner = typeof affiliatePartner.$inferSelect;
export type NewAffiliatePartner = typeof affiliatePartner.$inferInsert;

/**
 * P-492 — one row per scheduled drain tick, so "did the drain fire" is a
 * query, not a log search. Pruned to 7 days by the drain itself.
 */
export const ssLifecycleDrainRun = pgTable(
  "ss_lifecycle_drain_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    host: text("host").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    claimed: integer("claimed").notNull().default(0),
    sent: integer("sent").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    dead: integer("dead").notNull().default(0),
    quietEnqueued: integer("quiet_enqueued").notNull().default(0),
    claudeEnqueued: integer("claude_enqueued").notNull().default(0),
    error: text("error"),
  },
  (t) => [index("ss_lifecycle_drain_run_started_idx").on(t.startedAt)],
);

export type SsLifecycleDrainRun = typeof ssLifecycleDrainRun.$inferSelect;
