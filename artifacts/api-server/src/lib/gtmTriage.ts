/**
 * Read-only GTM triage — classifies observation events into intent, package,
 * conversion opportunity, and friction. Results may be persisted to gtm_events
 * only (no external side effects).
 */

import type { GtmErrorClass } from "./gtmErrorClass";

export const GTM_DATA_PACKAGES = [
  "subsurface",
  "hydrology",
  "parcel",
  "code",
  "environmental",
  "unknown",
] as const;

export type GtmDataPackage = (typeof GTM_DATA_PACKAGES)[number];

export type GtmConversionOpportunity = "high" | "medium" | "low" | "none";

export type GtmTriageInput = {
  eventType: string;
  sourceSurface?: string;
  toolName?: string | null;
  errorClass?: string | null;
  externalCaller?: boolean | null;
  jurisdictionKey?: string | null;
};

export type GtmTriageResult = {
  intentScore: number;
  dataPackage: GtmDataPackage;
  conversionOpportunity: GtmConversionOpportunity;
  friction: GtmErrorClass | "none" | "coverage_gap";
};

const PACKAGE_TOOL_PATTERNS: Array<{ pkg: GtmDataPackage; patterns: RegExp[] }> =
  [
    {
      pkg: "subsurface",
      patterns: [
        /subsurface/i,
        /ssurgo/i,
        /geolog/i,
        /seismic/i,
        /groundwater/i,
        /soil/i,
      ],
    },
    {
      pkg: "hydrology",
      patterns: [/hydrolog/i, /drainage/i, /flood/i, /nfhl/i, /rainfall/i, /pyshed/i],
    },
    {
      pkg: "parcel",
      patterns: [
        /brief/i,
        /place/i,
        /workspace/i,
        /parcel/i,
        /property/i,
        /resolve_place/i,
        /get_place/i,
        /regrid/i,
      ],
    },
    {
      pkg: "code",
      patterns: [
        /code/i,
        /reconcile/i,
        /plan.?set/i,
        /accessibility/i,
        /standard/i,
        /jurisdiction/i,
        /atom/i,
      ],
    },
    {
      pkg: "environmental",
      patterns: [/environment/i, /ejscreen/i, /esg/i],
    },
  ];

const FRICTION_ERROR_CLASSES = new Set<string>([
  "no_coverage",
  "empty_corpus",
  "auth_reject",
  "upstream_timeout",
  "geocode_miss",
]);

export function inferDataPackage(toolName: string | null | undefined): GtmDataPackage {
  if (!toolName) return "unknown";
  for (const { pkg, patterns } of PACKAGE_TOOL_PATTERNS) {
    if (patterns.some((re) => re.test(toolName))) return pkg;
  }
  return "unknown";
}

function frictionFromError(errorClass: string | null | undefined): GtmTriageResult["friction"] {
  if (!errorClass) return "none";
  if (FRICTION_ERROR_CLASSES.has(errorClass)) {
    return errorClass as GtmErrorClass;
  }
  if (errorClass === "validation_error") return "none";
  return "coverage_gap";
}

function intentScore(input: GtmTriageInput, pkg: GtmDataPackage): number {
  let score = 20;
  if (input.externalCaller) score += 35;
  if (input.eventType === "mcp_connect") score += 15;
  if (input.eventType === "mcp_tool_call") score += 25;
  if (input.eventType === "mcp_docs_clicked") score += 30;
  if (pkg !== "unknown") score += 15;
  if (input.jurisdictionKey) score += 10;
  if (input.eventType === "mcp_error") score -= 20;
  return Math.max(0, Math.min(100, score));
}

function conversionOpportunity(
  input: GtmTriageInput,
  pkg: GtmDataPackage,
  friction: GtmTriageResult["friction"],
): GtmConversionOpportunity {
  if (friction !== "none" && friction !== "coverage_gap") return "none";
  if (input.eventType === "mcp_docs_clicked" && input.externalCaller) return "high";
  if (input.eventType === "mcp_tool_call" && input.externalCaller && pkg !== "unknown") {
    return "high";
  }
  if (input.eventType === "mcp_connect" && input.externalCaller) return "medium";
  if (input.eventType === "mcp_tool_call") return "medium";
  if (input.eventType === "mcp_error" && input.externalCaller) return "low";
  return "none";
}

/** Pure read-only classifier for a single observation event. */
export function classifyGtmEvent(input: GtmTriageInput): GtmTriageResult {
  const dataPackage = inferDataPackage(input.toolName);
  const friction = frictionFromError(input.errorClass);
  return {
    intentScore: intentScore(input, dataPackage),
    dataPackage,
    conversionOpportunity: conversionOpportunity(input, dataPackage, friction),
    friction,
  };
}

export type GtmTriageRecord = GtmTriageInput & {
  eventId?: string;
  createdAt?: string;
  triage: GtmTriageResult;
};

/** Batch classify events for steward digest / scoreboard. */
export function classifyGtmEvents(
  events: Array<GtmTriageInput & { eventId?: string; createdAt?: string }>,
): GtmTriageRecord[] {
  return events.map((ev) => ({
    ...ev,
    triage: classifyGtmEvent(ev),
  }));
}
