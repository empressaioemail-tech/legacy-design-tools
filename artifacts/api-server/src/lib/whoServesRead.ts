/**
 * P-75 who-serves serve-time read over L22 staging.
 *
 * PIP against `tx_utility_territory_staging` (schema 0076). Territory
 * holders plus the fixed residual on every parcel, including a miss.
 * No atom family. TCEQ additive rows stay complementary who-governs
 * (`water-district`) and are never restated as water CCN.
 *
 * Reuses bbox + even-odd `pointInGeometry` from `@workspace/cad-ingest/txgio-geo`
 * (same helpers as city/county containment and NFHL). Does not edit
 * containment.ts.
 */

import { and, count, getTableName, gte, lte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { txUtilityTerritoryStaging } from "@workspace/db/schema";
import {
  pointInGeometry,
  type GeoJsonGeometry,
} from "@workspace/cad-ingest/txgio-geo";

export const WHO_SERVES_RESIDUAL =
  "SERVICE-LETTER-REQUIRED — territory is not tap/capacity/extension commitment.";

export const WHO_SERVES_MIGRATION = "0076_tx_utility_territory_staging.sql";

export const WHO_SERVES_TABLE = getTableName(txUtilityTerritoryStaging);

export const WHO_SERVES_SERVICE_KINDS = [
  "water",
  "sewer",
  "electric",
  "water-district",
] as const;

export type WhoServesServiceKind = (typeof WHO_SERVES_SERVICE_KINDS)[number];

export type WhoServesHolder = {
  source_key: string;
  service_kind: WhoServesServiceKind;
  territory_id: string;
  territory_name: string | null;
};

export type WhoServesMeasured = {
  status: "measured";
  holders: WhoServesHolder[];
  residual: typeof WHO_SERVES_RESIDUAL;
  asOf: string | null;
};

export type WhoServesUnmeasured = {
  status: "unmeasured";
  basis: string;
  holders: [];
  asOf: null;
};

export type WhoServesSection = WhoServesMeasured | WhoServesUnmeasured;

export const WHO_SERVES_EMPTY_STORE_BASIS =
  "tx_utility_territory_staging row count is 0 — staging not loaded; this is unmeasured, not a searched miss";

export type WhoServesCandidate = {
  sourceKey: string;
  serviceKind: string;
  territoryId: string;
  territoryName: string | null;
  geometry: GeoJsonGeometry;
  fetchedAt: Date | string | null;
};

const SERVICE_KIND_SET = new Set<string>(WHO_SERVES_SERVICE_KINDS);

export function isWhoServesServiceKind(
  value: string,
): value is WhoServesServiceKind {
  return SERVICE_KIND_SET.has(value);
}

/**
 * TCEQ additive rows are who-governs complementary. A remap to water
 * is the defect this card exists to refuse.
 */
export function holderFromCandidate(
  candidate: WhoServesCandidate,
): WhoServesHolder {
  if (!isWhoServesServiceKind(candidate.serviceKind)) {
    throw new Error(
      `who-serves refused unknown service_kind ${JSON.stringify(candidate.serviceKind)} for ${candidate.sourceKey}`,
    );
  }
  if (
    candidate.sourceKey === "tceq-water-districts" &&
    candidate.serviceKind === "water"
  ) {
    throw new Error(
      "who-serves refused TCEQ additive row restated as water CCN",
    );
  }
  return {
    source_key: candidate.sourceKey,
    service_kind: candidate.serviceKind,
    territory_id: candidate.territoryId,
    territory_name: candidate.territoryName,
  };
}

function asOfIso(value: Date | string | null): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function maxAsOf(values: Array<Date | string | null>): string | null {
  let maxMs = Number.NEGATIVE_INFINITY;
  let maxIso: string | null = null;
  for (const value of values) {
    const iso = asOfIso(value);
    if (!iso) continue;
    const ms = Date.parse(iso);
    if (ms > maxMs) {
      maxMs = ms;
      maxIso = iso;
    }
  }
  return maxIso;
}

function holderKey(holder: WhoServesHolder): string {
  return `${holder.source_key}\0${holder.territory_id}`;
}

/**
 * Assemble the served section from bbox-prefiltered staging rows.
 * Empty hit set is holders [] + residual, never {}.
 */
export function assembleWhoServesFromHits(
  longitude: number,
  latitude: number,
  candidates: WhoServesCandidate[],
): WhoServesSection {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    throw new Error("who-serves refused a non-finite query point");
  }
  const holders: WhoServesHolder[] = [];
  const seen = new Set<string>();
  const hitFetched: Array<Date | string | null> = [];
  for (const candidate of candidates) {
    if (!pointInGeometry(longitude, latitude, candidate.geometry)) continue;
    const holder = holderFromCandidate(candidate);
    const key = holderKey(holder);
    if (seen.has(key)) continue;
    seen.add(key);
    holders.push(holder);
    hitFetched.push(candidate.fetchedAt);
  }
  return {
    status: "measured",
    holders,
    residual: WHO_SERVES_RESIDUAL,
    asOf: maxAsOf(hitFetched.length > 0 ? hitFetched : candidates.map((c) => c.fetchedAt)),
  };
}

export function unmeasuredWhoServesSection(): WhoServesUnmeasured {
  return {
    status: "unmeasured",
    basis: WHO_SERVES_EMPTY_STORE_BASIS,
    holders: [],
    asOf: null,
  };
}

/**
 * Meaning-shaped gate: {} is not a successful who-serves section.
 * Verified by violation in whoServesRead.test.ts.
 */
export function assertWhoServesSection(value: unknown): WhoServesSection {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("who-serves section must be a non-array object");
  }
  const rec = value as Record<string, unknown>;
  if (rec.status === "unmeasured") {
    if (typeof rec.basis !== "string" || rec.basis.length === 0) {
      throw new Error("who-serves unmeasured requires a basis");
    }
    if ("residual" in rec) {
      throw new Error(
        "who-serves unmeasured must not carry SERVICE-LETTER-REQUIRED as if a search ran",
      );
    }
    if (!Array.isArray(rec.holders) || rec.holders.length !== 0) {
      throw new Error("who-serves unmeasured holders must be []");
    }
    return value as WhoServesSection;
  }
  if (rec.status === "measured" && (!("holders" in rec) || !("residual" in rec))) {
    throw new Error(
      "who-serves empty-object success is refused: holders and residual are required",
    );
  }
  if (!("holders" in rec) || !("residual" in rec)) {
    throw new Error(
      "who-serves empty-object success is refused: holders and residual are required",
    );
  }
  if (!Array.isArray(rec.holders)) {
    throw new Error("who-serves holders must be an array");
  }
  if (rec.residual !== WHO_SERVES_RESIDUAL) {
    throw new Error("who-serves residual must be the exact SERVICE-LETTER-REQUIRED sentence");
  }
  for (const holder of rec.holders) {
    if (!holder || typeof holder !== "object") {
      throw new Error("who-serves holder must be an object");
    }
    const h = holder as Record<string, unknown>;
    if (
      typeof h.source_key !== "string" ||
      typeof h.service_kind !== "string" ||
      typeof h.territory_id !== "string"
    ) {
      throw new Error("who-serves holder missing source_key, service_kind, or territory_id");
    }
    if (!isWhoServesServiceKind(h.service_kind)) {
      throw new Error(`who-serves holder has unknown service_kind ${JSON.stringify(h.service_kind)}`);
    }
    if (h.source_key === "tceq-water-districts" && h.service_kind === "water") {
      throw new Error("who-serves refused TCEQ additive row restated as water CCN");
    }
  }
  return value as WhoServesSection;
}

export type WhoServesStoreDb = Pick<
  NodePgDatabase<Record<string, unknown>>,
  "select"
>;

interface StagingCandidateRow {
  sourceKey: string;
  serviceKind: string;
  territoryId: string;
  territoryName: string | null;
  geometry: unknown;
  fetchedAt: Date;
}

/**
 * Bbox-column prefilter against the pinned 0076 table, then in-process PIP.
 * Does not guess a table name.
 */
export async function loadWhoServesCandidatesAtPoint(
  longitude: number,
  latitude: number,
  database: WhoServesStoreDb,
): Promise<WhoServesCandidate[]> {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    throw new Error("who-serves refused a non-finite query point");
  }
  const rows = (await database
    .select({
      sourceKey: txUtilityTerritoryStaging.sourceKey,
      serviceKind: txUtilityTerritoryStaging.serviceKind,
      territoryId: txUtilityTerritoryStaging.territoryId,
      territoryName: txUtilityTerritoryStaging.territoryName,
      geometry: txUtilityTerritoryStaging.geometry,
      fetchedAt: txUtilityTerritoryStaging.fetchedAt,
    })
    .from(txUtilityTerritoryStaging)
    .where(
      and(
        lte(txUtilityTerritoryStaging.westLng, longitude),
        gte(txUtilityTerritoryStaging.eastLng, longitude),
        lte(txUtilityTerritoryStaging.southLat, latitude),
        gte(txUtilityTerritoryStaging.northLat, latitude),
      ),
    )) as StagingCandidateRow[];

  return rows.map((row) => ({
    sourceKey: row.sourceKey,
    serviceKind: row.serviceKind,
    territoryId: row.territoryId,
    territoryName: row.territoryName,
    geometry: row.geometry as GeoJsonGeometry,
    fetchedAt: row.fetchedAt,
  }));
}

export async function countWhoServesStaging(
  database: WhoServesStoreDb,
): Promise<number> {
  const [row] = (await database
    .select({ n: count() })
    .from(txUtilityTerritoryStaging)) as Array<{ n: number | bigint }>;
  const n = row?.n;
  if (typeof n === "bigint") return Number(n);
  if (typeof n === "number" && Number.isFinite(n)) return n;
  throw new Error("who-serves refused an unreadable staging row count");
}

export async function serveWhoServesAtPoint(
  longitude: number,
  latitude: number,
  load: (
    longitude: number,
    latitude: number,
  ) => Promise<WhoServesCandidate[]>,
  stagingRowCount?: () => Promise<number>,
): Promise<WhoServesSection> {
  if (stagingRowCount) {
    const n = await stagingRowCount();
    if (!Number.isFinite(n) || n < 0) {
      throw new Error("who-serves refused an unreadable staging row count");
    }
    if (n === 0) {
      return assertWhoServesSection(unmeasuredWhoServesSection());
    }
  }
  const candidates = await load(longitude, latitude);
  return assertWhoServesSection(
    assembleWhoServesFromHits(longitude, latitude, candidates),
  );
}
