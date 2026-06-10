/**
 * Authoritative-source URL builders for the web-code allowlist.
 */

import type { WebCodeReviewTarget } from "./types";
import {
  bareSectionFromCodeRef,
  driverProfileForJurisdiction,
  inferChapterNumber,
  sectionAnchorToken,
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
  return urls;
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
      if (codeRef.startsWith("NEC")) return null;
      if (codeRef.includes("M601") || codeRef.includes("Ch.4")) {
        return "https://codes.iccsafe.org/content/FLMECH2023P1";
      }
      if (codeRef.includes("1405")) {
        return "https://codes.iccsafe.org/content/FLBC2023P1/chapter-14-exterior-walls";
      }
      if (codeRef.includes("FBCEB") || codeRef.includes("601.2")) {
        return "https://codes.iccsafe.org/content/FLFEC2023P1";
      }
      return "https://codes.iccsafe.org/content/FLBC2023P1";
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
  const iccChapter = inferChapterNumber(section);
  const anchor = sectionAnchorToken(section);

  if (cfg?.deeplinkOnly && cfg.deeplinkUrl) {
    return driver === "icc"
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
    case "icc": {
      if (!cfg?.iccContentSlug) return [];
      const chapterUrl = `https://codes.iccsafe.org/content/${cfg.iccContentSlug}/chapter-${iccChapter}`;
      return [
        {
          driver,
          url: `${chapterUrl}#${anchor}`,
          granularity: "section",
        },
        { driver, url: chapterUrl, granularity: "chapter" },
      ];
    }
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
