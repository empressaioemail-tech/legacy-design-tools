import type { WebCodeReviewTarget } from "@workspace/codes";
import type { CodewarmManifestEntry } from "./types";

export function editionSlug(code: string, edition: string): string {
  return `${code}-${edition}`
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

export function driversForCode(code: string, codeRef: string): WebCodeReviewTarget["drivers"] {
  const upper = `${code} ${codeRef}`.toUpperCase();
  if (upper.includes("NEC") || upper.includes("NFPA")) {
    return ["nfpa", "upcodes"];
  }
  if (upper.includes("IFC") || upper.includes("IPMC")) {
    return ["icc", "upcodes"];
  }
  return ["upcodes", "icc"];
}

export function manifestEntryToTarget(
  entry: CodewarmManifestEntry,
  jurisdictionKey?: string,
): WebCodeReviewTarget {
  const slug = editionSlug(entry.code, entry.edition);
  return {
    codeRef: entry.codeRef,
    edition: `${entry.code} ${entry.edition}`,
    editionSlug: slug,
    label: `${entry.codeRef} — ${entry.title}`,
    expectedTitle: entry.title,
    drivers: driversForCode(entry.code, entry.codeRef),
    jurisdictionKey,
  };
}

export function nfpaDeeplinkUrl(entry: CodewarmManifestEntry): string {
  const upper = entry.codeRef.toUpperCase();
  if (upper.includes("NEC")) {
    return "https://www.nfpa.org/codes-and-standards/nfpa-70-nec";
  }
  if (upper.includes("NFPA 101") || entry.code.toUpperCase().includes("NFPA")) {
    return "https://www.nfpa.org/codes-and-standards/all-codes-and-standards/list-of-codes-and-standards/detail?code=101";
  }
  return "https://www.nfpa.org/codes-and-standards";
}
