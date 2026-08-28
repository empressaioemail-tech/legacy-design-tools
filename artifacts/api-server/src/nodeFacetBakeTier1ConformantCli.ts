#!/usr/bin/env node
/**
 * F-06 Tier-1 facet bake from conformant-v1 hauska_mcp atoms (Bastrop publish).
 * County-scoped via jurisdiction_tenant + shape (never entity_id prefix alone).
 */
import pg from "pg";
import { TIER1_ADAPTER_KEY } from "./lib/nodeFacetTier1Constants.js";
import { contentHashForPayload } from "./lib/placeLayerUtils.js";
import { conformantCadCountyWhere } from "./lib/conformantStorePredicate.js";
import { assertAccessPair, assertSitusNotPunctuationOnly } from "./lib/serveGuards.js";

const PLACE_COORD_SENTINEL = "0.00000";

function placeKeyForNode(parcelNodeId: string): string {
  return `node:${parcelNodeId}`;
}

function parseArgs(argv: string[]) {
  const county = argv.find((a) => a.startsWith("--county="))?.split("=")[1] ?? "48021";
  const dryRun = argv.includes("--dry-run");
  return { county, dryRun };
}

function parcelNodeIdFromBody(body: Record<string, unknown>): string | null {
  const nodeId = body?.nodeId ?? (body?.claim as Record<string, unknown> | undefined)?.nodeId;
  if (typeof nodeId === "string" && nodeId.includes(":")) return nodeId;
  return null;
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
  const where = conformantCadCountyWhere(1);
  const { rows: cadRows } = await mcp.query(
    `SELECT entity_id, body FROM atoms WHERE ${where}`,
    [county],
  );
  let written = 0;
    let skippedNoNode = 0;
  for (const { body: rawBody } of cadRows) {
    const body = (rawBody ?? {}) as Record<string, unknown>;
    const parcelNodeId = parcelNodeIdFromBody(body);
    if (!parcelNodeId) {
      skippedNoNode += 1;
      continue;
    }
    const access = assertAccessPair(body.access);
    const claim = body.claim as Record<string, unknown> | undefined;
    const situs =
      (claim?.situsAddress as string | undefined) ?? (body.situsAddress as string | undefined) ?? null;
    assertSitusNotPunctuationOnly(situs);
    const payload = {
      shapeSource: "conformant-v1",
      baked: true,
      source: "conformant-v1-cad-parcel-roll",
      access,
      facets: {
        base: {
          parcelNodeId,
          situsAddress: situs,
          apn: parcelNodeId.split(":")[1] ?? null,
        },
      },
      facetCoverage: { tier1: "populated" },
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
        [
          placeKeyForNode(parcelNodeId),
          TIER1_ADAPTER_KEY,
          PLACE_COORD_SENTINEL,
          PLACE_COORD_SENTINEL,
          JSON.stringify(payload),
          contentHash,
        ],
      );
    }
    written += 1;
  }
  console.log(
    JSON.stringify({
      county,
      dryRun,
      conformantCadRows: cadRows.length,
      written,
      skippedNoNode,
    }),
  );
  await mcp.end();
  await neondb.end();
}

main().catch((err) => {
  console.error(err.code || err.message);
  process.exit(1);
});
