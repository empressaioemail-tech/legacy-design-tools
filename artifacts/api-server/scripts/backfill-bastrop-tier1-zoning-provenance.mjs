#!/usr/bin/env node
/**
 * backfill-bastrop-tier1-zoning-provenance.mjs — COMPLETE-BASTROP A1 (WDLL 3,4)
 *
 * Patches existing Bastrop place_layer_snapshots (adapter node-facets:tier1)
 * where zoning.district is present but zoning.provenance / provenance.zoningSource
 * are empty. Also sets txgio_parcel.zoning_jurisdiction='bastrop-city-tx' for
 * county_fips=48021 rows that already carry zoning_district.
 *
 * Origin (do not invent): City of Bastrop AGOL Zoning_Place_Type / PlaceTypeClass
 *   https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Zoning_Place_Type/FeatureServer/0
 *   cityKey=bastrop-city-tx
 *
 * Does NOT touch depth-warm / boundary write paths.
 *
 *   CORTEX_DATABASE_URL=...neondb... \
 *     node artifacts/api-server/scripts/backfill-bastrop-tier1-zoning-provenance.mjs \
 *       [--dry-run] [--limit=N] [--skip-txgio] [--skip-snapshots]
 *
 * Persist requires COMPLETE_BASTROP_A1_BACKFILL=1 (or --apply).
 */

import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import pg from "pg";

const COUNTY_FIPS = "48021";
const ADAPTER_KEY = "node-facets:tier1";
const CITY_KEY = "bastrop-city-tx";
const CODE_FIELD = "PlaceTypeClass";
const LAYER_NAME = "Zoning_Place_Type";
const SOURCE_URL =
  "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Zoning_Place_Type/FeatureServer/0";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
    limit: { type: "string" },
    "skip-txgio": { type: "boolean", default: false },
    "skip-snapshots": { type: "boolean", default: false },
    "batch-size": { type: "string", default: "500" },
  },
  allowPositionals: false,
});

const dryRun =
  values["dry-run"] === true ||
  (values.apply !== true &&
    process.env.COMPLETE_BASTROP_A1_BACKFILL !== "1");
const limit = values.limit ? Number(values.limit) : null;
const batchSize = Math.max(1, Number(values["batch-size"] || 500) || 500);
const skipTxgio = values["skip-txgio"] === true;
const skipSnapshots = values["skip-snapshots"] === true;

const databaseUrl =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim() ||
  process.env.LEGACY_DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error(
    "FATAL: CORTEX_DATABASE_URL (or DATABASE_URL) required for neondb.",
  );
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
  max: 4,
});

function contentHashForPayload(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function log(msg) {
  console.log(`[a1-tier1-zoning-prov] ${msg}`);
}

const t0 = performance.now();
const stampedAt = new Date().toISOString();

const client = await pool.connect();
try {
  // --- BEFORE tallies (planner re-verifies independently) ---
  const beforeSnap = await client.query(`
    SELECT
      count(*) FILTER (
        WHERE payload_json->'zoning'->>'district' IS NOT NULL
          AND btrim(payload_json->'zoning'->>'district') <> ''
      )::int AS zoning_present,
      count(*) FILTER (
        WHERE payload_json->'zoning'->>'district' IS NOT NULL
          AND btrim(payload_json->'zoning'->>'district') <> ''
          AND coalesce(btrim(payload_json->'zoning'->'provenance'->>'sourceUrl'), '') <> ''
      )::int AS zoning_has_prov,
      count(*) FILTER (
        WHERE coalesce(btrim(payload_json->'provenance'->>'zoningSource'), '') <> ''
      )::int AS top_zoning_source,
      count(*)::int AS tier1_total
    FROM place_layer_snapshots
    WHERE adapter_key = $1
      AND place_key LIKE $2
  `, [ADAPTER_KEY, `node:${COUNTY_FIPS}:%`]);
  log(`BEFORE snapshots: ${JSON.stringify(beforeSnap.rows[0])}`);

  const beforeTxgio = await client.query(`
    SELECT
      count(*) FILTER (
        WHERE zoning_district IS NOT NULL AND btrim(zoning_district) <> ''
      )::int AS with_district,
      count(*) FILTER (
        WHERE zoning_jurisdiction IS NOT NULL AND btrim(zoning_jurisdiction) <> ''
      )::int AS with_jurisdiction,
      count(*) FILTER (
        WHERE zoning_district IS NOT NULL AND btrim(zoning_district) <> ''
          AND (zoning_jurisdiction IS NULL OR btrim(zoning_jurisdiction) = '')
      )::int AS zd_without_zj
    FROM txgio_parcel
    WHERE county_fips = $1
  `, [COUNTY_FIPS]);
  log(`BEFORE txgio: ${JSON.stringify(beforeTxgio.rows[0])}`);

  let snapUpdated = 0;
  let txgioUpdated = 0;

  if (!skipTxgio) {
    const txgioSql = `
      UPDATE txgio_parcel
      SET zoning_jurisdiction = $1
      WHERE county_fips = $2
        AND zoning_district IS NOT NULL
        AND btrim(zoning_district) <> ''
        AND (zoning_jurisdiction IS NULL OR btrim(zoning_jurisdiction) = ''
             OR replace(lower(zoning_jurisdiction), '_', '-') <> $1)
    `;
    if (dryRun) {
      const preview = await client.query(`
        SELECT count(*)::int AS would_update
        FROM txgio_parcel
        WHERE county_fips = $1
          AND zoning_district IS NOT NULL
          AND btrim(zoning_district) <> ''
          AND (zoning_jurisdiction IS NULL OR btrim(zoning_jurisdiction) = ''
               OR replace(lower(zoning_jurisdiction), '_', '-') <> $2)
      `, [COUNTY_FIPS, CITY_KEY]);
      log(`DRY-RUN txgio would_update=${preview.rows[0].would_update}`);
    } else {
      const res = await client.query(txgioSql, [CITY_KEY, COUNTY_FIPS]);
      txgioUpdated = res.rowCount ?? 0;
      log(`UPDATED txgio_parcel rows=${txgioUpdated}`);
    }
  }

  if (!skipSnapshots) {
    const selectSql = `
      SELECT place_key, payload_json
      FROM place_layer_snapshots
      WHERE adapter_key = $1
        AND place_key LIKE $2
        AND payload_json->'zoning'->>'district' IS NOT NULL
        AND btrim(payload_json->'zoning'->>'district') <> ''
        AND coalesce(btrim(payload_json->'zoning'->'provenance'->>'sourceUrl'), '') = ''
      ORDER BY place_key
      ${limit != null && Number.isFinite(limit) ? `LIMIT ${Number(limit)}` : ""}
    `;
    const { rows } = await client.query(selectSql, [
      ADAPTER_KEY,
      `node:${COUNTY_FIPS}:%`,
    ]);
    log(`snapshots needing provenance: ${rows.length}`);

    if (dryRun) {
      log(`DRY-RUN snapshots would_update=${rows.length}`);
      if (rows[0]) {
        const z = rows[0].payload_json?.zoning;
        log(
          `sample place_key=${rows[0].place_key} district=${z?.district ?? null}`,
        );
      }
    } else {
      for (let i = 0; i < rows.length; i += batchSize) {
        const chunk = rows.slice(i, i + batchSize);
        await client.query("BEGIN");
        try {
          for (const row of chunk) {
            const payload = row.payload_json;
            const zoning = payload?.zoning && typeof payload.zoning === "object"
              ? { ...payload.zoning }
              : null;
            if (!zoning?.district) continue;
            const provenance = {
              sourceUrl: SOURCE_URL,
              codeField: CODE_FIELD,
              cityKey: CITY_KEY,
              layerName: LAYER_NAME,
              stampedAt:
                typeof payload?.bakedAt === "string" && payload.bakedAt
                  ? payload.bakedAt
                  : stampedAt,
            };
            zoning.provenance = provenance;
            if (!zoning.jurisdictionKey) {
              zoning.jurisdictionKey = CITY_KEY.replace(/-/g, "_");
            }
            const next = {
              ...payload,
              zoning,
              provenance: {
                ...(payload?.provenance && typeof payload.provenance === "object"
                  ? payload.provenance
                  : {}),
                zoningSource: SOURCE_URL,
              },
            };
            const contentHash = contentHashForPayload(next);
            await client.query(
              `
                UPDATE place_layer_snapshots
                SET payload_json = $1::jsonb,
                    content_hash = $2,
                    updated_at = NOW()
                WHERE adapter_key = $3 AND place_key = $4
              `,
              [JSON.stringify(next), contentHash, ADAPTER_KEY, row.place_key],
            );
            snapUpdated += 1;
          }
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
        log(
          `snapshot progress ${Math.min(i + chunk.length, rows.length)}/${rows.length}`,
        );
      }
      log(`UPDATED place_layer_snapshots rows=${snapUpdated}`);
    }
  }

  const afterSnap = await client.query(`
    SELECT
      count(*) FILTER (
        WHERE payload_json->'zoning'->>'district' IS NOT NULL
          AND btrim(payload_json->'zoning'->>'district') <> ''
      )::int AS zoning_present,
      count(*) FILTER (
        WHERE payload_json->'zoning'->>'district' IS NOT NULL
          AND btrim(payload_json->'zoning'->>'district') <> ''
          AND coalesce(btrim(payload_json->'zoning'->'provenance'->>'sourceUrl'), '') <> ''
      )::int AS zoning_has_prov,
      count(*) FILTER (
        WHERE coalesce(btrim(payload_json->'provenance'->>'zoningSource'), '') <> ''
      )::int AS top_zoning_source
    FROM place_layer_snapshots
    WHERE adapter_key = $1
      AND place_key LIKE $2
  `, [ADAPTER_KEY, `node:${COUNTY_FIPS}:%`]);
  log(`AFTER snapshots: ${JSON.stringify(afterSnap.rows[0])}`);

  const afterTxgio = await client.query(`
    SELECT
      count(*) FILTER (
        WHERE zoning_district IS NOT NULL AND btrim(zoning_district) <> ''
      )::int AS with_district,
      count(*) FILTER (
        WHERE replace(lower(coalesce(zoning_jurisdiction,'')), '_', '-') = $2
      )::int AS with_jurisdiction_bastrop_city,
      count(*) FILTER (
        WHERE zoning_district IS NOT NULL AND btrim(zoning_district) <> ''
          AND (zoning_jurisdiction IS NULL OR btrim(zoning_jurisdiction) = '')
      )::int AS zd_without_zj
    FROM txgio_parcel
    WHERE county_fips = $1
  `, [COUNTY_FIPS, CITY_KEY]);
  log(`AFTER txgio: ${JSON.stringify(afterTxgio.rows[0])}`);

  log(
    `done dryRun=${dryRun} snapUpdated=${snapUpdated} txgioUpdated=${txgioUpdated} ` +
      `elapsedMs=${Math.round(performance.now() - t0)}`,
  );
} finally {
  client.release();
  await pool.end();
}
