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
 *    them as quoted-CSV .txt drops (record types 1/2/5 in separate
 *    files); Williamson publishes the same shape through its Socrata
 *    portal (data.wcad.org) with lowercased headers and a variant
 *    owner dataset. The parser is header-driven and handles both.
 */
export type CadFormat = "pacs" | "orion";

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
    //   segment:  https://data.wcad.org/api/views/4kxj-e8c3/rows.csv?accessType=DOWNLOAD
    bulkPage: "https://data.wcad.org",
  },
};

export function resolveCounty(input: string): CadCounty | undefined {
  const key = input.trim();
  if (CAD_COUNTIES[key]) return CAD_COUNTIES[key];
  const lower = key.toLowerCase();
  return Object.values(CAD_COUNTIES).find(
    (c) => c.name.toLowerCase() === lower || c.cad.toLowerCase() === lower,
  );
}
