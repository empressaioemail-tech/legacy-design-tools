/**
 * Common types for code-knowledge source adapters.
 *
 * Each source adapter (HTML scraper, PDF parser, third-party API client) maps
 * its native data shape into the universal AtomCandidate / TocEntry shape so
 * that the orchestrator (`@workspace/codes`) can drive any source uniformly.
 */

export type SourceType = "html" | "pdf" | "api";

/** A discoverable section that the orchestrator may decide to fetch. */
export interface TocEntry {
  /** Stable URL the orchestrator will pass back to fetchSection() and persist on the atom for verification. */
  sectionUrl: string;
  /** Section number / locator as printed in the code, e.g. "R301.2(1)" or "§ 4.1.2.A". */
  sectionRef: string | null;
  /** Human-readable title, e.g. "Climatic and geographic design criteria". */
  sectionTitle: string | null;
  /** Direct parent section ref if known. */
  parentSection?: string | null;
  /** Source-specific context the adapter wants to round-trip (e.g. clientId, sectionId, pdfPage). */
  context?: Record<string, unknown>;
}

/** A fully fetched section ready to be persisted as one or more atoms. */
export interface AtomCandidate {
  sectionRef: string | null;
  sectionTitle: string | null;
  parentSection?: string | null;
  body: string;
  bodyHtml?: string | null;
  /** Canonical URL an architect can click to verify this content outside our system. */
  sourceUrl: string;
  /** Free-form provenance bag (page numbers, table cell coords, raw API blob hash, etc.). */
  metadata?: Record<string, unknown>;
}

export interface FetchContext {
  jurisdictionKey: string;
  codeBook: string;
  edition: string;
  /** TocEntry.context if the orchestrator stored one. */
  context?: Record<string, unknown>;
}

/**
 * The contract every source adapter must implement.
 *
 * Adapters are stateless except for in-process rate-limiting / caching.
 * They must NOT touch the database directly — the orchestrator owns persistence.
 */
export interface CodeSource {
  /** Stable id matching the seeded code_atom_sources.source_name row. */
  readonly id: string;
  /** Display label used by the Code Library UI. */
  readonly label: string;
  readonly sourceType: SourceType;
  readonly licenseType: string;

  /**
   * Discovery pass. Yield a TocEntry for every section the orchestrator should
   * consider fetching. The orchestrator decides whether to actually fetch
   * (it may already have a fresh atom for the same URL).
   */
  listToc(input: {
    jurisdictionKey: string;
    codeBook: string;
    edition: string;
    /** Adapter-specific knobs from jurisdictions.ts. */
    config?: Record<string, unknown>;
  }): Promise<TocEntry[]>;

  /**
   * Hydrate one section into one or more AtomCandidates. Multiple candidates
   * are allowed if the source naturally yields siblings (e.g. one HTML table
   * row per atom).
   */
  fetchSection(
    sectionUrl: string,
    ctx: FetchContext,
  ): Promise<AtomCandidate[]>;
}
