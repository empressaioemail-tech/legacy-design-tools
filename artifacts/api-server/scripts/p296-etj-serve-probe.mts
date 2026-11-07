#!/usr/bin/env tsx
/**
 * P-296 falsifier probe — the ETJ serve path against a real deployment store.
 *
 * The moment a premise in the dispatch is checked by a script rather than by
 * "I asked the model to look", it is repeatable. Re-runnable as:
 *
 *   DATABASE_URL=<store> pnpm exec tsx scripts/p296-etj-serve-probe.mts
 *
 * What it does, and nothing else:
 *   1. For each named control point, take the N parcels in that point's county
 *      whose centroid is nearest the point (a real parcel id and a real bake
 *      point, not a hand-typed coordinate pair).
 *   2. Run the REAL serve entry point (`loadCityLimitsFactForServe`) on each,
 *      i.e. the same function the brokerage facet route calls.
 *   3. Print, per parcel, the city-limits status and the ETJ status with the
 *      evidence behind it (publisher, ring label, publishers whose own extent
 *      covered the point, rings tested), then a per-control-point tally.
 *   4. Read each control POINT at the point itself, twice: the served wire
 *      (`loadCityLimitsFactForServe`) and the ETJ read given the containing
 *      city the STATEWIDE city-limits index reports (`loadCityLimitsFact`,
 *      which needs no parcel-record store). Step 4 exists because the served
 *      city-limits branch for a slated county reads parcel_record, which
 *      refuses with `parcel-record-store-not-configured` in any process that
 *      has no RETRIEVAL_API_KEY; the statewide read is the same containing-city
 *      answer a configured process would hand the ETJ read, so the pair keeps
 *      "the wire is degraded by a missing credential in THIS process" visibly
 *      separate from "the ETJ read gets the containing city wrong".
 *      A control-point label is not a parcel id, so the wrapper takes its
 *      point-based branch there -- a real serve branch, and the one whose ETJ
 *      overlay sees a containing city.
 *
 * It writes nothing and reads only. `--json` emits one machine-readable
 * document on stdout with no prose.
 *
 * EXIT CODE is 0 whenever the read path answered, whatever the dispositions
 * are — a probe that fails because data is absent would make "not read" and
 * "read, and wrong" indistinguishable. Read the tallies.
 */

import pg from "pg";
import { loadCityLimitsFactForServe } from "../src/lib/cityLimitsFactServeCutover";
import { loadCityLimitsFact } from "../src/lib/cityLimitsFactRead";
import { loadEtjFact } from "../src/lib/etjFactRead";

const jsonMode = process.argv.includes("--json");
const NEAREST_N = Number(
  (process.argv.find((a) => a.startsWith("--nearest=")) ?? "--nearest=8").split("=")[1],
);

type ControlPoint = {
  label: string;
  countyFips: string;
  lng: number;
  lat: number;
  /** What the pre-registered falsifier predicts, so a miss is visible as a miss. */
  predicts: "present" | "absent" | "unresolved";
};

/**
 * Pre-registered 2026-09-17 before the staging run (P-296 falsifiers 1 and 2).
 * Coordinates are the mission's own control points, unchanged from P-241's
 * suite so the two lanes' evidence is comparable.
 */
const CONTROL_POINTS: ControlPoint[] = [
  {
    label: "austin-etj (3128 Edgewater Dr, inside Austin's 2-mile ETJ)",
    countyFips: "48453",
    lng: -97.855113,
    lat: 30.352812,
    predicts: "present",
  },
  {
    label: "austin-city-limits (5833 Taylor Draper Cv)",
    countyFips: "48453",
    lng: -97.75715,
    lat: 30.41603,
    predicts: "absent",
  },
  {
    label: "bastrop-city (registered publisher, county 48021)",
    countyFips: "48021",
    lng: -97.31654,
    lat: 30.10981,
    predicts: "absent",
  },
  {
    label: "round-rock (enumerated, publishes no ETJ layer)",
    countyFips: "48491",
    lng: -97.67769,
    lat: 30.50827,
    predicts: "unresolved",
  },
  {
    label: "houston (county 48201, no registered publisher)",
    countyFips: "48201",
    lng: -95.36936,
    lat: 29.76024,
    predicts: "unresolved",
  },
];

type Row = {
  controlPoint: string;
  predicts: string;
  parcelNodeId: string;
  countyFips: string;
  propId: string;
  lng: number;
  lat: number;
  cityLimitsStatus: string;
  etjStatus: string;
  cityName: string | null;
  etjCity: string | null;
  ringLabel: string | null;
  coveredBy: string[];
  ringsConsulted: number | null;
  basis: string;
};

type PointRow = {
  controlPoint: string;
  predicts: string;
  lng: number;
  lat: number;
  /** The wire this point would be served (slated counties read parcel_record,
   * which refuses without a retrieval credential -- see the header). */
  pointServedCityLimitsStatus: string;
  pointServedEtjStatus: string;
  /** The statewide city-limits answer, the containing city the ETJ read wants. */
  statewideCityLimitsStatus: string;
  statewideCityName: string | null;
  /** The ETJ read given that containing city. */
  etjStatus: string;
  etjCity: string | null;
  ringLabel: string | null;
  coveredBy: string[];
  ringsConsulted: number | null;
  basis: string;
};

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("p296-etj-serve-probe: DATABASE_URL must be set (read-only)");
    process.exit(2);
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const rows: Row[] = [];
  const pointRows: PointRow[] = [];
  try {
    for (const cp of CONTROL_POINTS) {
      const { rows: parcels } = await pool.query<{
        county_fips: string;
        prop_id: string;
        lng: number;
        lat: number;
      }>(
        `select county_fips, prop_id,
                ST_X(ST_Centroid(geom)) as lng,
                ST_Y(ST_Centroid(geom)) as lat
           from txgio_parcel
          where county_fips = $1
            and geom is not null
          order by geom <-> ST_SetSRID(ST_MakePoint($2, $3), 4326)
          limit $4`,
        [cp.countyFips, cp.lng, cp.lat, NEAREST_N],
      );
      for (const p of parcels) {
        const nodeId = `${p.county_fips}:${p.prop_id}`;
        const point = { longitude: Number(p.lng), latitude: Number(p.lat) };
        const fact = await loadCityLimitsFactForServe(nodeId, point);
        rows.push({
          controlPoint: cp.label,
          predicts: cp.predicts,
          parcelNodeId: nodeId,
          countyFips: p.county_fips,
          propId: p.prop_id,
          lng: point.longitude,
          lat: point.latitude,
          cityLimitsStatus: fact.status,
          etjStatus: fact.etjStatus,
          cityName: fact.cityName ?? null,
          etjCity: fact.etjFact?.cityName ?? null,
          ringLabel: fact.etjFact?.ringLabel ?? null,
          coveredBy: fact.etjFact?.coveredBy ?? [],
          ringsConsulted: fact.etjFact?.ringsConsulted ?? null,
          basis: fact.basis,
        });
      }

      // Step 4: the control POINT itself, served and read with the statewide
      // containing city. Same county node id format the parcel rows use.
      const point = { longitude: cp.lng, latitude: cp.lat };
      const nodeId = `${cp.countyFips}:${cp.label.split(" ")[0]}`;
      const served = await loadCityLimitsFactForServe(nodeId, point);
      const statewide = await loadCityLimitsFact(point);
      const containing =
        statewide.status === "incorporated"
          ? { cityName: statewide.cityName ?? null, geoId: statewide.geoId ?? null }
          : null;
      const etj = await loadEtjFact(point, undefined, containing);
      pointRows.push({
        controlPoint: cp.label,
        predicts: cp.predicts,
        lng: cp.lng,
        lat: cp.lat,
        pointServedCityLimitsStatus: served.status,
        pointServedEtjStatus: served.etjStatus,
        statewideCityLimitsStatus: statewide.status,
        statewideCityName: statewide.cityName ?? null,
        etjStatus: etj.status,
        etjCity: etj.cityName ?? null,
        ringLabel: etj.ringLabel ?? null,
        coveredBy: etj.coveredBy ?? [],
        ringsConsulted: etj.ringsConsulted ?? null,
        basis: etj.basis,
      });
    }
  } finally {
    await pool.end();
  }

  const tallies = CONTROL_POINTS.map((cp) => {
    const own = rows.filter((r) => r.controlPoint === cp.label);
    const byStatus = { present: 0, absent: 0, unresolved: 0 } as Record<string, number>;
    for (const r of own) byStatus[r.etjStatus] = (byStatus[r.etjStatus] ?? 0) + 1;
    return {
      controlPoint: cp.label,
      predicts: cp.predicts,
      parcels: own.length,
      etjStatusCounts: byStatus,
    };
  });

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          instrument: "scripts/p296-etj-serve-probe.mts",
          generatedAt: new Date().toISOString(),
          nearestN: NEAREST_N,
          rows,
          pointRows,
          tallies: {
            parcels: tallies,
            points: CONTROL_POINTS.map((cp) => {
              const own = pointRows.find((r) => r.controlPoint === cp.label);
              return {
                controlPoint: cp.label,
                predicts: cp.predicts,
                etjStatus: own?.etjStatus ?? null,
                matchesPrediction: own ? own.etjStatus === cp.predicts : null,
                pointServedEtjStatus: own?.pointServedEtjStatus ?? null,
                statewideCityLimitsStatus: own?.statewideCityLimitsStatus ?? null,
                statewideCityName: own?.statewideCityName ?? null,
              };
            }),
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  for (const t of tallies) {
    console.log(
      `\n== ${t.controlPoint}\n   predicts=${t.predicts} parcels=${t.parcels} ` +
        `present=${t.etjStatusCounts.present ?? 0} absent=${t.etjStatusCounts.absent ?? 0} ` +
        `unresolved=${t.etjStatusCounts.unresolved ?? 0}`,
    );
    for (const r of rows.filter((x) => x.controlPoint === t.controlPoint)) {
      console.log(
        `   ${r.parcelNodeId.padEnd(18)} city=${r.cityLimitsStatus.padEnd(15)} etj=${r.etjStatus.padEnd(11)} ` +
          `ring=${(r.ringLabel ?? "-").slice(0, 28).padEnd(28)} coveredBy=[${r.coveredBy.join(",")}] ` +
          `rings=${r.ringsConsulted ?? "-"}`,
      );
    }
  }
  console.log(`\n== control POINTS (the point itself; the ETJ read is given the statewide containing city)`);
  for (const r of pointRows) {
    console.log(
      `   ${r.controlPoint.slice(0, 46).padEnd(46)} predicts=${r.predicts.padEnd(11)} ` +
        `etj=${r.etjStatus.padEnd(11)} ${r.etjStatus === r.predicts ? "==" : "!!"} ` +
        `statewideCity=${r.statewideCityLimitsStatus}/${r.statewideCityName ?? "-"} ` +
        `pointServed=${r.pointServedEtjStatus}`,
    );
    console.log(`      basis: ${r.basis}`);
  }
  console.log(`\nprobe rows: ${rows.length} (counting rule: one row per parcel queried)`);
  console.log(`point rows: ${pointRows.length} (counting rule: one row per control point)`);
}

main().catch((err) => {
  console.error("[p296-etj-serve-probe] FATAL:", err);
  process.exit(1);
});
