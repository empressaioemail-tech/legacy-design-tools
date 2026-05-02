/**
 * Public type contracts for {@link @workspace/mnml-client} v2.
 *
 * Implements the wire shape Spec 54 v2 §6.1 names. Supersedes the v1
 * types — which assumed mnml.ai accepted IFC/glb scene geometry against
 * a unified `/v1/renders` resource — with the actual production API
 * surface verified live against `mnmlai.dev/docs` on 2026-05-02:
 *
 *   - `POST /v1/archDiffusion-v43`  (multipart) — single image render
 *   - `POST /v1/video-ai`           (multipart) — Kling-backed video
 *   - `GET  /v1/status/{id}`                    — shared status poll
 *
 * Two `kind`-discriminated request shapes:
 *   - `archdiffusion` — one still image. The api-server route makes
 *     four separate `triggerRender` calls (with distinct
 *     `expertParams.camera_direction`) when the architect requests an
 *     elevation set; the client itself stays single-call.
 *   - `video`         — one 5- or 10-second clip. The video-thumbnail
 *     `render-output` row is server-synthesized post-`ready` via
 *     ffmpeg first-frame extraction; mnml does not return one.
 *
 * Output role taxonomy (`primary` / `elevation-{n,e,s,w}` /
 * `video-{primary,thumbnail}`) lives here for the api-server's
 * `render_outputs` row tagging — it is not a wire field. mnml's
 * `GET /v1/status/{id}` returns plain URLs in `message[]`; the route
 * assigns the role based on which call in the elevation-set fan-out
 * produced each output.
 */

/** Spec 54 v2 §2.1.1 `time_of_day` enum — useful as an `expertParams` value for the exterior expert. */
export type TimeOfDay = "dawn" | "morning" | "midday" | "evening" | "night";

/** Spec 54 v2 §2.1.1 `weather` enum — useful as an `expertParams` value for the exterior expert. */
export type Weather = "clear" | "overcast" | "stormy";

// ─────────────────────────────────────────────────────────────────────
// Render request union (Spec 54 v2 §6.1)
// ─────────────────────────────────────────────────────────────────────

/**
 * Spec 54 v2 §2.1 — `POST /v1/archDiffusion-v43`. Single still image.
 *
 * `expertParams` is the per-expert flat string→string bag that
 * mnml.ai's v4.3-Ultra endpoint accepts as form fields alongside the
 * documented `expert_name` / `render_style` / etc. The client passes
 * each entry through verbatim as a multipart field; it does NOT
 * validate against the per-expert allowed values. That validation is
 * the caller's contract — the api-server route owns the per-expert
 * enum-checking before constructing the request.
 */
export interface ArchDiffusionRequest {
  kind: "archdiffusion";
  /** JPEG/PNG/WebP, 1KB–15MB. Auto-resized server-side to 1344px width. */
  image: Buffer | Blob;
  /** Max 2000 chars per Spec 54 v2 §2.1. */
  prompt: string;
  expertName?:
    | "exterior"
    | "interior"
    | "masterplan"
    | "landscape"
    | "plan"
    | "product";
  renderStyle?:
    | "raw"
    | "photoreal"
    | "cgi_render"
    | "cad"
    | "freehand_sketch"
    | "clay_model"
    | "illustration"
    | "watercolor";
  geometry?: "precise" | "creative";
  viewMode?: "auto" | "manual";
  /**
   * Expert-specific form fields — `camera_angle`, `camera_direction`,
   * `time_of_day`, `weather`, `room_type`, etc. Passed through as
   * verbatim multipart fields; not validated by the client.
   */
  expertParams?: Record<string, string>;
  /** Up to 4 reference images per Spec 54 v2 §2.1. Extras are dropped. */
  referenceImages?: ReadonlyArray<Buffer | Blob>;
  /** 0..1,000,000. Random if omitted. */
  seed?: number;
}

/**
 * Spec 54 v2 §2.2 — `POST /v1/video-ai`. Single Kling v2.1 clip.
 *
 * `duration` is constrained to mnml's documented `5 | 10` per the
 * Video AI docs page; the client does not coerce other values, the
 * caller must pick one.
 */
export interface VideoAiRequest {
  kind: "video";
  /** JPG/PNG/GIF/WebP, max 10MB. */
  image: Buffer | Blob;
  prompt: string;
  /** Spec 54 v2 §2.2 — only `5` or `10` accepted. */
  duration: 5 | 10;
  cfgScale?: number;
  aspectRatio?: "16:9" | "4:3" | "1:1";
  negativePrompt?: string;
  movementType?: "horizontal" | "vertical" | "zoom_in" | "zoom_out" | "pan";
  direction?: "left" | "right" | "up" | "down";
  seed?: number;
}

export type RenderRequest = ArchDiffusionRequest | VideoAiRequest;

// ─────────────────────────────────────────────────────────────────────
// Status / Result
// ─────────────────────────────────────────────────────────────────────

/**
 * Codebase-internal render lifecycle. The wire vocabulary (`starting`
 * / `processing` / `success` / `failed` / `canceled`) is translated
 * inside {@link HttpMnmlClient} per Spec 54 v2 §3 — call sites
 * downstream of the client see only this set.
 */
export type RenderStatus =
  | "queued"
  | "rendering"
  | "ready"
  | "failed"
  | "cancelled";

/** {@link MnmlClient.triggerRender} return shape. */
export interface TriggerRenderResult {
  /** mnml-side render id; the api-server stamps this onto `viewpoint_renders.mnml_job_id`. */
  renderId: string;
  /**
   * The user's remaining credit balance after the deduction (mnml's
   * `credits` response field per Spec 54 v2 §2.1). The api-server
   * route surfaces this on the kickoff response so DA-RP-2 can
   * eventually display it; V1-4 itself does not render the value.
   * `-1` is the sentinel when mnml omits the field.
   */
  remainingCredits: number;
}

/**
 * {@link MnmlClient.getRenderStatus} return shape. `outputUrls` is the
 * raw `message[]` array mnml returns on `success` — caller-side role
 * tagging happens in the api-server route, since role is determined by
 * which call in an elevation-set fan-out produced each output rather
 * than by anything mnml carries on the wire.
 */
export interface RenderStatusResult {
  renderId: string;
  status: RenderStatus;
  /** Populated when status === "ready". Length ≥ 1. */
  outputUrls?: string[];
  /** Populated when mnml returned a seed. */
  seed?: number;
  /** Populated when status === "failed". `code` is mnml's error code (or a transport-bucket sentinel). */
  error?: { code: string; message: string };
}

/**
 * Persistence-layer role taxonomy. The api-server uses these as the
 * literal `render_outputs.role` enum.
 *
 * The four `elevation-*` slots are populated by the route's
 * elevation-set fan-out (one mnml call per cardinal direction). The
 * `video-thumbnail` slot is server-synthesized via ffmpeg post-`ready`
 * — mnml does not return a thumbnail.
 */
export type RenderOutputRole =
  | "primary"
  | "elevation-n"
  | "elevation-e"
  | "elevation-s"
  | "elevation-w"
  | "video-primary"
  | "video-thumbnail";

// ─────────────────────────────────────────────────────────────────────
// Errors (Spec 54 v2 §5)
// ─────────────────────────────────────────────────────────────────────

/**
 * Spec 54 v2 §5 — coarse error category surfaced on
 * `viewpoint-render.failed` events and inspected by route-level retry
 * / surfacing logic. Distinct remediation paths drive the bucketing:
 *
 *   - `validation`           — 400-family / invalid-image / oversize
 *   - `auth`                 — 401 missing/invalid api key
 *   - `insufficient_credits` — 403 NO_CREDITS / insufficient_credits
 *   - `not_found`            — 404 (e.g. unknown renderId on status poll)
 *   - `rate_limited`         — 429 with `details.retryAfterSeconds`
 *   - `unavailable`          — 5xx (transient, retry with backoff)
 *   - `transport`            — pre-mnml network/timeout failure
 */
export type MnmlErrorKind =
  | "validation"
  | "auth"
  | "insufficient_credits"
  | "not_found"
  | "rate_limited"
  | "unavailable"
  | "transport";

/**
 * Surfaced as the structured error reason on viewpoint-render.failed
 * events. `kind` is the coarse remediation bucket the UI branches on;
 * `code` is mnml's verbatim wire code (e.g. `NO_CREDITS`,
 * `IMAGE_TOO_LARGE`, `rate_limit_exceeded`) for support tracking;
 * `message` is the human-readable blurb the status pill renders;
 * `details` carries any structured payload mnml attached (e.g.
 * `available_credits` / `required_credits` for `insufficient_credits`,
 * `retryAfterSeconds` for `rate_limited`).
 */
export class MnmlError extends Error {
  constructor(
    public readonly kind: MnmlErrorKind,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MnmlError";
    Object.setPrototypeOf(this, MnmlError.prototype);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Client interface
// ─────────────────────────────────────────────────────────────────────

/**
 * The pluggable client both {@link MockMnmlClient} and
 * {@link HttpMnmlClient} satisfy.
 *
 * `cancelRender` is intentionally absent — mnml.ai exposes no public
 * cancel endpoint (Spec 54 v2 §6.1). Cancellation, when needed, is a
 * server-side concept tracked via a `viewpoint_renders.status =
 * 'cancelled'` transition; the api-server simply stops polling.
 */
export interface MnmlClient {
  triggerRender(input: RenderRequest): Promise<TriggerRenderResult>;
  getRenderStatus(renderId: string): Promise<RenderStatusResult>;
}

// ─────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────

/**
 * Minimal structured-logger contract the http client emits against.
 * Decoupled from any concrete logger so this lib doesn't pull in pino
 * (or force a dependency on `@workspace/api-server`'s logger
 * singleton). The api-server can pass its `req.log` / `logger` at
 * construction time; tests can pass a no-op or a spy.
 */
export interface MnmlLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** No-op logger used as the default when none is injected. */
export const noopMnmlLogger: MnmlLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
