import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { snapshots } from "./snapshots";

export const engagements = pgTable(
  "engagements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    // A04.7: name_lower is no longer UNIQUE. Two distinct Revit projects may
    // legitimately share a (case-insensitive) name; the matching identity is
    // now `revit_central_guid` / `revit_document_path` (silent auto-bind) or
    // an explicit user choice surfaced via POST /api/engagements/match.
    // The non-unique index below is retained for fast collision lookup.
    nameLower: text("name_lower").notNull(),
    jurisdiction: text("jurisdiction"),
    address: text("address"),
    // Free-text name of the applicant firm (architect / designer of
    // record) submitting plan-review packages for this engagement.
    // Nullable: legacy engagements created before this column landed
    // have no recorded applicant firm. Surfaced to reviewers in the
    // Plan Review Inbox so triage can identify "who submitted this"
    // without opening the engagement (Task #439).
    applicantFirm: text("applicant_firm"),
    status: text("status").notNull().default("active"),

    // Wave 1.2: site context fields (all nullable, additive)
    latitude: numeric("latitude", { precision: 9, scale: 6 }),
    longitude: numeric("longitude", { precision: 9, scale: 6 }),
    geocodedAt: timestamp("geocoded_at", { withTimezone: true }),
    geocodeSource: text("geocode_source"),
    jurisdictionCity: text("jurisdiction_city"),
    jurisdictionState: text("jurisdiction_state"),
    jurisdictionFips: text("jurisdiction_fips"),
    projectType: text("project_type"),
    zoningCode: text("zoning_code"),
    lotAreaSqft: numeric("lot_area_sqft"),
    siteContextRaw: jsonb("site_context_raw"),

    // A04.7: Revit binding identity. Both nullable — populated only when the
    // Revit add-in supplies them. revit_central_guid is the strong signal
    // (truly unique per Revit central file); revit_document_path is the
    // weaker fallback used for non-workshared files. Sticky on rebind: never
    // overwritten once set, even if the user picks the engagement from the
    // dropdown for a file with a different GUID.
    revitCentralGuid: text("revit_central_guid"),
    revitDocumentPath: text("revit_document_path"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    nameLowerIdx: index("engagements_name_lower_idx").on(t.nameLower),
    revitCentralGuidUniq: uniqueIndex("engagements_revit_central_guid_uniq")
      .on(t.revitCentralGuid)
      .where(sql`${t.revitCentralGuid} IS NOT NULL`),
  }),
);

export const engagementsRelations = relations(engagements, ({ many }) => ({
  snapshots: many(snapshots),
}));

export type Engagement = typeof engagements.$inferSelect;
export type NewEngagement = typeof engagements.$inferInsert;
