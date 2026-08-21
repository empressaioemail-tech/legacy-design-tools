/**
 * Parser for Tarrant Appraisal District (TAD) PropertyData(Delimited)
 * pipe-delimited export.
 *
 * Open-fetch: PropertyData(Delimited)_R.ZIP (~50MB residential slice).
 * Full county: PropertyData(Delimited).ZIP (~97MB) — announce before load.
 *
 * Field-mapping decisions:
 *  - prop_id: GIS_Link (matches StratMap/parcel store shape, e.g.
 *    "14437-29-32"), with internal whitespace collapsed. Account_Num is
 *    the numeric TAD account, not the store join key.
 *  - RP filter: R (residential) and C (commercial) land parcels are
 *    kept; other RP classes are named-skipped (counted). Silent drops
 *    of C were the L21 Tarrant load defect.
 *  - tax_year: Appraisal_Year (in-row).
 *  - living_area_sqft: Living_Area, rounded; 0 -> null.
 *  - year_built: Year_Built; 0 -> null.
 *  - land_acres: Land_Acres as explicit decimal (4 places); blank -> null.
 *  - owner mailing: Owner_Address + Owner_CityState + Owner_Zip.
 *  - assessed_value: Appraised_Value.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { CadPropertyRecord, ParseCounters } from "../../types";
import { newCounters, recordSkip } from "../../types";
import {
  explicitAcresOrNull,
  joinParts,
  positiveWholeOrNull,
  textOrNull,
  wholeNumberOrNull,
} from "../../normalize";

export type PipeRow = string[];

/** Async-generate pipe-delimited rows (header included as first row). */
export async function* readPipeRows(
  filePath: string,
  encoding: BufferEncoding = "utf8",
): AsyncGenerator<PipeRow> {
  const stream = createReadStream(filePath, { encoding });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    yield line.split("|");
  }
}

class PipeHeaderIndex {
  private readonly byName = new Map<string, number>();

  constructor(header: PipeRow) {
    header.forEach((h, i) => {
      const key = h.trim().toLowerCase().replace(/\s+/g, "");
      if (!this.byName.has(key)) this.byName.set(key, i);
    });
  }

  get(row: PipeRow, name: string): string {
    const i = this.byName.get(name.toLowerCase().replace(/\s+/g, ""));
    if (i === undefined || i >= row.length) return "";
    return row[i] ?? "";
  }
}

function ownerMailing(header: PipeHeaderIndex, row: PipeRow): string | null {
  const street = textOrNull(header.get(row, "owner_address"));
  const cityState = textOrNull(header.get(row, "owner_citystate"));
  const zip = textOrNull(header.get(row, "owner_zip"));
  const zip4 = textOrNull(header.get(row, "owner_zip4"));
  const zipFull =
    zip !== null && zip4 !== null ? `${zip}-${zip4}` : zip ?? zip4;
  return joinParts(street, cityState, zipFull);
}

function livingAreaSqft(raw: string): number | null {
  const t = raw.trim();
  if (t.length === 0) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

export function parseTadPropertyLine(
  header: PipeHeaderIndex,
  row: PipeRow,
  countyFips: string,
  counters: ParseCounters,
): CadPropertyRecord | null {
  const recordType = header.get(row, "rp").trim() || row[0]?.trim() || "";
  // L21: non-R rows are real accounts (C=commercial, P=personal). The
  // prior silent `return null` dropped ~49k parcel-linked 2025 GIS_Link
  // keys that exist in the 2026 source. Count them; do not invent keys.
  // Residential+commercial land parcels (R,C) enter cad_property. Personal
  // property (P) is named-skipped (not a parcel-read entity by itself).
  if (recordType.length > 0 && recordType !== "R" && recordType !== "C") {
    recordSkip(
      counters,
      `non-parcel RP class dropped (rp=${JSON.stringify(recordType)})`,
    );
    return null;
  }

  const rawGis = textOrNull(header.get(row, "gis_link"));
  // Normalize GIS_Link: collapse whitespace + uppercase so StratMap and
  // TAD land on the same prop_id (L21 measured case/space divergence).
  const propId =
    rawGis === null
      ? null
      : rawGis.trim().replace(/\s+/g, " ").toUpperCase() || null;
  const taxYear = wholeNumberOrNull(header.get(row, "appraisal_year"));
  if (propId === null || taxYear === null || taxYear < 1900) {
    recordSkip(
      counters,
      `unparsable key fields (gis_link=${JSON.stringify(header.get(row, "gis_link"))}, year=${header.get(row, "appraisal_year")})`,
    );
    return null;
  }

  return {
    countyFips,
    propId,
    taxYear,
    ownerName: textOrNull(header.get(row, "owner_name")),
    ownerMailingAddress: ownerMailing(header, row),
    situsAddress: textOrNull(header.get(row, "situs_address")),
    situsCity: null,
    situsZip: null,
    legalDescription: textOrNull(header.get(row, "legaldescription")),
    exemptionCodes: textOrNull(header.get(row, "exemption_code"))
      ? [header.get(row, "exemption_code").trim().toUpperCase()]
      : null,
    landValue: wholeNumberOrNull(header.get(row, "land_value")),
    improvementValue: wholeNumberOrNull(header.get(row, "improvement_value")),
    marketValue: wholeNumberOrNull(header.get(row, "total_value")),
    assessedValue: wholeNumberOrNull(header.get(row, "appraised_value")),
    yearBuilt: positiveWholeOrNull(header.get(row, "year_built")),
    livingAreaSqft: livingAreaSqft(header.get(row, "living_area")),
    landAcres: explicitAcresOrNull(header.get(row, "land_acres")),
    propertyUseCode: textOrNull(header.get(row, "state_use_code")),
  };
}

export interface TadParseOptions {
  countyFips: string;
  propertyFile: string;
  limit?: number;
}

/** Async-generate normalized records from a TAD PropertyData export. */
export async function* parseTadPropertyExport(
  opts: TadParseOptions,
  counters: ParseCounters = newCounters(),
): AsyncGenerator<CadPropertyRecord, ParseCounters> {
  let header: PipeHeaderIndex | null = null;
  const seen = new Set<string>();

  for await (const row of readPipeRows(opts.propertyFile)) {
    if (header === null) {
      header = new PipeHeaderIndex(row);
      continue;
    }
    counters.rowsRead += 1;
    const rec = parseTadPropertyLine(header, row, opts.countyFips, counters);
    if (rec === null) continue;
    const key = `${rec.propId}:${rec.taxYear}`;
    if (seen.has(key)) {
      counters.duplicateRows += 1;
      continue;
    }
    seen.add(key);
    counters.rowsParsed += 1;
    yield rec;
    if (opts.limit !== undefined && counters.rowsParsed >= opts.limit) break;
  }
  return counters;
}
