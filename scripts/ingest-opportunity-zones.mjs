#!/usr/bin/env node
/**
 * Ingest CDFI/HUD Opportunity Zone tracts into versioned GeoJSON.
 * Usage: pnpm --filter @workspace/scripts exec tsx scripts/ingest-opportunity-zones.mjs [--version oz-1.0]
 */
import { ingestOpportunityZonesFromHud } from "../artifacts/api-server/src/lib/ozTractIngest.ts";

const version = process.argv.includes("--version")
  ? process.argv[process.argv.indexOf("--version") + 1]
  : undefined;

const result = await ingestOpportunityZonesFromHud({ version });
console.log(JSON.stringify(result, null, 2));
