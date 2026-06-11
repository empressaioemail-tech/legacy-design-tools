/**
 * Spine engine-api HTTP client (C1 cut).
 *
 * cortex-api calls hauska-engine `engine-api` using the gate-front seam
 * contract: service bearer + X-Hauska-* context headers. During transition
 * cortex-api constructs the gate-front context from the inbound request's
 * jurisdiction tenant resolution — the same partition the MCP gate would
 * forward on a service call.
 *
 * See `hauska-engine/services/engine-api/docs/gate-front-seam.md`.
 */

import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { logger } from "./logger";
import { resolveRequestJurisdictionTenant } from "./gateFrontSeam";

/** Gate-front header names (canonical contract). */
export const SPINE_GATE_HEADERS = {
  product: "x-hauska-product",
  tenantId: "x-hauska-tenant-id",
  packageId: "x-hauska-package-id",
  accessTier: "x-hauska-access-tier",
  credentialId: "x-hauska-gate-credential-id",
  requestId: "x-hauska-request-id",
  subjectId: "x-hauska-subject-id",
} as const;

export type SpineEnginePackage =
  | "plan-review"
  | "briefing"
  | "site-context"
  | "hydrology";

export interface SpineGateFrontContext {
  product: "cortex";
  tenantId: string;
  packageId: SpineEnginePackage;
  accessTier: "platform-internal" | "public-free" | "public-paid" | "tenant-private";
  gateCredentialId: string;
  requestId: string;
  subjectId?: string;
}

export class EngineSpineError extends Error {
  constructor(
    public readonly code:
      | "engine_api_unreachable"
      | "engine_api_unauthorized"
      | "engine_api_rejected"
      | "engine_api_invalid_response"
      | "engine_api_not_configured",
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "EngineSpineError";
  }
}

function engineApiBaseUrl(): string | null {
  const raw = process.env.ENGINE_API_URL?.trim();
  return raw && raw.length > 0 ? raw.replace(/\/$/, "") : null;
}

function engineApiGateToken(): string {
  return process.env.ENGINE_API_GATE_TOKEN?.trim() ?? "";
}

export function isEngineSpineConfigured(): boolean {
  return Boolean(engineApiBaseUrl());
}

/**
 * Build gate-front context for an outbound engine-api call from the
 * active cortex-api request + the authorized package surface.
 */
export function buildSpineGateFrontContextFromTenant(args: {
  packageId: SpineEnginePackage;
  jurisdictionTenant: string | null;
  accessTier?: SpineGateFrontContext["accessTier"];
  subjectId?: string;
}): SpineGateFrontContext {
  return {
    product: "cortex",
    tenantId: args.jurisdictionTenant ?? "default",
    packageId: args.packageId,
    accessTier: args.accessTier ?? "platform-internal",
    gateCredentialId: "cortex-api-bff",
    requestId: randomUUID(),
    subjectId: args.subjectId,
  };
}

export function buildSpineGateFrontContext(
  req: Request,
  args: {
    packageId: SpineEnginePackage;
    jurisdictionTenant: string | null;
    accessTier?: SpineGateFrontContext["accessTier"];
  },
): SpineGateFrontContext {
  const tenantId =
    args.jurisdictionTenant ??
    resolveRequestJurisdictionTenant(req) ??
    "default";

  const subjectId = req.session?.requestor?.id;

  return buildSpineGateFrontContextFromTenant({
    ...args,
    jurisdictionTenant: tenantId,
    subjectId,
  });
}

function gateFrontToHeaders(ctx: SpineGateFrontContext): Record<string, string> {
  const headers: Record<string, string> = {
    [SPINE_GATE_HEADERS.product]: ctx.product,
    [SPINE_GATE_HEADERS.tenantId]: ctx.tenantId,
    [SPINE_GATE_HEADERS.packageId]: ctx.packageId,
    [SPINE_GATE_HEADERS.accessTier]: ctx.accessTier,
    [SPINE_GATE_HEADERS.credentialId]: ctx.gateCredentialId,
    [SPINE_GATE_HEADERS.requestId]: ctx.requestId,
    "content-type": "application/json",
  };
  const token = engineApiGateToken();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  if (ctx.subjectId) {
    headers[SPINE_GATE_HEADERS.subjectId] = ctx.subjectId;
  }
  return headers;
}

export interface SpinePostOptions {
  path: string;
  body: unknown;
  gateFront: SpineGateFrontContext;
  timeoutMs?: number;
}

export async function postEngineSpine<T>(options: SpinePostOptions): Promise<T> {
  const base = engineApiBaseUrl();
  if (!base) {
    throw new EngineSpineError(
      "engine_api_not_configured",
      "ENGINE_API_URL is not set",
    );
  }

  const url = `${base}${options.path.startsWith("/") ? options.path : `/${options.path}`}`;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: gateFrontToHeaders(options.gateFront),
      body: JSON.stringify(options.body),
      signal: controller.signal,
    });

    const text = await res.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new EngineSpineError(
        "engine_api_invalid_response",
        `engine-api returned non-JSON (${res.status}): ${text.slice(0, 200)}`,
        res.status,
      );
    }

    if (res.status === 401) {
      throw new EngineSpineError(
        "engine_api_unauthorized",
        "engine-api rejected bearer or gate-front context",
        401,
      );
    }

    if (!res.ok) {
      const msg =
        typeof payload === "object" &&
        payload !== null &&
        "message" in payload &&
        typeof (payload as { message: unknown }).message === "string"
          ? (payload as { message: string }).message
          : text.slice(0, 300);
      throw new EngineSpineError(
        "engine_api_rejected",
        `engine-api ${res.status}: ${msg}`,
        res.status,
      );
    }

    return payload as T;
  } catch (err) {
    if (err instanceof EngineSpineError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new EngineSpineError(
        "engine_api_unreachable",
        `engine-api did not respond within ${timeoutMs} ms`,
      );
    }
    throw new EngineSpineError(
      "engine_api_unreachable",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Human-readable failure for consumers when engine-api is unreachable.
 * Never returns empty success — callers map this to failed-run / 502 states.
 */
export function formatEngineSpineFailure(err: unknown): {
  code: EngineSpineError["code"] | "engine_api_unknown";
  message: string;
} {
  if (err instanceof EngineSpineError) {
    return { code: err.code, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: "engine_api_unknown", message };
}

/** Boot-time fail-fast: cortex-api BFF requires a configured engine-api home. */
export function validateEngineSpineEnvAtBoot(): void {
  if (!engineApiBaseUrl()) {
    throw new Error(
      "ENGINE_API_URL is required — cortex-api routes all reasoning through spine engine-api",
    );
  }

  logger.info(
    { engineApiUrl: engineApiBaseUrl(), spineFlags: "unconditional" },
    "engine spine: cortex-api BFF — all reasoning via engine-api",
  );
}
