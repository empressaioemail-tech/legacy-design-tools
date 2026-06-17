#!/usr/bin/env node
/**
 * Ingest TX Comptroller SPDPID registry into tx-special-districts.json.
 * Usage: pnpm --filter @workspace/scripts exec tsx scripts/ingest-tx-special-districts.mjs
 */
import { ingestTxSpecialDistrictsFromComptroller } from "../artifacts/api-server/src/lib/txSpecialDistrictIngest.ts";

const result = await ingestTxSpecialDistrictsFromComptroller();
console.log(JSON.stringify(result, null, 2));
