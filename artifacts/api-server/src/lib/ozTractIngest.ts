/**
 * CDFI/HUD Opportunity Zone tract ingest — live ArcGIS GeoJSON pull.
 *
 * Run via `node scripts/ingest-opportunity-zones.mjs` before deploy or
 * during Docker build. Writes to BROKERAGE_FEDERAL_DATA_DIR when set.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  OZ_TRACT_LIST_VERSION,
  resolveOzTractDataPath,
} from "./brokerageFederalDataPaths";

export const HUD_OZ_ARCGIS_QUERY =
  "https://services.arcgis.com/VTyQ9soqVukalItT/ArcGIS/rest/services/Opportunity_Zones/FeatureServer/13/query";

export const OZ_INGEST_PAGE_SIZE = 2000;

export interface OzIngestOptions {
  version?: string;
  outputPath?: string;
  fetchImpl?: typeof fetch;
}

export interface OzIngestResult {
  version: string;
  outputPath: string;
  featureCount: number;
  fetchedAt: string;
}

export async function ingestOpportunityZonesFromHud(
  options: OzIngestOptions = {},
): Promise<OzIngestResult> {
  const version = options.version ?? OZ_TRACT_LIST_VERSION;
  const outputPath = options.outputPath ?? resolveOzTractDataPath(version);
  const fetchImpl = options.fetchImpl ?? fetch;
  const features: unknown[] = [];
  let offset = 0;

  for (;;) {
    const url = new URL(HUD_OZ_ARCGIS_QUERY);
    url.searchParams.set("where", "1=1");
    url.searchParams.set("outFields", "GEOID10,STATE,COUNTY,STATE_NAME");
    url.searchParams.set("f", "geojson");
    url.searchParams.set("resultOffset", String(offset));
    url.searchParams.set("resultRecordCount", String(OZ_INGEST_PAGE_SIZE));

    const res = await fetchImpl(url.toString(), {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`HUD OZ ingest failed (${res.status}): ${await res.text()}`);
    }
    const page = (await res.json()) as {
      features?: unknown[];
    };
    const batch = page.features ?? [];
    features.push(...batch);
    if (batch.length < OZ_INGEST_PAGE_SIZE) break;
    offset += batch.length;
    if (offset > 50_000) break;
  }

  const fetchedAt = new Date().toISOString();
  const collection = {
    type: "FeatureCollection" as const,
    metadata: {
      version,
      source: "HUD ArcGIS Opportunity_Zones FeatureServer/13",
      fetchedAt,
      featureCount: features.length,
    },
    features: features.map((f) => {
      const feature = f as { properties?: Record<string, unknown> };
      return {
        ...feature,
        properties: {
          ...feature.properties,
          geoid10: feature.properties?.GEOID10 ?? feature.properties?.geoid10,
          round: version,
        },
      };
    }),
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(collection, null, 2), "utf8");

  return {
    version,
    outputPath,
    featureCount: features.length,
    fetchedAt,
  };
}
