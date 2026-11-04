/**
 * Authoritative-source URL builders for the web-code allowlist.
 */

import { isIccHost, isIccMirrorUrl, type WebCodeReviewTarget } from "./types";
import {
  bareSectionFromCodeRef,
  driverProfileForJurisdiction,
  slugConfigForTarget,
  upcodesChapterPath,
  upcodesJurisdictionSlug,
} from "./driverProfiles";

export type WebDriverId = "icc" | "florida" | "nfpa" | "upcodes";

export interface DriverUrlCandidate {
  driver: WebDriverId;
  url: string;
  /** Section-level fetch preferred over chapter landing. */
  granularity: "section" | "chapter";
}

/** Build candidate fetch URLs for a review target (allowlist only). */
export function buildDriverUrls(
  target: Pick<
    WebCodeReviewTarget,
    "codeRef" | "editionSlug" | "edition" | "drivers" | "jurisdictionKey"
  >,
): DriverUrlCandidate[] {
  const urls: DriverUrlCandidate[] = [];

  for (const driver of target.drivers) {
    urls.push(...singleDriverUrls(driver, target));
  }
  // G-309 (A15): no ICC model-code title URL is ever built for a mirror.
  return urls.filter((c) => !isIccMirrorUrl(c.url));
}

function singleDriverUrls(
  driver: WebDriverId,
  target: Pick<
    WebCodeReviewTarget,
    "codeRef" | "editionSlug" | "edition" | "jurisdictionKey"
  >,
): DriverUrlCandidate[] {
  const profile = driverProfileForJurisdiction(target.jurisdictionKey, {
    edition: target.edition,
    codeRef: target.codeRef,
  });
  const ref = target.codeRef;

  if (profile === "florida") {
    const url = floridaDriverUrl(driver, ref);
    return url ? [{ driver, url, granularity: "chapter" }] : [];
  }

  return nationalOrTexasDriverUrls(driver, target);
}

/** Legacy Miami / FBC 2023 paths — unchanged. */
function floridaDriverUrl(driver: WebDriverId, codeRef: string): string | null {
  switch (driver) {
    case "icc":
      // G-309: ICC Digital Codes is never fetched.
      return null;
    case "florida":
      return "https://www.floridabuilding.org/fbc/commission_fbc_8th_edition.htm";
    case "nfpa":
      if (!codeRef.startsWith("NEC")) return null;
      return "https://www.nfpa.org/codes-and-standards/nfpa-70-nec";
    case "upcodes":
      if (codeRef.startsWith("NEC")) {
        const art = codeRef.replace(/NEC\s*Art\.?\s*/i, "").trim();
        return `https://up.codes/viewer/florida/nfpa-70-2017/chapter/${art.split(".")[0]}`;
      }
      return "https://up.codes/viewer/florida/florida-building-code-2023";
    default:
      return null;
  }
}

function nationalOrTexasDriverUrls(
  driver: WebDriverId,
  target: Pick<
    WebCodeReviewTarget,
    "codeRef" | "editionSlug" | "edition" | "jurisdictionKey"
  >,
): DriverUrlCandidate[] {
  const cfg = slugConfigForTarget({
    editionSlug: target.editionSlug,
    codeRef: target.codeRef,
    edition: target.edition,
  });
  const section = bareSectionFromCodeRef(target.codeRef);
  const chapter = upcodesChapterPath(
    target.codeRef,
    target.edition,
    cfg?.upcodesBookSlug,
  );

  if (cfg?.deeplinkOnly && cfg.deeplinkUrl) {
    return driver === "icc" && !isIccHost(new URL(cfg.deeplinkUrl).hostname)
      ? [{ driver, url: cfg.deeplinkUrl, granularity: "chapter" }]
      : [];
  }

  switch (driver) {
    case "nfpa":
      if (!target.codeRef.startsWith("NEC")) return [];
      return [
        {
          driver,
          url: "https://www.nfpa.org/codes-and-standards/nfpa-70-nec",
          granularity: "chapter",
        },
      ];
    case "icc":
      // G-309 item 5: no iccsafe.org URL is ever built or fetched.
      return [];
    case "upcodes": {
      if (!cfg?.upcodesBookSlug) return [];
      if (target.codeRef.startsWith("NEC")) {
        const art = target.codeRef.replace(/NEC\s*Art\.?\s*/i, "").trim();
        const url = `https://up.codes/viewer/texas/nfpa-70-2017/chapter/${art.split(".")[0]}`;
        return [{ driver, url, granularity: "chapter" }];
      }
      const city = cfg.municipalityScoped
        ? upcodesJurisdictionSlug(target.jurisdictionKey)
        : "texas";
      const chapterBase = `https://up.codes/viewer/${city}/${cfg.upcodesBookSlug}/chapter/${chapter}`;
      return [
        {
          driver,
          url: `${chapterBase}/${encodeURIComponent(section)}`,
          granularity: "section",
        },
        { driver, url: chapterBase, granularity: "chapter" },
      ];
    }
    case "florida":
      return [];
    default:
      return [];
  }
}

/** Normalize edition label to a four-digit year for verification. */
export function editionYear(edition: string): string | null {
  const m = edition.match(/\b(20\d{2})\b/);
  return m ? m[1] : null;
}

/** Section token for presence check in page text. */
export function sectionPresenceToken(codeRef: string): string {
  if (codeRef.startsWith("NEC")) {
    const art = codeRef.replace(/NEC\s*Art\.?\s*/i, "").trim();
    return `Article ${art.split(".")[0]}`;
  }
  const bare = bareSectionFromCodeRef(codeRef)
    .replace(/^FBC[A-Z.-]*\s*/i, "")
    .replace(/^FBCEB\s*/i, "")
    .replace(/\s+/g, "");
  return bare || codeRef;
}
