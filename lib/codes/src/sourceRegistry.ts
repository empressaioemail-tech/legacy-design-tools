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
      sourceName: "grand_county_landuse_html",
      label: "Grand County, UT — Land Use Code (HTML, codepublishing.com)",
      sourceType: "html",
      licenseType: "public_record",
      baseUrl: "https://www.codepublishing.com/UT/GrandCounty/",
      notes:
        "Per-article HTML on Code Publishing Co. (General Code Inc.); linked from grandcountyutah.net/927/Land-Use-Code via 301 redirect. Section-level atoms at H3 granularity, with over-cap sections split into '#partN' siblings. Per-section revision markers (e.g. 'Revised 6/19') are captured into atom metadata.revision. Warmup makes exactly 10 GETs (LUC01-LUC10); the LUCAddA/LUCAddB appendix pages are forwarding-link stubs and are intentionally NOT ingested.",
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
    {
      sourceName: "cedar_hill_municode",
      label: "Municode (Cedar Hill, TX)",
      sourceType: "api",
      licenseType: "permitted_use",
      baseUrl: "https://api.municode.com",
      notes:
        "QA-58 / QA-60. library.municode.com/tx/cedar_hill — clientId 1568, productId 11825. Shipped substrate cedar_hill_tx (~706 atoms, eval 0.913/1.0/1.0). Same adapter as bastrop_municode.",
    },
    {
      sourceName: "miami_beach_municode",
      label: "Municode (Miami Beach, FL)",
      sourceType: "api",
      licenseType: "permitted_use",
      baseUrl: "https://api.municode.com",
      notes:
        "Miami Beach plan-review bootstrap. ClientID 3289 verified 2026-06-08. Scoped warmup: existing-building valuation (FBCEB 601.2), local admin. Atoms tagged platform-internal.",
    },
    {
      sourceName: "miami_dade_municode",
      label: "Municode (Miami-Dade County, FL)",
      sourceType: "api",
      licenseType: "permitted_use",
      baseUrl: "https://api.municode.com",
      notes:
        "Miami-Dade county overlay bootstrap. ClientID 11719 verified 2026-06-08. Product filter: Code of Ordinances. Scoped warmup: HVAC Ch.8, NOA/BORA wind-load, unit-combination / demolition thresholds.",
    },
    {
      sourceName: "florida_interim_reference",
      label: "Florida Layer-1 interim deep-link references (FBC + NEC)",
      sourceType: "reference",
      licenseType: "deep_link_only",
      baseUrl: "https://codes.iccsafe.org",
      notes:
        "ADR-019 interim footing. FBC sections flagged ungrounded-pending-ICC; NEC articles flagged ungrounded-pending-NFPA. Seeded per jurisdiction key — not a live fetch source.",
    },
  ];
