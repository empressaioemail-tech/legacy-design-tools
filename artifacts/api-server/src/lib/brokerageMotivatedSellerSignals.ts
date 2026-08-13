/**
 * Public-record signal reader for the motivated-seller composite map layer.
 *
 * This module supplies the ONE motivated-seller signal that is genuinely live
 * from data the spine already holds — ABSENTEE OWNERSHIP — by reading the
 * `cad_property` county appraisal-district roll and comparing the owner's
 * mailing address to the property's situs address. It is deliberately a thin,
 * INJECTABLE reader (same precedent as `makeCadPropertyLookup` /
 * `fetchCadLandUseForTile`) so the derivation is testable without a live db and
 * so `lib/adapters` stays db-free.
 *
 * WHY ONLY ABSENTEE TODAY (honest data-availability, not a shortcut): the
 * motivated-seller heat score is a TRANSPARENT, documented weighted-sum over TX
 * public records acquired through the uniform public-record process (ruling R3,
 * `_inbox/2026-07-16_map_data_sourcing_rulings.md`). Of the five R3 signals,
 * exactly one is reachable from a store the spine holds right now:
 *
 *   - absentee-owner (mailing != situs)  -> LIVE here, from `cad_property`.
 *   - tenure / length-of-ownership       -> NOT LIVE. `cad_property` carries NO
 *     last-sale / deed date (see its schema — owner, mailing, situs, values,
 *     year_built, exemptions only). A year_built is NOT ownership tenure, so
 *     tenure is recorded as not-evaluated-pending-ingest, never faked.
 *   - tax-delinquency                    -> NOT LIVE. No delinquent-roll store.
 *   - pre-foreclosure Notice of (Substitute) Trustee's Sale -> NOT LIVE.
 *   - lis-pendens / tax-liens / probate  -> NOT LIVE.
 *
 * The derivation (`deriveMotivatedSellerHeat`) is nevertheless shaped to CONSUME
 * every one of those signals with its documented weight the moment its data is
 * ingested; this reader is where the absentee leg is wired. The rest light up
 * through their own readers as the county ingests land (each flagged as an
 * operator/fleet data-pull, not fabricated).
 *
 * A homestead exemption (`HS` in `exemption_codes`) is a public corroborator of
 * OWNER-OCCUPANCY: a homestead-exempt parcel is owner-occupied by definition, so
 * it cannot be an out-of-area absentee. We surface it as corroboration of the
 * absentee determination, never as an independent weighted signal (R3's signal
 * list is explicit), and never to manufacture motivation where the mailing
 * address does not support it.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db as defaultDb, cadProperty } from "@workspace/db";
import { normalizeCadPropId } from "./cadPropertyLookup";

/** Narrow db surface, mirroring `CadLookupDb` — injectable for tests. */
export type MotivatedSellerSignalDb = Pick<
  NodePgDatabase<Record<string, unknown>>,
  "select"
>;

/**
 * The absentee-ownership determination for one parcel, read from the CAD roll.
 * `available:false` means the parcel was not matchable to a `cad_property` row
 * (no roll ingested for that county, or the id did not join) — which makes the
 * absentee signal NOT-EVALUATED for that parcel, never "absentee: no".
 */
export type AbsenteeSignal = {
  available: boolean;
  /** True only when a mailing address was resolved AND it differs from situs. */
  absentee: boolean | null;
  ownerMailingAddress: string | null;
  situsAddress: string | null;
  /** Homestead exemption present -> owner-occupied corroboration. */
  homesteadExempt: boolean;
  /** Which CAD export drop the row came from (data vintage / provenance). */
  sourceVintage: string | null;
  taxYear: number | null;
  note: string | null;
};

/** A parcel identity the absentee reader can join on. */
export type ParcelIdentity = {
  countyFips: string;
  propId: string;
  /** Situs from the parcel feature, used when the CAD row lacks its own. */
  featureSitusAddress: string | null;
};

const NOT_MATCHED: AbsenteeSignal = {
  available: false,
  absentee: null,
  ownerMailingAddress: null,
  situsAddress: null,
  homesteadExempt: false,
  sourceVintage: null,
  taxYear: null,
  note: "No cad_property row matched this parcel (no roll ingested for the county, or the id did not join); absentee ownership is not-evaluated here, not 'not absentee'.",
};

/** Uppercase, collapse whitespace, strip punctuation for address comparison. */
export function normalizeAddressForCompare(value: string | null): string {
  if (!value) return "";
  return value
    .toUpperCase()
    .replace(/[.,#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Decide absentee from a resolved CAD row. Absentee is TRUE only when both a
 * mailing address and a situs address are present AND their normalized street
 * lines differ. When either is missing we cannot decide, so absentee stays null
 * (not-evaluated for this parcel) rather than defaulting to a motivating "yes".
 */
export function decideAbsentee(input: {
  ownerMailingAddress: string | null;
  cadSitusAddress: string | null;
  cadSitusCity: string | null;
  featureSitusAddress: string | null;
  exemptionCodes: string[] | null;
}): {
  absentee: boolean | null;
  situsUsed: string | null;
  homesteadExempt: boolean;
  note: string | null;
} {
  const homesteadExempt = (input.exemptionCodes ?? []).some(
    (c) => typeof c === "string" && c.trim().toUpperCase() === "HS",
  );

  const mailing = normalizeAddressForCompare(input.ownerMailingAddress);
  // Prefer the CAD situs; fall back to the parcel feature's situs line.
  const situsRaw =
    input.cadSitusAddress?.trim() || input.featureSitusAddress?.trim() || null;
  const situs = normalizeAddressForCompare(situsRaw);

  if (!mailing) {
    return {
      absentee: null,
      situsUsed: situsRaw,
      homesteadExempt,
      note: "Owner mailing address missing on the CAD row; absentee cannot be determined (not-evaluated), never assumed.",
    };
  }
  if (!situs) {
    return {
      absentee: null,
      situsUsed: situsRaw,
      homesteadExempt,
      note: "Situs address missing on both the CAD row and the parcel feature; absentee cannot be determined (not-evaluated).",
    };
  }

  // A homestead exemption is a hard owner-occupancy corroborator: never flag a
  // homestead-exempt parcel absentee even if the mailing string differs (PO box,
  // formatting), since the exemption legally requires the owner to reside there.
  if (homesteadExempt) {
    return {
      absentee: false,
      situsUsed: situsRaw,
      homesteadExempt: true,
      note: "Homestead (HS) exemption present -> owner-occupied by law; not absentee regardless of mailing-string formatting.",
    };
  }

  const absentee = mailing !== situs;
  return {
    absentee,
    situsUsed: situsRaw,
    homesteadExempt: false,
    note: absentee
      ? "Owner mailing address differs from situs -> absentee owner (mailing != situs)."
      : "Owner mailing address matches situs -> owner appears to reside at the property.",
  };
}

/**
 * Batch-read the absentee signal for a tile's parcels from `cad_property` in ONE
 * query per county present in the viewport (not one per parcel), mirroring
 * `fetchCadLandUseForTile`. Returns a map keyed
 * `${countyFips}:${normalizeCadPropId(propId)}`. A parcel with no matched CAD
 * row is ABSENT from the map, which the derivation reads as not-evaluated.
 */
export async function fetchAbsenteeSignalsForTile(
  parcels: ParcelIdentity[],
  database: MotivatedSellerSignalDb = defaultDb,
): Promise<Map<string, AbsenteeSignal>> {
  const out = new Map<string, AbsenteeSignal>();
  if (parcels.length === 0) return out;

  // Group distinct normalized prop ids by county.
  const byCounty = new Map<string, Set<string>>();
  const featureSitus = new Map<string, string | null>();
  for (const p of parcels) {
    const county = p.countyFips.trim();
    const id = normalizeCadPropId(p.propId);
    if (!county || !id) continue;
    if (!byCounty.has(county)) byCounty.set(county, new Set());
    byCounty.get(county)!.add(id);
    const key = `${county}:${id}`;
    if (!featureSitus.has(key)) featureSitus.set(key, p.featureSitusAddress);
  }

  for (const [county, idSet] of byCounty) {
    const ids = [...idSet];
    if (ids.length === 0) continue;

    const rows = (await database
      .select({
        propId: cadProperty.propId,
        taxYear: cadProperty.taxYear,
        ownerMailingAddress: cadProperty.ownerMailingAddress,
        situsAddress: cadProperty.situsAddress,
        situsCity: cadProperty.situsCity,
        exemptionCodes: cadProperty.exemptionCodes,
        sourceVintage: cadProperty.sourceVintage,
      })
      .from(cadProperty)
      .where(
        and(
          eq(cadProperty.countyFips, county),
          inArray(cadProperty.propId, ids),
        ),
      )
      .orderBy(desc(cadProperty.taxYear))) as Array<{
      propId: string;
      taxYear: number;
      ownerMailingAddress: string | null;
      situsAddress: string | null;
      situsCity: string | null;
      exemptionCodes: string[] | null;
      sourceVintage: string;
    }>;

    // Latest tax-year row wins per parcel (rows come pre-sorted desc).
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.propId)) continue;
      seen.add(row.propId);
      const key = `${county}:${row.propId}`;
      const decision = decideAbsentee({
        ownerMailingAddress: row.ownerMailingAddress,
        cadSitusAddress: row.situsAddress,
        cadSitusCity: row.situsCity,
        featureSitusAddress: featureSitus.get(key) ?? null,
        exemptionCodes: row.exemptionCodes,
      });
      out.set(key, {
        available: true,
        absentee: decision.absentee,
        ownerMailingAddress: row.ownerMailingAddress,
        situsAddress: decision.situsUsed,
        homesteadExempt: decision.homesteadExempt,
        sourceVintage: row.sourceVintage,
        taxYear: row.taxYear,
        note: decision.note,
      });
    }
  }

  return out;
}

export { NOT_MATCHED as MOTIVATED_SELLER_ABSENTEE_NOT_MATCHED };
