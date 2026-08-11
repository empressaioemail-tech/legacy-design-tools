import { sql, type SQL } from "drizzle-orm";

import { RAIL_ENGINE_BINDINGS } from "./schema/railEngineBinding";

export const TEXAS_COUNTY_COUNT = 254;

export interface RailCapability {
  railKey: string;
  maxCountiesReachable: number | null;
  reachPct: number | null;
  sourceBasis: string;
  limitation?: string;
}

export interface RailCapabilityProbeResult {
  railCapabilities: RailCapability[];
}

export interface RailCapabilityProbeFailure {
  railCapabilities: null;
  reason: string;
}

export type RailCapabilityOutcome = RailCapabilityProbeResult | RailCapabilityProbeFailure;

/** Minimal DB handle for COUNT DISTINCT probes — inject in tests. */
export interface CapabilityDbHandle {
  execute: (query: SQL) => Promise<{ rows: Record<string, unknown>[] }>;
}

/** Hardcoded / file-based capability when SQL is unavailable. */
const STATIC_RAIL_CAPABILITIES: Partial<
  Record<string, Omit<RailCapability, "railKey">>
> = {
  "rrc-wells": {
    maxCountiesReachable: 1,
    reachPct: 1 / TEXAS_COUNTY_COUNT,
    sourceBasis:
      "RRC public GIS Harris County mirror carries statewide well coverage (lib/adapters/src/federal/texas-rrc.ts)",
    limitation: "Point layer mirrored from Harris endpoint; not per-county ingest",
  },
  footprint: {
    maxCountiesReachable: TEXAS_COUNTY_COUNT,
    reachPct: 1,
    sourceBasis: "ML footprint sources theoretically statewide",
    limitation:
      "O(fp×parcels) compute limits metro-scale apply; capability is theoretical max",
  },
};

async function countDistinctCountyFips(
  db: CapabilityDbHandle,
  table: string,
  column = "county_fips",
): Promise<number | null> {
  try {
    const { rows } = await db.execute(
      sql.raw(`SELECT COUNT(DISTINCT ${column})::int AS n FROM ${table}`),
    );
    const n = rows[0]?.n;
    return typeof n === "number" ? n : Number(n);
  } catch {
    return null;
  }
}

function reachPct(count: number | null): number | null {
  if (count === null) return null;
  return count / TEXAS_COUNTY_COUNT;
}

function staticCapability(railKey: string): RailCapability | null {
  const cap = STATIC_RAIL_CAPABILITIES[railKey];
  if (!cap) return null;
  return { railKey, ...cap };
}

/**
 * Probe max Texas counties each rail source could light. Fail closed: when
 * `db` is omitted or a probe fails, per-rail values fall back to static
 * hardcodes or null with reason in `limitation`.
 */
export async function probeRailCapabilities(
  db?: CapabilityDbHandle,
): Promise<RailCapabilityOutcome> {
  if (!db) {
    return {
      railCapabilities: null,
      reason: "no database handle — capability SQL probes skipped",
    };
  }

  const capabilities: RailCapability[] = [];

  let ownerCount: number | null = null;
  let parcelCountyCount: number | null = null;

  try {
    ownerCount = await countDistinctCountyFips(db, "cad_property");
    parcelCountyCount = await countDistinctCountyFips(db, "txgio_parcel");
  } catch (err) {
    return {
      railCapabilities: null,
      reason:
        "capability probe failed: " +
        (err instanceof Error ? err.message : String(err)),
    };
  }

  for (const binding of RAIL_ENGINE_BINDINGS) {
    const railKey = binding.railKey;
    const staticCap = staticCapability(railKey);
    if (staticCap) {
      capabilities.push(staticCap);
      continue;
    }

    if (railKey === "owner") {
      capabilities.push({
        railKey,
        maxCountiesReachable: ownerCount,
        reachPct: reachPct(ownerCount),
        sourceBasis: "cad_property DISTINCT county_fips (CAD roll ingest)",
        limitation: ownerCount === null ? "probe returned null" : undefined,
      });
      continue;
    }

    if (railKey === "rail-corridor") {
      capabilities.push({
        railKey,
        maxCountiesReachable: parcelCountyCount,
        reachPct: reachPct(parcelCountyCount),
        sourceBasis:
          "txgio_parcel DISTINCT county_fips — corridor overlay needs parcel geometry context",
        limitation:
          parcelCountyCount === null ? "probe returned null" : undefined,
      });
      continue;
    }

    if (railKey === "mud") {
      const districtCountyCount = await countDistinctCountyFips(
        db,
        "tx_special_district",
      );
      capabilities.push({
        railKey,
        maxCountiesReachable: districtCountyCount,
        reachPct: reachPct(districtCountyCount),
        sourceBasis:
          "tx_special_district DISTINCT county_fips (TCEQ WaterDistricts ingest)",
        limitation:
          districtCountyCount === null ? "probe returned null" : undefined,
      });
      continue;
    }

    capabilities.push({
      railKey,
      maxCountiesReachable: null,
      reachPct: null,
      sourceBasis: "no capability probe defined for this rail",
    });
  }

  return { railCapabilities: capabilities };
}
