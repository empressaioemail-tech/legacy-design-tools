import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const SCREEN_RESOLUTIONS = [
  "resolved",
  "ambiguous",
  "unresolved",
] as const;
export type ScreenResolution = (typeof SCREEN_RESOLUTIONS)[number];

export const SCREEN_SOURCES = [
  "pasted",
  "chrome",
  "gmail",
  "file",
  "walk",
  "saved",
] as const;
export type ScreenSource = (typeof SCREEN_SOURCES)[number];

export const peScreens = pgTable(
  "pe_screens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: text("tenant_id").notNull().default("default"),
    ownerUserId: text("owner_user_id").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("pe_screens_owner_updated_idx").on(
      t.tenantId,
      t.ownerUserId,
      t.updatedAt,
    ),
  ],
);

export const peScreenRows = pgTable(
  "pe_screen_rows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    screenId: uuid("screen_id")
      .notNull()
      .references(() => peScreens.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    query: text("query").notNull(),
    parcelNodeId: text("parcel_node_id"),
    resolution: text("resolution").notNull(),
    source: text("source").notNull(),
    candidates: jsonb("candidates"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("pe_screen_rows_screen_ordinal_idx").on(t.screenId, t.ordinal),
    uniqueIndex("pe_screen_rows_screen_node_uidx")
      .on(t.screenId, t.parcelNodeId)
      .where(sql`${t.parcelNodeId} IS NOT NULL`),
    check(
      "pe_screen_rows_resolution_chk",
      sql`${t.resolution} IN ('resolved', 'ambiguous', 'unresolved')`,
    ),
    check(
      "pe_screen_rows_source_chk",
      sql`${t.source} IN ('pasted', 'chrome', 'gmail', 'file', 'walk', 'saved')`,
    ),
    check(
      "pe_screen_rows_resolved_node_chk",
      sql`(${t.resolution} = 'resolved') = (${t.parcelNodeId} IS NOT NULL)`,
    ),
    check(
      "pe_screen_rows_ambiguous_candidates_chk",
      sql`(
        (${t.resolution} = 'ambiguous')
        =
        (
          ${t.candidates} IS NOT NULL
          AND jsonb_typeof(${t.candidates}) = 'array'
          AND jsonb_array_length(${t.candidates}) > 0
        )
      )`,
    ),
    check(
      "pe_screen_rows_query_present_chk",
      sql`char_length(btrim(${t.query})) > 0`,
    ),
  ],
);

export type PeScreen = typeof peScreens.$inferSelect;
export type PeScreenRow = typeof peScreenRows.$inferSelect;
