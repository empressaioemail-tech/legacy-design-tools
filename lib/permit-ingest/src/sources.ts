/**
 * Registry of supported permit open-data sources.
 *
 * Each source pins a jurisdiction to its county FIPS and the per-city
 * column extractor from `@workspace/calibration-engines/k2` (the single
 * source of truth for the raw CSV column mapping — see
 * `permitColumns.ts`). The ingest and the K2 calibration harness read
 * the same corpus through the same extractor.
 */

import {
  extractAustinPermitFields,
  extractSanAntonioPermitFields,
  type RawPermitRow,
  type RawPermitFields,
} from "@workspace/calibration-engines/k2";

export type PermitSourceKey = "austin" | "san-antonio";

export interface PermitSource {
  key: PermitSourceKey;
  /** 5-digit county FIPS. */
  fips: string;
  /** Jurisdiction tenant label, matching the K2 harness. */
  jurisdiction: string;
  /** Human name, for logs. */
  name: string;
  /** Column extractor shared with the K2 calibration harness. */
  extract: (row: RawPermitRow) => RawPermitFields;
  /** Where the open-data drop lives, for operators. */
  openDataPage: string;
}

export const PERMIT_SOURCES: Record<PermitSourceKey, PermitSource> = {
  austin: {
    key: "austin",
    fips: "48453",
    jurisdiction: "austin_tx",
    name: "Austin (Travis)",
    extract: extractAustinPermitFields,
    openDataPage: "https://data.austintexas.gov/ (Issued Construction Permits)",
  },
  "san-antonio": {
    key: "san-antonio",
    fips: "48029",
    jurisdiction: "san_antonio_tx",
    name: "San Antonio (Bexar)",
    extract: extractSanAntonioPermitFields,
    openDataPage: "https://data.sanantonio.gov/ (Building Permits Issued)",
  },
};

/** FIPS -> source key, for the `--county=` form. */
const BY_FIPS: Record<string, PermitSourceKey> = {
  "48453": "austin",
  "48029": "san-antonio",
};

/**
 * Resolve a source from a `--source=austin|san-antonio` value or a
 * `--county=48453|48029` FIPS. Accepts the jurisdiction label too.
 */
export function resolveSource(value: string): PermitSource | null {
  const v = value.trim().toLowerCase();
  if (v in PERMIT_SOURCES) return PERMIT_SOURCES[v as PermitSourceKey];
  if (v in BY_FIPS) return PERMIT_SOURCES[BY_FIPS[v]!];
  // jurisdiction label (austin_tx / san_antonio_tx)
  for (const s of Object.values(PERMIT_SOURCES)) {
    if (s.jurisdiction === v) return s;
  }
  return null;
}
