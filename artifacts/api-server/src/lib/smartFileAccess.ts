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

/**
 * Command Center and MCP call cortex-api with the service bearer
 * (CORTEX_SERVICE_API_KEY / SERVICE_API_KEY). requireServiceToken attaches
 * serviceAuth on success. That credential is the operator path (WDLL G-56
 * item 7): it reads platform-internal. Gate-front may also set
 * platformInternal via signed context or x-hauska-platform-internal; either
 * signal is enough. A missing serviceAuth is anonymous and cannot read
 * platform-internal (the route middleware 401s first).
 */
export function accessSubjectFromRequest(req: {
  serviceAuth?: { platformInternal?: boolean; jurisdictionTenant?: string | null };
}): SmartFileAccessSubject {
  const authedService = req.serviceAuth !== undefined;
  return {
    platformInternal: authedService || req.serviceAuth?.platformInternal === true,
    jurisdictionTenant: req.serviceAuth?.jurisdictionTenant ?? null,
    paidTier: false,
  };
}
