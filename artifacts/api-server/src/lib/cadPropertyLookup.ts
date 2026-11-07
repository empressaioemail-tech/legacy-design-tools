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

import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  db as defaultDb,
  cadProperty,
  cadPropertyVintageCrosswalk,
  cadPropertyVintageFallback,
  txgioParcel,
} from "@workspace/db";
import type { CadPropertyLookup } from "@workspace/adapters";
import {
  chooseCadPropIdResolution,
  classifyCadPropertyMiss,
  tryResolveDeclaredCadVintage,
} from "@workspace/cad-ingest";
import { normalizeCadPropId } from "./parcelNodeId";
import {
  accountCrosswalkForNode,
  cadAccountNumberStem,
  LANDUSE_JOIN_DISABLED_FIPS_SEED,
} from "./joinNormalize";

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
 * P-180 (2026-09-13). GATE-BLOCKED ACCOUNT LOOKUP -- the THIRD instance of the
 * OPS-21 identity law (never join a cell, a label or a dollar to `cad_property`
 * by the bare number in a gate-blocked county).
 *
 * WHY THIS FILE. For a gate-blocked county a property node is keyed by TxGIO's
 * `prop_id`, which is a DIFFERENT numbering system from the CAD roll's
 * `PropertyID` and only coincidentally collides with it. For Hays 48209 every
 * one of 97651/97652/97653/97657/97658 is ALSO a real, unrelated CAD account
 * (the Mesa Verde / Catalina Ln block), so this accessor's bare
 * `(county_fips, prop_id)` lookup served the colliding account's living area
 * and year built under the Sturgeon lots' identity.
 *
 * THE ACCOUNT IS REACHED THROUGH THE PUBLISHED IDENTIFIERS, not the bare
 * number: the node's own `txgio_parcel.geo_id` names `cad_property.property_number`,
 * corroborated by the account's `quick_ref_id` R-stem agreeing with the node's
 * own `prop_id` -- the SAME rule `joinNormalize.accountCrosswalkForNode` and the
 * tier-1 bake's `effectiveCadPropertyRoll` already apply, reused here rather
 * than re-derived.
 *
 * FAIL CLOSED: no `geo_id` on the node, no account publishing it, an ambiguous
 * `property_number`, or a disagreeing corroborator all return `null` (an honest
 * absence), NEVER a fallback to the colliding bare-number row. A non-blocked
 * county is byte-identical to the old behaviour -- this branch is never entered.
 */
export function shouldCrosswalkAccountLookup(
  countyFips: string,
  blockedFips: ReadonlySet<string> = LANDUSE_JOIN_DISABLED_FIPS_SEED,
): boolean {
  return blockedFips.has(countyFips);
}

/** The two columns the crosswalk bind needs from a candidate CAD account row. */
export interface CrosswalkAccountCandidate {
  propId: string;
  quickRefId: string | null;
}

/**
 * Pure half of the gate-blocked lookup, so the collision fixture is testable
 * without a database. `accounts` is every `cad_property` row at the declared
 * vintage whose `property_number` equals the node's `geo_id` -- the caller
 * refuses an ambiguous set rather than picking one.
 *
 * Returns the ACCOUNT prop id the node's own published Geographic ID names,
 * or null when the bind is absent, ambiguous, or refused by corroboration.
 */
export function chooseCrosswalkAccount(
  nodePropId: string,
  nodeGeoId: string | null | undefined,
  accounts: readonly CrosswalkAccountCandidate[],
): string | null {
  const geoId = nodeGeoId?.trim();
  if (!geoId) return null;
  const candidates = accounts.filter((a) => a.propId);
  if (candidates.length !== 1) return null; // none, or ambiguous -> refuse
  const account = candidates[0]!;
  const geoIdToAccountPropId = new Map<string, string>([
    [geoId, account.propId],
  ]);
  const stem = cadAccountNumberStem(account.quickRefId);
  const accountStemByPropId = new Map<string, string>();
  if (stem != null) accountStemByPropId.set(account.propId, stem);
  const { accountPropId } = accountCrosswalkForNode(
    nodePropId,
    geoId,
    geoIdToAccountPropId,
    accountStemByPropId,
  );
  return accountPropId;
}

async function lookupAccountViaCrosswalk(
  database: CadLookupDb,
  countyFips: string,
  nodePropId: string,
  taxYear: number,
) {
  const nodeRows = await database
    .select({ geoId: txgioParcel.geoId })
    .from(txgioParcel)
    .where(
      and(
        eq(txgioParcel.countyFips, countyFips),
        eq(txgioParcel.propId, nodePropId),
        isNotNull(txgioParcel.geoId),
      ),
    )
    .limit(3);
  const geoId =
    nodeRows.map((r) => r.geoId?.trim()).find((v) => v && v !== "") ?? null;
  if (!geoId) return null;

  const accounts = await database
    .select({
      propId: cadProperty.propId,
      quickRefId: cadProperty.quickRefId,
    })
    .from(cadProperty)
    .where(
      and(
        eq(cadProperty.countyFips, countyFips),
        eq(cadProperty.taxYear, taxYear),
        sql`btrim(${cadProperty.propertyNumber}) = ${geoId}`,
      ),
    )
    .limit(3);
  const accountPropId = chooseCrosswalkAccount(nodePropId, geoId, accounts);
  if (!accountPropId) return null;

  const rows = await database
    .select()
    .from(cadProperty)
    .where(
      and(
        eq(cadProperty.countyFips, countyFips),
        eq(cadProperty.propId, accountPropId),
        eq(cadProperty.taxYear, taxYear),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

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

    // P-180: a gate-blocked county's bare prop_id names a DIFFERENT account
    // (or none). Take the crosswalk bind or return an honest absence -- never
    // the bare-number row. Non-blocked counties skip this entirely.
    if (shouldCrosswalkAccountLookup(declared.countyFips)) {
      return lookupAccountViaCrosswalk(
        database,
        declared.countyFips,
        prop,
        declared.taxYear,
      );
    }

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
