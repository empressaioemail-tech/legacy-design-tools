#!/usr/bin/env node
/**
 * Wave R dollar-fields patch: stamp cad_property values onto existing
 * place_layer_snapshots. Does not rebuild zoning / envelope / land use.
 * NEVER reads cad-parcel-roll atoms.
 *
 * Usage: --county=<fips> [--dry-run] [--prop-ids=a.b.c] [--page-size=2000]
 * Env: DATABASE_URL (or DEPLOYMENT_DATABASE_URL). neondb only.
 */
import pg from "pg";
import { TIER1_ADAPTER_KEY } from "./lib/nodeFacetTier1Constants.js";
import { contentHashForPayload } from "./lib/placeLayerUtils.js";
import { fetchCountyCadPropertyRoll } from "./lib/joinIntegrityGate.js";
import {
  applyCadPropertyFactsToPayload,
  cadPropertyFactsFromRow,
} from "./lib/cadRollValue.js";

const DEFAULT_PAGE = 2000;

function parseArgs(argv: string[]) {
  const county = argv.find((a) => a.startsWith("--county="))?.split("=")[1];
  if (!county || !/^\d{5}$/.test(county)) {
    throw new Error("usage: --county=<5-digit fips> [--dry-run] [--prop-ids=a.b.c]");
  }
  const dryRun = argv.includes("--dry-run");
  const propIdsRaw = argv.find((a) => a.startsWith("--prop-ids="))?.split("=")[1];
  const propIds = propIdsRaw
    ? propIdsRaw.split(/[.|+]/).map((s) => s.trim()).filter(Boolean)
    : null;
  const pageSizeRaw = argv.find((a) => a.startsWith("--page-size="))?.split("=")[1];
  const pageSize =
    pageSizeRaw && Number.isFinite(Number(pageSizeRaw)) && Number(pageSizeRaw) > 0
      ? Number(pageSizeRaw)
      : DEFAULT_PAGE;
  return { county, dryRun, propIds, pageSize };
}

async function main() {
  const { county, dryRun, propIds, pageSize } = parseArgs(process.argv.slice(2));
  const neondbUrl = process.env.DATABASE_URL ?? process.env.DEPLOYMENT_DATABASE_URL;
  if (!neondbUrl) throw new Error("DATABASE_URL required");
  const neondb = new pg.Pool({
    connectionString: neondbUrl,
    ssl: { rejectUnauthorized: true },
    max: 2,
  });

  const dbName = await neondb.query("SELECT current_database() AS db, now() AS ts");
  const roll = await fetchCountyCadPropertyRoll(neondb, county);
  const prefix = `node:${county}:`;

  let scanned = 0;
  let patched = 0;
  let noCadRow = 0;
  let marketPresent = 0;
  let improvementZero = 0;
  let livingPresent = 0;
  let yearPresent = 0;
  let legalPresent = 0;
  let assessedPresent = 0;

  let afterKey: string | null = null;
  for (;;) {
    const page = await neondb.query<{
      place_key: string;
      payload_json: Record<string, unknown>;
    }>(
      `SELECT place_key, payload_json
         FROM place_layer_snapshots
        WHERE adapter_key = $1
          AND place_key LIKE $2
          AND ($3::text IS NULL OR place_key > $3)
        ORDER BY place_key
        LIMIT $4`,
      [TIER1_ADAPTER_KEY, `${prefix}%`, afterKey, pageSize],
    );
    if (page.rows.length === 0) break;
    afterKey = page.rows[page.rows.length - 1].place_key;

    const keys: string[] = [];
    const payloads: string[] = [];
    const hashes: string[] = [];
    for (const row of page.rows) {
      const propId = row.place_key.slice(prefix.length);
      if (propIds && !propIds.includes(propId)) continue;
      scanned += 1;
      const cad = roll.consulted ? (roll.byPropId.get(propId) ?? null) : null;
      if (!cad) noCadRow += 1;
      const facts = cadPropertyFactsFromRow(cad);
      if (facts.cadRoll.marketValue && facts.cadRoll.marketValue.v > 0) marketPresent += 1;
      if (facts.cadRoll.assessedValue != null) assessedPresent += 1;
      if (facts.cadRoll.improvementValue?.v === 0) improvementZero += 1;
      if (facts.cadRoll.livingAreaSqft) livingPresent += 1;
      if (facts.yearBuilt) yearPresent += 1;
      if (facts.legalDescription) legalPresent += 1;

      const next = applyCadPropertyFactsToPayload(row.payload_json, facts);
      keys.push(row.place_key);
      payloads.push(JSON.stringify(next));
      hashes.push(contentHashForPayload(next));
      patched += 1;
    }
    if (!dryRun && keys.length > 0) {
      await neondb.query(
        `UPDATE place_layer_snapshots AS s
            SET payload_json = v.payload::jsonb,
                content_hash = v.hash,
                snapshot_at = now(),
                updated_at = now()
           FROM unnest($1::text[], $2::text[], $3::text[]) AS v(place_key, payload, hash)
          WHERE s.adapter_key = $4
            AND s.place_key = v.place_key`,
        [keys, payloads, hashes, TIER1_ADAPTER_KEY],
      );
    }
  }

  console.log(
    JSON.stringify({
      county,
      dryRun,
      current_database: dbName.rows[0].db,
      ts: dbName.rows[0].ts,
      cadPropertyConsulted: roll.consulted,
      cadPropertyRows: roll.byPropId.size,
      declaredTaxYear: roll.declaredTaxYear,
      scanned,
      patched,
      noCadRow,
      marketPresent,
      assessedPresent,
      improvementZero,
      livingPresent,
      yearPresent,
      legalPresent,
    }),
  );
  await neondb.end();
}

main().catch((err) => {
  console.error(err.code || err.message);
  process.exit(1);
});
