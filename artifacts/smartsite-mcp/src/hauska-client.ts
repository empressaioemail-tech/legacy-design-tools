/**
 * Optional Hauska MCP client for export_instrument proxy (P-87 item 17).
 * Failure domain is tool-scoped: Hauska health never rolls into GET /health.
 */

const PROBE_TIMEOUT_MS = 2_000;

export type HauskaMcpConfig = {
  baseUrl: string;
  serviceKey?: string;
};

export type HauskaDepState = "ok" | "degraded" | "down" | "skipped";

export type HauskaDepHealth = {
  state: HauskaDepState;
  latency_ms: number | null;
  detail?: string;
};

export function loadHauskaMcpConfig(): HauskaMcpConfig | null {
  const baseUrl = process.env.HAUSKA_MCP_BASE_URL?.trim();
  if (!baseUrl) return null;
  const serviceKey = process.env.HAUSKA_MCP_SERVICE_KEY?.trim();
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    ...(serviceKey ? { serviceKey } : {}),
  };
}

export async function probeHauskaMcpHealth(
  config: HauskaMcpConfig | null = loadHauskaMcpConfig(),
): Promise<HauskaDepHealth> {
  if (!config) {
    return {
      state: "skipped",
      latency_ms: null,
      detail: "HAUSKA_MCP_BASE_URL not configured",
    };
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (config.serviceKey) {
      headers["X-Hauska-Key"] = config.serviceKey;
    }
    const res = await fetch(`${config.baseUrl}/health`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const latency = Date.now() - started;
    if (res.status >= 500) {
      return {
        state: "degraded",
        latency_ms: latency,
        detail: `HTTP ${res.status}`,
      };
    }
    return {
      state: "ok",
      latency_ms: latency,
      detail: `HTTP ${res.status}`,
    };
  } catch (err) {
    const latency = Date.now() - started;
    const detail = err instanceof Error ? err.message : "probe_failed";
    return { state: "down", latency_ms: latency, detail };
  } finally {
    clearTimeout(timer);
  }
}

export async function hauskaMcpFetch(
  config: HauskaMcpConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = `${config.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (config.serviceKey) {
    headers.set("X-Hauska-Key", config.serviceKey);
  }
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    return await fetch(url, { ...init, headers, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export function isHauskaMcpReachable(health: HauskaDepHealth): boolean {
  return health.state === "ok" || health.state === "degraded";
}
