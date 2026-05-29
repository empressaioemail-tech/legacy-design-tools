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

export const placeLayerSnapshots = pgTable(
  "place_layer_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    placeKey: text("place_key").notNull(),
    adapterKey: text("adapter_key").notNull(),
    latRounded: numeric("lat_rounded", { precision: 9, scale: 5 }).notNull(),
    lngRounded: numeric("lng_rounded", { precision: 9, scale: 5 }).notNull(),
    llUuid: text("ll_uuid"),
    payloadJson: jsonb("payload_json").notNull(),
    contentHash: text("content_hash").notNull(),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("place_layer_snapshots_adapter_place_uidx").on(
      t.adapterKey,
      t.placeKey,
    ),
    index("place_layer_snapshots_coord_idx").on(
      t.adapterKey,
      t.latRounded,
      t.lngRounded,
    ),
  ],
);
