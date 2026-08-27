#!/usr/bin/env node
/**
 * F-06 Tier-1 facet bake from conformant-v1 hauska_mcp atoms (Bastrop publish).
 */
import pg from "pg";
import { TIER1_ADAPTER_KEY } from "./lib/nodeFacetTier1Constants.js";
import { assertAccessPair, assertSitusNotPunctuationOnly } from "./lib/serveGuards.js";

function placeKeyForNode(parcelNodeId: string): string {
  return `node:${parcelNodeId}`;
}

function parseArgs(argv: string[]) {
  const county = argv.find((a) => a.startsWith("--county="))?.split("=")[1] ?? "48021";
  const dryRun = argv.includes("--dry-run");
  return { county, dryRun };
}

async function main() {
  const { county, dryRun } = parseArgs(process.argv.slice(2));
  const mcpUrl = process.env.HAUSKA_MCP_DATABASE_URL;
  const neondbUrl = process.env.DATABASE_URL ?? process.env.DEPLOYMENT_DATABASE_URL;
  if (!mcpUrl || !neondbUrl) {
    throw new Error("HAUSKA_MCP_DATABASE_URL and DATABASE_URL required");
  }
  const mcp = new pg.Client({ connectionString: mcpUrl, ssl: { rejectUnauthorized: true } });
  const neondb = new pg.Client({ connectionString: neondbUrl, ssl: { rejectUnauthorized: true } });
  await mcp.connect();
  await neondb.connect();
  const { rows: aliases } = await mcp.query(
    `SELECT body->>'aliasKey' AS alias_key, node_id
       FROM atoms
      WHERE entity_type = 'identity.alias'
        AND body->>'aliasKey' LIKE $1`,
    [`${county}:%`],
  );
  let written = 0;
  for (const { alias_key: aliasKey, node_id: nodeId } of aliases) {
    const { rows: cadRows } = await mcp.query(
      `SELECT body FROM atoms
        WHERE node_id = $1 AND entity_type = 'cad-parcel-roll'
          AND body->>'shape' = 'conformant-v1'
        LIMIT 1`,
      [nodeId],
    );
    if (cadRows.length === 0) continue;
    const body = cadRows[0].body ?? {};
    const access = assertAccessPair(body.access);
    const situs = body.claim?.situsAddress ?? body.situsAddress ?? null;
    assertSitusNotPunctuationOnly(situs);
    const payload = {
      shapeSource: "conformant-v1",
      access,
      facets: {
        base: {
          parcelNodeId: aliasKey,
          situsAddress: situs,
          apn: aliasKey.split(":")[1] ?? null,
        },
      },
      facetCoverage: { tier1: "populated" },
    };
    if (!dryRun) {
      await neondb.query(
        `INSERT INTO place_layer_snapshots (place_key, adapter_key, payload_json, snapshot_at)
         VALUES ($1, $2, $3::jsonb, now())
         ON CONFLICT (place_key, adapter_key) DO UPDATE
           SET payload_json = EXCLUDED.payload_json, snapshot_at = EXCLUDED.snapshot_at`,
        [placeKeyForNode(aliasKey), TIER1_ADAPTER_KEY, JSON.stringify(payload)],
      );
    }
    written += 1;
  }
  console.log(JSON.stringify({ county, dryRun, aliasCount: aliases.length, written }));
  await mcp.end();
  await neondb.end();
}

main().catch((err) => {
  console.error(err.code || err.message);
  process.exit(1);
});
