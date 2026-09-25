/**
 * P-453. Non-homestead exemption types (over-65, disability, veteran,
 * surviving-spouse codes, and any label that describes a person) are suppressed
 * at the api-server serve layer once so every downstream path inherits it.
 *
 * Homestead yes/no may survive for Studio/Team (and unlock) callers; public
 * card, stub, and share surfaces carry no exemption detail at all.
 */

import { summarizeCadPayload } from "@workspace/adapters/local/cad";
import type {
  BrokerageSiteContext,
  BrokerageSiteContextLayer,
} from "./brokerageSiteContext";

export type ExemptionDetailLevel = "none" | "homestead-only";

export const PERSONAL_ATTRIBUTE_EXEMPTION_REFUSAL = {
  state: "refused",
  code: "personal-attribute",
  reason:
    "This exemption type describes a personal attribute of a real person and is not carried on this surface.",
} as const;

const HOMESTEAD_EXEMPTION_CODES = new Set(["HS", "DVHS"]);

export function isHomesteadExemptionCode(code: string): boolean {
  return HOMESTEAD_EXEMPTION_CODES.has(code.trim().toUpperCase());
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function refusalField(): typeof PERSONAL_ATTRIBUTE_EXEMPTION_REFUSAL {
  return PERSONAL_ATTRIBUTE_EXEMPTION_REFUSAL;
}

/** Owner-fact exemptionFlags: keep homestead boolean on homestead-only; refuse the rest. */
export function gateOwnerFactExemptionTypesForServe(
  ownerFact: unknown,
  level: ExemptionDetailLevel,
): unknown {
  const rec = asRecord(ownerFact);
  if (!rec || rec.state !== "present") return ownerFact;
  if (level === "none") {
    return { ...rec, exemptionFlags: null };
  }
  const flags = asRecord(rec.exemptionFlags);
  if (!flags) return ownerFact;
  return {
    ...rec,
    exemptionFlags: {
      homestead:
        typeof flags.homestead === "boolean" ? flags.homestead : null,
      seniorOrDisability: refusalField(),
      agricultural: refusalField(),
      veteran: refusalField(),
    },
  };
}

function sanitizeExemptionCodeList(
  codes: unknown,
  level: ExemptionDetailLevel,
): string[] | null | typeof PERSONAL_ATTRIBUTE_EXEMPTION_REFUSAL {
  if (level === "none") return null;
  if (!Array.isArray(codes)) return null;
  const kept = codes.filter(
    (c): c is string => typeof c === "string" && isHomesteadExemptionCode(c),
  );
  const hadPersonal = codes.some(
    (c) => typeof c === "string" && !isHomesteadExemptionCode(c),
  );
  if (hadPersonal && kept.length === 0) {
    return PERSONAL_ATTRIBUTE_EXEMPTION_REFUSAL;
  }
  if (kept.length === 0) return null;
  return kept;
}

function sanitizeBakedExemptionCodes(
  value: unknown,
  level: ExemptionDetailLevel,
): unknown {
  const rec = asRecord(value);
  if (!rec || !("v" in rec)) {
    return sanitizeExemptionCodeList(value, level);
  }
  const sanitized = sanitizeExemptionCodeList(rec.v, level);
  if (sanitized === PERSONAL_ATTRIBUTE_EXEMPTION_REFUSAL) {
    return PERSONAL_ATTRIBUTE_EXEMPTION_REFUSAL;
  }
  if (sanitized === null) return null;
  return { ...rec, v: sanitized };
}

function sanitizeCadTaxPayload(
  payload: Record<string, unknown>,
  level: ExemptionDetailLevel,
): Record<string, unknown> {
  if (level === "none") {
    const { exemptionCodes: _c, exemptions: _e, ...rest } = payload;
    return rest;
  }
  const codes = sanitizeExemptionCodeList(payload.exemptionCodes, level);
  const next: Record<string, unknown> = { ...payload };
  if (codes === PERSONAL_ATTRIBUTE_EXEMPTION_REFUSAL) {
    next.exemptionCodes = PERSONAL_ATTRIBUTE_EXEMPTION_REFUSAL;
    next.exemptions = PERSONAL_ATTRIBUTE_EXEMPTION_REFUSAL;
  } else if (codes === null) {
    delete next.exemptionCodes;
    delete next.exemptions;
  } else if (Array.isArray(codes)) {
    next.exemptionCodes = codes;
    next.exemptions = codes.map((code) => ({
      code,
      label: code === "HS" ? "Homestead" : code,
    }));
  }
  return next;
}

function sanitizeCadOwnerOccupancyPayload(
  payload: Record<string, unknown>,
  level: ExemptionDetailLevel,
): Record<string, unknown> {
  if (level === "none") {
    const { homesteadExemption: _h, ...rest } = payload;
    return rest;
  }
  return payload;
}

function sanitizeFacetsTree(value: unknown, level: ExemptionDetailLevel): unknown {
  const rec = asRecord(value);
  if (!rec) return value;
  const baseFacts = asRecord(rec.baseFacts);
  if (!baseFacts) return value;
  if (!("exemptionCodes" in baseFacts)) return value;
  return {
    ...rec,
    baseFacts: {
      ...baseFacts,
      exemptionCodes: sanitizeBakedExemptionCodes(baseFacts.exemptionCodes, level),
    },
  };
}

/** Site-context / brokerage brief layers (cad-tax summaries, payloads). */
export function applyExemptionTypesServeToSiteContext(
  ctx: BrokerageSiteContext,
  level: ExemptionDetailLevel,
): BrokerageSiteContext {
  return {
    ...ctx,
    layers: ctx.layers.map((layer): BrokerageSiteContextLayer => {
      const payload = asRecord(layer.payload);
      if (!payload) return layer;
      let nextPayload = payload;
      if (layer.layerKind === "cad-tax" || payload.kind === "cad-tax") {
        nextPayload = sanitizeCadTaxPayload(payload, level);
      } else if (
        layer.layerKind === "cad-owner-occupancy" ||
        payload.kind === "cad-owner-occupancy"
      ) {
        nextPayload = sanitizeCadOwnerOccupancyPayload(payload, level);
      }
      const summary =
        typeof layer.summary === "string"
          ? summarizeCadPayload(String(layer.layerKind), nextPayload) ??
            layer.summary
          : layer.summary;
      return { ...layer, payload: nextPayload, summary };
    }),
  };
}

/** `/research/brief` and MCP upstream body. */
export function applyExemptionTypesServeToResearchBriefBody(
  body: Record<string, unknown>,
  level: ExemptionDetailLevel,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body };
  if ("ownerFact" in next) {
    next.ownerFact = gateOwnerFactExemptionTypesForServe(next.ownerFact, level);
  }
  if ("facets" in next) {
    next.facets = sanitizeFacetsTree(next.facets, level);
  }
  if ("onRecord" in next && level === "none") {
    // onRecord carries no exemption codes today; keep for forward safety.
    next.onRecord = next.onRecord;
  }
  return next;
}

/** `/api/spine/property-atoms/.../facets` response envelope. */
export function applyExemptionTypesServeToNodeFacetsResponse(
  response: Record<string, unknown>,
  level: ExemptionDetailLevel,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...response };
  if ("ownerFact" in next) {
    next.ownerFact = gateOwnerFactExemptionTypesForServe(next.ownerFact, level);
  }
  if ("facets" in next) {
    next.facets = sanitizeFacetsTree(next.facets, level);
  }
  return next;
}

export function exemptionDetailLevelForOwnerCoGate(
  grantsOwnerCoGatedFields: boolean,
): ExemptionDetailLevel {
  return grantsOwnerCoGatedFields ? "homestead-only" : "none";
}
