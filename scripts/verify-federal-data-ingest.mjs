#!/usr/bin/env node
/**
 * Run live federal data ingests and verify OZ + MUD/PID resolve real records.
 *
 * Usage:
 *   node scripts/verify-federal-data-ingest.mjs
 *   BROKERAGE_FEDERAL_DATA_DIR=./var/brokerage-federal-data node scripts/verify-federal-data-ingest.mjs
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ingestOpportunityZonesFromHud } from "../artifacts/api-server/src/lib/ozTractIngest.ts";
import { ingestTxSpecialDistrictsFromComptroller } from "../artifacts/api-server/src/lib/txSpecialDistrictIngest.ts";
import {
  __resetOzTractCacheForTests,
  loadOzTractFixture,
  lookupOpportunityZone,
} from "../artifacts/api-server/src/lib/opportunityZoneAdapter.ts";
import {
  __resetTxSpecialDistrictCacheForTests,
  loadTxSpecialDistrictRegistry,
  matchTxSpecialDistricts,
} from "../artifacts/api-server/src/lib/mudPidRegistry.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir =
  process.env.BROKERAGE_FEDERAL_DATA_DIR?.trim() ??
  join(repoRoot, "var", "brokerage-federal-data");

process.env.BROKERAGE_FEDERAL_DATA_DIR = dataDir;
mkdirSync(join(dataDir, "opportunity-zones"), { recursive: true });

console.log("Ingesting OZ tracts from HUD...");
const oz = await ingestOpportunityZonesFromHud();
console.log(JSON.stringify(oz, null, 2));

console.log("Ingesting TX SPDPID registry from Comptroller...");
const spd = await ingestTxSpecialDistrictsFromComptroller();
console.log(JSON.stringify(spd, null, 2));

__resetOzTractCacheForTests();
__resetTxSpecialDistrictCacheForTests();

const ozCollection = loadOzTractFixture();
if (ozCollection.features.length < 100) {
  throw new Error(
    `OZ ingest too small (${ozCollection.features.length} features) — expected national tract set`,
  );
}

// Travis County OZ tract from live HUD ingest (GEOID 48453002435).
const ozHit = lookupOpportunityZone({
  latitude: 30.146886,
  longitude: -97.632124,
});
if (!ozHit.inOpportunityZone) {
  throw new Error(
    `OZ point-in-polygon miss at Travis OZ test coord — got ${JSON.stringify(ozHit)}`,
  );
}
if (!ozHit.tractGeoid?.startsWith("48453")) {
  throw new Error(`OZ tract geoid ${ozHit.tractGeoid} — expected Travis County tract`);
}

const registry = loadTxSpecialDistrictRegistry();
if (registry.length < 500) {
  throw new Error(
    `SPDPID registry too small (${registry.length} districts) — expected live Comptroller export`,
  );
}
if (registry.some((d) => d.name.includes("Sample Travis MUD"))) {
  throw new Error("SPDPID registry still contains CI sample fixture rows");
}

const mudHit = matchTxSpecialDistricts(
  "Tax bill includes Fort Bend County Municipal Utility District #2 assessment",
);
if (mudHit.length === 0) {
  throw new Error("MUD/PID registry did not match a known live Comptroller district name");
}

console.log(
  JSON.stringify(
    {
      ok: true,
      dataDir,
      ozFeatureCount: ozCollection.features.length,
      ozHit,
      spdDistrictCount: registry.length,
      mudMatch: mudHit[0],
    },
    null,
    2,
  ),
);
