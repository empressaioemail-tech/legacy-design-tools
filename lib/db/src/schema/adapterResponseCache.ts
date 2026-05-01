import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  numeric,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Federal-adapter response cache — Task #180.
 *
 * Each row caches one `(adapter_key, lat_rounded, lng_rounded)` lookup
 * for a configurable TTL (default ~24h, set by the api-server). The
 * runner consults the cache before invoking an adapter and writes the
 * row through after a successful run, so a re-run of
 * `POST /api/engagements/:id/generate-layers` against the same parcel
 * skips the slow / rate-limited federal feeds (FEMA NFHL, USGS EPQS,
 * EPA EJScreen, FCC broadband).
 *
 * Coordinate columns are stored as `numeric(9, 5)` so the unique index
 * is a stable equality match (no float-precision drift) and the round-
 * to-5-decimals contract from `lib/adapters/src/cache.ts` is enforced
 * at the storage layer too.
 *
 * `result_payload` carries the full `AdapterResult` envelope verbatim
 * — the runner replays it on a hit without re-deriving anything, so
 * cache hits produce wire-identical envelopes to a fresh run.
 *
 * `expires_at` is the TTL gate; readers filter on `expires_at > now()`.
 * No background sweep is required to enforce correctness — expired
 * rows just stop serving and get overwritten on the next run via the
 * unique index's `ON CONFLICT DO UPDATE` upsert. Task #203 added a
 * periodic capacity-only sweep (`startAdapterCacheSweepWorker` in
 * `artifacts/api-server/src/lib/adapterCache.ts`) that deletes rows
 * already past their TTL plus a grace window, in bounded batches —
 * this keeps the table from growing without bound for parcels that
 * are looked up once and never re-cached, but it is not required for
 * correctness.
 */
export const adapterResponseCache = pgTable(
  "adapter_response_cache",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Stable `<jurisdiction-key>:<source-name>` slug from the adapter. */
    adapterKey: text("adapter_key").notNull(),
    /** Latitude rounded to 5 decimal places (~1.1m). */
    latRounded: numeric("lat_rounded", { precision: 9, scale: 5 }).notNull(),
    /** Longitude rounded to 5 decimal places. */
    lngRounded: numeric("lng_rounded", { precision: 9, scale: 5 }).notNull(),
    /** Full `AdapterResult` envelope — replayed verbatim on hits. */
    resultPayload: jsonb("result_payload").notNull(),
    /** TTL gate — readers filter `expires_at > now()`. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    /**
     * One row per (adapter, parcel) — the upsert path relies on this
     * so a re-run with a fresh TTL replaces the old row in place.
     */
    uniq: uniqueIndex("adapter_response_cache_uniq").on(
      t.adapterKey,
      t.latRounded,
      t.lngRounded,
    ),
    /**
     * Lets a cleanup pass cheaply find expired rows; not required for
     * correctness but keeps the table from growing without bound.
     */
    expiresIdx: index("adapter_response_cache_expires_idx").on(t.expiresAt),
  }),
);

export type AdapterResponseCacheRow = typeof adapterResponseCache.$inferSelect;
export type NewAdapterResponseCacheRow =
  typeof adapterResponseCache.$inferInsert;
