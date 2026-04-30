/**
 * Source registry — the canonical list of `code_atom_sources` rows required
 * by the JURISDICTIONS registry.
 *
 * Why this exists: the warmup orchestrator looks up each book's
 * `sourceName` in the `code_atom_sources` table to resolve the source URL,
 * licensing, and notes. Without these rows, warmup correctly reports
 * "source_row_missing" and discovers nothing.
 *
 * Historically these rows were inserted by hand during dev setup and never
 * codified, which left fresh deploys (e.g. production) silently empty —
 * the prod symptom was "0 atoms / 0 embedded" with no obvious cause until
 * the P1.3 observability surface exposed `discoveryErrors[]` containing
 * `source_row_missing` for every book.
 *
 * This file is the single source of truth. `ensureCodeAtomSources()` in
 * `./bootstrap` does an idempotent upsert against this list at server boot
 * so any environment (dev, prod, ephemeral test DB) self-heals on first
 * start. To add a new code source, add an entry here and wire its
 * `sourceName` into a `JurisdictionConfig.books` entry in
 * `./jurisdictions`.
 */
export interface RequiredCodeAtomSource {
  sourceName: string;
  label: string;
  /** e.g. "html", "pdf", "api". Free-form metadata, not enforced. */
  sourceType: string;
  /** e.g. "public_record", "permitted_use". Free-form metadata. */
  licenseType: string;
  baseUrl: string | null;
  notes: string | null;
}

export const REQUIRED_CODE_ATOM_SOURCES: ReadonlyArray<RequiredCodeAtomSource> =
  [
    {
      sourceName: "grand_county_html",
      label: "Grand County, UT — Design Criteria (HTML)",
      sourceType: "html",
      licenseType: "public_record",
      baseUrl: "https://www.grandcountyutah.net/146/Design-Criteria",
      notes:
        'Inline HTML "2021 IRC TABLE 301.2(1)" and surrounding climatic/geographic design criteria scraped from the Grand County Building Department page. Page is published by the County for public design use; treated as public record.',
    },
    {
      sourceName: "grand_county_pdf",
      label: "Grand County, UT — 2006 Wildland-Urban Interface Code (PDF)",
      sourceType: "pdf",
      licenseType: "public_record",
      baseUrl: "https://www.grandcountyutah.net/DocumentCenter/View/3611",
      notes:
        "Single text-extractable PDF linked from /146/Design-Criteria. The other linked PDF (View/1869) is scanned/non-extractable and is intentionally NOT ingested in this sprint.",
    },
    {
      sourceName: "bastrop_municode",
      label: "Municode (Bastrop, TX)",
      sourceType: "api",
      licenseType: "permitted_use",
      baseUrl: "https://api.municode.com",
      notes:
        "Unofficial Municode JSON API at api.municode.com. Municipal ordinances are public records by Texas law. Bridge infrastructure pending official Municode API partnership. ClientID 1169 verified during recon. Rate-limited to >=1.5s spacing + jitter, daily cap 500.",
    },
  ];
