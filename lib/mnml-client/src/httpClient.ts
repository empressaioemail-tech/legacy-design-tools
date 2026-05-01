/**
 * Production HTTP client for mnml.ai. Speaks Spec 54 §5's wire
 * contract:
 *
 *   POST   {baseUrl}/v1/renders           — submit a job
 *   GET    {baseUrl}/v1/renders/{id}      — get status + outputs
 *   DELETE {baseUrl}/v1/renders/{id}      — cancel a queued / rendering job
 *
 * Auth: `Authorization: Bearer {apiKey}` on every request.
 *
 * Mirrors `HttpConverterClient`
 * (`artifacts/api-server/src/lib/converterClient.ts:213`) for:
 *   - per-attempt timeout via {@link AbortSignal.timeout}
 *   - structured logging on every attempt (success + failure)
 *   - {@link MnmlError} mapping that splits transport-side failures
 *     (`unavailable` / `timeout`) from mnml.ai-side failures
 *     (`invalid_scene` / `quota_exceeded` / `internal_error`)
 *
 * No retry policy at this layer in v1: Spec 54 §5 names polling as
 * the v1 transition mechanism, and the polling cadence (5 s → 15 s →
 * 60 s) is itself the retry surface for transient status fetches.
 * The trigger and cancel calls are one-shot; DA-RP-1 may layer a
 * retry policy on top once it has real failure-mode data from Wave 2
 * Recon.
 *
 * TODO(wave-2-recon): Spec 54 §5's endpoint shapes are inferred from
 * typical render-API patterns, not from mnml.ai's actual docs. The
 * Wave 2 Recon sprint validates and, if needed, the request /
 * response payload mappers below adapt while keeping the public
 * {@link MnmlClient} contract stable.
 */

import {
  MnmlError,
  noopMnmlLogger,
  type CancelRenderResult,
  type MnmlClient,
  type MnmlErrorCode,
  type MnmlLogger,
  type RenderOutput,
  type RenderRequest,
  type RenderStatus,
  type RenderStatusResult,
  type TriggerRenderResult,
} from "./types";

export interface HttpMnmlClientOptions {
  /** Base URL for the mnml.ai API, e.g. `"https://api.mnml.ai"`. No trailing slash required. */
  baseUrl: string;
  /** Bearer token; sent on every request as `Authorization: Bearer {apiKey}`. */
  apiKey: string;
  /**
   * Test-injectable fetch implementation. Mirrors
   * {@link createAnthropicClient}'s `fetcher` option so tests can
   * stub the network without `vi.mock`-ing global fetch.
   */
  fetcher?: typeof fetch;
  /** Per-attempt timeout. Default 30 s (matches `HttpConverterClient`). */
  timeoutMs?: number;
  /** Optional structured logger. Defaults to a no-op so tests stay quiet. */
  logger?: MnmlLogger;
}

interface MnmlErrorBody {
  error?: { code?: string; message?: string };
}

interface MnmlTriggerResponseBody {
  // TODO(wave-2-recon): mnml.ai may use `id` or `job_id` or `render_id` —
  // verify and adjust. The accessor in `extractRenderId` accepts all three.
  id?: string;
  job_id?: string;
  render_id?: string;
  status?: string;
}

interface MnmlOutputBody {
  role?: string;
  url?: string;
  format?: string;
  resolution?: string;
  size_bytes?: number;
  duration_seconds?: number;
  thumbnail_url?: string;
  output_id?: string;
}

interface MnmlStatusResponseBody {
  id?: string;
  job_id?: string;
  render_id?: string;
  status?: string;
  outputs?: MnmlOutputBody[];
  error?: { code?: string; message?: string };
}

export class HttpMnmlClient implements MnmlClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly logger: MnmlLogger;

  constructor(opts: HttpMnmlClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetcher ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.logger = opts.logger ?? noopMnmlLogger;
  }

  async triggerRender(input: RenderRequest): Promise<TriggerRenderResult> {
    const url = `${this.baseUrl}/v1/renders`;
    const startedAt = Date.now();
    const response = await this.doFetch(
      "POST",
      url,
      "triggerRender",
      JSON.stringify(input),
    );
    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      const err = await mapErrorResponse(response);
      this.logger.warn(
        {
          op: "triggerRender",
          url,
          status: response.status,
          durationMs,
          code: err.code,
          err,
        },
        "mnml.ai trigger failed",
      );
      throw err;
    }

    const body = (await safeJson<MnmlTriggerResponseBody>(response)) ?? {};
    const renderId = extractRenderId(body);
    if (!renderId) {
      const err = new MnmlError(
        "internal_error",
        "mnml.ai trigger response missing renderId",
      );
      this.logger.warn(
        {
          op: "triggerRender",
          url,
          status: response.status,
          durationMs,
          code: err.code,
        },
        "mnml.ai trigger response malformed",
      );
      throw err;
    }
    this.logger.info(
      {
        op: "triggerRender",
        url,
        status: response.status,
        durationMs,
        renderId,
      },
      "mnml.ai trigger ok",
    );
    return { renderId, status: "queued" };
  }

  async getRenderStatus(renderId: string): Promise<RenderStatusResult> {
    const url = `${this.baseUrl}/v1/renders/${encodeURIComponent(renderId)}`;
    const startedAt = Date.now();
    const response = await this.doFetch("GET", url, "getRenderStatus");
    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      const err = await mapErrorResponse(response);
      this.logger.warn(
        {
          op: "getRenderStatus",
          url,
          renderId,
          status: response.status,
          durationMs,
          code: err.code,
          err,
        },
        "mnml.ai status fetch failed",
      );
      throw err;
    }

    const body = (await safeJson<MnmlStatusResponseBody>(response)) ?? {};
    const status = mapStatus(body.status);
    const result: RenderStatusResult = {
      renderId,
      status,
    };
    if (status === "ready" && body.outputs) {
      result.outputs = body.outputs.map(mapOutput);
    }
    if (status === "failed" && body.error) {
      result.error = {
        code: mapErrorCode(body.error.code),
        message: body.error.message ?? "mnml.ai render failed",
      };
    }
    this.logger.info(
      {
        op: "getRenderStatus",
        url,
        renderId,
        status: response.status,
        renderStatus: status,
        durationMs,
      },
      "mnml.ai status fetch ok",
    );
    return result;
  }

  async cancelRender(renderId: string): Promise<CancelRenderResult> {
    const url = `${this.baseUrl}/v1/renders/${encodeURIComponent(renderId)}`;
    const startedAt = Date.now();
    const response = await this.doFetch("DELETE", url, "cancelRender");
    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      const err = await mapErrorResponse(response);
      this.logger.warn(
        {
          op: "cancelRender",
          url,
          renderId,
          status: response.status,
          durationMs,
          code: err.code,
          err,
        },
        "mnml.ai cancel failed",
      );
      throw err;
    }
    this.logger.info(
      {
        op: "cancelRender",
        url,
        renderId,
        status: response.status,
        durationMs,
      },
      "mnml.ai cancel ok",
    );
    return { renderId, status: "cancelled" };
  }

  private async doFetch(
    method: "GET" | "POST" | "DELETE",
    url: string,
    op: "triggerRender" | "getRenderStatus" | "cancelRender",
    body?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const startedAt = Date.now();
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Transport-side failure (DNS, ECONN*, abort, timeout). Log
      // before translating to MnmlError so every attempt — happy or
      // not — emits exactly one structured record. Mirrors
      // HttpConverterClient's per-attempt logging contract.
      const name = (err as { name?: string } | null)?.name;
      const durationMs = Date.now() - startedAt;
      const mnmlErr =
        name === "TimeoutError" || name === "AbortError"
          ? new MnmlError(
              "timeout",
              `mnml.ai did not respond within ${this.timeoutMs} ms`,
            )
          : new MnmlError(
              "unavailable",
              `mnml.ai request failed: ${(err as Error).message}`,
            );
      this.logger.warn(
        {
          op,
          url,
          method,
          durationMs,
          code: mnmlErr.code,
          err: mnmlErr,
        },
        `mnml.ai ${op} transport failure`,
      );
      throw mnmlErr;
    }
  }
}

function extractRenderId(body: MnmlTriggerResponseBody): string | null {
  return body.id ?? body.render_id ?? body.job_id ?? null;
}

/** Maps mnml.ai's status string onto our discriminated set. */
function mapStatus(raw: string | undefined): RenderStatus {
  switch (raw) {
    case "queued":
    case "pending":
      return "queued";
    case "rendering":
    case "processing":
    case "running":
      return "rendering";
    case "ready":
    case "complete":
    case "succeeded":
      return "ready";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      // Unknown status string → treat as still rendering rather than
      // poisoning the row. The next poll will likely return a known
      // value; if it persists, mnml.ai is sending us something Spec 54
      // didn't account for and Wave 2 Recon needs to extend the map.
      return "rendering";
  }
}

function mapOutput(raw: MnmlOutputBody): RenderOutput {
  return {
    role: (raw.role as RenderOutput["role"]) ?? "primary",
    url: raw.url ?? "",
    format: (raw.format as RenderOutput["format"]) ?? "png",
    resolution: raw.resolution ?? "",
    sizeBytes: raw.size_bytes ?? 0,
    ...(raw.duration_seconds !== undefined
      ? { durationSeconds: raw.duration_seconds }
      : {}),
    ...(raw.thumbnail_url !== undefined
      ? { thumbnailUrl: raw.thumbnail_url }
      : {}),
    ...(raw.output_id !== undefined ? { mnmlOutputId: raw.output_id } : {}),
  };
}

/**
 * Maps mnml.ai's response status + body onto a {@link MnmlError}.
 * Spec 54 §5 names the four mnml.ai-side failure categories
 * (invalid-scene / quota-exceeded / timeout / internal-error); we
 * derive the bucket from the response status and, if present, the
 * body's `error.code` field.
 */
async function mapErrorResponse(response: Response): Promise<MnmlError> {
  const body = await safeJson<MnmlErrorBody>(response);
  const bodyCode = body?.error?.code;
  const bodyMessage = body?.error?.message;

  let code: MnmlErrorCode;
  if (bodyCode) {
    code = mapErrorCode(bodyCode);
  } else if (response.status === 429) {
    code = "quota_exceeded";
  } else if (response.status === 408 || response.status === 504) {
    code = "timeout";
  } else if (response.status >= 400 && response.status < 500) {
    code = "invalid_scene";
  } else {
    code = "internal_error";
  }

  const message =
    bodyMessage ??
    `mnml.ai returned ${response.status} ${response.statusText || ""}`.trim();
  return new MnmlError(code, message);
}

/** Maps mnml.ai's textual error code onto our coarse bucket. */
function mapErrorCode(raw: string | undefined): MnmlErrorCode {
  if (!raw) return "internal_error";
  // Accept hyphen + underscore variants — mnml.ai spec drift insurance.
  const normalized = raw.toLowerCase().replace(/-/g, "_");
  switch (normalized) {
    case "invalid_scene":
    case "scene_invalid":
    case "bad_request":
      return "invalid_scene";
    case "quota_exceeded":
    case "rate_limited":
    case "too_many_requests":
      return "quota_exceeded";
    case "timeout":
    case "timed_out":
      return "timeout";
    case "internal_error":
    case "server_error":
      return "internal_error";
    case "unavailable":
    case "service_unavailable":
      return "unavailable";
    default:
      return "internal_error";
  }
}

async function safeJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}
