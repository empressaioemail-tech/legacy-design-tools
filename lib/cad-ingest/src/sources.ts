/**
 * Per-CAD bulk-source registry — the free-layer land-records
 * acquisition rail (Rail B).
 *
 * Given a county, this says WHERE its free bulk appraisal roll lives
 * and HOW it is fetched. Access modes:
 *
 *  - `open-fetch`: Orion-style multi-dataset Socrata GET (WCAD).
 *  - `open-fetch-zip`: single zip URL; CLI extracts format-specific
 *    entries (TAD PropertyData, DCAD certified).
 *  - `manual-download`: WAF/session-gated; operator supplies --file.
 *
 * Texas non-disclosure note: NO Texas CAD publishes sale PRICE in its
 * bulk roll (Property Tax Code is a non-disclosure state). Sales price
 * is therefore absent from every source below by law; it is never
 * fabricated or inferred, and `cad_property` carries no sale-price
 * column.
 */

import type { OrionFileKind } from "./orion/parser";

/** One open-HTTP dataset within a CAD's bulk drop, tagged by role. */
export interface BulkDataset {
  /** Which Orion file role this URL provides. */
  kind: Exclude<OrionFileKind, "unknown">;
  url: string;
}

export interface OpenFetchSource {
  mode: "open-fetch";
  /** The open-HTTP datasets that compose this CAD's roll. */
  datasets: BulkDataset[];
}

/** Single zip open-GET (TAD PropertyData, DCAD certified). */
export interface OpenFetchZipSource {
  mode: "open-fetch-zip";
  url: string;
  /** Human label for logs and source_vintage drop basename. */
  label: string;
}

export interface ManualDownloadSource {
  mode: "manual-download";
  /** Human page where the operator obtains the drop. */
  page: string;
  /**
   * What the operator downloads and how to feed it back in. Printed by
   * the CLI so the manual step is unambiguous.
   */
  instructions: string;
}

export type CadBulkSource =
  | OpenFetchSource
  | OpenFetchZipSource
  | ManualDownloadSource;

/**
 * WCAD Socrata Open Data dataset ids (data.wcad.org). Each is a stable
 * view served as `rows.csv?accessType=DOWNLOAD`. Verified live 200 with
 * the expected Orion headers 2026-07-15.
 */
const WCAD_SOCRATA_VIEWS = {
  property: "ij43-xknu",
  owner: "bbia-wsxs",
  land: "2ckt-cqwj",
  segment: "4kxj-e8c3",
} as const;

function wcadSocrataUrl(viewId: string): string {
  return `https://data.wcad.org/api/views/${viewId}/rows.csv?accessType=DOWNLOAD`;
}

/** DCAD ViewPDFs proxy for the certified comma-delimited drop. */
export const DCAD_CERTIFIED_OPEN_FETCH_URL =
  "https://www.dallascad.org/ViewPDFs.aspx?type=3&id=%5C%5CDCAD.ORG%5CWEB%5CWEBDATA%5CWEBFORMS%5CDATA%20PRODUCTS%5CDCAD2026_CERTIFIED_07232026.zip";

export const CAD_BULK_SOURCES: Record<string, CadBulkSource> = {
  // Williamson / WCAD — open Socrata portal, fully automatable.
  "48491": {
    mode: "open-fetch",
    datasets: [
      { kind: "property", url: wcadSocrataUrl(WCAD_SOCRATA_VIEWS.property) },
      { kind: "owner", url: wcadSocrataUrl(WCAD_SOCRATA_VIEWS.owner) },
      { kind: "land", url: wcadSocrataUrl(WCAD_SOCRATA_VIEWS.land) },
      { kind: "segment", url: wcadSocrataUrl(WCAD_SOCRATA_VIEWS.segment) },
    ],
  },

  // Hays / Hays CAD — WAF-fronted WordPress portal, session-gated ZIP.
  "48209": {
    mode: "manual-download",
    page: "https://hayscad.com/data-downloads/",
    instructions:
      "Download the latest 'Property Data Export' ZIP from " +
      "hayscad.com/data-downloads/ (the drop named e.g. 'PROPERTY DATA " +
      "EXPORT FILES AS OF <date>'; it 403s a programmatic fetch). Then " +
      "run:  cad-ingest --county=48209 --file=<local .zip|dir> " +
      "--tax-year=<roll year>. The ZIP holds the Property/Owner/Land/" +
      "ImpSegment .txt files, which the CLI classifies by header.",
  },

  // Tarrant / TAD — open-fetch residential slice (~50MB).
  // Full county (~97MB): PropertyData(Delimited).ZIP — announce before load.
  "48439": {
    mode: "open-fetch-zip",
    url: "https://www.tad.org/content/data-download/PropertyData(Delimited)_R.ZIP",
    label: "PropertyData(Delimited)_R.ZIP",
  },

  // Dallas / DCAD — open-fetch certified comma-delimited zip (~193MB).
  "48113": {
    mode: "open-fetch-zip",
    url: DCAD_CERTIFIED_OPEN_FETCH_URL,
    label: "DCAD2026_CERTIFIED_07232026.zip",
  },
};

export function resolveCadBulkSource(fips: string): CadBulkSource | undefined {
  return CAD_BULK_SOURCES[fips.trim()];
}
