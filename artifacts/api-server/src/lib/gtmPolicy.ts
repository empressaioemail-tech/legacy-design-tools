/**
 * GTM policy tier gate — Tier 0 auto; Tier 1 outbound held until E&O + consent.
 * v1: OUTBOUND_ENABLED defaults false; no send path executes without explicit flip.
 */

export const GTM_OUTBOUND_ACTIONS = [
  "email_send",
  "content_publish",
] as const;

export type GtmOutboundAction = (typeof GTM_OUTBOUND_ACTIONS)[number];

export type OutboundGateResult =
  | { allowed: true }
  | { allowed: false; reason: string; tier: 1 };

function parseEnvBool(name: string, defaultValue = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return defaultValue;
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Hard-disable flag for Tier 1 outbound in v1. */
export function isOutboundEnabled(): boolean {
  return parseEnvBool("OUTBOUND_ENABLED", false);
}

/** E&O insurance bound — required before any Tier 1 outbound. */
export function isEoBound(): boolean {
  return parseEnvBool("GTM_EO_BOUND", false);
}

export function evaluateOutboundGate(input: {
  action: GtmOutboundAction;
  hasConsent: boolean;
}): OutboundGateResult {
  if (!isOutboundEnabled()) {
    return {
      allowed: false,
      tier: 1,
      reason: "OUTBOUND_ENABLED=false — Tier 1 outbound held in v1",
    };
  }
  if (!isEoBound()) {
    return {
      allowed: false,
      tier: 1,
      reason: "GTM_EO_BOUND=false — E&O not bound",
    };
  }
  if (!input.hasConsent) {
    return {
      allowed: false,
      tier: 1,
      reason: "consent_required — caller lacks gtm_consent record",
    };
  }
  return { allowed: true };
}
