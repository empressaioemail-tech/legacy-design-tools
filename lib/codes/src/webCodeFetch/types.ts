/**
 * Web-search code retrieval types (transient, review-scoped — NOT corpus atoms).
 */

export const WEBSEARCH_ATOM_PREFIX = "websearch:";

/** Authoritative hosts the fetcher may contact. */
export const WEB_CODE_ALLOWLIST_HOSTS = [
  "floridabuilding.org",
  "codes.iccsafe.org",
  "www.nfpa.org",
  "nfpa.org",
  "up.codes",
  "www.up.codes",
] as const;

export type WebCodeAllowlistHost = (typeof WEB_CODE_ALLOWLIST_HOSTS)[number];

export interface WebCodeFetchInput {
  /** Section reference, e.g. `FBC-M601.6`, `NEC Art. 220`. */
  codeRef: string;
  /** Requested edition label, e.g. `FBC 2023`, `NEC 2017`. */
  edition: string;
  jurisdictionKey?: string;
}

export interface WebCodeFetchResult {
  text: string;
  sourceUrl: string;
  retrievedAt: string;
  edition: string;
  section: string;
  confidence: number;
  verified: boolean;
  sourceName: string;
  /** Set when edition/section could not be confirmed on the page. */
  unverifiedWebSource?: boolean;
}

export interface WebCodeReviewTarget {
  codeRef: string;
  edition: string;
  editionSlug: string;
  label: string;
  /** Preferred driver order. */
  drivers: Array<"icc" | "florida" | "nfpa" | "upcodes">;
}

export type HttpFetcher = (url: string) => Promise<{
  status: number;
  body: string;
  finalUrl: string;
}>;
