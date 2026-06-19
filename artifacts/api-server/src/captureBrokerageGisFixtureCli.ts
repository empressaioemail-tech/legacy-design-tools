/**
 * CLI — capture real Cotality Spatial Tile Bastrop bbox fixtures.
 * Run: node node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs artifacts/api-server/src/captureBrokerageGisFixtureCli.ts
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cotalityGetWithApp, cotalitySpatialTileBaseUrl } from "@workspace/adapters/national/cotalityClient";
import {
  BASTROP_PARCELS_BBOX,
  type GisLayerFixtureFile,
} from "./lib/brokerageGisLayerFixtures";
import {
  buildParcelsGeoJsonFromSpatialRows,
  listGisLayerEndpoints,
  type GisLayerBbox,
} from "./lib/brokerageGisLayers";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../data/gis-fixtures");
const BBOX: GisLayerBbox = { ...BASTROP_PARCELS_BBOX };
const PAGE_SIZE = 50;
const MAX_PAGES = 4;

function loadCotalityCredsFromGcloud(): void {
  if (process.env.COTALITY_SPATIALTILE_KEY) return;
  const gcloud =
    process.env.GCLOUD_BIN ??
    (process.platform === "win32"
      ? "C:\\Users\\cente\\google-cloud-sdk\\bin\\gcloud.cmd"
      : "gcloud");
  const project = process.env.GCP_PROJECT ?? "legacy-design-tools-prod";
  const env = {
    ...process.env,
    GOOGLE_APPLICATION_CREDENTIALS:
      process.env.GOOGLE_APPLICATION_CREDENTIALS ??
      "C:\\Users\\cente\\google-cloud-sdk\\smartcity-agent-key.json",
  };
  for (const secret of [
    "COTALITY_PROPERTY_KEY",
    "COTALITY_PROPERTY_SECRET",
    "COTALITY_SPATIALTILE_KEY",
    "COTALITY_SPATIALTILE_SECRET",
  ]) {
    process.env[secret] = execSync(
      `${gcloud} secrets versions access latest --secret=${secret} --project=${project}`,
      { encoding: "utf8", env },
    ).trim();
  }
}

function spatialParcelRows(json: unknown): Record<string, unknown>[] {
  if (!json || typeof json !== "object") return [];
  const root = json as Record<string, unknown>;
  const list =
    (Array.isArray(root.parcels) ? root.parcels : null) ??
    (Array.isArray(root.items) ? root.items : null) ??
    (Array.isArray(root.features) ? root.features : null);
  return (list ?? []) as Record<string, unknown>[];
}

function spatialPageHasMore(
  json: unknown,
  pageNumber: number,
  pageSize: number,
): boolean {
  if (!json || typeof json !== "object") return false;
  const root = json as Record<string, unknown>;
  if (root.exceededTransferLimit === true) return true;
  const pageInfo = root.pageInfo as Record<string, unknown> | undefined;
  if (pageInfo) {
    const totalPages = Number(pageInfo.totalPages);
    if (Number.isFinite(totalPages) && totalPages > pageNumber) return true;
  }
  return spatialParcelRows(json).length >= pageSize;
}

async function fetchSpatialPages(): Promise<{
  rows: Record<string, unknown>[];
  pages: unknown[];
  truncated: boolean;
}> {
  const rows: Record<string, unknown>[] = [];
  const pages: unknown[] = [];
  let truncated = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const json = await cotalityGetWithApp({
      app: "spatialtile",
      path: process.env.COTALITY_SPATIALTILE_POINT_PATH ?? "/parcels",
      query: {
        bbox: `${BBOX.westLng},${BBOX.southLat},${BBOX.eastLng},${BBOX.northLat}`,
        pageNumber: page,
        pageSize: PAGE_SIZE,
      },
      adapterKeyForLog: "capture:gis-fixture",
      label: "spatialtile-parcels",
    });
    pages.push(json);
    rows.push(...spatialParcelRows(json));
    const more = spatialPageHasMore(json, page, PAGE_SIZE);
    if (!more) break;
    if (page === MAX_PAGES) truncated = true;
  }

  return { rows, pages, truncated };
}

async function main(): Promise<void> {
  loadCotalityCredsFromGcloud();
  mkdirSync(OUT_DIR, { recursive: true });

  let spatialOk = false;
  try {
    console.log("Fetching Cotality Spatial Tile bbox pages…", BBOX);
    const { rows, pages, truncated } = await fetchSpatialPages();
    if (rows.length === 0) {
      throw new Error("Cotality Spatial Tile returned zero parcel rows.");
    }

    const rawPath = join(OUT_DIR, "bastrop-tx-parcels-bbox.spatial-tile.raw.json");
    writeFileSync(
      rawPath,
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          bbox: BBOX,
          pages,
          parcelCount: rows.length,
          truncated,
          serviceUrl: cotalitySpatialTileBaseUrl(),
        },
        null,
        2,
      ),
    );
    console.log("Wrote raw spatial tile capture:", rawPath, "rows=", rows.length);

    const built = await buildParcelsGeoJsonFromSpatialRows({
      rows,
      bbox: BBOX,
      truncated,
    });
    const endpoint = listGisLayerEndpoints().find((l) => l.layer === "parcels")!;
    const parcelsFixture: GisLayerFixtureFile = {
      manifest: {
        fixtureKey: "bastrop-tx-parcels-bbox",
        layer: "parcels",
        capturedAt: new Date().toISOString(),
        source: "cotality-spatial-tile-bbox",
        bbox: BASTROP_PARCELS_BBOX,
        spatialTilePages: pages.length,
        spatialTilePageSize: PAGE_SIZE,
        zoningEnrichCount: Math.min(rows.length, 25),
        featureCount: built.featureCount,
        notes:
          "Real Cotality Spatial Tile bbox capture for extension-agent mesh + choropleth QA.",
      },
      result: {
        ...endpoint,
        ...built,
      },
    };

    const parcelsPath = join(OUT_DIR, "bastrop-tx-parcels-bbox.gis-layer.json");
    writeFileSync(parcelsPath, JSON.stringify(parcelsFixture, null, 2));
    console.log(
      "Wrote parcels fixture:",
      parcelsPath,
      "features=",
      built.featureCount,
    );
    spatialOk = true;
  } catch (err) {
    console.error("Spatial Tile capture failed:", (err as Error).message);
  }

  if (!spatialOk) {
    console.error(
      "Parcels fixture NOT written — Cotality demo Spatial Tile quota exhausted (100 req/day). Retry tomorrow or use production keys.",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
