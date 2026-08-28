#!/usr/bin/env node
/** F-06 Tier-2 conformant bake stub for publish lane. */
import pg from "pg";
import { TIER2_ADAPTER_KEY } from "./lib/nodeFacetTier2Constants.js";
import { contentHashForPayload } from "./lib/placeLayerUtils.js";

const PLACE_COORD_SENTINEL = "0.00000";

function parseArgs(argv: string[]) {
  const county = argv.find((a) => a.startsWith("--county="))?.split("=")[1] ?? "48021";
  const dryRun = argv.includes("--dry-run");
  return { county, dryRun };
}

async function main() {
  const { county, dryRun } = parseArgs(process.argv.slice(2));
  const neondbUrl = process.env.DATABASE_URL ?? process.env.DEPLOYMENT_DATABASE_URL;
  if (!neondbUrl) throw new Error("DATABASE_URL required");
  const neondb = new pg.Client({ connectionString: neondbUrl, ssl: { rejectUnauthorized: true } });
  await neondb.connect();
  const { rows } = await neondb.query(
    `SELECT place_key FROM place_layer_snapshots
      WHERE adapter_key = 'node-facets:tier1'
        AND place_key LIKE $1
        AND coalesce(payload_json->>'shapeSource', '') = 'conformant-v1'`,
    [`node:${county}:%`],
  );
  let written = 0;
  for (const { place_key: placeKey } of rows) {
    const payload = {
      shapeSource: "conformant-v1",
      baked: true,
      source: "conformant-v1-tier2-stub",
      flood: null,
      envelope: null,
      bakedAt: new Date().toISOString(),
    };
    const contentHash = contentHashForPayload(payload);
    if (!dryRun) {
      await neondb.query(
        `INSERT INTO place_layer_snapshots
           (place_key, adapter_key, lat_rounded, lng_rounded, ll_uuid, payload_json, content_hash, snapshot_at)
         VALUES ($1, $2, $3::numeric, $4::numeric, NULL, $5::jsonb, $6, now())
         ON CONFLICT (adapter_key, place_key) DO UPDATE
           SET payload_json = EXCLUDED.payload_json,
               content_hash = EXCLUDED.content_hash,
               snapshot_at = EXCLUDED.snapshot_at`,
        [placeKey, TIER2_ADAPTER_KEY, PLACE_COORD_SENTINEL, PLACE_COORD_SENTINEL, JSON.stringify(payload), contentHash],
      );
    }
    written += 1;
  }
  console.log(JSON.stringify({ county, dryRun, written }));
  await neondb.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
