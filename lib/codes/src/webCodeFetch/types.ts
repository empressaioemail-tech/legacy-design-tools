/**
 * Web-search code retrieval types (transient, review-scoped — NOT corpus atoms).
 */

export const WEBSEARCH_ATOM_PREFIX = "websearch:";

/**
 * G-309 item 5: ICC Digital Codes (iccsafe.org and every subdomain) is never
 * fetched. Content is licensed through Code Connect only; we link, not scrape.
 */
export function isIccHost(hostname: string): boolean {
  return hostname.trim().toLowerCase().includes("iccsafe");
}

/**
 * G-309 (A15): mirrors such as up.codes republish ICC I-Code text. Any URL on a
 * mirror whose path names an ICC model-code title is refused. A city ordinance
 * or a non-ICC book on the same host is unaffected.
 */
const ICC_BOOK_SEGMENT =
  /^(?:(?:ibc|irc|ifc|ipmc|iecc|ipc|imc|ifgc|iebc|ispsc|igcc|iwuic|izc|ipsdc|iccpc|ifgs|icc)(?:[-_.\d].*)?|international-.*code.*)$/i;

export function isIccMirrorUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  if (host.includes("iccsafe")) return true;
  if (host !== "up.codes" && !host.endsWith(".up.codes")) return false;
  const segs = u.pathname.split("/").filter(Boolean);
  // /viewer/{jurisdiction}/{book}/... : test every segment after the viewer root.
  return segs.slice(1).some((seg) => {
    try {
      return ICC_BOOK_SEGMENT.test(decodeURIComponent(seg));
    } catch {
      return false;
    }
  });
}

/** Authoritative hosts the fetcher may contact. */
export const WEB_CODE_ALLOWLIST_HOSTS = [
  "floridabuilding.org",
  "www.nfpa.org",
  "nfpa.org",
  "up.codes",
  "www.up.codes",
  // Civic PE-chat backup (2026-08-24). Official ISD / TEA / city / county.
  // Not blogs, aggregators, or licensed code viewers. ICC hold list unchanged.
  "tea.texas.gov",
  "cityofbastrop.org",
  "bastropisd.org",
  "co.bastrop.tx.us",
  "georgetown.org",
  "georgetownisd.org",
] as const;

export type WebCodeAllowlistHost = (typeof WEB_CODE_ALLOWLIST_HOSTS)[number];

export interface WebCodeFetchInput {
  /** Section reference, e.g. `FBC-M601.6`, `NEC Art. 220`. */
  codeRef: string;
  /** Requested edition label, e.g. `FBC 2023`, `NEC 2017`. */
  edition: string;
  jurisdictionKey?: string;
  /** Manifest/catalog title — verified against fetched section heading when set. */
  expectedTitle?: string;
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
  /** Manifest/catalog title for section-heading verification. */
  expectedTitle?: string;
  /** Preferred driver order. */
  drivers: Array<"icc" | "florida" | "nfpa" | "upcodes">;
  /** Jurisdiction key — selects Florida vs Texas vs national driver profile. */
  jurisdictionKey?: string;
}

export type HttpFetcher = (url: string) => Promise<{
  status: number;
  body: string;
  finalUrl: string;
}>;
