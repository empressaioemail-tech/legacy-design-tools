/**
 * ETJ READ from `tx_etj_boundary` + `tx_etj_source`
 * (feat/p241-etj-acquisition, P-241 acquisition half).
 *
 * Mirrors `cityLimitsFactRead.ts`: same store (`@workspace/db`, the deployment
 * store — not ATOMS_DATABASE_URL), same bbox-prefilter-then-point-in-polygon
 * shape, same honest-empty-table rule, same optional injected index for tests.
 *
 * The difference is coverage. City limits are statewide, so a miss has one
 * meaning. ETJ is published per municipality, so a miss has two, and this
 * module is where they are kept apart:
 *
 *   - `absent`     at least one registered publisher's own published ETJ
 *                  extent covers the query point and none of its rings
 *                  contains it;
 *   - `unresolved` nothing was ingested, or the point lies outside every
 *                  registered publisher's extent, or its city is enumerated as
 *                  publishing no ETJ layer at all.
 *
 * A zero-row `tx_etj_boundary` is therefore `unresolved`, never `absent`, and
 * so is a populated ring table whose source register is missing: a ring's own
 * bbox is not a publisher's claim about what it covers, so coverage cannot be
 * reconstructed from geometry. Guessing there would convert "we did not look"
 * into "it is not there", which is the defect this module exists to avoid.
 *
 * NO §42.021 BUFFER PATH. Not deferred — retired. Austin's real ETJ is shaped
 * by individual development agreements and disannexation actions, so a
 * statutory buffer would contradict the published layer it claims to describe.
 *
 * Not wired to a route: this lane is the acquisition half, and the consumer
 * sites that would read it (`hauska-engine`'s report/feasibility hardcodes,
 * `hauska-map`'s three) are explicit follow-on work. This module is the read
 * path those sites can adopt without touching how it is built.
 */

import { and, gte, lte } from "drizzle-orm";
import { txEtjBoundary, txEtjSource } from "@workspace/db/schema";
import {
  buildEtjBoundaryIndex,
  resolveEtjAtPoint,
  type EtjBoundaryIndexEntry,
  type EtjSourceCoverageEntry,
} from "@workspace/cad-ingest/boundary";
import {
  etjFactFromContainment,
  unmeasuredEtjFact,
  usableEtjQueryPoint,
  type EtjFact,
} from "@workspace/cad-ingest/etj";
import type { GeoJsonGeometry } from "@workspace/cad-ingest/txgio-geo";

export const ETJ_FACT_SOURCE = "tx_etj_boundary" as const;

export type EtjQueryPoint = {
  longitude: number;
  latitude: number;
};

export type EtjFactWire = EtjFact & {
  queryPoint: EtjQueryPoint | null;
};

/** Injected index for tests, same shape as the city-limits injection. */
export type EtjIndexInjection = {
  sourceRowsPresent: boolean;
  ringRowsPresent: boolean;
  index: EtjBoundaryIndexEntry[];
  coverage: EtjSourceCoverageEntry[];
};

type EtjBoundaryRow = {
  etjId: string;
  cityKey: string;
  cityName: string;
  ringLabel: string;
  geometry: unknown;
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
  sourceCitation: string;
};

type EtjSourceRow = {
  cityKey: string;
  cityName: string;
  cityGeoId: string | null;
  mode: string;
  hasEtjRings: boolean;
  westLng: number | null;
  southLat: number | null;
  eastLng: number | null;
  northLat: number | null;
};

/**
 * The drizzle surface this module uses. `select(...).from(...)` is awaitable
 * for the unfiltered source register and carries `.where`/`.limit` for the
 * filtered reads, which is what the real builder gives.
 */
export type EtjFactDb = {
  select: (fields: Record<string, unknown>) => {
    from: (table: unknown) => PromiseLike<unknown[]> & {
      where: (cond: unknown) => PromiseLike<unknown[]>;
      limit: (n: number) => PromiseLike<unknown[]>;
    };
  };
};

async function deploymentDb(): Promise<EtjFactDb> {
  const { db } = await import("@workspace/db");
  return db as unknown as EtjFactDb;
}

let injectedIndex: EtjIndexInjection | null | undefined;

export function setEtjIndexForTests(
  index: EtjIndexInjection | null,
): void {
  injectedIndex = index;
}

export function resetEtjIndexForTests(): void {
  injectedIndex = undefined;
}

function asGeometry(value: unknown): GeoJsonGeometry | null {
  if (!value || typeof value !== "object") return null;
  const g = value as { type?: unknown };
  if (g.type === "Polygon" || g.type === "MultiPolygon") {
    return value as GeoJsonGeometry;
  }
  return null;
}

/** Every enumerated publisher, rings or not. */
async function loadSourceCoverage(
  db: EtjFactDb,
): Promise<{ coverage: EtjSourceCoverageEntry[]; rows: EtjSourceRow[] }> {
  const rows = (await db
    .select({
      cityKey: txEtjSource.cityKey,
      cityName: txEtjSource.cityName,
      cityGeoId: txEtjSource.cityGeoId,
      mode: txEtjSource.mode,
      hasEtjRings: txEtjSource.hasEtjRings,
      westLng: txEtjSource.westLng,
      southLat: txEtjSource.southLat,
      eastLng: txEtjSource.eastLng,
      northLat: txEtjSource.northLat,
    })
    .from(txEtjSource)) as EtjSourceRow[];

  const coverage: EtjSourceCoverageEntry[] = rows.map((r) => ({
    cityKey: r.cityKey,
    cityName: r.cityName,
    cityGeoId: r.cityGeoId,
    mode: r.mode,
    hasEtjRings: r.hasEtjRings,
    bbox:
      r.westLng !== null &&
      r.southLat !== null &&
      r.eastLng !== null &&
      r.northLat !== null
        ? {
            westLng: r.westLng,
            southLat: r.southLat,
            eastLng: r.eastLng,
            northLat: r.northLat,
          }
        : null,
  }));
  return { coverage, rows };
}

async function countRings(db: EtjFactDb): Promise<number> {
  const rows = (await db
    .select({ etjId: txEtjBoundary.etjId })
    .from(txEtjBoundary)
    .limit(1)) as Array<{ etjId: string }>;
  return rows.length;
}

/** Rings whose bbox contains the query point — the pre-filter only. */
async function loadBboxCandidates(
  db: EtjFactDb,
  longitude: number,
  latitude: number,
): Promise<EtjBoundaryIndexEntry[]> {
  const rows = (await db
    .select({
      etjId: txEtjBoundary.etjId,
      cityKey: txEtjBoundary.cityKey,
      cityName: txEtjBoundary.cityName,
      ringLabel: txEtjBoundary.ringLabel,
      geometry: txEtjBoundary.geometry,
      westLng: txEtjBoundary.westLng,
      southLat: txEtjBoundary.southLat,
      eastLng: txEtjBoundary.eastLng,
      northLat: txEtjBoundary.northLat,
      sourceCitation: txEtjBoundary.sourceCitation,
    })
    .from(txEtjBoundary)
    .where(
      and(
        lte(txEtjBoundary.westLng, longitude),
        gte(txEtjBoundary.eastLng, longitude),
        lte(txEtjBoundary.southLat, latitude),
        gte(txEtjBoundary.northLat, latitude),
      ),
    )) as EtjBoundaryRow[];

  const built: Array<{
    etjId: string;
    cityKey: string;
    cityName: string;
    ringLabel: string;
    geometry: GeoJsonGeometry;
    bbox: {
      westLng: number;
      southLat: number;
      eastLng: number;
      northLat: number;
    };
    sourceCitation: string;
  }> = [];
  for (const row of rows) {
    const geometry = asGeometry(row.geometry);
    if (!geometry) continue;
    built.push({
      etjId: row.etjId,
      cityKey: row.cityKey,
      cityName: row.cityName,
      ringLabel: row.ringLabel,
      geometry,
      bbox: {
        westLng: row.westLng,
        southLat: row.southLat,
        eastLng: row.eastLng,
        northLat: row.northLat,
      },
      sourceCitation: row.sourceCitation,
    });
  }
  return buildEtjBoundaryIndex(built);
}

/**
 * Resolve ETJ for a WGS84 point. Pass null when the inspect snapshot has no
 * usable centroid — that is unresolved, not absent. `containing` is the
 * already-resolved containing city when the caller has it, used only so the
 * unresolved basis can name the city and its enumeration outcome.
 */
export async function loadEtjFact(
  point: EtjQueryPoint | null,
  db?: EtjFactDb,
  containing: { cityName?: string | null; geoId?: string | null } | null = null,
): Promise<EtjFactWire> {
  const usable = point
    ? usableEtjQueryPoint(point.longitude, point.latitude)
    : null;
  if (!usable) {
    return {
      ...unmeasuredEtjFact("no usable parcel query point; ETJ is unmeasured"),
      queryPoint: null,
    };
  }
  const queryPoint = { longitude: usable.longitude, latitude: usable.latitude };

  if (injectedIndex !== undefined) {
    if (injectedIndex === null || !injectedIndex.sourceRowsPresent) {
      return {
        ...unmeasuredEtjFact(
          "tx_etj_source has zero rows; ETJ is unmeasured, not absent — " +
            "no ETJ source has been acquired",
        ),
        queryPoint,
      };
    }
    if (!injectedIndex.ringRowsPresent && injectedIndex.coverage.some((c) => c.hasEtjRings)) {
      // The register claims publishers WITH rings and the ring table holds none.
      // That is an incomplete acquisition, not a checked absence: the rings that
      // would have answered were never loaded, so zero rings consulted proves
      // nothing. Ring identity is per publisher, so "no ring contains the point"
      // and "no ring was ever written" are only distinguishable here.
      return {
        ...unmeasuredEtjFact(
          "tx_etj_source lists publishers with ETJ rings but tx_etj_boundary " +
            "holds none; the acquisition is incomplete, so ETJ is unmeasured " +
            "rather than absent",
        ),
        queryPoint,
      };
    }
    if (injectedIndex.ringRowsPresent && injectedIndex.coverage.length === 0) {
      return {
        ...unmeasuredEtjFact(
          "tx_etj_boundary has rings but tx_etj_source is empty; publisher " +
            "coverage is unreadable, so ETJ is unresolved rather than a guess",
        ),
        queryPoint,
      };
    }
    return {
      ...etjFactFromContainment(
        resolveEtjAtPoint(
          usable.longitude,
          usable.latitude,
          injectedIndex.index,
          injectedIndex.coverage,
          containing,
        ),
      ),
      queryPoint,
    };
  }

  const store = db ?? (await deploymentDb());
  const { coverage: coverageRows } = await loadSourceCoverage(store);
  const ringRows = await countRings(store);
  if (coverageRows.length === 0) {
    return {
      ...unmeasuredEtjFact(
        ringRows > 0
          ? "tx_etj_boundary has rings but tx_etj_source is empty; publisher " +
            "coverage is unreadable, so ETJ is unresolved rather than a guess"
          : "tx_etj_source has zero rows; ETJ is unmeasured, not absent — " +
            "no ETJ source has been acquired",
      ),
      queryPoint,
    };
  }
  // The register claiming rings while the ring table is empty is an incomplete
  // acquisition. Answering `absent` here would report a verified absence from
  // zero rings consulted — "we looked and it is not there" when nothing was
  // ever written to look at. Same class as the empty-register case above, and
  // deliberately distinct from "the table is populated but no ring's bbox
  // reaches this point", which is what the absent path below means.
  if (ringRows === 0 && coverageRows.some((c) => c.hasEtjRings)) {
    return {
      ...unmeasuredEtjFact(
        "tx_etj_source lists publishers with ETJ rings but tx_etj_boundary " +
          "holds none; the acquisition is incomplete, so ETJ is unmeasured " +
          "rather than absent",
      ),
      queryPoint,
    };
  }

  const index = await loadBboxCandidates(store, usable.longitude, usable.latitude);
  return {
    ...etjFactFromContainment(
      resolveEtjAtPoint(
        usable.longitude,
        usable.latitude,
        index,
        coverageRows,
        containing,
      ),
    ),
    queryPoint,
  };
}
