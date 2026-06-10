/**
 * Web-code driver profiles — add a state/edition via config, not a code fork.
 *
 * Florida (Miami/FBC 2023) keeps legacy hardcoded paths. Texas and national 2021
 * I-Codes use UpCodes + ICC Digital Codes slugs below.
 */

export type DriverProfileId = "florida" | "texas" | "national";

export interface CodeBookSlugConfig {
  /** UpCodes book slug segment, e.g. `irc-2021`. Empty → no UpCodes URL for this book. */
  upcodesBookSlug: string;
  /** ICC Digital Codes content path, e.g. `IRC2021P1`. */
  iccContentSlug: string;
  /** IECC / A117.1 adopt at municipality on UpCodes — use city slug not `texas/`. */
  municipalityScoped?: boolean;
  /** No ICC HTML — deeplink-only (ADA.gov, etc.). */
  deeplinkOnly?: boolean;
  deeplinkUrl?: string;
}

/** UpCodes + ICC slug table keyed by `{CODE}-{edition}`. */
export const CODE_BOOK_SLUGS: Record<string, CodeBookSlugConfig> = {
  "IRC-2021": { upcodesBookSlug: "irc-2021", iccContentSlug: "IRC2021P1" },
  "IBC-2021": { upcodesBookSlug: "ibc-2021", iccContentSlug: "IBC2021P1" },
  "IEBC-2021": { upcodesBookSlug: "iebc-2021", iccContentSlug: "IEBC2021P1" },
  "IECC-2021": {
    upcodesBookSlug: "iecc-2021",
    iccContentSlug: "IECC2021P1",
    municipalityScoped: true,
  },
  "IMC-2021": { upcodesBookSlug: "imc-2021", iccContentSlug: "IMC2021P1" },
  "IPC-2021": { upcodesBookSlug: "ipc-2021", iccContentSlug: "IPC2021P1" },
  "IFGC-2021": { upcodesBookSlug: "ifgc-2021", iccContentSlug: "IFGC2021P1" },
  "IFC-2021": { upcodesBookSlug: "ifc-2021", iccContentSlug: "IFC2021P1" },
  "IPMC-2021": { upcodesBookSlug: "ipmc-2021", iccContentSlug: "IPMC2021P1" },
  "IRC-2024": {
    upcodesBookSlug: "irc-2024",
    iccContentSlug: "IRC2024P1",
    municipalityScoped: true,
  },
  "IBC-2024": {
    upcodesBookSlug: "ibc-2024",
    iccContentSlug: "IBC2024P1",
    municipalityScoped: true,
  },
  "IECC-2024": {
    upcodesBookSlug: "iecc-2024",
    iccContentSlug: "IECC2024P1",
    municipalityScoped: true,
  },
  "IFC-2024": {
    upcodesBookSlug: "ifc-2024",
    iccContentSlug: "IFC2024P1",
    municipalityScoped: true,
  },
  "UMC-2024": {
    upcodesBookSlug: "umc-2024",
    iccContentSlug: "",
    municipalityScoped: true,
  },
  "UPC-2024": {
    upcodesBookSlug: "upc-2024",
    iccContentSlug: "",
    municipalityScoped: true,
  },
  "A117.1-2017": {
    upcodesBookSlug: "icc-a117.1-2017",
    iccContentSlug: "A11712017",
    municipalityScoped: true,
  },
  "NEC-2023": {
    upcodesBookSlug: "",
    iccContentSlug: "",
    deeplinkOnly: true,
    deeplinkUrl: "https://www.nfpa.org/codes-and-standards/nfpa-70-nec",
  },
  "TAS-2012": {
    upcodesBookSlug: "",
    iccContentSlug: "",
    deeplinkOnly: true,
    deeplinkUrl: "https://www.tdlr.texas.gov/ab/abtas.htm",
  },
  "ADA-2010": {
    upcodesBookSlug: "",
    iccContentSlug: "",
    deeplinkOnly: true,
    deeplinkUrl: "https://www.ada.gov/law-and-regs/design-standards/2010-std/",
  },
};

const FLORIDA_JURISDICTION_SUFFIXES = ["_fl"];

/** Resolve driver profile from persisted jurisdiction key (FBC refs default Florida). */
export function driverProfileForJurisdiction(
  jurisdictionKey?: string,
  hints?: { edition?: string; codeRef?: string },
): DriverProfileId {
  if (
    hints?.codeRef?.startsWith("FBC") ||
    hints?.edition?.includes("FBC")
  ) {
    return "florida";
  }
  if (!jurisdictionKey) return "national";
  const key = jurisdictionKey.toLowerCase();
  if (
    key.includes("miami") ||
    FLORIDA_JURISDICTION_SUFFIXES.some((s) => key.endsWith(s))
  ) {
    return "florida";
  }
  if (key.endsWith("_tx")) return "texas";
  return "national";
}

/** UpCodes jurisdiction path segment (`florida`, `austin`, `texas`, …). */
export function upcodesJurisdictionSlug(jurisdictionKey?: string): string {
  const profile = driverProfileForJurisdiction(jurisdictionKey);
  if (profile === "florida") return "florida";
  if (profile === "texas") {
    if (!jurisdictionKey) return "austin";
    const city = jurisdictionKey
      .replace(/_tx$/i, "")
      .replace(/_/g, "-");
    if (city === "san-antonio" || city === "san-antonio") return "san-antonio";
    if (city === "new-braunfels") return "new-braunfels";
    if (city === "round-rock") return "round-rock";
    if (city === "bastrop-county") return "bastrop";
    return city || "austin";
  }
  return "texas";
}

/** Map manifest code families (IECC-R, IECC-C) to slug-table keys. */
export function normalizeCodeBookKey(code: string): string {
  const upper = code.toUpperCase();
  if (upper.startsWith("IECC")) return "IECC";
  if (upper.startsWith("A117")) return "A117.1";
  if (upper.startsWith("TAS")) return "TAS";
  return upper;
}

/** ICC / UpCodes fragment anchor: R301.1 → R301_1 */
export function sectionAnchorToken(section: string): string {
  return section.replace(/\./g, "_");
}

/** Resolve code-book family from a manifest codeRef (handles IECC-C402.4, A117.1-302). */
export function codeBookFromRef(codeRef: string): string | null {
  const upper = codeRef.toUpperCase();
  if (upper.startsWith("IECC-R-") || upper.startsWith("IECC-C-")) return "IECC";
  if (upper.startsWith("IECC-R") || upper.startsWith("IECC-C")) return "IECC";
  if (upper.startsWith("A117.1-")) return "A117.1";
  if (upper.startsWith("TAS-")) return "TAS";
  const m = codeRef.match(/^([A-Z][A-Z0-9.]*?)-/i);
  return m?.[1] ?? null;
}

/**
 * UpCodes chapter path segment — numeric chapter or IECC 2024 RE_/CE_ volume slug.
 */
export function upcodesChapterPath(
  codeRef: string,
  edition?: string,
  upcodesBookSlug?: string,
): string {
  const year = edition?.match(/\b(20\d{2})\b/)?.[1];
  const upper = codeRef.toUpperCase();
  if (year === "2024" && upcodesBookSlug === "iecc-2024") {
    if (upper.startsWith("IECC-C") || upper.includes("-C4")) {
      return "CE_4/ce-commercial-energy-efficiency";
    }
    return "RE_4/re-residential-energy-efficiency";
  }
  const section = bareSectionFromCodeRef(codeRef);
  return inferChapterNumber(section);
}

/** Lookup slug config from codeRef prefix + edition label. */
export function slugConfigForTarget(args: {
  editionSlug: string;
  codeRef: string;
  edition?: string;
}): CodeBookSlugConfig | null {
  const codeFromRef = codeBookFromRef(args.codeRef);
  const year =
    args.edition?.match(/\b(20\d{2})\b/)?.[1] ??
    args.editionSlug.match(/\b(20\d{2})\b/)?.[1];
  if (codeFromRef && year) {
    const composite = `${normalizeCodeBookKey(codeFromRef)}-${year}`;
    const hit = CODE_BOOK_SLUGS[composite];
    if (hit) return hit;
  }

  for (const [key, cfg] of Object.entries(CODE_BOOK_SLUGS)) {
    if (
      key.toLowerCase().replace(/[^a-z0-9]/g, "") ===
      args.editionSlug.replace(/[^a-z0-9]/g, "")
    ) {
      return cfg;
    }
  }
  return null;
}

/** Bare section token from a codeRef like `IRC-R301.1` → `R301.1`. */
export function bareSectionFromCodeRef(codeRef: string): string {
  const iecc = codeRef.match(/^IECC-[RC]-(.+)$/i);
  if (iecc) return iecc[1]!;
  const prefixed = codeRef.match(/^[A-Z][A-Z0-9.]*-(.+)$/i);
  if (prefixed) return prefixed[1]!;
  return codeRef;
}

/** Infer ICC/UpCodes chapter number from section reference. */
export function inferChapterNumber(section: string): string {
  const bare = section.replace(/"/g, "").trim();
  const r = bare.match(/^R(\d)/i);
  if (r) return r[1]!;
  const threeDigit = bare.match(/^(\d{3})(?:\.\d+)*$/);
  if (threeDigit) return threeDigit[1]!.charAt(0);
  const letterNum = bare.match(/^[A-Z]+(\d)/i);
  if (letterNum) return letterNum[1]!;
  const n = bare.match(/^(\d{1,2})/);
  if (n) return String(parseInt(n[1]!, 10));
  return "1";
}
