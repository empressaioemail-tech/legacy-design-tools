/**
 * Store reads for the W0b named land-use source. CLI only. Tests stay on
 * the DB-free `namedLandUseSource.ts`.
 */

import { tryResolveDeclaredCadVintage } from "@workspace/cad-ingest";
import {
  interpretLandUseFactRows,
  LAND_USE_FACT_ENTITY_TYPE,
  type AtomQueryable,
} from "./landUseFactRead";
import { tableExists, type QueryablePool } from "./nodeFacetTier1ParcelJoin";
import type { NamedLandUseHit } from "./namedLandUseSource";

export async function fetchCountyPropertyUseByPropId(
  pool: QueryablePool,
  fips: string,
): Promise<Map<string, NamedLandUseHit>> {
  const out = new Map<string, NamedLandUseHit>();
  const declared = tryResolveDeclaredCadVintage(fips);
  if (!declared) return out;
  if (!(await tableExists(pool, "cad_property"))) return out;
  const r = await pool.query<{
    prop_id: string;
    property_use_code: string;
    source_vintage: string | null;
  }>(
    `SELECT prop_id, property_use_code, source_vintage
       FROM cad_property
      WHERE county_fips = $1
        AND tax_year = $2
        AND property_use_code IS NOT NULL`,
    [declared.countyFips, declared.taxYear],
  );
  for (const row of r.rows) {
    const pid = row.prop_id?.trim();
    const code = row.property_use_code?.trim();
    if (!pid || !code) continue;
    out.set(pid, {
      code,
      vintage: row.source_vintage?.trim() || null,
      source: "cad-property",
    });
  }
  return out;
}

const SELECT_COUNTY_LAND_USE_FACTS = `
SELECT entity_id, body
  FROM atoms
 WHERE entity_type = $1
   AND entity_id LIKE $2 ESCAPE '\\'
`;

export async function fetchCountyLandUseFactByPropId(
  atoms: AtomQueryable,
  fips: string,
): Promise<Map<string, NamedLandUseHit>> {
  const out = new Map<string, NamedLandUseHit>();
  const like = `${fips.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}:%`;
  const result = await atoms.query<{ entity_id: string; body: unknown }>(
    SELECT_COUNTY_LAND_USE_FACTS,
    [LAND_USE_FACT_ENTITY_TYPE, like],
  );
  const byPrefix = new Map<string, Array<{ entity_id: string; body: unknown }>>();
  for (const row of result.rows) {
    const id = row.entity_id;
    const parts = id.split(":");
    if (parts.length < 3) continue;
    const prefix = `${parts[0]}:${parts[1]}`;
    const list = byPrefix.get(prefix) ?? [];
    list.push(row);
    byPrefix.set(prefix, list);
  }
  for (const [prefix, rows] of byPrefix) {
    const read = interpretLandUseFactRows(prefix, rows);
    if (read.state !== "present" || !read.landUseCode) continue;
    const propId = prefix.split(":")[1];
    if (!propId) continue;
    out.set(propId, {
      code: read.landUseCode,
      vintage: read.sourceVintage ?? String(read.taxYear),
      source: "land-use-fact",
    });
  }
  return out;
}
