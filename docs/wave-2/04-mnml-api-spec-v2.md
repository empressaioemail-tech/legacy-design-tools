# Spec 54 v2 — mnml.ai integration spec

**Status:** Source of truth for V1-4 (DA-RP-1). Supersedes
`docs/wave-2/01-mnml-integration-recon.md`, which was directionally
correct but written against an earlier API surface that no longer matches
production. The recon doc remains in repo for historical reference; do
not implement against it.

**Scope:** Defines the wire contract V1-4 must implement against, the
proposed `MnmlClient` TypeScript surface, the status-name translation
table, error mapping, cost handling, and migration notes from the
current `lib/mnml-client/src/types.ts` shape.

**Non-goals:** This spec does not redesign the atom graph, the
`viewpoint_renders` schema, or the freshness mechanic (Spec 54 §6) —
those remain as defined in the existing wave-2 recon and the V1-4
recon report. This spec only fixes the wire layer.

**Generated:** 2026-05-02. Verified live against
[mnmlai.dev/docs](https://mnmlai.dev/docs) on the same day.

---

## 1. Base URL and authentication

- **Base URL:** `https://api.mnmlai.dev`
- **Authentication:** `Authorization: Bearer <MNML_API_KEY>` on every
  request. No OAuth, no signed-request mechanism, no IP allowlist
  visible in the docs.
- **Content type for uploads:** `multipart/form-data`. The `image`
  field carries the raw bytes; all other params are form fields, not
  JSON body.
- **Response content type:** `application/json` for all endpoints we
  consume.
- **Env var:** `MNML_API_KEY` (existing convention from
  `validateMnmlEnvAtBoot`). `MNML_API_URL` defaults to the production
  base URL above; override only for staging if/when mnml exposes one.

## 2. Endpoints we consume

V1-4 uses three endpoints. A fourth (`GET /v1/credits` — name to
confirm at first integration) is documented in the docs index as
"Remaining Credits" and may be useful for the cost-display affordance,
but is not strictly required by V1-4.

### 2.1 `POST /v1/archDiffusion-v43` — render engine (v4.3-Ultra)

The unified render endpoint. Replaces the per-capability v3.1 endpoints
(`/v1/exterior`, `/v1/interior`, etc.) the previous recon doc assumed.

**Request:** `multipart/form-data`

| Field | Type | Required | Notes |
|---|---|---|---|
| `image` | File | yes | JPEG, PNG, or WebP. 1KB–15MB. Auto-resized to 1344px width. |
| `prompt` | String | yes | Max 2000 chars. |
| `expert_name` | String | no (default `exterior`) | `exterior \| interior \| masterplan \| landscape \| plan \| product` |
| `render_style` | String | no (default `photoreal`) | `raw \| photoreal \| cgi_render \| cad \| freehand_sketch \| clay_model \| illustration \| watercolor` |
| `geometry` | String | no (default `precise`) | `precise \| creative` |
| `view_mode` | String | no (default `auto`) | `auto \| manual` |
| `seed` | Number | no | 0–1,000,000. Random if omitted. |
| `reference_image_1..4` | File | no | Optional style reference images. |
| Expert-specific params | String | no | See §2.1.1 |

**§2.1.1 Expert-specific params (exterior, the case V1-4 cares about):**

`camera_angle` (`auto | eye_level | elevation | low | elevated | aerial | top_down | close_up`),
`camera_direction` (`front | corner_right | right | back | left | corner_left`),
`site_context`, `greenery`, `vehicles`, `people`, `street_props`,
`motion`, `time_of_day`, `weather`, `ground_wetness`. Full enumerations
in mnml's v4.3-Ultra docs.

**Response (200):**

```json
{
  "status": "success",
  "id": "vysqf2nr0drmc0ctqx5tkdse48",
  "prompt": "...",
  "expert_name": "exterior",
  "parameters": { "expertType": "exterior", "renderStyle": "photoreal", ... },
  "credits": 96
}
```

`id` is the request ID for status polling. `credits` is the user's
remaining credit balance after the deduction. **Cost:** 3 credits per
generation, deducted at request time.

### 2.2 `POST /v1/video-ai` — video render (Kling v2.1 pro mode)

**Request:** `multipart/form-data`

| Field | Type | Required | Notes |
|---|---|---|---|
| `image` | File | yes | JPG, PNG, GIF, WebP. Max 10MB. |
| `prompt` | String | yes | Description of motion. |
| `duration` | Number | no (default 10) | **Only `5` or `10` accepted.** |
| `cfg_scale` | Number | no (default 0.5) | Higher = more prompt adherence. |
| `aspect_ratio` | String | no (default `16:9`) | `16:9 \| 4:3 \| 1:1` |
| `negative_prompt` | String | no | Elements to exclude. |
| `movement_type` | String | no (default `horizontal`) | `horizontal \| vertical \| zoom_in \| zoom_out \| pan` |
| `direction` | String | no (default `left`) | `left \| right \| up \| down` |
| `seed` | Number | no | Reproducibility. |

**Response (200):**

```json
{
  "status": "success",
  "id": "b09ssvpzzhrj00cmzt1bykjzp1",
  "seed": 123456,
  "prompt": "..."
}
```

**Cost:** 10 credits per video.

### 2.3 `GET /v1/status/{id}` — shared status poll

The single status endpoint for both archdiffusion and video-ai
generations.

**Response shapes:**

```json
{ "status": "starting" }
{ "status": "processing" }
{
  "status": "success",
  "message": [
    "https://api.mnmlai.dev/v1/images/yhqm//.png"
  ],
  "seed": 453463
}
{ "status": "failed", "error": "..." }
{ "status": "canceled" }
```

`message` on success is `string[]` — typically length 1 for stills
and videos, but treat as variable. Output URLs are scoped/signed and
**will expire**; mirror to object storage on first observation of
`success`.

**Polling cadence:** mnml recommends 3–5 seconds. Implement exponential
backoff capped at 5s for the steady state. Typical processing time:
30–60s for v4.3-Ultra renders, longer for video.

## 3. Status state translation

mnml's wire vocabulary differs from the codebase's. The
`HttpMnmlClient` is responsible for translating; consumers (api-server
routes, atom contextSummary) only see the codebase-internal vocabulary.

| mnml wire status | Codebase status |
|---|---|
| `starting` | `queued` |
| `processing` | `rendering` |
| `success` | `ready` |
| `failed` | `failed` |
| `canceled` | `cancelled` (note spelling) |

The codebase's existing `RenderStatus` union (`queued | rendering | ready
| failed | cancelled`) stays as-is. No call site downstream of
`HttpMnmlClient` needs to know about mnml's wire names.

## 4. Cost handling — static, no quote method

The current `mnml-client` interface has no `quoteRender` method, and
**this spec does not add one.** Costs are static:

| Operation | Credits |
|---|---:|
| `archDiffusion-v43` (any expert) | 3 |
| `video-ai` | 10 |

Computing the cost of a render request is a pure function of
`request.kind`. For an "elevation set" (one viewpoint_render that
fans out to four `archDiffusion-v43` calls — see §6.2), cost is 4 × 3
= 12 credits.

Display the cost in the trigger UI by computing it client-side from
the same constants. After the API call succeeds, the response's
`credits` field gives the post-deduction balance, which the UI may
surface to confirm. The optional `GET /v1/credits` endpoint can be
used at session start to display the running balance, but is not
required for V1-4.

**Insufficient credits:** `403` with
`code: "insufficient_credits"` (or, on archdiffusion specifically,
`code: "NO_CREDITS"` per the v4.3 docs — see §5). The trigger route
should surface this to the architect with the credit gap from
`details.required_credits` and `details.available_credits`.

## 5. Error mapping

mnml errors follow a uniform shape:

```json
{
  "status": "error",
  "code": "",
  "message": "",
  "details": { ... }
}
```

| HTTP status | Code (examples) | Codebase mapping |
|---|---|---|
| 400 | `MISSING_IMAGE`, `MISSING_PROMPT`, `IMAGE_TOO_LARGE`, `INVALID_IMAGE_TYPE`, `invalid_request_id` | `MnmlError("validation", code, message)` |
| 401 | `missing_api_key`, `invalid_api_key`, `UNAUTHORIZED` | `MnmlError("auth", code, message)` |
| 403 | `NO_CREDITS`, `insufficient_credits` | `MnmlError("insufficient_credits", code, message, { required, available })` |
| 404 | `resource_not_found` | `MnmlError("not_found", code, message)` |
| 429 | `rate_limit_exceeded` | `MnmlError("rate_limited", code, message, { retryAfterSeconds })` |
| 5xx | `internal_server_error`, `service_unavailable` | `MnmlError("unavailable", code, message)` |
| Transport (timeout, network) | — | `MnmlError("transport", "timeout" \| "network", message)` |

The current `MnmlError` enum in `types.ts` (`unavailable | timeout | ...`)
expands to cover the new buckets. Existing call sites checking for
`unavailable` and `timeout` continue to work — those are subset matches.

## 6. Codebase migration

### 6.1 New `MnmlClient` interface

```typescript
// lib/mnml-client/src/types.ts (proposed v2 shape)

export interface MnmlClient {
  triggerRender(input: RenderRequest): Promise;
  getRenderStatus(renderId: string): Promise;
  // cancelRender removed — mnml has no public cancel endpoint.
  // Cancellation, if needed, becomes a server-side concept tracked
  // on viewpoint_renders rows with a status='cancelled' transition.
}

export interface ArchDiffusionRequest {
  kind: "archdiffusion";
  image: Buffer | Blob;
  prompt: string;
  expertName?: "exterior" | "interior" | "masterplan" | "landscape" | "plan" | "product";
  renderStyle?: "raw" | "photoreal" | "cgi_render" | "cad" | "freehand_sketch" | "clay_model" | "illustration" | "watercolor";
  geometry?: "precise" | "creative";
  viewMode?: "auto" | "manual";
  /**
   * Expert-specific params (e.g., camera_angle, time_of_day for
   * exterior; room_type, room_style for interior). Passed through
   * verbatim as form fields. The client does not validate against
   * the per-expert allowed values — that's the caller's contract.
   */
  expertParams?: Record;
  referenceImages?: Array;  // up to 4
  seed?: number;
}

export interface VideoAiRequest {
  kind: "video";
  image: Buffer | Blob;
  prompt: string;
  duration: 5 | 10;
  cfgScale?: number;
  aspectRatio?: "16:9" | "4:3" | "1:1";
  negativePrompt?: string;
  movementType?: "horizontal" | "vertical" | "zoom_in" | "zoom_out" | "pan";
  direction?: "left" | "right" | "up" | "down";
  seed?: number;
}

export type RenderRequest = ArchDiffusionRequest | VideoAiRequest;

export interface TriggerRenderResult {
  renderId: string;
  remainingCredits: number;  // from response.credits
}

export type RenderStatus =
  | "queued"
  | "rendering"
  | "ready"
  | "failed"
  | "cancelled";

export interface RenderStatusResult {
  renderId: string;
  status: RenderStatus;
  /** Present on `ready`. Length ≥ 1 for stills/videos. */
  outputUrls?: string[];
  /** Present on `ready` if mnml returned one. */
  seed?: number;
  /** Present on `failed`. */
  error?: { code: string; message: string };
}

export type RenderOutputRole =
  | "primary"
  | "elevation-n"
  | "elevation-e"
  | "elevation-s"
  | "elevation-w"
  | "video-primary"
  | "video-thumbnail";

export type MnmlErrorKind =
  | "validation"
  | "auth"
  | "insufficient_credits"
  | "not_found"
  | "rate_limited"
  | "unavailable"
  | "transport";

export class MnmlError extends Error {
  constructor(
    public readonly kind: MnmlErrorKind,
    public readonly code: string,
    message: string,
    public readonly details?: Record,
  ) {
    super(message);
  }
}
```

### 6.2 Elevation set: orchestration moves out of the client

The previous types treated "elevation set" as a single render kind.
v4.3-Ultra produces one image per call. The cleanest split:

- `MnmlClient` stays single-call. Each `triggerRender` invocation is
  one mnml API call producing one output URL on `ready`.
- The api-server's renders route, when the architect requests an
  "elevation set" viewpoint, makes 4 separate `triggerRender` calls
  (with `expertParams.camera_direction` set to `front`, `right`,
  `back`, `left` respectively), creates **one** `viewpoint_renders`
  row, and inserts 4 `render_outputs` rows tagged with roles
  `elevation-n` / `elevation-e` / `elevation-s` / `elevation-w` once
  each call's status hits `ready`.
- The single-call simplification means the http client doesn't need
  to know about render-set semantics. That logic lives in the route.

For "still" the client makes 1 call → 1 `viewpoint_renders` row → 1
`render_outputs` row (`primary`). For "video" the client makes 1 call
→ 1 `viewpoint_renders` row → 1 `render_outputs` row
(`video-primary`); the `video-thumbnail` role is server-synthesized
post-`ready` via ffmpeg first-frame extraction (mnml does not
return a thumbnail).

### 6.3 Output mirror is V1-4's responsibility

mnml's output URLs expire. On a status transition to `ready`, the
api-server route must:

1. Fetch each URL in `outputUrls`.
2. Upload to the project's object storage with a deterministic key
   (e.g., `renders/<viewpointRenderId>/<role>.<ext>`).
3. Persist both `source_url` (mnml's, ephemeral) and
   `mirrored_object_key` (ours, durable) on the `render_outputs` row.
4. Compute and persist size/format/duration metadata as available.

Reuse `lib/object-storage-web/` (or the equivalent mirror utility
in repo). The mirror step happens in the same status-poll handler
that flips the `viewpoint_renders.status` to `ready`; if the mirror
fails, the row stays in `rendering` and a subsequent poll retries.

### 6.4 Image capture from bim-model (V1-4 input pipeline)

mnml accepts only 2D images. The bim-model is GLB/IFC. V1-4 needs an
image-capture step that produces a JPEG/PNG suitable for mnml from
the bim-model's three.js viewport — typically a server-side headless
render of the same camera angle the architect selected.

Options for V1-4 implementation, in order of preference:

1. Reuse the same three.js setup that drives the BIM viewport on
   the FE, run it in puppeteer (already in deps for PDF export).
2. If that's slow, add a dedicated render-worker package with a
   minimal three.js scene and gl renderer.
3. Defer to V1-4 implementation: pick the smallest path that
   produces a 1024+px JPEG within ~5s of trigger.

The image-capture step is the single biggest piece of new
infrastructure V1-4 needs. Spec it carefully in the V1-4
implementation prompt.

### 6.5 Mock-mode behavior unchanged

`MockMnmlClient` retains its existing in-memory half-life timer
behavior, but its `RenderStatus` outputs now use the codebase
vocabulary natively (no translation needed since mock never speaks
mnml's wire). The mock's `buildMockOutputs(request.kind)` is updated:

- `archdiffusion` → 1 fixture URL with role `primary`
- `video` → 1 fixture URL with role `video-primary` plus a
  thumbnail fixture URL with role `video-thumbnail`

The 47 existing tests need an update pass to reflect: the renamed
`kind` enum (drop "still" and "elevation"; add "archdiffusion"),
the dropped `cancelRender` method, the renamed `MnmlError` kinds.
Estimate: 1–2 sessions of test maintenance, included in V1-4 scope.

### 6.6 `validateMnmlEnvAtBoot`

Existing function continues to validate `MNML_API_KEY` and
`MNML_API_URL` when `MNML_RENDER_MODE=http`. No new env vars
introduced by this spec.

## 7. Deferred / out of scope

These are real concerns but explicitly NOT V1-4:

- **Cost ceiling enforcement.** Per-tenant or per-engagement credit
  caps, dollar-budget alerts, etc. → future hardening sprint.
- **Style-reference image management.** Architects uploading
  reference images for `reference_image_1..4` → DA-RP-2 (UI sprint).
- **Per-expert deep parameter UX.** The full grid of camera_angle ×
  time_of_day × weather × etc. with previews and presets → DA-RP-2.
- **Live `GET /v1/credits` polling.** Useful for credit-balance
  display, but V1-4 derives the same info from each call's response.
- **Cancel UX.** No mnml-side cancel; client-side "abandon and don't
  poll further" is sufficient for v1, with the row staying in
  `cancelled` per server-side convention.

## 8. References

- [mnml.ai API portal](https://mnmlai.dev) (registration, dashboard,
  API keys)
- [Authentication](https://mnmlai.dev/docs/authentication)
- [v4.3-Ultra render engine](https://mnmlai.dev/docs/api/arch-diffusion-v43)
- [Video AI](https://mnmlai.dev/docs/api/video-ai)
- [Status check](https://mnmlai.dev/docs/api/status-check)
- [Error handling](https://mnmlai.dev/docs/api/errors)
- [Pricing](https://mnmlai.dev/pricing)
- Internal: `lib/mnml-client/src/types.ts` (current v1 shape — to
  be replaced per §6.1)
- Internal: `docs/wave-2/01-mnml-integration-recon.md` (historical;
  superseded by this doc)
- Internal: V1-4 recon report in chat thread (premise verification
  for the §6 migration plan)
