-- GTM MCP observation extension (76b Track C).
-- Event types validated in api-server; payload may include tool_name, error_class,
-- jurisdiction_key, api_key_hash (sha256 prefix, no raw keys).

ALTER TABLE "gtm_events"
  ALTER COLUMN "source_surface" SET DEFAULT 'api';

COMMENT ON COLUMN "gtm_events"."source_surface" IS
  'extension | api | mcp | docs | share_page';

CREATE INDEX IF NOT EXISTS "gtm_events_source_surface_created_at_idx"
  ON "gtm_events" ("source_surface", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "gtm_events_mcp_tool_payload_idx"
  ON "gtm_events" ((payload_json ->> 'tool_name'))
  WHERE event_type = 'mcp_tool_call';
