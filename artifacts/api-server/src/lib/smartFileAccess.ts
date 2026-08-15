/**
 * Smart Files access-policy gate (ADR-017) for cortex-api serve routes.
 * Mirrors hauska-mcp-server access-policy.ts semantics.
 */

import type { SmartFileAccessPolicyValue } from "@workspace/db";

export interface SmartFileAccessSubject {
  platformInternal: boolean;
  jurisdictionTenant: string | null;
  paidTier: boolean;
}

export function canReadSmartFilePolicy(
  subject: SmartFileAccessSubject,
  policy: SmartFileAccessPolicyValue,
  jurisdictionTenant: string | null = null,
): boolean {
  switch (policy) {
    case "public-free":
      return true;
    case "public-paid":
      return subject.paidTier || subject.platformInternal;
    case "platform-internal":
      return subject.platformInternal;
    case "tenant-private":
      if (subject.platformInternal) return true;
      if (!subject.jurisdictionTenant || !jurisdictionTenant) return false;
      return subject.jurisdictionTenant === jurisdictionTenant;
    case "tenant-shared":
      if (subject.platformInternal) return true;
      if (!subject.jurisdictionTenant) return false;
      return subject.jurisdictionTenant === jurisdictionTenant;
    default:
      return false;
  }
}

export function accessSubjectFromRequest(req: {
  serviceAuth?: { platformInternal?: boolean; jurisdictionTenant?: string | null };
}): SmartFileAccessSubject {
  return {
    platformInternal: req.serviceAuth?.platformInternal ?? false,
    jurisdictionTenant: req.serviceAuth?.jurisdictionTenant ?? null,
    paidTier: false,
  };
}
