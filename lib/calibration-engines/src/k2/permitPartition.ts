/**
 * Permit provision-domain partition — local LDC/UDC vs I-Code-dependent.
 *
 * Conservative rule: if dominant domain cannot be determined confidently,
 * defer to I-Code bucket (pending-icc).
 */

export type PermitProvisionDomain =
  | "local-code-evaluable"
  | "icode-dependent"
  | "deferred-ambiguous";

const LOCAL_KEYWORDS = [
  "zoning",
  "setback",
  "lot coverage",
  "site plan",
  "siteplan",
  "land use",
  "landscape",
  "tree",
  "sign permit",
  "driveway",
  "sidewalk",
  "subdivision",
  "plat",
  "udc",
  "land development",
  "floodplain",
  "parking waiver",
  "variance",
  "conditional use",
  "special use",
  "change of use",
  "nonconforming",
  "overlay",
  "historic",
  "demolition delay",
];

const ICODE_KEYWORDS = [
  "electrical",
  "mechanical",
  "plumbing",
  "structural",
  "building permit",
  "fire",
  "sprinkler",
  "alarm",
  "hvac",
  "energy",
  "elevator",
  "boiler",
  "medgas",
  "gas line",
  "refrigeration",
  "occupancy",
  "tenant improvement",
  "remodel",
  "addition",
  "new construction",
  "foundation",
  "framing",
  "roof",
  "solar pv",
  "generator",
];

/** Austin open-data permit type codes → default domain (dominant prior). */
const AUSTIN_PERMIT_TYPE_PRIOR: Record<string, PermitProvisionDomain> = {
  EP: "icode-dependent",
  MP: "icode-dependent",
  PP: "icode-dependent",
  BP: "icode-dependent",
  FP: "icode-dependent",
  FA: "icode-dependent",
  EL: "icode-dependent",
  EV: "icode-dependent",
  BO: "icode-dependent",
  DM: "icode-dependent",
  LP: "local-code-evaluable",
  SP: "local-code-evaluable",
  DS: "local-code-evaluable",
  ZP: "local-code-evaluable",
  SD: "local-code-evaluable",
  PL: "local-code-evaluable",
  GP: "local-code-evaluable",
};

const SA_PERMIT_TYPE_PRIOR: Record<string, PermitProvisionDomain> = {
  ELECTRICAL: "icode-dependent",
  MECHANICAL: "icode-dependent",
  PLUMBING: "icode-dependent",
  BUILDING: "icode-dependent",
  FIRE: "icode-dependent",
  SIGN: "local-code-evaluable",
  LANDSCAPE: "local-code-evaluable",
  ZONING: "local-code-evaluable",
  SITE: "local-code-evaluable",
};

function scoreKeywords(haystack: string, keywords: readonly string[]): number {
  const h = haystack.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (h.includes(kw)) score += kw.includes(" ") ? 2 : 1;
  }
  return score;
}

function classifyFromText(fields: string[]): PermitProvisionDomain {
  const haystack = fields.filter(Boolean).join(" ");
  const localScore = scoreKeywords(haystack, LOCAL_KEYWORDS);
  const icodeScore = scoreKeywords(haystack, ICODE_KEYWORDS);

  if (localScore === 0 && icodeScore === 0) return "deferred-ambiguous";
  if (localScore > icodeScore) return "local-code-evaluable";
  if (icodeScore > localScore) return "icode-dependent";
  return "deferred-ambiguous";
}

export function classifyAustinPermitDomain(
  row: Record<string, string>,
): PermitProvisionDomain {
  const permitType = (row["Permit Type"] ?? "").trim().toUpperCase();
  const typePrior = AUSTIN_PERMIT_TYPE_PRIOR[permitType];

  const textFields = [
    row["Permit Type Desc"] ?? "",
    row["Permit Class Mapped"] ?? "",
    row["Permit Class"] ?? "",
    row["Work Class"] ?? "",
    row["Description"] ?? "",
    row["Project Name"] ?? "",
  ];

  const textDomain = classifyFromText(textFields);

  if (typePrior === "local-code-evaluable" && textDomain !== "icode-dependent") {
    return "local-code-evaluable";
  }
  if (typePrior === "icode-dependent" && textDomain !== "local-code-evaluable") {
    return "icode-dependent";
  }
  if (textDomain !== "deferred-ambiguous") return textDomain;
  if (typePrior) return typePrior;
  return "deferred-ambiguous";
}

export function classifySanAntonioPermitDomain(
  row: Record<string, string>,
): PermitProvisionDomain {
  const permitType = (
    row["PERMIT_TYPE"] ??
    row["Permit Type"] ??
    row["permit_type"] ??
    ""
  )
    .trim()
    .toUpperCase();

  const typePrior = SA_PERMIT_TYPE_PRIOR[permitType];

  const textFields = [
    row["DESCRIPTION"] ?? row["Description"] ?? "",
    row["WORK_TYPE"] ?? row["Work Type"] ?? "",
    row["PERMIT_DESC"] ?? "",
    row["PROJECT_NAME"] ?? "",
  ];

  const textDomain = classifyFromText(textFields);
  if (typePrior === "local-code-evaluable" && textDomain !== "icode-dependent") {
    return "local-code-evaluable";
  }
  if (typePrior === "icode-dependent" && textDomain !== "local-code-evaluable") {
    return "icode-dependent";
  }
  if (textDomain !== "deferred-ambiguous") return textDomain;
  if (typePrior) return typePrior;
  return "deferred-ambiguous";
}

/** Map partition domain to K2 retrodiction scope. */
export function scopeFromPermitDomain(
  domain: PermitProvisionDomain,
): "local-code" | "pending-icc" {
  return domain === "local-code-evaluable" ? "local-code" : "pending-icc";
}

export type PermitPartitionCounts = {
  total: number;
  localCodeEvaluable: number;
  icodeDependent: number;
  deferredAmbiguous: number;
};

export function tallyPermitPartition(
  domain: PermitProvisionDomain,
  counts: PermitPartitionCounts,
): void {
  counts.total++;
  if (domain === "local-code-evaluable") counts.localCodeEvaluable++;
  else if (domain === "icode-dependent") counts.icodeDependent++;
  else counts.deferredAmbiguous++;
}
