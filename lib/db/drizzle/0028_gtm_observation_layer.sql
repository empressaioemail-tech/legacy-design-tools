-- GTM observation layer (Empressa wedge): consent + structured events for operator loops.

CREATE TABLE IF NOT EXISTS "gtm_consent" (
  "install_id" text PRIMARY KEY NOT NULL,
  "consent_version" text NOT NULL,
  "terms_accepted_at" timestamp with time zone NOT NULL,
  "graph_opt_in" boolean DEFAULT false NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "gtm_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "install_id" text NOT NULL,
  "event_type" text NOT NULL,
  "source_surface" text DEFAULT 'extension' NOT NULL,
  "run_id" uuid,
  "listing_key" text,
  "persona_inferred" text,
  "consent_version" text,
  "graph_opt_in" text,
  "payload_json" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "gtm_events_install_id_created_at_idx"
  ON "gtm_events" ("install_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "gtm_events_event_type_created_at_idx"
  ON "gtm_events" ("event_type", "created_at" DESC);
