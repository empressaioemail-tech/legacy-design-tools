/**
 * P-430 — viewport GeoJSON for city limits + ETJ map layer.
 *
 * Same store and served-geometry contract as `etjFactRead.ts` /
 * `cityLimitsFactRead.ts`. Only rings the determination may test are drawn;
 * refused rings are omitted and counted for the legend note.
 */

import { and, gte, lte } from "drizzle-orm";
import { txCityBoundary, txEtjBoundary } from "@workspace/db/schema";
import {
  buildCityBoundaryIndex,
  buildEtjBoundaryIndex,
  resolveCityContainmentAtPoint,
  resolveEtjAtPoint,
  type EtjBoundarySourceRow,
  type EtjSourceCoverageEntry,
  type EtjContainingCity,
} from "@workspace/cad-ingest/boundary";
import type { GeoJsonGeometry } from "@workspace/cad-ingest/txgio-geo";

export type JurisdictionBbox = {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
};

export type JurisdictionBoundariesNearBboxRequest = JurisdictionBbox;

export type JurisdictionLayerFeatureProperties = {
  kind: "city-limits" | "etj";
  cityName: string;
  geoId?: string;
  etjId?: string;
  ringLabel?: string;
  servedStatus?: string;
  source: string;
  sourceCitation?: string;
};

export type JurisdictionBoundariesNearBboxResponse = {
  status: "ok";
  provider: "tx_city_boundary+tx_etj_boundary";
  cityLimits: {
    type: "FeatureCollection";
    features: Array<{
      type: "Feature";
      properties: JurisdictionLayerFeatureProperties;
      geometry: GeoJsonGeometry;
    }>;
  };
  etj: {
    type: "FeatureCollection";
    features: Array<{
      type: "Feature";
      properties: JurisdictionLayerFeatureProperties;
      geometry: GeoJsonGeometry;
    }>;
  };
  legendNote: {
    /** Refused / untestable rings whose published bbox intersects this viewport. */
    omittedRingCountInViewport: number;
    /** Human-readable basis for the note (P-359). */
    basis: string;
  };
};

const MAX_BBOX_SPAN_DEG = 0.5;

type BoundariesDb = {
  select: (fields: Record<string, unknown>) => {
    from: (table: unknown) => {
      where: (cond: unknown) => Promise<unknown[]>;
    };
  };
};

async function deploymentDb(): Promise<BoundariesDb> {
  const { db } = await import("@workspace/db");
  return db as unknown as BoundariesDb;
}

function bboxIntersectsViewport(
  row: { westLng: number; southLat: number; eastLng: number; northLat: number },
  vp: JurisdictionBbox,
): boolean {
  return (
    row.westLng <= vp.eastLng &&
    row.eastLng >= vp.westLng &&
    row.southLat <= vp.northLat &&
    row.northLat >= vp.southLat
  );
}

function parseBbox(input: JurisdictionBoundariesNearBboxRequest): JurisdictionBbox | { error: string } {
  const { westLng, southLat, eastLng, northLat } = input;
  if (
    ![westLng, southLat, eastLng, northLat].every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    return { error: "westLng,southLat,eastLng,northLat must be finite numbers" };
  }
  if (westLng >= eastLng || southLat >= northLat) {
    return { error: "west<east and south<north required" };
  }
  if (eastLng - westLng > MAX_BBOX_SPAN_DEG || northLat - southLat > MAX_BBOX_SPAN_DEG) {
    return {
      error: `bbox span exceeds ${MAX_BBOX_SPAN_DEG}° — zoom in (never load the whole state at once)`,
    };
  }
  return { westLng, southLat, eastLng, northLat };
}

function featureFromGeometry(
  kind: "city-limits" | "etj",
  geometry: GeoJsonGeometry,
  props: Omit<JurisdictionLayerFeatureProperties, "kind">,
): JurisdictionBoundariesNearBboxResponse["cityLimits"]["features"][number] | null {
  if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") return null;
  return {
    type: "Feature",
    properties: { kind, ...props },
    geometry,
  };
}

/** Exported for tests — same membership the card's readers use on an in-memory index. */
export function jurisdictionMembershipAtPoint(
  longitude: number,
  latitude: number,
  cityIndex: ReturnType<typeof buildCityBoundaryIndex>,
  etjIndex: ReturnType<typeof buildEtjBoundaryIndex>,
  coverage: EtjSourceCoverageEntry[] = [],
): {
  cityLimits: ReturnType<typeof resolveCityContainmentAtPoint>;
  etj: ReturnType<typeof resolveEtjAtPoint>;
} {
  const cityLimits = resolveCityContainmentAtPoint(longitude, latitude, cityIndex);
  let containingCity: EtjContainingCity | null = null;
  if (cityLimits.status === "incorporated") {
    containingCity = {
      cityName: cityLimits.cityName,
      geoId: cityLimits.geoId,
      incorporation: {
        cityName: cityLimits.cityName,
        geoId: cityLimits.geoId,
        source: "tx_city_boundary",
        cityLimitsBasis: cityLimits.basis,
      },
    };
  }
  const etj = resolveEtjAtPoint(longitude, latitude, etjIndex, coverage, containingCity);
  return { cityLimits, etj };
}

export async function assembleJurisdictionBoundariesNearBbox(
  raw: JurisdictionBoundariesNearBboxRequest,
): Promise<JurisdictionBoundariesNearBboxResponse | { error: string; status: number }> {
  const parsed = parseBbox(raw);
  if ("error" in parsed) return { error: parsed.error, status: 400 };

  const db = await deploymentDb();
  const vp = parsed;

  const cityRows = (await db
    .select({
      geoId: txCityBoundary.geoId,
      cityName: txCityBoundary.cityName,
      gnis: txCityBoundary.gnis,
      geometry: txCityBoundary.geometry,
      westLng: txCityBoundary.westLng,
      southLat: txCityBoundary.southLat,
      eastLng: txCityBoundary.eastLng,
      northLat: txCityBoundary.northLat,
      sourceCitation: txCityBoundary.sourceCitation,
    })
    .from(txCityBoundary)
    .where(
      and(
        lte(txCityBoundary.westLng, vp.eastLng),
        gte(txCityBoundary.eastLng, vp.westLng),
        lte(txCityBoundary.southLat, vp.northLat),
        gte(txCityBoundary.northLat, vp.southLat),
      ),
    )) as Array<{
    geoId: string;
    cityName: string;
    gnis: string | null;
    geometry: unknown;
    westLng: number;
    southLat: number;
    eastLng: number;
    northLat: number;
    sourceCitation: string;
  }>;

  const etjRows = (await db
    .select({
      etjId: txEtjBoundary.etjId,
      cityKey: txEtjBoundary.cityKey,
      cityName: txEtjBoundary.cityName,
      ringLabel: txEtjBoundary.ringLabel,
      geometry: txEtjBoundary.geometry,
      servedGeometry: txEtjBoundary.servedGeometry,
      servedStatus: txEtjBoundary.servedStatus,
      derivation: txEtjBoundary.derivation,
      westLng: txEtjBoundary.westLng,
      southLat: txEtjBoundary.southLat,
      eastLng: txEtjBoundary.eastLng,
      northLat: txEtjBoundary.northLat,
      sourceCitation: txEtjBoundary.sourceCitation,
    })
    .from(txEtjBoundary)
    .where(
      and(
        lte(txEtjBoundary.westLng, vp.eastLng),
        gte(txEtjBoundary.eastLng, vp.westLng),
        lte(txEtjBoundary.southLat, vp.northLat),
        gte(txEtjBoundary.northLat, vp.southLat),
      ),
    )) as Array<{
    etjId: string;
    cityKey: string;
    cityName: string;
    ringLabel: string;
    geometry: unknown;
    servedGeometry: unknown;
    servedStatus: string;
    derivation: unknown;
    westLng: number;
    southLat: number;
    eastLng: number;
    northLat: number;
    sourceCitation: string;
  }>;

  const cityFeatures: JurisdictionBoundariesNearBboxResponse["cityLimits"]["features"] = [];
  for (const row of cityRows) {
    const geom = row.geometry as GeoJsonGeometry;
    const feat = featureFromGeometry("city-limits", geom, {
      cityName: row.cityName,
      geoId: row.geoId,
      source: "tx_city_boundary",
      sourceCitation: row.sourceCitation,
    });
    if (feat) cityFeatures.push(feat);
  }

  const sourceRows: EtjBoundarySourceRow[] = etjRows.map((row) => ({
    etjId: row.etjId,
    cityKey: row.cityKey,
    cityName: row.cityName,
    ringLabel: row.ringLabel,
    geometry: row.geometry,
    servedGeometry: row.servedGeometry,
    servedStatus: row.servedStatus as EtjBoundarySourceRow["servedStatus"],
    derivation: row.derivation,
    bbox: {
      westLng: row.westLng,
      southLat: row.southLat,
      eastLng: row.eastLng,
      northLat: row.northLat,
    },
    sourceCitation: row.sourceCitation,
  }));

  const etjIndex = buildEtjBoundaryIndex(sourceRows);
  const omittedInViewport = etjIndex.refusals.filter((r) =>
    r.bbox ? bboxIntersectsViewport(r.bbox, vp) : false,
  ).length;

  const etjFeatures: JurisdictionBoundariesNearBboxResponse["etj"]["features"] = [];
  for (const ring of etjIndex.rings) {
    const feat = featureFromGeometry("etj", ring.geometry, {
      cityName: ring.cityName,
      etjId: ring.etjId,
      ringLabel: ring.ringLabel,
      servedStatus: ring.servedStatus,
      source: "tx_etj_boundary",
      sourceCitation: ring.sourceCitation,
    });
    if (feat) etjFeatures.push(feat);
  }

  const basis =
    omittedInViewport === 0
      ? "Every ETJ ring intersecting this view is drawn from its served geometry."
      : `${omittedInViewport} ETJ ring(s) in this view are not drawn — invalid, excluded, or not yet derived (P-359); the card declares these rather than testing them.`;

  return {
    status: "ok",
    provider: "tx_city_boundary+tx_etj_boundary",
    cityLimits: { type: "FeatureCollection", features: cityFeatures },
    etj: { type: "FeatureCollection", features: etjFeatures },
    legendNote: {
      omittedRingCountInViewport: omittedInViewport,
      basis,
    },
  };
}
