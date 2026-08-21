/**
 * Drizzle-backed `CadPropertyLookup` accessor for the `cad:*` Property
 * Brief adapters (feat/cad-brief-adapters).
 *
 * `lib/adapters` is HTTP-fetch-shaped and must not import
 * `@workspace/db`, so the adapters declare an injected accessor on the
 * `AdapterContext` (`ctx.cadLookup`) and this module supplies the real
 * implementation: the county's DECLARED vintage row for a
 * `(county_fips, prop_id)` pair out of the `cad_property` store
 * (L17 / P-25 vintage-read discipline — replaces "latest tax_year wins").
 *
 * L21: on declared-year miss, consult `cad_property_vintage_crosswalk`
 * for at most one mapped key at the declared year (still no year
 * fallback).
 *
 * propId normalization mirrors `@workspace/cad-ingest`'s
 * `stripLeadingZeros`: the store keys prop ids as decimal strings with
 * leading zeros stripped, while county GIS layers sometimes return
 * zero-padded or numeric ids.
 */

import { and, eq, ne } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  db as defaultDb,
  cadProperty,
  cadPropertyVintageCrosswalk,
  cadPropertyVintageFallback,
} from "@workspace/db";
import type { CadPropertyLookup } from "@workspace/adapters";
import {
  chooseCadPropIdResolution,
  classifyCadPropertyMiss,
  tryResolveDeclaredCadVintage,
} from "@workspace/cad-ingest";
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
 *
 * Vintage discipline: filters to `resolveDeclaredCadVintage` tax year.
 * If the declared year has no row but another year does, returns null
 * (vintage-gap — never the other vintage's row). Undeclared counties
 * return null (honest empty). Crosswalk may remap the prop id inside
 * the declared year only. A named fallback may then return one explicitly
 * sanctioned prior-year row with a visible vintageResolution marker.
 */
export function makeCadPropertyLookup(
  database: CadLookupDb = defaultDb,
): CadPropertyLookup {
  return async (countyFips, propId) => {
    const declared = tryResolveDeclaredCadVintage(countyFips);
    if (!declared) return null;

    const prop = normalizeCadPropId(propId);
    const exact = await database
      .select()
      .from(cadProperty)
      .where(
        and(
          eq(cadProperty.countyFips, declared.countyFips),
          eq(cadProperty.propId, prop),
          eq(cadProperty.taxYear, declared.taxYear),
        ),
      )
      .limit(1);
    if (exact[0]) return exact[0];

    // L21: deterministic declared-year key mapping (not year fallback).
    const mapped = await database
      .select({
        toPropId: cadPropertyVintageCrosswalk.toPropId,
        method: cadPropertyVintageCrosswalk.method,
      })
      .from(cadPropertyVintageCrosswalk)
      .where(
        and(
          eq(cadPropertyVintageCrosswalk.countyFips, declared.countyFips),
          eq(cadPropertyVintageCrosswalk.fromPropId, prop),
          eq(cadPropertyVintageCrosswalk.toTaxYear, declared.taxYear),
        ),
      )
      .limit(2);
    if (mapped.length > 1) {
      // Unique constraint should prevent this; fail closed if violated.
      return null;
    }
    const fallback = await database
      .select({
        fallbackPropId: cadPropertyVintageFallback.fallbackPropId,
        fallbackTaxYear: cadPropertyVintageFallback.fallbackTaxYear,
        method: cadPropertyVintageFallback.method,
        evidenceClass: cadPropertyVintageFallback.evidenceClass,
      })
      .from(cadPropertyVintageFallback)
      .where(
        and(
          eq(cadPropertyVintageFallback.countyFips, declared.countyFips),
          eq(cadPropertyVintageFallback.requestedPropId, prop),
          eq(cadPropertyVintageFallback.declaredTaxYear, declared.taxYear),
        ),
      )
      .limit(2);
    if (fallback.length > 1) return null;

    let decision = chooseCadPropIdResolution({
      requestedPropId: prop,
      exactDeclaredHit: false,
      crosswalk: mapped[0]
        ? { toPropId: mapped[0].toPropId, method: mapped[0].method }
        : null,
      namedFallback: fallback[0] ?? null,
    });
    if (decision.kind === "crosswalk") {
      const rows = await database
        .select()
        .from(cadProperty)
        .where(
          and(
            eq(cadProperty.countyFips, declared.countyFips),
            eq(cadProperty.propId, decision.propId),
            eq(cadProperty.taxYear, declared.taxYear),
          ),
        )
        .limit(1);
      if (rows[0]) return rows[0];

      // A stale/missing crosswalk target is not a license to invent a hit.
      // Continue to the separately named fallback, if one exists.
      decision = chooseCadPropIdResolution({
        requestedPropId: prop,
        exactDeclaredHit: false,
        crosswalk: null,
        namedFallback: fallback[0] ?? null,
      });
    }

    if (decision.kind === "named-fallback") {
      const rows = await database
        .select()
        .from(cadProperty)
        .where(
          and(
            eq(cadProperty.countyFips, declared.countyFips),
            eq(cadProperty.propId, decision.propId),
            eq(cadProperty.taxYear, decision.taxYear),
          ),
        )
        .limit(1);
      if (rows[0]) {
        return {
          ...rows[0],
          vintageResolution: {
            kind: "named-fallback",
            requestedPropId: decision.fromPropId,
            declaredTaxYear: declared.taxYear,
            servedTaxYear: decision.taxYear,
            method: decision.method,
            evidenceClass: decision.evidenceClass,
          },
        };
      }
    }

    // Fail-closed vintage-gap probe: does another year have this prop
    // (requested key OR mapped key)?
    const other = await database
      .select({ taxYear: cadProperty.taxYear })
      .from(cadProperty)
      .where(
        and(
          eq(cadProperty.countyFips, declared.countyFips),
          eq(cadProperty.propId, prop),
          ne(cadProperty.taxYear, declared.taxYear),
        ),
      )
      .limit(1);
    const miss = classifyCadPropertyMiss({
      declaredYearHit: false,
      otherVintageHit: other.length > 0,
    });
    // Brief adapters only consume CadPropertyLookupRow | null today;
    // vintage-gap and not-found both surface as null (never cross-vintage).
    void miss;
    return null;
  };
}
