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

import { basename } from "node:path";

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

/**
 * Per-county PACS export entry-name declaration (P-169 / A-132,
 * `_decisions/2026-09-12_loaders_get_cloud_jobs_no_break_glass.md`).
 *
 * The generic PACS shape assumes `*APPRAISAL_INFO.TXT` /
 * `*APPRAISAL_IMPROVEMENT_DETAIL.TXT` entry names (see zip.ts's
 * PACS_ENTRY_FILTER and cli.ts's discoverFiles). TCAD's live certified
 * export (2026 Certified Appraisal Export, Supp 0, 07182026) instead
 * names its entries `PROP.TXT` / `IMP_DET.TXT` — a per-county SOURCE
 * SHAPE, not a defect to paper over by widening the generic regex or
 * renaming the county's files. A county with no declaration here keeps
 * today's generic pattern exactly as before; this registry is additive.
 */
export interface PacsExportDeclaration {
  /** Base-roll entry name, exact basename, matched case-insensitively. */
  infoEntry: string;
  /** Improvement-detail entry name, or absent if this county's declared
   *  export has none. */
  improvementDetailEntry?: string;
}

export const PACS_EXPORT_DECLARATIONS: Record<string, PacsExportDeclaration> = {
  // Travis / TCAD — 2026 Certified Appraisal Export, Supp 0 (07182026):
  // entries are PROP.TXT / IMP_DET.TXT, not the generic
  // APPRAISAL_INFO.TXT / APPRAISAL_IMPROVEMENT_DETAIL.TXT shape.
  "48453": {
    infoEntry: "PROP.TXT",
    improvementDetailEntry: "IMP_DET.TXT",
  },
};

export function resolvePacsExportDeclaration(
  fips: string,
): PacsExportDeclaration | undefined {
  return PACS_EXPORT_DECLARATIONS[fips.trim()];
}

export class PacsEntryNotFoundError extends Error {
  constructor(
    public readonly fips: string,
    public readonly entryName: string,
    public readonly role: "info" | "improvement-detail",
  ) {
    super(
      `declared PACS ${role} entry "${entryName}" for county ${fips} was not found in ` +
        "this export. The county's registered source shape " +
        "(lib/cad-ingest/src/sources.ts PACS_EXPORT_DECLARATIONS) does not match what this " +
        "archive actually contains — refusing rather than falling back to the generic pattern.",
    );
    this.name = "PacsEntryNotFoundError";
  }
}

export interface ResolvedPacsEntries {
  infoFile: string;
  improvementDetailFile?: string;
}

/**
 * Resolve which extracted file plays which PACS role for `fips`, using its
 * declared entry names. Returns `null` when the county has no declaration
 * (caller falls back to the generic `*APPRAISAL_INFO.TXT` pattern, unchanged).
 * Throws PacsEntryNotFoundError when a declared entry is absent from the
 * given file list — never a silent fallback to the generic pattern.
 */
export function resolvePacsEntries(
  files: string[],
  fips: string,
): ResolvedPacsEntries | null {
  const declaration = resolvePacsExportDeclaration(fips);
  if (!declaration) return null;

  const info = files.find(
    (f) => basename(f).toLowerCase() === declaration.infoEntry.toLowerCase(),
  );
  if (!info) {
    throw new PacsEntryNotFoundError(fips, declaration.infoEntry, "info");
  }

  let improvementDetailFile: string | undefined;
  if (declaration.improvementDetailEntry) {
    improvementDetailFile = files.find(
      (f) =>
        basename(f).toLowerCase() ===
        declaration.improvementDetailEntry!.toLowerCase(),
    );
    if (!improvementDetailFile) {
      throw new PacsEntryNotFoundError(
        fips,
        declaration.improvementDetailEntry,
        "improvement-detail",
      );
    }
  }

  return { infoFile: info, improvementDetailFile };
}
