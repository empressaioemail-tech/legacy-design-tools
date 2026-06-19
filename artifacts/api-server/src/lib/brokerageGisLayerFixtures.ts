/**
 * Committed GIS layer fixtures for Max map dev — real Cotality Spatial Tile
 * bbox captures served when live demo quota is exhausted (HTTP 429).
 *
 * Refresh: `node scripts/capture-brokerage-gis-fixture.mjs`
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Request } from "express";
import type { GisLayerGeoJsonResult, GisProxyLayerKey } from "./brokerageGisLayers";

export const BASTROP_PARCELS_BBOX = {
  westLng: -97.32,
  southLat: 30.1,
  eastLng: -97.3,
  northLat: 30.12,
} as const;

export type GisLayerFixtureManifest = {
  fixtureKey: string;
  layer: GisProxyLayerKey;
  capturedAt: string;
  source: "cotality-spatial-tile-bbox";
  bbox: typeof BASTROP_PARCELS_BBOX;
  spatialTilePages: number;
  spatialTilePageSize: number;
  zoningEnrichCount: number;
  featureCount: number;
  notes?: string;
};

export type GisLayerFixtureFile = {
  manifest: GisLayerFixtureManifest;
  result: GisLayerGeoJsonResult;
};

const FIXTURE_FILES: Partial<Record<GisProxyLayerKey, string>> = {
  parcels: "bastrop-tx-parcels-bbox.gis-layer.json",
};

function bundledFixtureDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "../../data/gis-fixtures");
}

export function resolveGisFixturePath(layer: GisProxyLayerKey): string {
  const envDir = process.env.BROKERAGE_GIS_FIXTURE_DIR?.trim();
  const base = envDir || bundledFixtureDir();
  const file = FIXTURE_FILES[layer];
  if (!file) {
    throw new Error(`No GIS fixture configured for layer: ${layer}`);
  }
  return join(base, file);
}

export function gisFixtureRequested(
  req: Request,
  body?: { fixture?: boolean },
): boolean {
  const q = req.query.fixture;
  if (q === "1" || q === "true") return true;
  return body?.fixture === true;
}

export function loadGisLayerFixture(
  layer: GisProxyLayerKey,
): GisLayerFixtureFile | null {
  if (layer !== "parcels") return null;
  const path = resolveGisFixturePath(layer);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as GisLayerFixtureFile;
}

export function fixtureManifestForLayer(
  layer: GisProxyLayerKey,
): GisLayerFixtureManifest | null {
  return loadGisLayerFixture(layer)?.manifest ?? null;
}
