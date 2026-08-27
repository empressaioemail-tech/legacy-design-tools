/**
 * Cortex / workbench client (A-039: no engine-api; service bearer only).
 */

const DEFAULT_TIMEOUT_MS = 30_000;

export type CortexClientConfig = {
  baseUrl: string;
  serviceApiKey: string;
};

export function loadCortexClientConfig(): CortexClientConfig | null {
  const baseUrl = process.env.CORTEX_API_BASE_URL?.trim();
  const serviceApiKey = process.env.SERVICE_API_KEY?.trim();
  if (!baseUrl || !serviceApiKey) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), serviceApiKey };
}

export async function cortexFetch(
  config: CortexClientConfig,
  path: string,
  init: RequestInit & { userId?: string } = {},
): Promise<Response> {
  const url = `${config.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${config.serviceApiKey}`);
  if (init.userId) {
    headers.set("X-PE-User-Id", init.userId);
  }
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, headers, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
