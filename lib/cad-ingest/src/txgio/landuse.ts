/**
 * StratMap land-parcel DBF land-use extraction -> `cad_property` row.
 *
 * The free public TxGIO/StratMap land-parcels DBF (the SAME file the
 * `txgio-ingest` geometry loader downloads - see `./cli.ts`) carries a
 * land-use classification the geometry parser (`./parse.ts`)
 * deliberately drops: `STAT_LAND_` (the Texas Comptroller PTAD state
 * category code, e.g. `A1`) and `LOC_LAND_U` (the CAD's local
 * classification, e.g. `RES`). This module maps a DBF attribute row to
 * the provider-neutral `cad_property` shape so a county whose licensed
 * CAD appraisal roll is not (or not yet) loaded still gets the ONE
 * field the map choropleth and the buildable-envelope district-mapping
 * read: `property_use_code`.
 *
 * Why the state category and not the local code: `property_use_code`
 * consumers (`artifacts/api-server/src/lib/ptadLandUse.ts`, the
 * `gis-map-paint.js` choropleth, and the envelope district-mapping) key
 * on the leading letter of a PTAD state category (A single-family, B
 * multifamily, C vacant, D ag, E rural, F commercial, ...). `STAT_LAND_`
 * IS that PTAD code; `LOC_LAND_U` is a per-CAD local vocabulary with no
 * shared mapping. So `STAT_LAND_` -> `property_use_code`, and
 * `LOC_LAND_U` is not emitted (there is no column for it and no
 * consumer that reads it).
 *
 * Field names verified against the real stratmap25 Bexar (48029) DBF
 * header 2026-07-20 (byte offsets confirmed: `STAT_LAND_` C(5),
 * `LOC_LAND_U` C(5), `LAND_VALUE`/`IMP_VALUE`/`MKT_VALUE` F(19),
 * `Prop_ID` C(10), `TAX_YEAR` N(10), `SITUS_*`), and match the schema
 * documented in `./parse.ts`.
 *
 * Honesty (structural commitment #1 - map only real values): a blank
 * `STAT_LAND_` yields a NULL `property_use_code` (no guessed code); the
 * value fields are emitted only when the DBF carries a finite number.
 * The row is still emitted for a blank-code parcel so its owner/situs/
 * value attributes land, but land-use stays null - the choropleth then
 * renders that parcel without a land-use color rather than a fabricated
 * one.
 */

import type { CadPropertyRecord, ParseCounters } from "../types";
import { recordSkip } from "../types";

/** Raw DBF attribute bag for one StratMap land-parcel feature. */
export type StratMapProperties = Record<string, unknown>;

function str(v: unknown): string | null {
  if (typeof v !== "string") {
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    return null;
  }
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : null;
}

/**
 * Whole-dollar value from a StratMap `F`-type value field. The DBF
 * stores these as floating strings (e.g. `2.68880000000e+05`); round to
 * the nearest whole dollar to match the `cad_property` bigint columns.
 * Zero and negatives are dropped to null (a StratMap value of `0` means
 * "not carried", not "worth nothing").
 */
function dollars(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

/**
 * Normalize a raw `STAT_LAND_` value to a single PTAD state category
 * code for `property_use_code`.
 *
 * StratMap concatenates a parcel's per-land-segment state codes with a
 * comma, so the field routinely reads `A1,A1` (the same code repeated
 * for a multi-segment single-use parcel) and occasionally `A1,F1` (a
 * genuine mixed-use parcel - ~1,793 of 709,541 in Bexar). The
 * choropleth and envelope mapping need ONE code, so we take the first
 * non-blank comma segment as the parcel's primary classification. That
 * is the parcel's own first-listed real value (never invented), and
 * for the overwhelmingly common repeated-code case it is exactly the
 * intended code. Returns null for a blank field (no fabricated code).
 */
export function normalizeStatLandUse(raw: unknown): string | null {
  const s = str(raw);
  if (!s) return null;
  for (const part of s.split(",")) {
    const code = part.trim().toUpperCase();
    if (code.length > 0) return code;
  }
  return null;
}

/**
 * Map one StratMap DBF attribute row to a `cad_property` record.
 * Returns null (and counts a skip) when the row carries no usable
 * `Prop_ID` or no `TAX_YEAR` - without either the row cannot key into
 * `cad_property`'s (county_fips, prop_id, tax_year) primary key and so
 * cannot join to a map feature.
 *
 * `propId` is normalized identically to `normalizeCadPropId` (leading
 * zeros stripped from all-numeric ids) so the row lands on the SAME key
 * the `txgioParcelStore` land-use join and the `cad:*` brief adapters
 * use; a divergent prop_id would silently never match a parcel.
 */
export function normalizeStratMapLandUse(
  countyFips: string,
  featureIndex: number,
  properties: StratMapProperties,
  counters: ParseCounters,
  fallbackTaxYear?: number,
): CadPropertyRecord | null {
  const rawPropId = str(properties.Prop_ID);
  if (!rawPropId) {
    recordSkip(counters, `feature ${featureIndex}: no Prop_ID`);
    return null;
  }
  // Mirror normalizeCadPropId: strip leading zeros on all-numeric ids.
  const propId = /^\d+$/.test(rawPropId)
    ? rawPropId.replace(/^0+(?=\d)/, "")
    : rawPropId;

  const rawTaxYear = str(properties.TAX_YEAR);
  const taxYear =
    rawTaxYear !== null && /^\d{4}$/.test(rawTaxYear)
      ? Number(rawTaxYear)
      : fallbackTaxYear;
  if (taxYear === undefined || !Number.isInteger(taxYear)) {
    recordSkip(counters, `feature ${featureIndex}: no TAX_YEAR (prop ${propId})`);
    return null;
  }

  return {
    countyFips,
    propId,
    taxYear,
    ownerName: str(properties.OWNER_NAME),
    ownerMailingAddress: str(properties.MAIL_ADDR),
    situsAddress: str(properties.SITUS_ADDR),
    situsCity: str(properties.SITUS_CITY),
    situsZip: str(properties.SITUS_ZIP),
    legalDescription: str(properties.LEGAL_DESC),
    exemptionCodes: null,
    landValue: dollars(properties.LAND_VALUE),
    improvementValue: dollars(properties.IMP_VALUE),
    marketValue: dollars(properties.MKT_VALUE),
    assessedValue: null,
    yearBuilt: null,
    livingAreaSqft: null,
    landAcres: null,
    propertyUseCode: normalizeStatLandUse(properties.STAT_LAND_),
  };
}
