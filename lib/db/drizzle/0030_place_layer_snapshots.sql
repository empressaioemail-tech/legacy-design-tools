-- Permanent place-layer archive for Property Brief (Regrid Premium, FEMA, future ICC).
-- Read before adapter fetch; write after successful run. Complements 24h adapter_response_cache.

CREATE TABLE IF NOT EXISTS "place_layer_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "place_key" text NOT NULL,
  "adapter_key" text NOT NULL,
  "lat_rounded" numeric(9, 5) NOT NULL,
  "lng_rounded" numeric(9, 5) NOT NULL,
  "ll_uuid" text,
  "payload_json" jsonb NOT NULL,
  "content_hash" text NOT NULL,
  "snapshot_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "place_layer_snapshots_adapter_place_uidx"
  ON "place_layer_snapshots" ("adapter_key", "place_key");

CREATE INDEX IF NOT EXISTS "place_layer_snapshots_coord_idx"
  ON "place_layer_snapshots" ("adapter_key", "lat_rounded", "lng_rounded");

-- Stable parcel identity on brokerage workspaces (from Regrid ll_uuid when available).

ALTER TABLE "brokerage_workspaces"
  ADD COLUMN IF NOT EXISTS "ll_uuid" text,
  ADD COLUMN IF NOT EXISTS "latitude" numeric(9, 6),
  ADD COLUMN IF NOT EXISTS "longitude" numeric(9, 6);

CREATE INDEX IF NOT EXISTS "brokerage_workspaces_ll_uuid_idx"
  ON "brokerage_workspaces" ("ll_uuid")
  WHERE "ll_uuid" IS NOT NULL;
