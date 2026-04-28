import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { snapshots } from "./snapshots";

export const engagements = pgTable(
  "engagements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    nameLower: text("name_lower").notNull().unique(),
    jurisdiction: text("jurisdiction"),
    address: text("address"),
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

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    nameLowerIdx: index("engagements_name_lower_idx").on(t.nameLower),
  }),
);

export const engagementsRelations = relations(engagements, ({ many }) => ({
  snapshots: many(snapshots),
}));

export type Engagement = typeof engagements.$inferSelect;
export type NewEngagement = typeof engagements.$inferInsert;
