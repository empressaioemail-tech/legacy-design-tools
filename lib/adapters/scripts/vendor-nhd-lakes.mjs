#!/usr/bin/env node
/**
 * Vendors the two lake polygons the Burnet per-parcel setback resolver measures adjacency against
 * (OPS-24 stage 6, 2026-10-13). Both are USGS National Hydrography Dataset (NHD) High Resolution
 * waterbodies, public domain, read from the USGS National Map hydro service:
 *
 *   https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/12   ("Waterbody - Large Scale")
 *   query: where=PERMANENT_IDENTIFIER='<id>'&outFields=PERMANENT_IDENTIFIER,GNIS_ID,GNIS_NAME,FDATE,
 *          RESOLUTION,FCODE,AREASQKM&returnGeometry=true&outSR=4326&f=geojson
 *
 *   Lake Marble Falls          PERMANENT_IDENTIFIER 120026930  GNIS 01360852  (Marble Falls Table 4.3.1.B note 1)
 *   Lake Lyndon B Johnson      PERMANENT_IDENTIFIER 69729583   GNIS 01374767  (Horseshoe Bay § 14.02.402(b)(15)(U),
 *                                                                              § 14.02.406 / § 14.02.409 shoreline text)
 *
 * Usage: node vendor-nhd-lakes.mjs <lake_marble_falls.geojson> <lake_lbj.geojson> <fetched-date YYYY-MM-DD>
 *
 * Writes ../src/local/setbacks/water/nhd-lake-marble-falls.json and nhd-lake-lbj.json. Coordinates
 * are rounded to 6 decimal places (about 0.1 m), far below NHD's own positional accuracy (1:24,000
 * National Map Accuracy Standard: 90% of well-defined points within 40 ft / 12.2 m), which is the
 * figure the adjacency bands in burnet-parcel-facts.ts are built around.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "../src/local/setbacks/water");

const [mfPath, lbjPath, fetched] = process.argv.slice(2);
if (!mfPath || !lbjPath || !/^\d{4}-\d{2}-\d{2}$/.test(fetched ?? "")) {
  throw new Error("usage: vendor-nhd-lakes.mjs <lake_marble_falls.geojson> <lake_lbj.geojson> <YYYY-MM-DD>");
}

const EXPECT = {
  "lake-marble-falls": { id: "120026930", gnis: "01360852", name: "Lake Marble Falls", path: mfPath },
  "lake-lbj": { id: "69729583", gnis: "01374767", name: "Lake Lyndon B Johnson", path: lbjPath },
};

const round = (v) => Math.round(v * 1e6) / 1e6;

mkdirSync(OUT, { recursive: true });
for (const [key, want] of Object.entries(EXPECT)) {
  const fc = JSON.parse(readFileSync(want.path, "utf8"));
  if (!Array.isArray(fc.features) || fc.features.length !== 1) {
    throw new Error(`${key}: expected exactly one feature, got ${fc.features?.length}`);
  }
  const f = fc.features[0];
  const p = f.properties;
  if (p.PERMANENT_IDENTIFIER !== want.id || p.GNIS_ID !== want.gnis || p.GNIS_NAME !== want.name) {
    throw new Error(`${key}: unexpected feature ${JSON.stringify(p)}`);
  }
  if (f.geometry.type !== "Polygon") throw new Error(`${key}: expected a Polygon, got ${f.geometry.type}`);
  const rings = f.geometry.coordinates.map((ring) => ring.map(([x, y]) => [round(x), round(y)]));
  const out = {
    key,
    name: want.name,
    source:
      "USGS National Hydrography Dataset (NHD) High Resolution, 'Waterbody - Large Scale' layer, " +
      "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/12 (public domain).",
    query: `where=PERMANENT_IDENTIFIER='${want.id}'&outSR=4326&f=geojson`,
    fetched,
    nhd: {
      permanent_identifier: p.PERMANENT_IDENTIFIER,
      gnis_id: p.GNIS_ID,
      gnis_name: p.GNIS_NAME,
      fcode: p.FCODE,
      resolution: p.RESOLUTION,
      fdate: new Date(p.FDATE).toISOString().slice(0, 10),
      areasqkm: p.AREASQKM,
    },
    positional_accuracy_note:
      "NHD High Resolution is compiled at 1:24,000; the National Map Accuracy Standard for that scale puts 90% of well-defined points within 40 ft (12.2 m). Coordinates here are rounded to 1e-6 degree (~0.1 m).",
    vertices: rings.reduce((a, r) => a + r.length, 0),
    geometry: { type: "Polygon", coordinates: rings },
  };
  writeFileSync(join(OUT, `nhd-${key}.json`), JSON.stringify(out) + "\n");
  console.log(`${key}: ${rings.length} rings, ${out.vertices} vertices`);
}
