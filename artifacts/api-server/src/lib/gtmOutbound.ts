/**
 * Tier 1 outbound workers — present but hard-disabled in v1.
 * All send paths route through evaluateOutboundGate; no-op when blocked.
 */

import { logger } from "./logger";
import {
  evaluateOutboundGate,
  type GtmOutboundAction,
  isOutboundEnabled,
} from "./gtmPolicy";

export type OutboundAttemptInput = {
  action: GtmOutboundAction;
  installId: string;
  hasConsent: boolean;
  payload?: Record<string, unknown>;
};

export type OutboundAttemptResult =
  | { sent: true; action: GtmOutboundAction }
  | { sent: false; blocked: true; reason: string; tier: 1 };

/** Side-effect stub — never calls external APIs when gate blocks. */
export async function attemptOutboundSend(
  input: OutboundAttemptInput,
): Promise<OutboundAttemptResult> {
  const gate = evaluateOutboundGate({
    action: input.action,
    hasConsent: input.hasConsent,
  });

  if (!gate.allowed) {
    logger.info(
      {
        action: input.action,
        installId: input.installId.slice(0, 8),
        reason: gate.reason,
        outboundEnabled: isOutboundEnabled(),
      },
      "gtm: outbound blocked by policy tier gate",
    );
    return { sent: false, blocked: true, reason: gate.reason, tier: gate.tier };
  }

  // Tier 1 path exists for post-E&O unlock; v1 never reaches here with default env.
  logger.warn(
    { action: input.action, installId: input.installId.slice(0, 8) },
    "gtm: outbound send executed (OUTBOUND_ENABLED=true)",
  );
  return { sent: true, action: input.action };
}
