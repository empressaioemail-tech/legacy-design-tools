/**
 * Per-CAD bulk-source registry — the free-layer land-records
 * acquisition rail (Rail B).
 *
 * Given a county, this says WHERE its free bulk appraisal roll lives
 * and HOW it is fetched. Two access modes:
 *
 *  - `open-fetch`: the CAD serves its bulk export over plain HTTP(S)
 *    GET (no form, no session, no login). The CLI can pull the whole
 *    drop from `--county=<fips>` with no `--file`. WCAD's Socrata Open
 *    Data portal (data.wcad.org) is the reference case: four datasets
 *    (Property / Owner / Land / ImpSegment) each at a stable
 *    `rows.csv?accessType=DOWNLOAD` endpoint, verified 200 live.
 *
 *  - `manual-download`: the bulk drop sits behind a WAF / portal /
 *    session-gated link (the WordPress data-downloads pages 403 a
 *    programmatic GET). The operator downloads the ZIP by hand and
 *    hands the local path to the CLI via `--file=<zip|dir>`. Hays is
 *    this case: hayscad.com/data-downloads/ is WAF-fronted and its
 *    export ZIP is not an open GET. We flag it as an operator-supplied
 *    input rather than faking a fetch.
 *
 * Adding the next CAD (El Paso, Tarrant, ...) is a new entry here plus
 * (if its file shape differs) a new parser — never a rewrite of the
 * ingest pipeline. This registry is source-resolution only; format is
 * still carried by CAD_COUNTIES.format in ./counties.ts.
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

export type CadBulkSource = OpenFetchSource | ManualDownloadSource;

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
  // Operator-supplied input, not an open GET.
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
};

export function resolveCadBulkSource(fips: string): CadBulkSource | undefined {
  return CAD_BULK_SOURCES[fips.trim()];
}
