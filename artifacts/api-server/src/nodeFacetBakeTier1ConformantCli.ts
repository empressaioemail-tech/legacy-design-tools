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
  const propIdsRaw = argv.find((a) => a.startsWith("--prop-ids="))?.split("=")[1];
  const propIds = propIdsRaw
    ? propIdsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  return { county, dryRun, propIds };
}

function parcelNodeIdFromBody(body: Record<string, unknown>, countyFips: string): string | null {
  const nodeId = body?.nodeId ?? (body?.claim as Record<string, unknown> | undefined)?.nodeId;
  if (typeof nodeId === "string" && nodeId.includes(":")) return nodeId;
  const src =
    (body?.sourceIdentifiers as Record<string, unknown> | undefined) ??
    ((body?.claim as Record<string, unknown> | undefined)?.sourceIdentifiers as
      | Record<string, unknown>
      | undefined);
  const propId = src?.prop_id;
  if (typeof propId === "string" && propId.trim() !== "") return `${countyFips}:${propId.trim()}`;
  if (typeof propId === "number" && Number.isFinite(propId)) return `${countyFips}:${propId}`;
  return null;
}

function situsForBake(body: Record<string, unknown>): { situs: string | null; refuse: boolean } {
  const claim = body.claim as Record<string, unknown> | undefined;
  const raw =
    (claim?.situsAddress as string | undefined) ?? (body.situsAddress as string | undefined) ?? null;
  if (raw == null || raw === "") return { situs: null, refuse: false };
  try {
    return { situs: assertSitusNotPunctuationOnly(raw), refuse: false };
  } catch {
    return { situs: null, refuse: true };
  }
}

async function main() {
  const { county, dryRun, propIds } = parseArgs(process.argv.slice(2));
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
  const params: Array<string | string[]> = [county];
  let propFilter = "";
  if (propIds?.length) {
    propFilter = ` AND body->'sourceIdentifiers'->>'prop_id' = ANY($2::text[])`;
    params.push(propIds);
  }
  const { rows: cadRows } = await mcp.query(
    `SELECT entity_id, body FROM atoms WHERE ${where}${propFilter}`,
    params,
  );
  let written = 0;
  let skippedNoNode = 0;
  let skippedBadSitus = 0;
  for (const { body: rawBody } of cadRows) {
    const body = (rawBody ?? {}) as Record<string, unknown>;
    const parcelNodeId = parcelNodeIdFromBody(body, county);
    if (!parcelNodeId) {
      skippedNoNode += 1;
      continue;
    }
    if (propIds && !propIds.includes(parcelNodeId.split(":")[1] ?? "")) {
      continue;
    }
    const access = assertAccessPair(body.access);
    const { situs, refuse: refuseSitus } = situsForBake(body);
    if (refuseSitus) {
      skippedBadSitus += 1;
      continue;
    }
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
      propIds,
      conformantCadRows: cadRows.length,
      written,
      skippedNoNode,
      skippedBadSitus,
    }),
  );
  await mcp.end();
  await neondb.end();
}

main().catch((err) => {
  console.error(err.code || err.message);
  process.exit(1);
});
