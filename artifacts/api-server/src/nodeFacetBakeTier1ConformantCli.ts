#!/usr/bin/env node
/**
 * F-06 Tier-1 facet bake from conformant-v1 hauska_mcp atoms (publish lane).
 * County-scoped via jurisdiction_tenant + shape (never entity_id prefix alone).
 *
 * 2026-08-28 (OPS-19 A-025, CTX card E): the bake projects the FULL Tier-1
 * facet set the old txgio-keyed bake projected — `baseFacts` from the CAD
 * claim, `zoning` from the same zoning-stamp join on `txgio_parcel` keyed by
 * parcel node id, `envelope` from the same derivation, `facetCoverage` and
 * `provenance` from the same predicates — through the shared assembly in
 * `./lib/nodeFacetTier1Assemble.ts` (import, not a fork). Where a facet has
 * no source for a parcel the key is present with an explicit absence.
 * `shapeSource`, `access` (canonical pair), `publishRunId`, `source` and
 * `facets.base` are kept. Tier 2 is untouched (SS-W16).
 *
 * The parcel join is gated by the same effective block set the old bake
 * uses (coverage-ledger `block` verdicts UNION the seed): in a blocked
 * county a CAD prop_id matched into a divergent TxGIO numbering attaches
 * another parcel's stamp and ring, so the prop_id join is refused. Those
 * counties recover on situs address plus the per-match owner gate
 * (`addressJoinKey` + `resolveAddressLandUse`): a recovered land-use
 * carries `source: cad-roll-address-join`, and a situs-keyed `txgio_parcel`
 * row may write ring, centroid, and zoning stamp. `parcelJoin.state` is
 * `joined-situs` on recovery. Owner never enters a payload
 * (`assertNoOwnerKey` before every write). The seed is not lifted.
 *
 * Coordinates: the ring centroid is written when a ring exists; on conflict
 * the 0,0 sentinel never overwrites a real prior coordinate (the serve's
 * city-limits query point reads it).
 *
 * Usage: --county=<fips> [--prop-ids=a.b.c] [--dry-run] [--page-size=5000]
 *        [--shape=conformant-v1]   (accepted for the publish job; the shape
 *                                   predicate is fixed to conformant-v1)
 * Env: HAUSKA_MCP_DATABASE_URL, DATABASE_URL (or DEPLOYMENT_DATABASE_URL),
 *      PUBLISH_RUN_ID (stamped when set). Prints one JSON summary line.
 */
import pg from "pg";
import { TIER1_ADAPTER_KEY } from "./lib/nodeFacetTier1Constants.js";
import { contentHashForPayload } from "./lib/placeLayerUtils.js";
import { conformantCadCountyWhere } from "./lib/conformantStorePredicate.js";
import { normalizeAccessPair, assertSitusNotPunctuationOnly } from "./lib/serveGuards.js";
import {
  fetchCountyLandUseByAddress,
  loadLedgerBlockedFips,
  resolveAddressLandUse,
} from "./lib/joinIntegrityGate.js";
import { addressJoinKey, normalizeSitusAddress } from "./lib/joinNormalize.js";
import { ringCentroid } from "./lib/nodeFacetBakeTier1.js";
import { COUNTY_NAMES, effectiveBlockedFips, firstRing } from "./lib/nodeFacetTier1Assemble.js";
import {
  fetchParcelRowsByPropIds,
  fetchParcelRowsBySitusKeys,
  resolveParcelTableForCounty,
  type ParcelJoinRow,
  type ParcelTableSource,
} from "./lib/nodeFacetTier1ParcelJoin.js";
import {
  assertNoOwnerKey,
  buildConformantTier1Payload,
  parcelNodeIdFromBody,
  TIER1_CONFORMANT_FACET_SCHEMA_VERSION,
} from "./lib/nodeFacetBakeTier1Conformant.js";

const PLACE_COORD_SENTINEL = "0.00000";
const JOIN_CHUNK = 5000;
const DEFAULT_PARCEL_TABLE = "txgio_parcel";

function placeKeyForNode(parcelNodeId: string): string {
  return `node:${parcelNodeId}`;
}

function parseArgs(argv: string[]) {
  const county = argv.find((a) => a.startsWith("--county="))?.split("=")[1] ?? "48021";
  const dryRun = argv.includes("--dry-run");
  const propIdsRaw = argv.find((a) => a.startsWith("--prop-ids="))?.split("=")[1];
  const propIds = propIdsRaw
    ? propIdsRaw.split(/[.|+]/).map((s) => s.trim()).filter(Boolean)
    : null;
  const pageSizeRaw = argv.find((a) => a.startsWith("--page-size="))?.split("=")[1];
  const pageSize = pageSizeRaw && Number.isFinite(Number(pageSizeRaw)) && Number(pageSizeRaw) > 0
    ? Number(pageSizeRaw)
    : JOIN_CHUNK;
  return { county, dryRun, propIds, pageSize };
}

function publishRunIdFromEnv(): string | undefined {
  const id = process.env.PUBLISH_RUN_ID?.trim();
  return id || undefined;
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

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Join parcel rows for the node ids' prop ids, keyed by prop_id. A prop id
 * with several features keeps the first by feature_index (deterministic) and
 * is counted so the summary shows it.
 */
async function joinParcelRows(
  neondb: pg.Pool,
  county: string,
  src: ParcelTableSource,
  propIds: string[],
  pageSize: number,
): Promise<{ byPropId: Map<string, ParcelJoinRow>; multiFeature: number }> {
  const byPropId = new Map<string, ParcelJoinRow>();
  const seenMulti = new Set<string>();
  for (const ids of chunk(propIds, pageSize)) {
    const rows = await fetchParcelRowsByPropIds(neondb, county, src, ids, false);
    for (const row of rows) {
      const pid = row.prop_id?.trim();
      if (!pid) continue;
      if (byPropId.has(pid)) {
        seenMulti.add(pid);
        continue;
      }
      byPropId.set(pid, row);
    }
  }
  return { byPropId, multiFeature: seenMulti.size };
}

/**
 * Join parcel rows for normalized situs keys. First feature_index wins on a
 * colliding situs. Used only after the county's prop_id join is refused.
 */
async function joinParcelRowsBySitus(
  neondb: pg.Pool,
  county: string,
  src: ParcelTableSource,
  situsKeys: string[],
  pageSize: number,
): Promise<{ bySitus: Map<string, ParcelJoinRow>; multiFeature: number }> {
  const bySitus = new Map<string, ParcelJoinRow>();
  const seenMulti = new Set<string>();
  for (const keys of chunk(situsKeys, pageSize)) {
    const rows = await fetchParcelRowsBySitusKeys(neondb, county, src, keys);
    for (const row of rows) {
      const key = normalizeSitusAddress(row.situs_address);
      if (!key) continue;
      if (bySitus.has(key)) {
        seenMulti.add(key);
        continue;
      }
      bySitus.set(key, row);
    }
  }
  return { bySitus, multiFeature: seenMulti.size };
}

async function main() {
  const { county, dryRun, propIds, pageSize } = parseArgs(process.argv.slice(2));
  const mcpUrl = process.env.HAUSKA_MCP_DATABASE_URL;
  const neondbUrl = process.env.DATABASE_URL ?? process.env.DEPLOYMENT_DATABASE_URL;
  if (!mcpUrl || !neondbUrl) {
    throw new Error("HAUSKA_MCP_DATABASE_URL and DATABASE_URL required");
  }
  const mcp = new pg.Client({ connectionString: mcpUrl, ssl: { rejectUnauthorized: true } });
  const neondb = new pg.Pool({
    connectionString: neondbUrl,
    ssl: { rejectUnauthorized: true },
    max: 2,
  });
  await mcp.connect();
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

  // Pass 1: identity. No node id -> no stable key -> never invented.
  let skippedNoNode = 0;
  const work: Array<{ body: Record<string, unknown>; parcelNodeId: string }> = [];
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
    work.push({ body, parcelNodeId });
  }

  // The parcel join, gated exactly as the old bake gates its prop_id join.
  // Blocked counties refuse prop_id and recover on situs + owner gate.
  const ledgerBlocked = await loadLedgerBlockedFips(neondb);
  const blockedSet = effectiveBlockedFips(ledgerBlocked);
  const joinGateBlocked = blockedSet.has(county);
  const parcelTable = await resolveParcelTableForCounty(neondb, county);
  let parcelRows = new Map<string, ParcelJoinRow>();
  let situsRows = new Map<string, ParcelJoinRow>();
  let txgioMultiFeature = 0;
  const addressLandUse = joinGateBlocked
    ? await fetchCountyLandUseByAddress(neondb, county)
    : null;
  if (joinGateBlocked && parcelTable) {
    const situsKeys = [
      ...new Set(
        work
          .map((w) => {
            const { situs, refuse } = situsForBake(w.body);
            if (refuse) return null;
            return addressJoinKey(county, situs, blockedSet);
          })
          .filter((k): k is string => k != null),
      ),
    ];
    const joined = await joinParcelRowsBySitus(
      neondb,
      county,
      parcelTable,
      situsKeys,
      pageSize,
    );
    situsRows = joined.bySitus;
    txgioMultiFeature = joined.multiFeature;
  } else if (!joinGateBlocked && parcelTable) {
    const ids = [...new Set(work.map((w) => w.parcelNodeId.split(":")[1] ?? "").filter(Boolean))];
    const joined = await joinParcelRows(neondb, county, parcelTable, ids, pageSize);
    parcelRows = joined.byPropId;
    txgioMultiFeature = joined.multiFeature;
  }
  const joinTable = parcelTable?.table ?? DEFAULT_PARCEL_TABLE;

  let written = 0;
  let skippedBadSitus = 0;
  let skippedBadAccess = 0;
  let txgioJoined = 0;
  let txgioNoRow = 0;
  const facetHits = { landUse: 0, acreage: 0, zoning: 0, envelopeDerived: 0 };
  const publishRunId = publishRunIdFromEnv();
  const nowIso = new Date().toISOString();
  const countyName = COUNTY_NAMES[county] ?? county;

  for (const { body, parcelNodeId } of work) {
    let access: { discoverability: string; entitlement: string };
    let accessNormalizedFrom: string | null = null;
    try {
      ({ access, normalizedFrom: accessNormalizedFrom } = normalizeAccessPair(body.access));
    } catch {
      skippedBadAccess += 1;
      continue;
    }
    const { situs, refuse: refuseSitus } = situsForBake(body);
    if (refuseSitus) {
      skippedBadSitus += 1;
      continue;
    }
    const propId = parcelNodeId.split(":")[1] ?? "";
    const propIdRow = joinGateBlocked ? null : (parcelRows.get(propId) ?? null);
    let situsRow: ParcelJoinRow | null = null;
    let txgioOwner: string | null = null;
    if (joinGateBlocked && addressLandUse) {
      const addrKey = addressJoinKey(county, situs, blockedSet);
      const offered = addrKey ? (situsRows.get(addrKey) ?? null) : null;
      txgioOwner = offered?.txgio_owner_for_gate ?? null;
      // Pass the situs-keyed row ONLY after the owner gate accepts.
      const hit = resolveAddressLandUse(addrKey, txgioOwner, addressLandUse);
      situsRow = hit ? offered : null;
    }
    const row = joinGateBlocked ? situsRow : propIdRow;
    if (joinGateBlocked) {
      if (situsRow) txgioJoined += 1;
      else txgioNoRow += 1;
    } else if (propIdRow) {
      txgioJoined += 1;
    } else {
      txgioNoRow += 1;
    }

    const payload = buildConformantTier1Payload({
      body,
      parcelNodeId,
      countyFips: county,
      countyName,
      situsAddress: situs,
      access,
      accessNormalizedFrom,
      publishRunId,
      parcelJoin: {
        table: joinTable,
        row: propIdRow,
        gateBlocked: joinGateBlocked,
        ...(joinGateBlocked ? { situsRow } : {}),
      },
      ...(joinGateBlocked && addressLandUse
        ? {
            situsRecovery: {
              addressLandUse,
              txgioOwner,
              blockedFips: blockedSet,
            },
          }
        : {}),
      nowIso,
      onSitusFallback: ({ cityKey, situsCity }) => {
        console.warn(
          `[node-facet-bake-t1-conformant] situs fallback jurisdiction=${cityKey} ` +
            `situs_city=${situsCity} county=${county} node=${parcelNodeId}`,
        );
      },
    });
    // Owner is never baked: the claim carries ownerName and the builder never
    // reads it; this refuses the write if any owner-shaped key slipped in.
    assertNoOwnerKey(payload);

    if (payload.facetCoverage.landUse) facetHits.landUse += 1;
    if (payload.facetCoverage.acreage) facetHits.acreage += 1;
    if (payload.facetCoverage.zoning) facetHits.zoning += 1;
    if (payload.envelope) facetHits.envelopeDerived += 1;

    const ring = row ? firstRing(row.geometry) : null;
    const centroid = ring ? ringCentroid(ring) : null;
    const latRounded = centroid ? centroid.lat.toFixed(5) : PLACE_COORD_SENTINEL;
    const lngRounded = centroid ? centroid.lng.toFixed(5) : PLACE_COORD_SENTINEL;

    const contentHash = contentHashForPayload(payload as unknown as Record<string, unknown>);
    if (!dryRun) {
      await neondb.query(
        `INSERT INTO place_layer_snapshots
           (place_key, adapter_key, lat_rounded, lng_rounded, ll_uuid, payload_json, content_hash, snapshot_at, updated_at)
         VALUES ($1, $2, $3::numeric, $4::numeric, NULL, $5::jsonb, $6, now(), now())
         ON CONFLICT (adapter_key, place_key) DO UPDATE
           SET payload_json = EXCLUDED.payload_json,
               content_hash = EXCLUDED.content_hash,
               snapshot_at = EXCLUDED.snapshot_at,
               updated_at = EXCLUDED.updated_at,
               lat_rounded = CASE
                 WHEN EXCLUDED.lat_rounded = 0 AND EXCLUDED.lng_rounded = 0
                   THEN place_layer_snapshots.lat_rounded
                 ELSE EXCLUDED.lat_rounded END,
               lng_rounded = CASE
                 WHEN EXCLUDED.lat_rounded = 0 AND EXCLUDED.lng_rounded = 0
                   THEN place_layer_snapshots.lng_rounded
                 ELSE EXCLUDED.lng_rounded END`,
        [
          placeKeyForNode(parcelNodeId),
          TIER1_ADAPTER_KEY,
          latRounded,
          lngRounded,
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
      schemaVersion: TIER1_CONFORMANT_FACET_SCHEMA_VERSION,
      conformantCadRows: cadRows.length,
      written,
      skippedNoNode,
      skippedBadSitus,
      skippedBadAccess,
      parcelTable: parcelTable?.table ?? null,
      joinGateBlocked,
      txgioJoined,
      txgioNoRow,
      txgioMultiFeature,
      facetHits,
    }),
  );
  await mcp.end();
  await neondb.end();
}

main().catch((err) => {
  console.error(err.code || err.message);
  process.exit(1);
});
