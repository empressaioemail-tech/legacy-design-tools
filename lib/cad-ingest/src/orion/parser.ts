/**
 * Parser for Tyler Orion "PropertyDataExport" CSVs.
 *
 * Two publishers, one shape:
 *  - Hays CAD ships quoted-CSV `.txt` drops (hayscad.com/data-downloads/,
 *    layout: "Copy-of-PropertyDataExport-CSV-Layout.pdf"). Record types
 *    live in separate files: 1 = Property, 2 = Owner, 3 = Land,
 *    5 = ImpSegment.
 *  - Williamson (WCAD) serves the same export through its Socrata
 *    portal (data.wcad.org): "Property - PropertyDataExport"
 *    (ij43-xknu) has identical columns lowercased and no RecordType
 *    column; "Owner" (bbia-wsxs) is a variant with `fullname`,
 *    pre-joined `mailingaddress`, `exemptionlist` and `primaryowner`;
 *    "Land - PropertyDataExport" (2ckt-cqwj) carries the state code.
 *
 * The parser is header-driven and case-insensitive, so both publishers
 * flow through the same code. Files are classified by their header
 * columns, not their names.
 *
 * Field-mapping decisions:
 *  - tax_year is NOT in the rows; the export drop is named for its
 *    roll year, so the caller must pass `taxYear` (CLI `--tax-year`).
 *  - values: `Curr*` columns (current roll state, supplements applied)
 *    preferred, falling back to the plain columns when blank.
 *  - situs: the pre-joined `Situs` column as-is.
 *  - living area: `SquareFootage` from the property record, falling
 *    back to the sum of MA ("Main Area") segment areas when blank.
 *  - year built: earliest MA-segment `ActYrBuilt`.
 *  - owner: first owner row per property wins, except a
 *    `primaryowner=1` row (WCAD) replaces a non-primary one.
 *  - exemptions: `ExemptionList` split on `|`/`,`/`;`, uppercased.
 *  - property_use_code: the Texas PTAD state category code (A1, E1,
 *    D1, ...) from the record-3 Land file's `StateCode` column, keyed
 *    on PropertyID. A property has one land row per land segment; the
 *    primary segment (lowest `Sequence`) wins. Raw code only, no
 *    fabricated description (matches the PACS `state_cd` flow). Null
 *    when no land file is supplied or a property has no land row.
 */

import type { CadPropertyRecord, ParseCounters } from "../types";
import { newCounters, recordSkip } from "../types";
import { HeaderIndex, readCsvRows } from "../csv";
import {
  explicitAcresOrNull,
  mailingLine,
  positiveWholeOrNull,
  stripLeadingZeros,
  textOrNull,
  wholeNumberOrNull,
} from "../normalize";

export type OrionFileKind =
  | "property"
  | "owner"
  | "land"
  | "segment"
  | "unknown";

/**
 * Classify an Orion CSV by its header row.
 *
 * Order matters: the property, owner, and land files all share
 * PropertyID, but each carries a discriminating column. The land file
 * is identified by `LandType` + `StateCode` (its `Description`/`Acres`
 * overlap the segment file, but the segment file carries `ActYrBuilt`
 * and no `StateCode`), and the segment check must run before the land
 * check would matter because both lack a property/owner marker.
 */
export function classifyOrionHeader(header: HeaderIndex): OrionFileKind {
  if (header.has("marketvalue") && header.has("situs")) return "property";
  if (header.has("ownername") || header.has("fullname")) return "owner";
  if (header.has("actyrbuilt")) return "segment";
  if (header.has("landtype") && header.has("statecode")) return "land";
  return "unknown";
}

export interface OrionOwner {
  ownerName: string | null;
  ownerMailingAddress: string | null;
  exemptionCodes: string[] | null;
  isPrimary: boolean;
}

function parseExemptionList(raw: string): string[] | null {
  const codes = raw
    .split(/[|,;]/)
    .map((c) => c.trim().toUpperCase())
    .filter((c) => c.length > 0);
  return codes.length > 0 ? [...new Set(codes)] : null;
}

/** Read an owner file (Hays record 2 or WCAD Socrata Owner) into a map. */
export async function readOrionOwners(
  filePath: string,
): Promise<Map<string, OrionOwner>> {
  const owners = new Map<string, OrionOwner>();
  let header: HeaderIndex | null = null;
  for await (const row of readCsvRows(filePath)) {
    if (header === null) {
      header = new HeaderIndex(row);
      continue;
    }
    const propId = stripLeadingZeros(header.get(row, "propertyid").trim());
    if (propId.length === 0) continue;
    const isPrimary = header.get(row, "primaryowner").trim() === "1";
    const existing = owners.get(propId);
    if (existing && (existing.isPrimary || !isPrimary)) continue;

    // Hays: OwnerName + Address1..3/City/State/Zip.
    // WCAD Socrata: fullname + pre-joined mailingaddress.
    const name =
      textOrNull(header.get(row, "ownername")) ??
      textOrNull(header.get(row, "fullname"));
    const preJoined = textOrNull(header.get(row, "mailingaddress"));
    const mailing =
      preJoined !== null
        ? preJoined.replace(/\s+/g, " ").trim()
        : mailingLine({
            lines: [
              header.get(row, "address1"),
              header.get(row, "address2"),
              header.get(row, "address3"),
            ],
            city: header.get(row, "city"),
            state: header.get(row, "state"),
            zip: header.get(row, "zip"),
          });
    owners.set(propId, {
      ownerName: name,
      ownerMailingAddress: mailing,
      exemptionCodes: parseExemptionList(header.get(row, "exemptionlist")),
      isPrimary,
    });
  }
  return owners;
}

export interface OrionSegmentRollup {
  yearBuilt: number | null;
  mainAreaSqft: number | null;
}

/** Read an ImpSegment file (record 5) and roll up MA segments per property. */
export async function readOrionSegments(
  filePath: string,
): Promise<Map<string, OrionSegmentRollup>> {
  const rollups = new Map<string, OrionSegmentRollup>();
  let header: HeaderIndex | null = null;
  for await (const row of readCsvRows(filePath)) {
    if (header === null) {
      header = new HeaderIndex(row);
      continue;
    }
    const type = header.get(row, "type").trim().toUpperCase();
    if (type !== "MA") continue;
    const propId = stripLeadingZeros(header.get(row, "propertyid").trim());
    if (propId.length === 0) continue;
    const prev = rollups.get(propId) ?? { yearBuilt: null, mainAreaSqft: null };
    const area = Number(header.get(row, "area"));
    if (Number.isFinite(area) && area > 0) {
      prev.mainAreaSqft = (prev.mainAreaSqft ?? 0) + area;
    }
    const yr = wholeNumberOrNull(header.get(row, "actyrbuilt"));
    if (yr !== null && yr > 0) {
      prev.yearBuilt = prev.yearBuilt === null ? yr : Math.min(prev.yearBuilt, yr);
    }
    rollups.set(propId, prev);
  }
  for (const r of rollups.values()) {
    if (r.mainAreaSqft !== null) r.mainAreaSqft = Math.round(r.mainAreaSqft);
  }
  return rollups;
}

interface OrionLandPick {
  stateCode: string;
  /** Lowest `Sequence` seen for this property; the primary land segment. */
  sequence: number;
}

/**
 * Read a Land file (record 3 / WCAD Socrata "Land - PropertyDataExport")
 * and pick one state code per property. A property has one land row per
 * land segment; the primary segment (lowest `Sequence`) wins so the map
 * colors by the property's principal land use. Rows with no `StateCode`
 * are ignored; a property with only blank-code rows resolves to null.
 */
export async function readOrionLand(
  filePath: string,
): Promise<Map<string, string>> {
  const picks = new Map<string, OrionLandPick>();
  let header: HeaderIndex | null = null;
  for await (const row of readCsvRows(filePath)) {
    if (header === null) {
      header = new HeaderIndex(row);
      continue;
    }
    const propId = stripLeadingZeros(header.get(row, "propertyid").trim());
    if (propId.length === 0) continue;
    const stateCode = textOrNull(header.get(row, "statecode"));
    if (stateCode === null) continue;
    // Sequence orders land segments; blank/unparsable sorts last so a
    // coded row always beats it. Ties keep the first row seen.
    const seqRaw = wholeNumberOrNull(header.get(row, "sequence"));
    const sequence = seqRaw !== null ? seqRaw : Number.MAX_SAFE_INTEGER;
    const existing = picks.get(propId);
    if (existing === undefined || sequence < existing.sequence) {
      picks.set(propId, { stateCode, sequence });
    }
  }
  const out = new Map<string, string>();
  for (const [propId, pick] of picks) out.set(propId, pick.stateCode);
  return out;
}

function currOrPlain(
  header: HeaderIndex,
  row: string[],
  currName: string,
  plainName: string,
): number | null {
  return (
    wholeNumberOrNull(header.get(row, currName)) ??
    wholeNumberOrNull(header.get(row, plainName))
  );
}

export interface OrionParseOptions {
  countyFips: string;
  /** Property file (Hays record 1 / WCAD property CSV). */
  propertyFile: string;
  /** The roll year this export describes (not present in the rows). */
  taxYear: number;
  ownerFile?: string;
  landFile?: string;
  segmentFile?: string;
  limit?: number;
}

/** Async-generate normalized records from an Orion PropertyDataExport. */
export async function* parseOrionExport(
  opts: OrionParseOptions,
  counters: ParseCounters = newCounters(),
): AsyncGenerator<CadPropertyRecord, ParseCounters> {
  const owners = opts.ownerFile
    ? await readOrionOwners(opts.ownerFile)
    : new Map<string, OrionOwner>();
  const land = opts.landFile
    ? await readOrionLand(opts.landFile)
    : new Map<string, string>();
  const segments = opts.segmentFile
    ? await readOrionSegments(opts.segmentFile)
    : new Map<string, OrionSegmentRollup>();

  const seen = new Set<string>();
  let header: HeaderIndex | null = null;
  for await (const row of readCsvRows(opts.propertyFile)) {
    if (header === null) {
      header = new HeaderIndex(row);
      const kind = classifyOrionHeader(header);
      if (kind !== "property") {
        throw new Error(
          `${opts.propertyFile}: expected an Orion property file, classified as "${kind}"`,
        );
      }
      continue;
    }
    counters.rowsRead += 1;
    const propIdRaw = header.get(row, "propertyid").trim();
    const propId = stripLeadingZeros(propIdRaw);
    if (propId.length === 0) {
      recordSkip(counters, `missing PropertyID (row ${counters.rowsRead})`);
      continue;
    }
    if (seen.has(propId)) {
      counters.duplicateRows += 1;
      continue;
    }
    seen.add(propId);

    const owner = owners.get(propId);
    const segment = segments.get(propId);
    // 0 sqft means "no living area recorded" — fall through to segments.
    const squareFootage = positiveWholeOrNull(header.get(row, "squarefootage"));

    counters.rowsParsed += 1;
    yield {
      countyFips: opts.countyFips,
      propId,
      taxYear: opts.taxYear,
      ownerName: owner?.ownerName ?? null,
      ownerMailingAddress: owner?.ownerMailingAddress ?? null,
      situsAddress: textOrNull(header.get(row, "situs"))?.replace(/\s+/g, " ") ?? null,
      situsCity: textOrNull(header.get(row, "situscity")),
      situsZip: textOrNull(header.get(row, "situszip")),
      legalDescription: textOrNull(header.get(row, "legaldesc")),
      exemptionCodes: owner?.exemptionCodes ?? null,
      landValue: currOrPlain(header, row, "currlandvalue", "landvalue"),
      improvementValue: currOrPlain(
        header,
        row,
        "currimprovmentvalue",
        "improvmentvalue",
      ),
      marketValue: currOrPlain(header, row, "currmarketvalue", "marketvalue"),
      assessedValue: currOrPlain(
        header,
        row,
        "currassessedvalue",
        "assessedvalue",
      ),
      yearBuilt: segment?.yearBuilt ?? null,
      livingAreaSqft: squareFootage ?? segment?.mainAreaSqft ?? null,
      landAcres: explicitAcresOrNull(header.get(row, "legalacres")),
      propertyUseCode: land.get(propId) ?? null,
    };
    if (opts.limit !== undefined && counters.rowsParsed >= opts.limit) break;
  }
  return counters;
}
