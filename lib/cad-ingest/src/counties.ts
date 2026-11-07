/**
 * Registry of supported county appraisal districts (CADs).
 *
 * `format` picks the parser:
 *  - `pacs`  — True Automation / Harris Govern PACS "Appraisal Export
 *    Layout 8.0.x" fixed-width TXT files (APPRAISAL_INFO.TXT et al).
 *    Offsets verified identical across layout 8.0.26 (Caldwell),
 *    8.0.30 (Bastrop), and 8.0.33 (Travis) — later versions only
 *    append fields past the ones we read.
 *  - `orion` — Tyler Orion "PropertyDataExport" CSVs. Hays publishes
 *    them as quoted-CSV .txt drops (record types 1/2/3/5 in separate
 *    files: Property/Owner/Land/ImpSegment); Williamson publishes the
 *    same shape through its Socrata portal (data.wcad.org) with
 *    lowercased headers and a variant owner dataset. The record-3 Land
 *    file carries the state category code (property_use_code). The
 *    parser is header-driven and handles both.
 *  - `tad-propertydata` — Tarrant TAD PropertyData(Delimited) pipe file.
 *  - `dcad-certified` — Dallas DCAD certified comma-delimited multi-file zip.
 */
export type CadFormat = "pacs" | "orion" | "tad-propertydata" | "dcad-certified";

export interface CadCounty {
  fips: string;
  name: string;
  cad: string;
  format: CadFormat;
  /** Where the bulk drops live, for operators. */
  bulkPage: string;
}

export const CAD_COUNTIES: Record<string, CadCounty> = {
  "48453": {
    fips: "48453",
    name: "Travis",
    cad: "TCAD",
    format: "pacs",
    bulkPage: "https://traviscad.org/publicinformation/",
  },
  "48021": {
    fips: "48021",
    name: "Bastrop",
    cad: "Bastrop CAD",
    format: "pacs",
    bulkPage: "https://bastropcad.org/exports-valuation-reports/",
  },
  "48055": {
    fips: "48055",
    name: "Caldwell",
    cad: "Caldwell CAD",
    format: "pacs",
    bulkPage: "https://caldwellcad.org/publicly-available-data/",
  },
  "48209": {
    fips: "48209",
    name: "Hays",
    cad: "Hays CAD",
    format: "orion",
    bulkPage: "https://hayscad.com/data-downloads/",
  },
  "48491": {
    fips: "48491",
    name: "Williamson",
    cad: "WCAD",
    format: "orion",
    // Socrata portal. Bulk CSV endpoints:
    //   property: https://data.wcad.org/api/views/ij43-xknu/rows.csv?accessType=DOWNLOAD
    //   owner:    https://data.wcad.org/api/views/bbia-wsxs/rows.csv?accessType=DOWNLOAD
    //   land:     https://data.wcad.org/api/views/2ckt-cqwj/rows.csv?accessType=DOWNLOAD
    //   segment:  https://data.wcad.org/api/views/4kxj-e8c3/rows.csv?accessType=DOWNLOAD
    bulkPage: "https://data.wcad.org",
  },
  "48439": {
    fips: "48439",
    name: "Tarrant",
    cad: "TAD",
    format: "tad-propertydata",
    bulkPage: "https://www.tad.org/resources/data-downloads",
  },
  "48113": {
    fips: "48113",
    name: "Dallas",
    cad: "DCAD",
    format: "dcad-certified",
    bulkPage: "https://www.dallascad.org/DataProducts.aspx",
  },

  // ---------------------------------------------------------------------
  // BURNET (48053) — deliberately NOT listed here (OPS-24 Phase 1 research,
  // 2026-10-07). Researched against Burnet CAD's actual export surface and
  // confirmed against the live service; written up so the next author does
  // not have to re-derive it.
  //
  // What exists: Burnet CAD (burnetcad.org) uses the BIS Consultants
  // ArcGIS Online GIS template (the audit's "arcgis_rest / bis-consultants"
  // — the SAME vendor as Bell/Guadalupe/McLennan, all "stratmap-roll" in
  // DECLARED_CAD_VINTAGES). Its public FeatureServer
  // (services8.arcgis.com/WB9lDuPLSvoToaB9/.../BurnetCADWebService1,
  // layer 0 "Parcels") was re-probed live 2026-10-07: 50,655 features,
  // fields prop_id / prop_id_text / owner_tax_yr / file_as_name /
  // legal_desc* / land_val / imprv_val / market / situs_* / Deed_* — a
  // roll-ACCOUNT schema. The service's full layer+table list (Parcels,
  // Abstracts, Subdivisions, Schools, City Limits, Lot Lines, Streets,
  // County Boundary, Texas Counties) has NO improvement-detail
  // layer/table anywhere: no year-built, no living-area/segment columns,
  // no per-improvement records of any kind.
  //
  // What was checked and ruled out: no self-serve bulk "Data Products" /
  // certified-export download page was reachable (burnetcad.org /
  // www.burnetcad.org return HTTP 403 to a programmatic fetch — WAF-gated,
  // like Hays; a human browser session would be needed to confirm whether
  // a manual-download bulk product even exists, which this pass could not
  // do). No TrueAutomation, Socrata, or other known bulk-export surface
  // was found for Burnet. Web search found only the ArcGIS map viewer
  // (gis.bisclient.com/burnetcad/, esearch.burnetcad.org property search,
  // burnet.trueautomation.com/mapSearch — all search/view UIs, not export
  // endpoints) and the CAD's own published PDF appraisal-roll estimate
  // (not a machine-readable bulk format).
  //
  // Conclusion: NONE of this repo's four parsers (pacs/orion/
  // tad-propertydata/dcad-certified) fit, because none of them has
  // anything to parse — there is no bulk improvement-detail export to
  // read, unlike Bastrop/Caldwell/Travis (PACS), Hays/Williamson (Orion),
  // Tarrant (TAD) or Dallas (DCAD). Burnet is wired instead as the
  // stratmap-roll county it already is today (see vintage.ts
  // DECLARED_CAD_VINTAGES 48053, and txgio/counties.ts TXGIO_COUNTIES
  // 48053) via the generic StratMap-DBF land-use adapter
  // (txgio/landuse-cli.ts), exactly like its BIS-Consultants siblings.
  // Store-truth read 2026-10-07 confirms this is ALREADY how Burnet's
  // 49,243 cad_property rows got there.
  //
  // What a direct-CAD parser would need, if Burnet CAD is later confirmed
  // to offer one (none was found 2026-10-07):
  //   1. A manual-download bulk product analogous to Hays's WAF-gated ZIP
  //      (sources.ts ManualDownloadSource) — someone with a browser
  //      session visiting burnetcad.org / esearch.burnetcad.org would need
  //      to find and document the actual "Data Products" page and file
  //      shape (fixed-width PACS-style TXT? delimited CSV? Orion-style
  //      multi-file CSV?).
  //   2. If it turns out to be PACS-shaped: a PACS_EXPORT_DECLARATIONS
  //      entry here declaring Burnet's REAL improvement-detail segment
  //      vocabulary (sources.ts PacsExportDeclaration.
  //      livingAreaSegmentTypeCds), verified against Burnet's actual
  //      IMPROVEMENT_DETAIL-equivalent file — NOT assumed to be the
  //      generic "MAIN AREA" default. This is the exact trap P-157/A-133
  //      already hit for Travis: declaring a county cad-export without
  //      checking its segment vocabulary produces a parser that runs
  //      clean and reports 100% null living area. Refuse rather than
  //      guess that vocabulary — it is not knowable from this ArcGIS
  //      service, which carries no improvement detail at all.
  //   3. If it turns out to be Orion- or otherwise CSV-shaped: a new
  //      `CadFormat` branch and parser, following the orion/ directory's
  //      header-driven pattern.
  // ---------------------------------------------------------------------
};

export function resolveCounty(input: string): CadCounty | undefined {
  const key = input.trim();
  if (CAD_COUNTIES[key]) return CAD_COUNTIES[key];
  const lower = key.toLowerCase();
  return Object.values(CAD_COUNTIES).find(
    (c) => c.name.toLowerCase() === lower || c.cad.toLowerCase() === lower,
  );
}
