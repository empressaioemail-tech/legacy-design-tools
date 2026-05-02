/**
 * Production HTTP client for mnml.ai. Speaks Spec 54 v2 §2's wire
 * contract verified live against `mnmlai.dev/docs` on 2026-05-02:
 *
 *   POST {baseUrl}/v1/archDiffusion-v43   — multipart, single image render
 *   POST {baseUrl}/v1/video-ai            — multipart, Kling 5/10s clip
 *   GET  {baseUrl}/v1/status/{id}         — shared status poll
 *
 * Auth: `Authorization: Bearer {apiKey}` on every request. Multipart
 * Content-Type is set by the runtime's FormData wiring (we MUST NOT
 * set it ourselves — fetch needs to mint the boundary).
 *
 * Status translation (Spec 54 v2 §3) lives here so consumers downstream
 * of the client never have to know about mnml's wire vocabulary
 * (`starting | processing | success | failed | canceled`):
 *
 *   starting   → queued
 *   processing → rendering
 *   success    → ready
 *   failed     → failed
 *   canceled   → cancelled    (note codebase spelling)
 *   {anything else} → rendering (defer to next poll; the unknown
 *                                value will likely resolve)
 *
 * Error mapping (Spec 54 v2 §5): the {@link MnmlError} `kind` is
 * derived from the HTTP status (and, for some buckets, the body's
 * `code`); the `code` field carries mnml's verbatim wire code
 * (`NO_CREDITS`, `IMAGE_TOO_LARGE`, etc.) for support tracking;
 * `details` passes through the body's structured payload.
 *
 * Per-attempt timeouts are operation-specific (Spec 54 v2 §6 calls
 * for 30 s on triggers and 10 s on status polls) — both are configurable.
 *
 * No retry policy at this layer in v1: Spec 54 v2 §2.3 names polling
 * as the v1 transition mechanism, and the polling cadence is itself
 * the retry surface for transient status fetches. Trigger calls are
 * one-shot.
 */

import {
  MnmlError,
  noopMnmlLogger,
  type ArchDiffusionRequest,
  type MnmlClient,
  type MnmlErrorKind,
  type MnmlLogger,
  type RenderRequest,
  type RenderStatus,
  type RenderStatusResult,
  type TriggerRenderResult,
  type VideoAiRequest,
} from "./types";

export interface HttpMnmlClientOptions {
  /** Base URL for the mnml.ai API, e.g. `"https://api.mnmlai.dev"`. No trailing slash required. */
  baseUrl: string;
  /** Bearer token; sent on every request as `Authorization: Bearer {apiKey}`. */
  apiKey: string;
  /**
   * Test-injectable fetch implementation. Mirrors the converter
   * client's `fetcher` option so tests can stub the network without
   * `vi.mock`-ing global fetch.
   */
  fetcher?: typeof fetch;
  /**
   * Per-attempt timeout for triggerRender. Default 30 s — Spec 54 v2
   * §6 names this as the trigger budget. (Triggers spend most of
   * their wall clock uploading the multipart image.)
   */
  triggerTimeoutMs?: number;
  /**
   * Per-attempt timeout for getRenderStatus. Default 10 s — Spec 54
   * v2 §6 names this as the poll budget. (Status polls are tiny.)
   */
  statusTimeoutMs?: number;
  /** Optional structured logger. Defaults to a no-op so tests stay quiet. */
  logger?: MnmlLogger;
}

interface MnmlTriggerResponseBody {
  status?: string;
  id?: string;
  prompt?: string;
  expert_name?: string;
  /** Spec 54 v2 §2.1 — user's remaining credit balance after deduction. */
  credits?: number;
  /** Spec 54 v2 §2.2 — video-ai also returns the seed inline. */
  seed?: number;
}

interface MnmlStatusResponseBody {
  status?: string;
  /** Spec 54 v2 §2.3 — output URL list on `success`. */
  message?: string[] | string;
  seed?: number;
  /** Verbatim engine error string on `failed`. */
  error?: string;
}

interface MnmlErrorResponseBody {
  status?: string;
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export class HttpMnmlClient implements MnmlClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly triggerTimeoutMs: number;
  private readonly statusTimeoutMs: number;
  private readonly logger: MnmlLogger;

  constructor(opts: HttpMnmlClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetcher ?? fetch;
    this.triggerTimeoutMs = opts.triggerTimeoutMs ?? 30_000;
    this.statusTimeoutMs = opts.statusTimeoutMs ?? 10_000;
    this.logger = opts.logger ?? noopMnmlLogger;
  }

  async triggerRender(input: RenderRequest): Promise<TriggerRenderResult> {
    const path =
      input.kind === "video" ? "/v1/video-ai" : "/v1/archDiffusion-v43";
    const url = `${this.baseUrl}${path}`;
    const form =
      input.kind === "video"
        ? buildVideoForm(input)
        : buildArchDiffusionForm(input);

    const startedAt = Date.now();
    const response = await this.doFetch(
      "POST",
      url,
      form,
      this.triggerTimeoutMs,
      "triggerRender",
    );
    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      const err = await mapErrorResponse(response);
      this.logger.warn(
        {
          op: "triggerRender",
          url,
          kind: input.kind,
          status: response.status,
          durationMs,
          mnmlKind: err.kind,
          code: err.code,
        },
        "mnml.ai trigger failed",
      );
      throw err;
    }

    const body = (await safeJson<MnmlTriggerResponseBody>(response)) ?? {};
    const renderId = body.id;
    if (!renderId) {
      const err = new MnmlError(
        "validation",
        "MISSING_ID",
        "mnml.ai trigger response had no id",
      );
      this.logger.warn(
        {
          op: "triggerRender",
          url,
          kind: input.kind,
          status: response.status,
          durationMs,
        },
        "mnml.ai trigger response malformed",
      );
      throw err;
    }
    // Spec 54 v2 §2.1 — `credits` is the post-deduction balance. `-1`
    // is the sentinel when mnml omits the field (e.g. video-ai docs
    // currently elide it on the success envelope; treat as unknown
    // rather than zero so callers can distinguish "we don't know" from
    // "you're out").
    const remainingCredits =
      typeof body.credits === "number" ? body.credits : -1;
    this.logger.info(
      {
        op: "triggerRender",
        url,
        kind: input.kind,
        status: response.status,
        durationMs,
        renderId,
        remainingCredits,
      },
      "mnml.ai trigger ok",
    );
    return { renderId, remainingCredits };
  }

  async getRenderStatus(renderId: string): Promise<RenderStatusResult> {
    const url = `${this.baseUrl}/v1/status/${encodeURIComponent(renderId)}`;
    const startedAt = Date.now();
    const response = await this.doFetch(
      "GET",
      url,
      null,
      this.statusTimeoutMs,
      "getRenderStatus",
    );
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
          mnmlKind: err.kind,
          code: err.code,
        },
        "mnml.ai status fetch failed",
      );
      throw err;
    }

    const body = (await safeJson<MnmlStatusResponseBody>(response)) ?? {};
    const status = translateStatus(body.status);
    const result: RenderStatusResult = { renderId, status };

    if (status === "ready") {
      // Spec 54 v2 §2.3 — `message` is `string[]` on success, but be
      // defensive in case mnml ever returns a single-string variant.
      const raw = body.message;
      result.outputUrls = Array.isArray(raw) ? raw : raw ? [raw] : [];
      if (typeof body.seed === "number") result.seed = body.seed;
    }
    if (status === "failed") {
      result.error = {
        code: "render_failed",
        message: body.error ?? "mnml.ai render failed",
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

  private async doFetch(
    method: "GET" | "POST",
    url: string,
    body: FormData | null,
    timeoutMs: number,
    op: "triggerRender" | "getRenderStatus",
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    // Intentionally do NOT set Content-Type for multipart bodies —
    // fetch sets it (with the multipart boundary) automatically.
    // Setting it manually breaks the boundary parameter and mnml
    // returns a `MISSING_IMAGE` 400.
    const startedAt = Date.now();
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        body: body ?? undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Transport-side failure (DNS, ECONN*, abort, timeout). Log
      // before translating to MnmlError so every attempt — happy or
      // not — emits exactly one structured record.
      const name = (err as { name?: string } | null)?.name;
      const durationMs = Date.now() - startedAt;
      const mnmlErr =
        name === "TimeoutError" || name === "AbortError"
          ? new MnmlError(
              "transport",
              "timeout",
              `mnml.ai did not respond within ${timeoutMs} ms`,
            )
          : new MnmlError(
              "transport",
              "network",
              `mnml.ai request failed: ${(err as Error).message}`,
            );
      this.logger.warn(
        {
          op,
          url,
          method,
          durationMs,
          mnmlKind: mnmlErr.kind,
          code: mnmlErr.code,
        },
        `mnml.ai ${op} transport failure`,
      );
      throw mnmlErr;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Form builders
// ─────────────────────────────────────────────────────────────────────

/**
 * Wrap Buffer/Blob into a Blob FormData accepts. TS 5.9 narrows the
 * Blob ctor's accept-set to `Uint8Array<ArrayBuffer>` (strict), while
 * `Buffer` is `Uint8Array<ArrayBufferLike>` (broader — could be a
 * `SharedArrayBuffer`-backed view). We copy into a fresh
 * `Uint8Array(byteLength)` whose backing is a freshly-allocated
 * non-shared `ArrayBuffer`, satisfying the strict variant without
 * any cast and without pulling in DOM lib for `BlobPart`.
 *
 * One byte copy per upload — image payloads are megabytes, the cost
 * is negligible against the network round-trip.
 */
function asFormBlob(image: Buffer | Blob): Blob {
  if (image instanceof Blob) return image;
  const copy = new Uint8Array(image.byteLength);
  copy.set(image);
  return new Blob([copy]);
}

function buildArchDiffusionForm(req: ArchDiffusionRequest): FormData {
  const form = new FormData();
  form.append("image", asFormBlob(req.image), "input.jpg");
  form.append("prompt", req.prompt);
  if (req.expertName) form.append("expert_name", req.expertName);
  if (req.renderStyle) form.append("render_style", req.renderStyle);
  if (req.geometry) form.append("geometry", req.geometry);
  if (req.viewMode) form.append("view_mode", req.viewMode);
  if (req.seed !== undefined) form.append("seed", String(req.seed));
  if (req.referenceImages) {
    // Spec 54 v2 §2.1 — `reference_image_1..4`. Extras silently dropped.
    req.referenceImages.slice(0, 4).forEach((img, i) => {
      form.append(`reference_image_${i + 1}`, asFormBlob(img));
    });
  }
  if (req.expertParams) {
    for (const [k, v] of Object.entries(req.expertParams)) {
      form.append(k, v);
    }
  }
  return form;
}

function buildVideoForm(req: VideoAiRequest): FormData {
  const form = new FormData();
  form.append("image", asFormBlob(req.image), "input.jpg");
  form.append("prompt", req.prompt);
  form.append("duration", String(req.duration));
  if (req.cfgScale !== undefined) form.append("cfg_scale", String(req.cfgScale));
  if (req.aspectRatio) form.append("aspect_ratio", req.aspectRatio);
  if (req.negativePrompt) form.append("negative_prompt", req.negativePrompt);
  if (req.movementType) form.append("movement_type", req.movementType);
  if (req.direction) form.append("direction", req.direction);
  if (req.seed !== undefined) form.append("seed", String(req.seed));
  return form;
}

// ─────────────────────────────────────────────────────────────────────
// Status + error mapping
// ─────────────────────────────────────────────────────────────────────

/** Spec 54 v2 §3 — mnml wire status → codebase status. */
function translateStatus(raw: string | undefined): RenderStatus {
  switch (raw) {
    case "starting":
      return "queued";
    case "processing":
      return "rendering";
    case "success":
      return "ready";
    case "failed":
      return "failed";
    case "canceled":
      return "cancelled";
    default:
      // Unknown status string → treat as still rendering rather than
      // poisoning the row. The next poll will likely return a known
      // value; if it persists, mnml.ai is sending us something Spec
      // 54 v2 didn't account for and the integration recon needs to
      // extend the map.
      return "rendering";
  }
}

/**
 * Spec 54 v2 §5 — HTTP status → MnmlErrorKind bucket. The body's
 * `code` field is preserved verbatim on the `MnmlError.code` field
 * for support tracking; `details` passes through whatever structured
 * payload mnml attached (e.g. `available_credits` / `required_credits`
 * for `insufficient_credits`).
 */
async function mapErrorResponse(response: Response): Promise<MnmlError> {
  const body = await safeJson<MnmlErrorResponseBody>(response);
  const code = body?.code ?? `HTTP_${response.status}`;
  const message =
    body?.message ??
    `mnml.ai returned ${response.status} ${response.statusText || ""}`.trim();
  const details = body?.details;

  let kind: MnmlErrorKind;
  if (response.status === 401) {
    kind = "auth";
  } else if (response.status === 403) {
    kind = "insufficient_credits";
  } else if (response.status === 404) {
    kind = "not_found";
  } else if (response.status === 429) {
    kind = "rate_limited";
  } else if (response.status >= 500) {
    kind = "unavailable";
  } else {
    // 4xx default — `validation` covers MISSING_IMAGE,
    // INVALID_IMAGE_TYPE, IMAGE_TOO_LARGE, MISSING_PROMPT,
    // invalid_request_id, etc.
    kind = "validation";
  }

  return details === undefined
    ? new MnmlError(kind, code, message)
    : new MnmlError(kind, code, message, details);
}

async function safeJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}
