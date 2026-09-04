/**
 * Optional Hauska MCP client for export_instrument proxy (P-87 item 17,
 * rewired P-110). Failure domain is tool-scoped: Hauska health never rolls
 * into GET /health.
 */

const PROBE_TIMEOUT_MS = 2_000;

/**
 * Real hauska-mcp-server JSON-RPC protocol version. Matches hauska-map's
 * proven `apps/property-explorer/api/_lib/mcp-server-client.ts` — that
 * client is already live against the deployed server; this one ports the
 * same handshake for smartsite-mcp's own service key (P-110).
 */
const HAUSKA_MCP_PROTOCOL_VERSION = "2025-03-26";

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

export function isHauskaMcpReachable(health: HauskaDepHealth): boolean {
  return health.state === "ok" || health.state === "degraded";
}

// ---------------------------------------------------------------------------
// Real MCP JSON-RPC tool calling (P-110).
//
// hauska-mcp-server serves MCP JSON-RPC on POST /mcp — no `/tools/*` REST
// route exists (A-074, measured 2026-09-02). This is the same Streamable
// HTTP handshake as hauska-map's already-live `ServerMcpClient`
// (apps/property-explorer/api/_lib/mcp-server-client.ts in that repo):
// initialize, notifications/initialized, then tools/call, with the session
// id echoed back on `mcp-session-id` and either a plain JSON or an SSE body.
// ---------------------------------------------------------------------------

interface HauskaJsonRpcMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: {
    content?: { type: string; text?: string }[];
    /** MCP tool-level error flag — forwarded, never swallowed. */
    isError?: boolean;
  } & Record<string, unknown>;
  error?: { message?: string; code?: number };
}

export type HauskaMcpToolResult = {
  /** Parsed JSON from the tool result's sole text content block. */
  data: Record<string, unknown>;
  isError: boolean;
};

function parseHauskaSseMessages(text: string): HauskaJsonRpcMessage[] {
  const messages: HauskaJsonRpcMessage[] = [];
  for (const block of text.replace(/\r\n/g, "\n").split("\n\n")) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        messages.push(JSON.parse(line.slice(5).trim()) as HauskaJsonRpcMessage);
      } catch {
        /* skip an unparsable SSE frame */
      }
    }
  }
  return messages;
}

/**
 * Minimal MCP Streamable HTTP client scoped to calling one tool at a time
 * against hauska-mcp-server. A fresh instance per `callHauskaMcpTool` call
 * mirrors hauska-map's proven per-request client — the upstream tools are
 * keyed on `parcel_node_id`/`format`, not on MCP session continuity, so
 * there is no correctness reason to share a session across the refresh and
 * download hops.
 */
export class HauskaMcpToolClient {
  private sessionId: string | null = null;
  private requestId = 1;
  private initialized = false;

  constructor(private readonly config: HauskaMcpConfig) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": HAUSKA_MCP_PROTOCOL_VERSION,
    };
    if (this.config.serviceKey) h["X-Hauska-Key"] = this.config.serviceKey;
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    return h;
  }

  private async post(body: unknown): Promise<HauskaJsonRpcMessage[]> {
    const res = await fetch(`${this.config.baseUrl}/mcp`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Hauska MCP HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    if (!text.trim()) return [];
    if (contentType.includes("text/event-stream") || text.includes("event:")) {
      return parseHauskaSseMessages(text);
    }
    try {
      const json = JSON.parse(text) as HauskaJsonRpcMessage | HauskaJsonRpcMessage[];
      return Array.isArray(json) ? json : [json];
    } catch {
      throw new Error(`Hauska MCP non-JSON response: ${text.slice(0, 160)}`);
    }
  }

  private async rpc(
    method: string,
    params: unknown,
  ): Promise<HauskaJsonRpcMessage["result"]> {
    const id = this.requestId++;
    const messages = await this.post({ jsonrpc: "2.0", id, method, params });
    const reply = messages.find((m) => m.id === id);
    if (reply?.error) {
      throw new Error(reply.error.message || JSON.stringify(reply.error));
    }
    return reply?.result;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.rpc("initialize", {
      protocolVersion: HAUSKA_MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "smartsite-mcp", version: "0.0.1" },
    });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.initialized = true;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<HauskaMcpToolResult> {
    await this.ensureInitialized();
    const result = await this.rpc("tools/call", { name, arguments: args });
    const text = result?.content?.find((c) => c.type === "text")?.text ?? "{}";
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { raw: text };
    }
    return { data, isError: result?.isError === true };
  }
}

/** One-shot convenience wrapper: construct a client, call one tool, done. */
export async function callHauskaMcpTool(
  config: HauskaMcpConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<HauskaMcpToolResult> {
  return new HauskaMcpToolClient(config).callTool(name, args);
}
