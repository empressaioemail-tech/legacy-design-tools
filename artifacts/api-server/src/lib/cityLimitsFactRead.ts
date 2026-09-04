/**
 * Inspect-card city-limits READ from `tx_city_boundary` (P-76).
 *
 * Not an atom family. No `--apply`. PIP against incorporated-place
 * polygons only. ETJ is `etjStatus: unresolved` — this module has no
 * buffer, offset, or guessed-municipality path.
 *
 * Empty table or missing usable query point is `unmeasured`, never
 * unincorporated. Unincorporated is only legal when the index is
 * populated and the point sits outside every polygon.
 *
 * Deployment store (`@workspace/db`). Not ATOMS_DATABASE_URL.
 */

import { and, gte, lte } from "drizzle-orm";
import { txCityBoundary } from "@workspace/db/schema";
import {
  buildCityBoundaryIndex,
  resolveCityContainmentAtPoint,
  type CityBoundaryIndexEntry,
} from "@workspace/cad-ingest/boundary";
import {
  cityLimitsFactFromContainment,
  unmeasuredCityLimitsFact,
  usableCityLimitsQueryPoint,
  type CityLimitsFact,
} from "@workspace/cad-ingest/city-limits";
import type { GeoJsonGeometry } from "@workspace/cad-ingest/txgio-geo";

export const CITY_LIMITS_FACT_SOURCE = "tx_city_boundary" as const;

export type CityLimitsQueryPoint = {
  longitude: number;
  latitude: number;
};

export type CityLimitsIndexInjection = {
  tablePopulated: boolean;
  entries: CityBoundaryIndexEntry[];
};

/**
 * The served city-limits fact: the containment result plus the WGS84 point it
 * was evaluated at (null when there was no usable point). CTX card F
 * (2026-08-28): the zoning verdict derives incorporation from this wire and
 * the Factory walk re-derives containment from the same point against its own
 * copy of the incorporated-place polygons, so the point travels with the fact.
 */
export type CityLimitsFactWire = CityLimitsFact & {
  queryPoint: CityLimitsQueryPoint | null;
};

type CityLimitsRow = {
  geoId: string;
  cityName: string;
  gnis: string | null;
  geometry: unknown;
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
};

type CityLimitsDb = {
  select: (fields: Record<string, unknown>) => {
    from: (table: unknown) => {
      limit: (n: number) => Promise<Array<Pick<CityLimitsRow, "geoId">>>;
      where: (cond: unknown) => Promise<CityLimitsRow[]>;
    };
  };
};

async function deploymentDb(): Promise<CityLimitsDb> {
  const { db } = await import("@workspace/db");
  return db as unknown as CityLimitsDb;
}

let injectedIndex: CityLimitsIndexInjection | null | undefined;

export function setCityLimitsIndexForTests(
  index: CityLimitsIndexInjection | null,
): void {
  injectedIndex = index;
}

export function resetCityLimitsIndexForTests(): void {
  injectedIndex = undefined;
}

function unincorporatedOutsidePopulatedIndex(): CityLimitsFact {
  return {
    status: "unincorporated",
    etjStatus: "unresolved",
    source: CITY_LIMITS_FACT_SOURCE,
    basis:
      "no incorporated-place polygon contains the query point " +
      "(tx_city_boundary statewide index; unincorporated is the honest answer)",
  };
}

function asGeometry(value: unknown): GeoJsonGeometry | null {
  if (!value || typeof value !== "object") return null;
  const g = value as { type?: unknown };
  if (g.type === "Polygon" || g.type === "MultiPolygon") {
    return value as GeoJsonGeometry;
  }
  return null;
}

async function tableIsPopulated(db: CityLimitsDb): Promise<boolean> {
  const rows = await db
    .select({ geoId: txCityBoundary.geoId })
    .from(txCityBoundary)
    .limit(1);
  return rows.length > 0;
}

async function loadBboxCandidates(
  db: CityLimitsDb,
  longitude: number,
  latitude: number,
): Promise<CityBoundaryIndexEntry[]> {
  const rows = await db
    .select({
      geoId: txCityBoundary.geoId,
      cityName: txCityBoundary.cityName,
      gnis: txCityBoundary.gnis,
      geometry: txCityBoundary.geometry,
      westLng: txCityBoundary.westLng,
      southLat: txCityBoundary.southLat,
      eastLng: txCityBoundary.eastLng,
      northLat: txCityBoundary.northLat,
    })
    .from(txCityBoundary)
    .where(
      and(
        lte(txCityBoundary.westLng, longitude),
        gte(txCityBoundary.eastLng, longitude),
        lte(txCityBoundary.southLat, latitude),
        gte(txCityBoundary.northLat, latitude),
      ),
    );
  const built: Array<{
    geoId: string;
    cityName: string;
    gnis: string | null;
    geometry: GeoJsonGeometry;
    bbox: {
      westLng: number;
      southLat: number;
      eastLng: number;
      northLat: number;
    };
  }> = [];
  for (const row of rows) {
    const geometry = asGeometry(row.geometry);
    if (!geometry) continue;
    built.push({
      geoId: row.geoId,
      cityName: row.cityName,
      gnis: row.gnis,
      geometry,
      bbox: {
        westLng: row.westLng,
        southLat: row.southLat,
        eastLng: row.eastLng,
        northLat: row.northLat,
      },
    });
  }
  return buildCityBoundaryIndex(built);
}

/**
 * Resolve city limits for a WGS84 point. Pass null when the inspect
 * snapshot has no usable centroid — that is unmeasured, not rural.
 */
export async function loadCityLimitsFact(
  point: CityLimitsQueryPoint | null,
  db?: CityLimitsDb,
): Promise<CityLimitsFactWire> {
  const usable = point
    ? usableCityLimitsQueryPoint(point.longitude, point.latitude)
    : null;
  if (!usable) {
    return {
      ...unmeasuredCityLimitsFact(
        "no usable parcel query point; city limits are unmeasured",
      ),
      queryPoint: null,
    };
  }
  const queryPoint = { longitude: usable.longitude, latitude: usable.latitude };

  if (injectedIndex !== undefined) {
    if (injectedIndex === null || !injectedIndex.tablePopulated) {
      return {
        ...unmeasuredCityLimitsFact(
          "tx_city_boundary index is empty; city limits are unmeasured, not unincorporated",
        ),
        queryPoint,
      };
    }
    if (injectedIndex.entries.length === 0) {
      return { ...unincorporatedOutsidePopulatedIndex(), queryPoint };
    }
    return {
      ...cityLimitsFactFromContainment(
        resolveCityContainmentAtPoint(
          usable.longitude,
          usable.latitude,
          injectedIndex.entries,
        ),
      ),
      queryPoint,
    };
  }

  const store = db ?? (await deploymentDb());
  const populated = await tableIsPopulated(store);
  if (!populated) {
    return {
      ...unmeasuredCityLimitsFact(
        "tx_city_boundary has zero rows; city limits are unmeasured, not unincorporated",
      ),
      queryPoint,
    };
  }

  const entries = await loadBboxCandidates(
    store,
    usable.longitude,
    usable.latitude,
  );
  if (entries.length === 0) {
    return { ...unincorporatedOutsidePopulatedIndex(), queryPoint };
  }
  return {
    ...cityLimitsFactFromContainment(
      resolveCityContainmentAtPoint(usable.longitude, usable.latitude, entries),
    ),
    queryPoint,
  };
}
