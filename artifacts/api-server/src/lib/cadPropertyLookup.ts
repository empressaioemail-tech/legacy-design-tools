/**
 * Drizzle-backed `CadPropertyLookup` accessor for the `cad:*` Property
 * Brief adapters (feat/cad-brief-adapters).
 *
 * `lib/adapters` is HTTP-fetch-shaped and must not import
 * `@workspace/db`, so the adapters declare an injected accessor on the
 * `AdapterContext` (`ctx.cadLookup`) and this module supplies the real
 * implementation: latest `tax_year` row for a `(county_fips, prop_id)`
 * pair out of the `cad_property` store (PR #245).
 *
 * The query walks the table's primary key — `(county_fips, prop_id,
 * tax_year)` — as an exact prefix match plus an ORDER BY on the key's
 * last column, so no additional index is needed.
 *
 * propId normalization mirrors `@workspace/cad-ingest`'s
 * `stripLeadingZeros`: the store keys prop ids as decimal strings with
 * leading zeros stripped, while county GIS layers sometimes return
 * zero-padded or numeric ids.
 */

import { and, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db as defaultDb, cadProperty } from "@workspace/db";
import type { CadPropertyLookup } from "@workspace/adapters";
import { normalizeCadPropId } from "./parcelNodeId";

// Re-exported so existing `./cadPropertyLookup` import sites keep working;
// the single implementation now lives in the dependency-free
// `parcelNodeId` module (see its header) so the db-free
// `brokerageTxParcels.ts` live path can share it.
export { normalizeCadPropId };

/**
 * Narrow db surface, mirroring @workspace/cad-ingest's `CadIngestDb`
 * precedent — lets tests pass their per-file test-schema handle without
 * generic gymnastics.
 */
export type CadLookupDb = Pick<
  NodePgDatabase<Record<string, unknown>>,
  "select"
>;

/**
 * Build the accessor. `database` is injectable for tests (the
 * integration suite passes its per-file test-schema drizzle handle).
 */
export function makeCadPropertyLookup(
  database: CadLookupDb = defaultDb,
): CadPropertyLookup {
  return async (countyFips, propId) => {
    const rows = await database
      .select()
      .from(cadProperty)
      .where(
        and(
          eq(cadProperty.countyFips, countyFips.trim()),
          eq(cadProperty.propId, normalizeCadPropId(propId)),
        ),
      )
      .orderBy(desc(cadProperty.taxYear))
      .limit(1);
    return rows[0] ?? null;
  };
}
