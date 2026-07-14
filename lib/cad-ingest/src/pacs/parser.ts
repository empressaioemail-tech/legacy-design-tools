/**
 * Streaming parser for PACS "Appraisal Export Layout 8.0.x" files
 * (Travis / Bastrop / Caldwell).
 *
 * Input is the fixed-width `*_APPRAISAL_INFO.TXT` file, optionally
 * enriched from `*_APPRAISAL_IMPROVEMENT_DETAIL.TXT` (year built +
 * living area of "MAIN AREA" segments). Rows are parsed defensively:
 * malformed lines (short records, unparsable prop_id / year) are
 * counted and skipped, never fatal.
 *
 * Field-mapping decisions (documented once, here):
 *  - market_value: the layout's `market_value` field; falls back to
 *    `appraised_val` when blank.
 *  - land_value = land_hstd + land_non_hstd + ag_market +
 *    timber_market (the land share of market value; ag/timber market
 *    is how rural land market value is carried in PACS).
 *  - improvement_value = imprv_hstd + imprv_non_hstd.
 *  - property_use_code: `imprv_state_cd` (more specific, e.g. A1/E1)
 *    falling back to `land_state_cd`.
 *  - exemptions: the T/F flag block mapped to short codes (HS, OV65,
 *    DV1..DV4(+S), EX, ...).
 *  - Multi-owner (UDI) properties emit one APPRAISAL_INFO row per
 *    owner; the first row wins for a given (prop_id, tax_year) and
 *    later ones count as `duplicateRows`.
 *  - year_built / living_area_sqft come from improvement-detail
 *    segments whose type description starts with "MAIN AREA" (MA,
 *    MA2, ... — porches/garages carry their own codes and are
 *    excluded): living area is the sum of MAIN AREA segment areas,
 *    year built the earliest MAIN AREA year.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { CadPropertyRecord, ParseCounters } from "../types";
import { newCounters, recordSkip } from "../types";
import {
  APPRAISAL_INFO,
  APPRAISAL_INFO_MIN_LEN,
  EXEMPTION_FLAGS,
  IMPROVEMENT_DETAIL,
  IMPROVEMENT_DETAIL_MIN_LEN,
  cut,
} from "./layout";
import {
  impliedAcresOrNull,
  joinParts,
  mailingLine,
  stripLeadingZeros,
  textOrNull,
  wholeNumberOrNull,
} from "../normalize";

/** Per-property improvement rollup keyed `${propId}:${taxYear}`. */
export interface ImprovementRollup {
  yearBuilt: number | null;
  livingAreaSqft: number | null;
}

function lineReader(filePath: string) {
  // PACS exports are Windows-1252-ish single-byte text. latin1 decodes
  // every byte 1:1, which is lossless for the ASCII fields we read.
  const stream = createReadStream(filePath, { encoding: "latin1" });
  return createInterface({ input: stream, crlfDelay: Infinity });
}

/**
 * Stream `APPRAISAL_IMPROVEMENT_DETAIL.TXT` and roll up MAIN AREA
 * segments per (prop_id, tax_year).
 */
export async function readImprovementRollups(
  filePath: string,
): Promise<Map<string, ImprovementRollup>> {
  const rollups = new Map<string, ImprovementRollup>();
  const rl = lineReader(filePath);
  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    if (line.length < IMPROVEMENT_DETAIL_MIN_LEN) continue;
    const typeDesc = cut(line, IMPROVEMENT_DETAIL.typeDesc).toUpperCase();
    if (!typeDesc.startsWith("MAIN AREA")) continue;
    const propId = stripLeadingZeros(cut(line, IMPROVEMENT_DETAIL.propId));
    const taxYear = wholeNumberOrNull(cut(line, IMPROVEMENT_DETAIL.propValYr));
    if (!propId || taxYear === null) continue;
    const key = `${propId}:${taxYear}`;
    const yrBuilt = wholeNumberOrNull(cut(line, IMPROVEMENT_DETAIL.yrBuilt));
    const areaRaw = cut(line, IMPROVEMENT_DETAIL.area);
    const area = areaRaw.length > 0 ? Number(areaRaw) : NaN;
    const prev = rollups.get(key) ?? { yearBuilt: null, livingAreaSqft: null };
    if (Number.isFinite(area) && area > 0) {
      prev.livingAreaSqft = (prev.livingAreaSqft ?? 0) + area;
    }
    if (yrBuilt !== null && yrBuilt > 0) {
      prev.yearBuilt =
        prev.yearBuilt === null ? yrBuilt : Math.min(prev.yearBuilt, yrBuilt);
    }
    rollups.set(key, prev);
  }
  // Round accumulated fractional areas once at the end.
  for (const r of rollups.values()) {
    if (r.livingAreaSqft !== null) r.livingAreaSqft = Math.round(r.livingAreaSqft);
  }
  return rollups;
}

function sumOrNull(...values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0);
}

/** Parse one APPRAISAL_INFO line; null means "skip" (reason via counters). */
export function parsePacsInfoLine(
  line: string,
  countyFips: string,
  counters: ParseCounters,
  rollups?: Map<string, ImprovementRollup>,
): CadPropertyRecord | null {
  if (line.length < APPRAISAL_INFO_MIN_LEN) {
    recordSkip(
      counters,
      `short record (${line.length} < ${APPRAISAL_INFO_MIN_LEN} chars)`,
    );
    return null;
  }
  const propIdRaw = cut(line, APPRAISAL_INFO.propId);
  const taxYear = wholeNumberOrNull(cut(line, APPRAISAL_INFO.propValYr));
  if (!/^\d+$/.test(propIdRaw) || taxYear === null || taxYear < 1900) {
    recordSkip(
      counters,
      `unparsable key fields (prop_id=${JSON.stringify(propIdRaw)}, year=${cut(line, APPRAISAL_INFO.propValYr)})`,
    );
    return null;
  }
  const propId = stripLeadingZeros(propIdRaw);

  const exemptions = EXEMPTION_FLAGS.filter(
    (f) => line.charAt(f.pos - 1).toUpperCase() === "T",
  ).map((f) => f.code);

  const landValue = sumOrNull(
    wholeNumberOrNull(cut(line, APPRAISAL_INFO.landHstdVal)),
    wholeNumberOrNull(cut(line, APPRAISAL_INFO.landNonHstdVal)),
    wholeNumberOrNull(cut(line, APPRAISAL_INFO.agMarket)),
    wholeNumberOrNull(cut(line, APPRAISAL_INFO.timberMarket)),
  );
  const improvementValue = sumOrNull(
    wholeNumberOrNull(cut(line, APPRAISAL_INFO.imprvHstdVal)),
    wholeNumberOrNull(cut(line, APPRAISAL_INFO.imprvNonHstdVal)),
  );
  const marketValue =
    wholeNumberOrNull(cut(line, APPRAISAL_INFO.marketValue)) ??
    wholeNumberOrNull(cut(line, APPRAISAL_INFO.appraisedVal));

  const legal = joinParts(
    cut(line, APPRAISAL_INFO.legalDesc),
    cut(line, APPRAISAL_INFO.legalDesc2),
  );

  const rollup = rollups?.get(`${propId}:${taxYear}`);

  return {
    countyFips,
    propId,
    taxYear,
    ownerName: textOrNull(cut(line, APPRAISAL_INFO.pyOwnerName)),
    ownerMailingAddress: mailingLine({
      lines: [
        cut(line, APPRAISAL_INFO.pyAddrLine1),
        cut(line, APPRAISAL_INFO.pyAddrLine2),
        cut(line, APPRAISAL_INFO.pyAddrLine3),
      ],
      city: cut(line, APPRAISAL_INFO.pyAddrCity),
      state: cut(line, APPRAISAL_INFO.pyAddrState),
      zip: cut(line, APPRAISAL_INFO.pyAddrZip),
      zip4: cut(line, APPRAISAL_INFO.pyAddrZipCass),
    }),
    situsAddress: joinParts(
      cut(line, APPRAISAL_INFO.situsNum),
      cut(line, APPRAISAL_INFO.situsStreetPrefix),
      cut(line, APPRAISAL_INFO.situsStreet),
      cut(line, APPRAISAL_INFO.situsStreetSuffix),
      cut(line, APPRAISAL_INFO.situsUnit),
    ),
    situsCity: textOrNull(cut(line, APPRAISAL_INFO.situsCity)),
    situsZip: textOrNull(cut(line, APPRAISAL_INFO.situsZip)),
    legalDescription: legal,
    exemptionCodes: exemptions.length > 0 ? exemptions : null,
    landValue,
    improvementValue,
    marketValue,
    assessedValue: wholeNumberOrNull(cut(line, APPRAISAL_INFO.assessedVal)),
    yearBuilt: rollup?.yearBuilt ?? null,
    livingAreaSqft: rollup?.livingAreaSqft ?? null,
    landAcres: impliedAcresOrNull(cut(line, APPRAISAL_INFO.landAcres)),
    propertyUseCode:
      textOrNull(cut(line, APPRAISAL_INFO.imprvStateCd)) ??
      textOrNull(cut(line, APPRAISAL_INFO.landStateCd)),
  };
}

export interface PacsParseOptions {
  countyFips: string;
  /** `*_APPRAISAL_INFO.TXT` path. */
  infoFile: string;
  /** Optional `*_APPRAISAL_IMPROVEMENT_DETAIL.TXT` path for yr-built/area. */
  improvementDetailFile?: string;
  /** Stop after N parsed rows (smoke runs). */
  limit?: number;
}

/**
 * Async-generate normalized records from a PACS export. Dedupes on
 * (prop_id, tax_year) — first row wins (UDI multi-owner rows).
 */
export async function* parsePacsExport(
  opts: PacsParseOptions,
  counters: ParseCounters = newCounters(),
): AsyncGenerator<CadPropertyRecord, ParseCounters> {
  const rollups = opts.improvementDetailFile
    ? await readImprovementRollups(opts.improvementDetailFile)
    : undefined;
  const seen = new Set<string>();
  const rl = lineReader(opts.infoFile);
  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    counters.rowsRead += 1;
    const rec = parsePacsInfoLine(line, opts.countyFips, counters, rollups);
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
