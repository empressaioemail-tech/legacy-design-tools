/**
 * Public type contracts for {@link @workspace/mnml-client}. Mirrors
 * Spec 54 §3 (atom shape — `viewpoint-render` + `render-output`) and
 * §4 (output format taxonomy — still / elevation / video) verbatim so
 * downstream consumers (DA-RP-1's trigger endpoint, DA-RP-2's UI) can
 * import this once and avoid re-deriving the schema.
 *
 * The discriminated unions deliberately mirror the per-kind viewpoint
 * metadata fields Spec 54 §4 lists. Where Spec 54 tags a field
 * "(optional)", it is `?` here. Where Spec 54 lists a constrained
 * literal set (e.g. `framerate: 24 | 30 | 60`), the literal union is
 * preserved.
 *
 * If the Wave 2 Recon sprint surfaces a contradiction with Spec 54 §4
 * once it lands, refine the unions in place; the discriminator
 * (`kind`, `pathKind`) is the stable hinge.
 */

/** XYZ vector in world coordinates (units defined by the upstream BIM model). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Spec 54 §4 timeOfDay set — superset of all three render kinds. */
export type TimeOfDay = "dawn" | "morning" | "midday" | "evening" | "night";

/** Spec 54 §4 weather set — superset of all three render kinds. */
export type Weather = "clear" | "overcast" | "stormy";

/** Spec 54 §4 — still: a single photorealistic image from a viewpoint. */
export interface StillRenderRequest {
  kind: "still";
  cameraPosition: Vec3;
  cameraTarget: Vec3;
  /** Degrees. Spec 54 §4 default 35. */
  fieldOfView?: number;
  /** Free-form e.g. "1920x1080", "3840x2160", "1080x1080". */
  resolution: string;
  timeOfDay?: TimeOfDay;
  weather?: Weather;
}

/** Spec 54 §4 — elevation: north / east / south / west cardinal stills. */
export interface ElevationRenderRequest {
  kind: "elevation";
  buildingCenter: Vec3;
  /** Meters from buildingCenter along each cardinal axis. */
  cameraDistance: number;
  /** Meters above ground. */
  cameraHeight: number;
  resolution: string;
  /** Spec 54 §4 elevation excludes "night" — we keep the superset and let mnml.ai validate. */
  timeOfDay?: TimeOfDay;
  /** Spec 54 §4 elevation excludes "stormy" — we keep the superset and let mnml.ai validate. */
  weather?: Weather;
}

/** A single waypoint inside an interior-walkthrough video path. */
export interface VideoWaypoint {
  position: Vec3;
  target: Vec3;
  holdSeconds: number;
}

/** Spec 54 §4 — video path kinds. v1 supports the three preset paths. */
export type VideoPathKind =
  | "exterior-orbit"
  | "interior-walkthrough"
  | "fly-over";

/** Spec 54 §4 — durationSeconds capped at 60 in v1. */
export type VideoDurationSeconds = 10 | 20 | 30 | 60;

/** Spec 54 §4 — framerate set. */
export type VideoFramerate = 24 | 30 | 60;

interface VideoRenderRequestBase {
  kind: "video";
  durationSeconds: VideoDurationSeconds;
  resolution: string;
  framerate: VideoFramerate;
  /** Spec 54 §4 video excludes "dawn" / "night" — we keep the superset; mnml.ai validates. */
  timeOfDay?: TimeOfDay;
  weather?: Weather;
}

/** Spec 54 §4 — exterior-orbit: camera orbits buildingCenter at distance/height. */
export interface ExteriorOrbitVideoRequest extends VideoRenderRequestBase {
  pathKind: "exterior-orbit";
  buildingCenter?: Vec3;
  cameraDistance?: number;
  cameraHeight?: number;
}

/** Spec 54 §4 — interior-walkthrough: ordered waypoint list. */
export interface InteriorWalkthroughVideoRequest
  extends VideoRenderRequestBase {
  pathKind: "interior-walkthrough";
  waypoints?: VideoWaypoint[];
}

/** Spec 54 §4 — fly-over: entry + exit at altitude. */
export interface FlyOverVideoRequest extends VideoRenderRequestBase {
  pathKind: "fly-over";
  flyOverStart?: Vec3;
  flyOverEnd?: Vec3;
  flyOverAltitude?: number;
}

export type VideoRenderRequest =
  | ExteriorOrbitVideoRequest
  | InteriorWalkthroughVideoRequest
  | FlyOverVideoRequest;

/**
 * Top-level request union. The `kind` discriminator partitions the
 * three render kinds; the video kind nests `pathKind` for its three
 * preset paths.
 */
export type RenderRequest =
  | StillRenderRequest
  | ElevationRenderRequest
  | VideoRenderRequest;

/** Spec 54 §3 viewpoint-render lifecycle states. */
export type RenderStatus =
  | "queued"
  | "rendering"
  | "ready"
  | "failed"
  | "cancelled";

/** Spec 54 §3 render-output role discriminator. */
export type RenderOutputRole =
  | "primary"
  | "elevation-north"
  | "elevation-east"
  | "elevation-south"
  | "elevation-west"
  | "video-primary"
  | "video-thumbnail";

/** Spec 54 §3 render-output formats. */
export type RenderOutputFormat = "png" | "jpg" | "mp4" | "webm";

/**
 * One file produced by a render. Mirrors Spec 54 §3 render-output
 * sub-atom Layer 3 metrics so the persistence layer can hydrate
 * `render-output` rows directly off this shape.
 */
export interface RenderOutput {
  role: RenderOutputRole;
  /** Direct URL to the rendered asset on mnml.ai's CDN (or fixture host in mock mode). */
  url: string;
  format: RenderOutputFormat;
  /** e.g. "3840x2160". */
  resolution: string;
  /** Bytes — best-effort; mnml.ai may report 0 if unknown. */
  sizeBytes: number;
  /** Video only. */
  durationSeconds?: number;
  /** Optional preview URL (e.g. video-primary's poster frame). */
  thumbnailUrl?: string;
  /** mnml.ai-side output id for support tracking. */
  mnmlOutputId?: string;
}

/** {@link MnmlClient.triggerRender} return shape. */
export interface TriggerRenderResult {
  /** Client-stable render id; the api-server uses this as the mnmlJobId on the viewpoint-render atom. */
  renderId: string;
  /** Always `"queued"` on first acknowledgement — Spec 54 §5 async pattern. */
  status: "queued";
}

/** {@link MnmlClient.getRenderStatus} return shape. */
export interface RenderStatusResult {
  renderId: string;
  status: RenderStatus;
  /** Populated when status === "ready". */
  outputs?: RenderOutput[];
  /** Populated when status === "failed". */
  error?: { code: MnmlErrorCode; message: string };
}

/** {@link MnmlClient.cancelRender} return shape. */
export interface CancelRenderResult {
  renderId: string;
  status: "cancelled";
}

/**
 * Spec 54 §5 failure-handling categories collapsed into a coarse code
 * bucket. Mirrors the {@link ConverterError} pattern in
 * `artifacts/api-server/src/lib/converterClient.ts:57`: a stable code
 * the UI can branch on, plus a human-readable message the status pill
 * renders verbatim.
 *
 *   - `invalid_scene`   — scene geometry unprocessable (Spec 54 §5)
 *   - `quota_exceeded`  — mnml.ai-side rate limit (Spec 54 §5)
 *   - `timeout`         — render exceeded mnml.ai-side wall clock
 *   - `internal_error`  — anything else mnml.ai-side
 *   - `unavailable`     — network / transport failure before mnml.ai answered
 */
export type MnmlErrorCode =
  | "invalid_scene"
  | "quota_exceeded"
  | "timeout"
  | "internal_error"
  | "unavailable";

/**
 * Surfaced as the structured error reason on viewpoint-render.failed
 * events. `code` is the coarse bucket the UI branches on; `message`
 * is the human-readable blurb the status pill renders.
 */
export class MnmlError extends Error {
  constructor(
    public readonly code: MnmlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MnmlError";
    Object.setPrototypeOf(this, MnmlError.prototype);
  }
}

/**
 * The pluggable contract Spec 54 §5 names. Both {@link MockMnmlClient}
 * and {@link HttpMnmlClient} satisfy it; tests can swap one for the
 * other via {@link setMnmlClient}.
 */
export interface MnmlClient {
  triggerRender(input: RenderRequest): Promise<TriggerRenderResult>;
  getRenderStatus(renderId: string): Promise<RenderStatusResult>;
  cancelRender(renderId: string): Promise<CancelRenderResult>;
}

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
