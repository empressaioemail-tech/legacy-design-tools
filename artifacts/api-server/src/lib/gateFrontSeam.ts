/**
 * Gate-front seam (ADR-008 / tenant leg step 2).
 *
 * Shared helpers for MCP service callers reaching cortex-api engine
 * entry points. The gate resolves `jurisdiction_tenant` on the API key
 * (hauska-mcp-server #29) and forwards it on every service call so
 * arrow-two partitions and tenant scoping stay aligned with Phase 1.
 */

import type { Request } from "express";
import { DEFAULT_TENANT_ID } from "../middlewares/session";

/** Header the MCP gate sends with the resolved jurisdiction tenant slug. */
export const GATE_JURISDICTION_TENANT_HEADER = "x-hauska-jurisdiction-tenant";

/** When true, Hauska/platform-internal callers bypass tenant-equality checks. */
export const GATE_PLATFORM_INTERNAL_HEADER = "x-hauska-platform-internal";

export interface GateServiceAuth {
  /** Legacy session tenant slot (single-tenant default today). */
  tenantId: string;
  /** ADR-005 jurisdiction partition resolved at the gate. */
  jurisdictionTenant: string | null;
  platformInternal: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Set when a request authenticates with the service bearer token
       * on a gate-front engine route.
       */
      serviceAuth?: GateServiceAuth;
    }
  }
}

export function readGateJurisdictionTenant(req: Request): string | null {
  const raw = req.header(GATE_JURISDICTION_TENANT_HEADER);
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

export function readGatePlatformInternal(req: Request): boolean {
  const raw = req.header(GATE_PLATFORM_INTERNAL_HEADER);
  if (typeof raw !== "string") return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function buildGateServiceAuth(req: Request): GateServiceAuth {
  return {
    tenantId: DEFAULT_TENANT_ID,
    jurisdictionTenant: readGateJurisdictionTenant(req),
    platformInternal: readGatePlatformInternal(req),
  };
}

/** Best-effort jurisdiction tenant for the active request (service or dev header). */
export function resolveRequestJurisdictionTenant(req: Request): string | null {
  return (
    req.serviceAuth?.jurisdictionTenant ??
    readGateJurisdictionTenant(req) ??
    null
  );
}

/**
 * Enforce tenant partition for service callers. Platform-internal and
 * browser-session paths pass through; mismatched tenant → 403.
 */
export function assertServiceTenantScope(
  req: Request,
  resourceTenant: string | null,
): { ok: true } | { ok: false; error: "tenant_scope_denied" } {
  if (!req.serviceAuth) return { ok: true };
  if (req.serviceAuth.platformInternal) return { ok: true };
  const callerTenant = req.serviceAuth.jurisdictionTenant;
  if (!callerTenant) return { ok: true };
  if (!resourceTenant) return { ok: false, error: "tenant_scope_denied" };
  if (callerTenant !== resourceTenant) {
    return { ok: false, error: "tenant_scope_denied" };
  }
  return { ok: true };
}
