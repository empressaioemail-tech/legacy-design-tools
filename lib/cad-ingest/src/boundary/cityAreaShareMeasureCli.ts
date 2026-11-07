/**
 * READ-ONLY before/after measurement for city containment by area share.
 *
 *   pnpm --filter @workspace/cad-ingest city-area-share-measure -- \
 *     --county=48053 [--county=48021 ...] [--chunk=4000] [--concurrency=3] [--out=<dir>]
 *
 * For every parcel of each county it decides the city three or four ways and
 * reports where the new rule moves the answer:
 *
 *   - `new`     — `decideByAreaShare` (areaShare.ts), measured by
 *                 `cityAreaShareSql` in EPSG:3083;
 *   - `landing` — what `landing_parcel_jurisdiction` holds today (the source of
 *                 the parcel_record `cityLimits` cell for every slated county);
 *   - `p2rule`  — the hauska-factory p2-juris rule that wrote `landing`
 *                 (largest overlap among cities clearing a 1e-8 deg² floor, no
 *                 majority test), recomputed from the same pieces, so a county
 *                 with no landing rows (Burnet) can be compared too and a
 *                 county with them shows how far `landing` has drifted from
 *                 today's boundaries;
 *   - `bake`    — point-in-polygon at the tier-1 bake point
 *                 (`place_layer_snapshots.lat_rounded/lng_rounded`), the
 *                 answer `loadCityLimitsFact` serves for a county whose
 *                 `cityLimits` rail is not slated (Bexar), through the very
 *                 function it serves with (`resolveCityContainmentAtPoint`).
 *
 * WRITES NOTHING. It refuses to run unless the session reports
 * `transaction_read_only = on`, which the caller sets through the connection
 * string (`options=-c default_transaction_read_only=on`) on the UNPOOLED
 * host. It never issues SET: through the Neon pooler a session SET leaks into
 * a shared server connection (2026-10-07 incident). With no
 * statement_timeout in production, each statement is bounded by its chunk of
 * prop_ids instead.
 *
 * Output: a JSON summary on stdout; with --out, one CSV per county of every
 * parcel whose answer changes under any comparison or that is split (ids,
 * city names and shares only — no owner or situs data is read).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import {
  cityAreaShareSql,
  decideByAreaShare,
  groupCityAreaShareRows,
  type AreaShareDecision,
  type CityAreaShareSqlRow,
} from "./areaShare";
import {
  buildCityBoundaryIndex,
  resolveCityContainmentAtPoint,
  type CityBoundaryIndexEntry,
} from "./containment";
import type { GeoJsonGeometry } from "../txgio/geo";

const UNINC = "unincorporated";
/** hauska-factory p2-juris-store.mjs CHUNK_GEOMETRY_SQL `overlap_deg2 >= 1e-8`. */
const P2_JURIS_FLOOR_DEG2 = 1e-8;

type Args = { counties: string[]; chunk: number; concurrency: number; out: string | null };

function parseArgs(argv: string[]): Args {
  const counties: string[] = [];
  let chunk = 4000;
  let concurrency = 3;
  let out: string | null = null;
  for (const a of argv) {
    const [k, v] = a.split("=", 2);
    if (k === "--county" && v) counties.push(...v.split(",").map((s) => s.trim()).filter(Boolean));
    else if (k === "--chunk" && v) chunk = Number(v);
    else if (k === "--concurrency" && v) concurrency = Number(v);
    else if (k === "--out" && v) out = v;
  }
  for (const c of counties) {
    if (!/^48\d{3}$/.test(c)) throw new Error(`--county must be a Texas county FIPS (48xxx), got ${c}`);
  }
  if (counties.length === 0) throw new Error("at least one --county=<fips> is required");
  if (!(chunk > 0) || !(concurrency > 0)) throw new Error("--chunk and --concurrency must be positive");
  return { counties, chunk, concurrency, out };
}

async function openReadOnly(url: string): Promise<pg.Client> {
  if (/-pooler\./.test(url)) {
    throw new Error("refusing the Neon pooler host: use the unpooled host (session options must not leak)");
  }
  const client = new pg.Client({ connectionString: url });
  client.on("error", (err) => {
    console.error(JSON.stringify({ event: "db_connection_lost", message: err.message }));
  });
  await client.connect();
  const { rows } = await client.query<{ transaction_read_only: string }>("SHOW transaction_read_only");
  if (rows[0]?.transaction_read_only !== "on") {
    await client.end();
    throw new Error(
      "refusing: session is not read-only. Pass options=-c default_transaction_read_only=on in the connection string (never SET).",
    );
  }
  return client;
}

function label(d: AreaShareDecision | null): string {
  if (!d) return "unmeasured";
  return d.winner.kind === "jurisdiction" ? d.winner.name : UNINC;
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

type Tally = Record<string, number>;
function bump(t: Tally, k: string): void {
  t[k] = (t[k] ?? 0) + 1;
}

interface CountySummary {
  county: string;
  parcels: number;
  unmeasured: number;
  newRule: { incorporated: number; unincorporated: number; plurality: number; split: number };
  landingRows: number;
  bakeRows: number;
  /** from→to counts, per comparison, only where the answer changes. */
  changes: Record<"landing" | "p2rule" | "bake", { total: number; compared: number; byTransition: Tally }>;
  /** p2rule vs landing: how far the stored answer has drifted from today's boundaries. */
  landingVsP2rule: { compared: number; differ: number };
  ms: number;
}

async function measureCounty(
  url: string,
  county: string,
  chunk: number,
  concurrency: number,
  out: string | null,
): Promise<CountySummary> {
  const t0 = Date.now();
  const meta = await openReadOnly(url);
  let ids: string[];
  let index: CityBoundaryIndexEntry[];
  let landingRows: number;
  let bakeRows: number;
  try {
    ids = (
      await meta.query<{ prop_id: string }>(
        `SELECT DISTINCT prop_id FROM txgio_parcel
          WHERE county_fips = $1 AND prop_id IS NOT NULL AND btrim(prop_id) <> '' AND prop_id <> '0'
          ORDER BY prop_id`,
        [county],
      )
    ).rows.map((r) => r.prop_id);
    const cityRows = (
      await meta.query<{
        geo_id: string;
        city_name: string;
        gnis: string | null;
        geometry: GeoJsonGeometry;
        west_lng: number;
        south_lat: number;
        east_lng: number;
        north_lat: number;
      }>(
        `SELECT v.geo_id, v.city_name, v.gnis, v.geometry, v.west_lng, v.south_lat, v.east_lng, v.north_lat
           FROM tx_city_boundary v, tx_county_boundary co
          WHERE co.county_fips = $1 AND v.geometry IS NOT NULL
            AND v.west_lng <= co.east_lng AND v.east_lng >= co.west_lng
            AND v.south_lat <= co.north_lat AND v.north_lat >= co.south_lat`,
        [county],
      )
    ).rows;
    index = buildCityBoundaryIndex(
      cityRows.map((r) => ({
        geoId: r.geo_id,
        cityName: r.city_name,
        gnis: r.gnis,
        geometry: r.geometry,
        bbox: { westLng: r.west_lng, southLat: r.south_lat, eastLng: r.east_lng, northLat: r.north_lat },
      })),
    );
    landingRows = Number(
      (await meta.query(`SELECT count(*)::bigint n FROM landing_parcel_jurisdiction WHERE county_fips = $1`, [county]))
        .rows[0]?.n ?? 0,
    );
    bakeRows = Number(
      (
        await meta.query(
          `SELECT count(*)::bigint n FROM place_layer_snapshots
            WHERE adapter_key = 'node-facets:tier1' AND place_key >= $1 AND place_key < $2`,
          [`node:${county}:`, `node:${county};`],
        )
      ).rows[0]?.n ?? 0,
    );
  } finally {
    await meta.end();
  }

  const ranges: Array<[string, string | null]> = [];
  for (let i = 0; i < ids.length; i += chunk) {
    ranges.push([ids[i]!, i + chunk < ids.length ? ids[i + chunk]! : null]);
  }

  const summary: CountySummary = {
    county,
    parcels: 0,
    unmeasured: 0,
    newRule: { incorporated: 0, unincorporated: 0, plurality: 0, split: 0 },
    landingRows,
    bakeRows,
    changes: {
      landing: { total: 0, compared: 0, byTransition: {} },
      p2rule: { total: 0, compared: 0, byTransition: {} },
      bake: { total: 0, compared: 0, byTransition: {} },
    },
    landingVsP2rule: { compared: 0, differ: 0 },
    ms: 0,
  };
  const csv: string[] = [
    "prop_id,parcel_m2,landing,p2rule,bake,new,rule,winner_share,split,disclosure",
  ];
  const measureSql = cityAreaShareSql({ withDegreeAreas: true });

  let next = 0;
  let done = 0;
  const worker = async () => {
    const client = await openReadOnly(url);
    try {
      for (;;) {
        const i = next++;
        if (i >= ranges.length) return;
        const [lo, hi] = ranges[i]!;
        const measured = (await client.query<CityAreaShareSqlRow>(measureSql, [county, lo, hi])).rows;
        const landing = new Map<string, string>();
        if (landingRows > 0) {
          const lr = await client.query<{ prop_id: string; disposition: string; city_name: string | null }>(
            `SELECT prop_id, disposition, city_name FROM landing_parcel_jurisdiction
              WHERE county_fips = $1 AND prop_id >= $2 AND ($3::text IS NULL OR prop_id < $3)`,
            [county, lo, hi],
          );
          for (const r of lr.rows) {
            landing.set(
              r.prop_id,
              r.disposition === "in-city" ? (r.city_name ?? "in-city(unnamed)") : r.disposition === "unincorporated" ? UNINC : r.disposition,
            );
          }
        }
        const bake = new Map<string, string>();
        if (bakeRows > 0) {
          const br = await client.query<{ place_key: string; lat: string; lng: string }>(
            `SELECT place_key, lat_rounded::text lat, lng_rounded::text lng FROM place_layer_snapshots
              WHERE adapter_key = 'node-facets:tier1' AND place_key >= $1 AND ($2::text IS NULL OR place_key < $2)`,
            [`node:${county}:${lo}`, hi === null ? `node:${county};` : `node:${county}:${hi}`],
          );
          for (const r of br.rows) {
            const propId = r.place_key.slice(`node:${county}:`.length);
            const lat = Number(r.lat);
            const lng = Number(r.lng);
            if (lat === 0 && lng === 0) {
              bake.set(propId, "unmeasured");
              continue;
            }
            const res = resolveCityContainmentAtPoint(lng, lat, index);
            bake.set(propId, res.status === "incorporated" ? res.cityName : res.status === "unincorporated" ? UNINC : "unmeasured");
          }
        }
        // p2-juris rule from the same pieces (degree areas).
        const p2 = new Map<string, string>();
        for (const r of measured) {
          if (!p2.has(r.prop_id)) p2.set(r.prop_id, UNINC);
        }
        const best = new Map<string, number>();
        for (const r of measured) {
          if (r.geo_id == null || r.area_deg2 == null) continue;
          const a = Number(r.area_deg2);
          if (!(a >= P2_JURIS_FLOOR_DEG2)) continue;
          if (a > (best.get(r.prop_id) ?? -1)) {
            best.set(r.prop_id, a);
            p2.set(r.prop_id, r.city_name ?? r.geo_id);
          }
        }

        for (const [propId, g] of groupCityAreaShareRows(measured)) {
          const d = decideByAreaShare(g.parcelM2, g.pieces, UNINC);
          const now = label(d);
          summary.parcels += 1;
          if (!d) summary.unmeasured += 1;
          else {
            if (d.winner.kind === "jurisdiction") summary.newRule.incorporated += 1;
            else summary.newRule.unincorporated += 1;
            if (d.rule === "plurality") summary.newRule.plurality += 1;
            if (d.split) summary.newRule.split += 1;
          }
          const was = { landing: landing.get(propId), p2rule: p2.get(propId), bake: bake.get(propId) };
          let changed = false;
          for (const k of ["landing", "p2rule", "bake"] as const) {
            const w = was[k];
            if (w === undefined) continue;
            summary.changes[k].compared += 1;
            if (w !== now) {
              summary.changes[k].total += 1;
              bump(summary.changes[k].byTransition, `${w} -> ${now}`);
              changed = true;
            }
          }
          if (was.landing !== undefined && was.p2rule !== undefined) {
            summary.landingVsP2rule.compared += 1;
            if (was.landing !== was.p2rule) summary.landingVsP2rule.differ += 1;
          }
          if (changed || d?.split) {
            csv.push(
              [
                propId,
                g.parcelM2.toFixed(1),
                was.landing ?? "",
                was.p2rule ?? "",
                was.bake ?? "",
                now,
                d?.rule ?? "",
                d ? d.winner.share.toFixed(4) : "",
                d?.split ? "1" : "0",
                d?.disclosure ?? "",
              ]
                .map(csvCell)
                .join(","),
            );
          }
        }
        done += 1;
        if (done % 10 === 0 || done === ranges.length) {
          console.error(`[measure] ${county} chunk ${done}/${ranges.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
        }
      }
    } finally {
      await client.end();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, ranges.length)) }, worker));

  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `city-area-share-${county}.csv`), csv.join("\n") + "\n");
  }
  summary.ms = Date.now() - t0;
  return summary;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2).filter((a) => a !== "--"));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (unpooled host, read-only session option)");
  const results: CountySummary[] = [];
  for (const county of args.counties) {
    console.error(`[measure] ${county} ...`);
    const s = await measureCounty(url, county, args.chunk, args.concurrency, args.out);
    console.error(`[measure] ${county} done in ${Math.round(s.ms / 1000)}s`);
    results.push(s);
    console.log(JSON.stringify(s));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
