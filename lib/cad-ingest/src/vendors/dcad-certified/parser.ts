/**
 * Parser for Dallas Central Appraisal District (DCAD) certified comma-
 * delimited bulk export (DCAD2026_CERTIFIED_*.zip).
 *
 * The drop is multi-file; this parser joins:
 *  - ACCOUNT_INFO.CSV — owner + situs identity
 *  - RES_DETAIL.CSV — year built + living area (residential)
 *  - ACCOUNT_APPRL_YEAR.CSV — land/improvement/total values
 *  - LAND.CSV — acreage (SQUARE FEET converted; ACRE rows summed)
 *
 * Field-mapping decisions:
 *  - prop_id: ACCOUNT_NUM trimmed (matches ArcGIS Prop_ID / store).
 *  - tax_year: APPRAISAL_YR (in-row).
 *  - living_area_sqft: RES_DETAIL.TOT_LIVING_AREA_SF, summed when
 *    multiple detail rows exist; rounded.
 *  - year_built: earliest RES_DETAIL.YR_BUILT across detail rows.
 *  - land_acres: LAND.AREA_SIZE summed per account, converting SF rows
 *    to acres (/ 43560); explicit ACRE rows added directly.
 *  - property_use_code: LAND.SPTD_CD from the primary land segment
 *    (lowest SECTION_NUM).
 *  - market_value: ACCOUNT_APPRL_YEAR.TOT_VAL.
 */

import type { CadPropertyRecord, ParseCounters } from "../../types";
import { newCounters, recordSkip } from "../../types";
import { HeaderIndex, readCsvRows } from "../../csv";
import {
  joinParts,
  positiveWholeOrNull,
  textOrNull,
  wholeNumberOrNull,
} from "../../normalize";

export type DcadFileKind =
  | "account-info"
  | "res-detail"
  | "apprl-year"
  | "land"
  | "unknown";

/** Classify a DCAD CSV by header columns. */
export function classifyDcadHeader(header: HeaderIndex): DcadFileKind {
  if (header.has("owner_name1") && header.has("full_street_name")) {
    return "account-info";
  }
  if (header.has("tot_living_area_sf") && header.has("yr_built")) {
    return "res-detail";
  }
  if (header.has("tot_val") && header.has("impr_val")) {
    return "apprl-year";
  }
  if (header.has("sptd_cd") && header.has("area_uom_desc")) {
    return "land";
  }
  return "unknown";
}

export interface DcadResRollup {
  yearBuilt: number | null;
  livingAreaSqft: number | null;
}

/** Roll up RES_DETAIL rows per `${account}:${year}`. */
export async function readDcadResDetail(
  filePath: string,
): Promise<Map<string, DcadResRollup>> {
  const rollups = new Map<string, DcadResRollup>();
  let header: HeaderIndex | null = null;
  for await (const row of readCsvRows(filePath)) {
    if (header === null) {
      header = new HeaderIndex(row);
      continue;
    }
    const account = textOrNull(header.get(row, "account_num"));
    const taxYear = wholeNumberOrNull(header.get(row, "appraisal_yr"));
    if (account === null || taxYear === null) continue;
    const key = `${account}:${taxYear}`;
    const prev = rollups.get(key) ?? { yearBuilt: null, livingAreaSqft: null };
    const areaRaw = header.get(row, "tot_living_area_sf").trim();
    const area = areaRaw.length > 0 ? Number(areaRaw) : NaN;
    if (Number.isFinite(area) && area > 0) {
      prev.livingAreaSqft = (prev.livingAreaSqft ?? 0) + area;
    }
    const yr = positiveWholeOrNull(header.get(row, "yr_built"));
    if (yr !== null) {
      prev.yearBuilt = prev.yearBuilt === null ? yr : Math.min(prev.yearBuilt, yr);
    }
    rollups.set(key, prev);
  }
  for (const r of rollups.values()) {
    if (r.livingAreaSqft !== null) r.livingAreaSqft = Math.round(r.livingAreaSqft);
  }
  return rollups;
}

interface DcadValues {
  landValue: number | null;
  improvementValue: number | null;
  marketValue: number | null;
  assessedValue: number | null;
}

export async function readDcadApprlYear(
  filePath: string,
): Promise<Map<string, DcadValues>> {
  const out = new Map<string, DcadValues>();
  let header: HeaderIndex | null = null;
  for await (const row of readCsvRows(filePath)) {
    if (header === null) {
      header = new HeaderIndex(row);
      continue;
    }
    const account = textOrNull(header.get(row, "account_num"));
    const taxYear = wholeNumberOrNull(header.get(row, "appraisal_yr"));
    if (account === null || taxYear === null) continue;
    const key = `${account}:${taxYear}`;
    const dollar = (name: string) => {
      const raw = header!.get(row, name).trim();
      if (raw.length === 0) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? Math.round(n) : null;
    };
    out.set(key, {
      landValue: dollar("land_val"),
      improvementValue: dollar("impr_val"),
      marketValue: dollar("tot_val"),
      assessedValue: dollar("hmstd_cap_val"),
    });
  }
  return out;
}

interface LandPick {
  stateCode: string;
  section: number;
  acres: number;
}

/** Sum land acreage + pick primary SPTD code per account/year. */
export async function readDcadLand(
  filePath: string,
): Promise<Map<string, { landAcres: string | null; propertyUseCode: string | null }>> {
  const picks = new Map<string, LandPick & { totalAcres: number }>();
  let header: HeaderIndex | null = null;
  for await (const row of readCsvRows(filePath)) {
    if (header === null) {
      header = new HeaderIndex(row);
      continue;
    }
    const account = textOrNull(header.get(row, "account_num"));
    const taxYear = wholeNumberOrNull(header.get(row, "appraisal_yr"));
    if (account === null || taxYear === null) continue;
    const key = `${account}:${taxYear}`;
    const uom = header.get(row, "area_uom_desc").trim().toUpperCase();
    const sizeRaw = header.get(row, "area_size").trim();
    const size = sizeRaw.length > 0 ? Number(sizeRaw) : NaN;
    let acres = 0;
    if (Number.isFinite(size) && size > 0) {
      if (uom === "ACRE" || uom === "ACRES") {
        acres = size;
      } else if (uom === "SQUARE FEET") {
        acres = size / 43_560;
      }
    }
    const sectionRaw = wholeNumberOrNull(header.get(row, "section_num"));
    const section = sectionRaw !== null ? sectionRaw : Number.MAX_SAFE_INTEGER;
    const stateCode = textOrNull(header.get(row, "sptd_cd"));
    const prev = picks.get(key) ?? {
      stateCode: stateCode ?? "",
      section: Number.MAX_SAFE_INTEGER,
      acres: 0,
      totalAcres: 0,
    };
    prev.totalAcres += acres;
    if (
      stateCode !== null &&
      (section < prev.section || prev.stateCode.length === 0)
    ) {
      prev.stateCode = stateCode;
      prev.section = section;
    }
    picks.set(key, prev);
  }
  const out = new Map<string, { landAcres: string | null; propertyUseCode: string | null }>();
  for (const [key, pick] of picks) {
    out.set(key, {
      landAcres: pick.totalAcres > 0 ? pick.totalAcres.toFixed(4) : null,
      propertyUseCode: pick.stateCode.length > 0 ? pick.stateCode : null,
    });
  }
  return out;
}

function situsLine(header: HeaderIndex, row: string[]): string | null {
  return joinParts(
    header.get(row, "street_num"),
    header.get(row, "street_half_num"),
    header.get(row, "full_street_name"),
    header.get(row, "bldg_id"),
    header.get(row, "unit_id"),
  );
}

function legalDesc(header: HeaderIndex, row: string[]): string | null {
  return joinParts(
    header.get(row, "legal1"),
    header.get(row, "legal2"),
    header.get(row, "legal3"),
    header.get(row, "legal4"),
    header.get(row, "legal5"),
  );
}

function ownerMailing(header: HeaderIndex, row: string[]): string | null {
  return joinParts(
    header.get(row, "owner_address_line1"),
    header.get(row, "owner_address_line2"),
    header.get(row, "owner_address_line3"),
    header.get(row, "owner_address_line4"),
    joinParts(
      header.get(row, "owner_city"),
      header.get(row, "owner_state"),
      header.get(row, "owner_zipcode"),
    ),
  );
}

export interface DcadParseOptions {
  countyFips: string;
  accountInfoFile: string;
  resDetailFile?: string;
  apprlYearFile?: string;
  landFile?: string;
  limit?: number;
}

/** Async-generate normalized records from a DCAD certified export. */
export async function* parseDcadCertifiedExport(
  opts: DcadParseOptions,
  counters: ParseCounters = newCounters(),
): AsyncGenerator<CadPropertyRecord, ParseCounters> {
  const resDetail = opts.resDetailFile
    ? await readDcadResDetail(opts.resDetailFile)
    : new Map<string, DcadResRollup>();
  const values = opts.apprlYearFile
    ? await readDcadApprlYear(opts.apprlYearFile)
    : new Map<string, DcadValues>();
  const land = opts.landFile
    ? await readDcadLand(opts.landFile)
    : new Map<string, { landAcres: string | null; propertyUseCode: string | null }>();

  const seen = new Set<string>();
  let header: HeaderIndex | null = null;
  for await (const row of readCsvRows(opts.accountInfoFile)) {
    if (header === null) {
      header = new HeaderIndex(row);
      const kind = classifyDcadHeader(header);
      if (kind !== "account-info") {
        throw new Error(
          `${opts.accountInfoFile}: expected ACCOUNT_INFO CSV, classified as "${kind}"`,
        );
      }
      continue;
    }
    counters.rowsRead += 1;
    const propId = textOrNull(header.get(row, "account_num"));
    const taxYear = wholeNumberOrNull(header.get(row, "appraisal_yr"));
    if (propId === null || taxYear === null || taxYear < 1900) {
      recordSkip(
        counters,
        `unparsable key fields (account_num=${JSON.stringify(header.get(row, "account_num"))}, year=${header.get(row, "appraisal_yr")})`,
      );
      continue;
    }
    const key = `${propId}:${taxYear}`;
    if (seen.has(key)) {
      counters.duplicateRows += 1;
      continue;
    }
    seen.add(key);

    const res = resDetail.get(key);
    const val = values.get(key);
    const landRow = land.get(key);

    counters.rowsParsed += 1;
    yield {
      countyFips: opts.countyFips,
      propId,
      taxYear,
      ownerName: joinParts(
        header.get(row, "owner_name1"),
        header.get(row, "owner_name2"),
      ),
      ownerMailingAddress: ownerMailing(header, row),
      situsAddress: situsLine(header, row),
      situsCity: textOrNull(header.get(row, "property_city")),
      situsZip: textOrNull(header.get(row, "property_zipcode")),
      legalDescription: legalDesc(header, row),
      exemptionCodes: null,
      landValue: val?.landValue ?? null,
      improvementValue: val?.improvementValue ?? null,
      marketValue: val?.marketValue ?? null,
      assessedValue: val?.assessedValue ?? null,
      yearBuilt: res?.yearBuilt ?? null,
      livingAreaSqft: res?.livingAreaSqft ?? null,
      landAcres: landRow?.landAcres ?? null,
      propertyUseCode: landRow?.propertyUseCode ?? null,
    };
    if (opts.limit !== undefined && counters.rowsParsed >= opts.limit) break;
  }
  return counters;
}
