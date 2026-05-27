import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export type GtmEventPayload = Record<string, unknown>;

export const gtmEvents = pgTable(
  "gtm_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installId: text("install_id").notNull(),
    eventType: text("event_type").notNull(),
    sourceSurface: text("source_surface").notNull().default("extension"),
    runId: uuid("run_id"),
    listingKey: text("listing_key"),
    personaInferred: text("persona_inferred"),
    consentVersion: text("consent_version"),
    graphOptIn: text("graph_opt_in"),
    payloadJson: jsonb("payload_json").$type<GtmEventPayload>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("gtm_events_install_id_created_at_idx").on(
      t.installId,
      t.createdAt,
    ),
    index("gtm_events_event_type_created_at_idx").on(
      t.eventType,
      t.createdAt,
    ),
  ],
);
