# Wave 2 Recon — mnml.ai Integration Validation Report

**Status:** Read-only recon. No code changes.
**Owner of follow-up reconciliation:** Empressa, at desktop, when drafting Spec 54 v2.
**Consumers of this report:** DA-RP-0 atom registration sprint (Task B) and DA-RP-INFRA client factory sprint (Task C) before either reaches Phase 2.
**Date of recon sweep:** May 1, 2026 (all URLs below fetched on this date).

---

## A. Public-docs sweep — sources consulted

All sources are publicly accessible without an account at the time of fetch.
Anything gated is flagged explicitly in §C / §F as an open question.

### Primary developer documentation (api.mnmlai.dev)

| Page | URL | What it covers |
|---|---|---|
| Authentication | https://mnmlai.dev/docs/authentication | Bearer token shape, key rotation guidance, 401 / 403 surfaces |
| Exterior AI | https://mnmlai.dev/docs/api/exterior-ai | `POST /v1/exterior` — image-in / image-out for exterior renderings |
| Interior AI | https://mnmlai.dev/docs/api/interior-ai | `POST /v1/interior` — image-in / image-out for interior renderings |
| Render Enhancer | https://mnmlai.dev/docs/api/render-enhancer | `POST /v1/render/enhancer` — image-in upscale/enhance |
| Style Transfer | https://mnmlai.dev/docs/api/style-transfer | `POST /v1/style/transfer` — source + reference image |
| Sketch to Image | https://mnmlai.dev/docs/api/sketch-to-image | `POST /v1/sketch-to-img` |
| Imagine AI | https://mnmlai.dev/docs/api/imagine-ai | `POST /v1/imagine-ai` — text-only prompt → image (0.5 credits) |
| Virtual Staging | https://mnmlai.dev/docs/api/virtual-staging | `POST /v1/virtual-staging-ai` (returns base64 inline, 2 credits) |
| Video AI | https://mnmlai.dev/docs/api/video-ai | `POST /v1/video-ai` — Kling v2.1 backed (10 credits) |
| Status Check | https://mnmlai.dev/docs/api/status-check | `GET /v1/status/{id}` — async polling endpoint |
| Errors | https://mnmlai.dev/docs/api/errors | HTTP status code taxonomy + error envelope |

### Product / pricing / engine surfaces (mnml.ai + docs.mnml.ai)

| Page | URL | Relevance |
|---|---|---|
| API Platform landing | https://mnmlai.dev/ | Confirms the seven advertised premium endpoints (Exterior AI, Interior AI, Render Enhancer, Virtual Staging) and that the api-server lives at `api.mnmlai.dev` |
| Pricing | https://mnml.ai/pricing | Credit-based plans; confirms credit allocations per tier |
| Render Modes guide | https://docs.mnml.ai/docs/render-modes-balanced-creative-ultra/ | "Balanced / Creative / Ultra" product-side render modes |
| Engines compared | https://docs.mnml.ai/docs/mnml-ai-engines-compared-v4-1-vs-v3-1/ | ArchDiffusion v4.x is the current engine |
| Animate guide | https://docs.mnml.ai/docs/how-to-animate-your-renderings-in-mnml-ai-studio/ | Studio-side video generation context |

### Confirmed gaps in public documentation (404 at fetch time)

These pages either do not exist or are not publicly indexed; recon **did not** speculate on their behalf:

- `https://mnmlai.dev/docs/api` — root API index (404)
- `https://mnmlai.dev/docs/api/webhooks` — webhook reference (404)
- `https://mnmlai.dev/docs/api/rate-limits` — rate-limit reference (404)
- `https://mnmlai.dev/docs/api/cancel` — cancel endpoint (404)
- `https://mnmlai.dev/docs/api/upscale` / `upscaler` / `4k-upscaler` (404)
- `https://mnmlai.dev/docs/api/landscape-ai` / `masterplan-ai` (404 — product-side surfaces, no public API doc)

There is no evidence in public docs that mnml.ai exposes a unified `/v1/renders` endpoint, a webhook callback, a job-cancel endpoint, an account/credit-balance endpoint, or a rate-limit policy page. If any of these exist behind a logged-in account dashboard, **that gating is the open question for Empressa, not an assumption recon could close from public material**.

---

## B. Section-by-section validation of Spec 54 §5

Ten sub-areas, in the order Spec 54 introduces them. Each entry has Spec 54's stated assumption, the actual mnml.ai behavior per the public docs cited above, and a Yes / No / Partial / Unknown match verdict.

### B.1 — Endpoint shapes

- **Spec 54 assumption:** Three resource-style endpoints under a tenant-configurable `MNML_API_URL`:
  - `POST   {MNML_API_URL}/v1/renders` — submit a job
  - `GET    {MNML_API_URL}/v1/renders/{id}` — get status + outputs
  - `DELETE {MNML_API_URL}/v1/renders/{id}` — cancel
- **Actual mnml.ai behavior:** The base URL is fixed at `https://api.mnmlai.dev/v1/`. There is **no unified `/v1/renders` resource**. Instead, mnml exposes one POST endpoint **per capability**:
  - `POST /v1/exterior` — exterior re-render from a source image + prompt
  - `POST /v1/interior` — interior re-render
  - `POST /v1/render/enhancer` — upscale/enhance an existing render
  - `POST /v1/style/transfer` — apply a style image to a source image
  - `POST /v1/sketch-to-img` — sketch → photoreal image
  - `POST /v1/imagine-ai` — text-only prompt → image
  - `POST /v1/virtual-staging-ai` — empty-room image + prompt → staged image
  - `POST /v1/video-ai` — image + prompt → short Kling video
  - `GET  /v1/status/{id}` — poll status of any of the above by request id
  - **No `DELETE` endpoint is publicly documented.** The status-check response can return a `canceled` status, but no path to *initiate* cancellation is published.
- **Match? No.** The shape and number of endpoints diverge significantly; the spec's resource model and mnml's per-capability model are not the same shape.

### B.2 — Auth model

- **Spec 54 assumption:** `MNML_API_KEY` sent as a bearer token on every request; rotation is manual via GCP Secret Manager + Cloud Run redeploy in v1.
- **Actual mnml.ai behavior:** `Authorization: Bearer YOUR_API_KEY` on every call; key created in the dashboard at `https://mnmlai.dev/apikeys`; mnml's own security guidance recommends environment-variable storage and 90-day rotation. Errors are 401 (`missing_api_key` / `invalid_api_key`) and 403 (forbidden / insufficient permissions).
- **Match? Yes.** The bearer-token model and rotation posture line up cleanly.

### B.3 — Async pattern

- **Spec 54 assumption:** Polling primary at 5s → 15s → 60s intervals; webhook fallback only post-v1.
- **Actual mnml.ai behavior:** Every render-producing endpoint is asynchronous and returns `{status: "success", id, prompt}` immediately after acceptance. The only documented path to retrieve outputs is `GET /v1/status/{id}`, which returns one of `starting | processing | success | failed | canceled`. Public docs explicitly recommend "exponential backoff when polling for status updates to avoid rate limiting." Webhook is **not** publicly documented (see B.10).
- **Match? Partial.** The polling-primary architecture is correct, but Spec 54's status enum (`queued | rendering | ready | failed`) does not match mnml's (`starting | processing | success | failed | canceled`). The HttpMnmlClient must translate between the two; the atom-side enum can stay as-specified.

### B.4 — Input format to mnml.ai

- **Spec 54 assumption:** Option A (IFC export from the bim-model, uploaded to mnml.ai) is preferred; Option B (glb) is the fallback. Either way, "scene geometry + camera + lighting" is what mnml needs.
- **Actual mnml.ai behavior:** **mnml.ai's documented API does not accept IFC, glb, or any 3D model file.** Every render endpoint requires a 2D **image** (JPEG / PNG / WebP, max 10 MB, ≥ 512×512 px) plus a text prompt. The exterior endpoint has an `imageType` discriminator that accepts `"3dmass" | "drawing" | "wireframe" | "construction" | "photo"` — these are *labels for the image content*, not 3D file formats. The mnml product is fundamentally a viewport-screenshot-in / photoreal-image-out diffusion pipeline, not a render farm operating over 3D scene geometry.
- **Match? No.** Both Option A and Option B in Spec 54 are incompatible with mnml.ai's actual API contract. The pipeline that prepares input must produce **rasterized viewport captures from the bim-model** (the Three.js viewer in DA-MV-1 already produces glb-driven scenes; we need a screenshotting step on top of that), not IFC or glb uploads.

### B.5 — Output format

- **Spec 54 assumption:** mnml returns output URLs that the api-server persists onto `render-output` atoms (one per role: still has `primary`, elevation has four cardinal-direction outputs, video has `video-primary` + `video-thumbnail`).
- **Actual mnml.ai behavior:** A successful status response returns:
  ```json
  { "status": "success",
    "message": ["https://api.mnmlai.dev/v1/images/.../<file>.png"],
    "seed": 453463 }
  ```
  i.e., a `message` **array** of URLs hosted under `api.mnmlai.dev/v1/images/`. Public docs warn that "image URLs may expire after a certain period" — clients are expected to download and persist immediately. The Virtual Staging endpoint is the exception: it returns the image **inline as a base64 data URI** in `message`, not a URL. Video AI has no explicit thumbnail in the response shape; only the primary video URL appears in `message`.
- **Match? Partial.** A URL-returning shape is correct in spirit, but: (a) the field is `message` not `outputUrls`; (b) virtual-staging is base64-inline not URL; (c) URLs are short-lived (we must mirror to our own object storage on `viewpoint-render.ready`); (d) mnml does not provide a video thumbnail — Spec 54's `video-thumbnail` render-output role would have to be **synthesized** (e.g., extract a frame from the mp4 server-side) rather than received from mnml.

### B.6 — Error categories

- **Spec 54 assumption:** Four categories — `invalid-scene | quota-exceeded | timeout | internal-error` — surfaced on `viewpoint-render.failed`.
- **Actual mnml.ai behavior:** Errors follow `{status: "error", message, code, details}`. HTTP status codes drive the taxonomy:
  - 400 `missing_required_field`, `invalid_image_format`, `invalid_request_id`
  - 401 `missing_api_key`, `invalid_api_key`
  - 403 `insufficient_credits` (with `available_credits` / `required_credits` in `details`), permission errors
  - 404 `resource_not_found`
  - 413 file size > 10 MB (`File size exceeds maximum limit of 10MB`)
  - 429 `rate_limit_exceeded` (with `retry_after` seconds in `details`)
  - 500 `internal_server_error`
  - 503 `service_unavailable` (with `retry_after`)
- **Match? Partial.** The mnml taxonomy is HTTP-code-driven and roughly maps, but the bucket boundaries differ:
  - `invalid-scene` → 400 `invalid_image_format` / `missing_required_field` / 413 oversized image
  - `quota-exceeded` splits into 403 `insufficient_credits` (account-level) **and** 429 `rate_limit_exceeded` (request-rate-level) — these are different remediation paths and should not collapse to one bucket
  - `timeout` is **not a documented mnml category**; the `failed` status from `GET /v1/status/{id}` is generic and does not break out a timeout cause
  - `internal-error` → 500 / 503 (retry-after)

### B.7 — Rate limits + pricing

- **Spec 54 assumption (cost guardrails section):** Per-engagement render cap per day (default 10), video cap per day (default 2); cost estimate displayed before confirm. Spec 54 §7 OQ-4 leaves the *model* (per-render? subscription? credit?) open for Empressa.
- **Actual mnml.ai behavior:**
  - **Pricing is credit-based**, not per-render dollars. From `mnml.ai/pricing`:
    - Lite: $29/mo (annual) / $39/mo, **1,000 credits/mo**
    - Plus: $49/mo / $59/mo, **3,000 credits/mo**
    - Studio: $119/mo / $139/mo, **10,000 credits/mo**
    - One-time pack: 10,000 credits / $149 / 12-month validity
    - Education (30% off) and Enterprise (SSO + custom) plans available
  - Per-call costs (where documented in API docs): Imagine AI = **0.5 credits**, Virtual Staging = **2 credits**, Video AI = **10 credits**. The pricing FAQ states "main tools use 10 credits per design, while auxiliary tools use 1–5." This implies Exterior AI / Interior AI cost ~10 credits per generation, but the API doc pages for those endpoints do **not** quote a per-call number.
  - **Numeric rate-limit policy is not publicly documented.** The error surface confirms 429 + `retry_after` exists; no requests-per-minute / requests-per-day cap is published.
- **Match? Partial.** A guardrail strategy is still appropriate, but the *unit* for the cost-estimate UI must be **credits**, not dollars, and the per-tier credit-per-tool figure should come from the live `403 insufficient_credits.required_credits` field rather than a hardcoded table. Numeric rate limits remain unknown.

### B.8 — Render quality tiers

- **Spec 54 assumption:** Spec 54 §7 OQ-6 leaves "preview vs final" tier support open.
- **Actual mnml.ai behavior:**
  - At the API level, Exterior AI and Interior AI both expose `renderspeed: "fast" | "best"` (default `"best"`) — this is the documented preview-vs-final knob. mnml's product UI and a dedicated docs page (`docs.mnml.ai/docs/render-modes-balanced-creative-ultra/`) describe three product-side render modes — **Balanced / Creative / Ultra** — and the FAQ characterizes Ultra as roughly 3× the credit cost. Whether `Balanced/Creative/Ultra` are surfaced as additional API parameters on the same endpoints is **not visible in the public API docs** (the documented optional params on `/v1/exterior` are only `imageType`, `scenario`, `geometry_input`, `styles`, `renderspeed`).
- **Match? Yes (with caveat).** Preview-vs-final exists at the API level via `renderspeed`; the richer Balanced/Creative/Ultra tiering needs to be confirmed at desktop (likely a logged-in-only API surface).

### B.9 — Video duration cap

- **Spec 54 assumption:** v1 caps videos at 60 seconds (`durationSeconds: 10 | 20 | 30 | 60`); framerate `24 | 30 | 60`; preset `pathKind: "exterior-orbit" | "interior-walkthrough" | "fly-over" | "custom"`.
- **Actual mnml.ai behavior:** From `https://mnmlai.dev/docs/api/video-ai`:
  - "Maximum video length is 10 seconds. Only allowed 5 & 10 seconds." Default is 10.
  - Aspect ratios: `16:9` (default), `4:3`, `1:1`. **Framerate is not a documented parameter.**
  - Camera control is one-axis only: `movement_type: "horizontal" | "vertical" | "zoom_in" | "zoom_out" | "pan"` plus `direction: "left" | "right" | "up" | "down"`. There is **no waypoint / path concept**, no `exterior-orbit`, no `interior-walkthrough`, no `fly-over`. The video is generated from a single still image (or two: `start_image_url` → `end_image_url`) plus the simple camera move.
  - The model is Kling v2.1 (third-party-hosted). Video output is one URL in `status.message[]`; no thumbnail is generated.
- **Match? No.** This is the largest single gap. mnml's public video API is a **6× shorter cap** (10 s vs 60 s), no waypoint/path control, no native thumbnail, and a different conceptual unit (single-image animation vs scene-walkthrough). Spec 54 §4 "Video" viewpoint metadata cannot map directly.

### B.10 — Webhook support

- **Spec 54 assumption:** Polling primary; "if mnml.ai supports webhooks and the polling overhead becomes meaningful at scale, add a webhook endpoint POST /api/internal/mnml-callback that mnml.ai invokes on job completion. Secured via HMAC + IP allowlist." Webhook decision deferred to recon (OQ-2).
- **Actual mnml.ai behavior:** **No webhook surface is publicly documented.** `https://mnmlai.dev/docs/api/webhooks` returns 404. The status-check page explicitly endorses polling with exponential backoff as the supported pattern. No HMAC signing scheme, no callback registration, no IP allowlist guidance is visible in public docs.
- **Match? No (in the sense that the option is not available), or Unknown if a webhook surface exists behind the logged-in dashboard.** Either way, the v1 plan stays polling-only; the post-v1 webhook fallback is **not buildable from public docs alone** and requires Empressa-side dashboard confirmation.

### Verdict count (used to size §C and self-check)

| Verdict | Sub-areas |
|---|---|
| **Yes** | B.2 (auth), B.8 (render-quality tiers, with caveat) |
| **Partial** | B.3 (async), B.5 (output format), B.6 (errors), B.7 (rate limits + pricing) |
| **No** | B.1 (endpoints), B.4 (input format), B.9 (video duration), B.10 (webhooks) |
| **Unknown** | — (every Partial / No has at least some public-source evidence) |

That gives **8 entries that need a reconciliation entry below** (4 Partial + 4 No). §C contains exactly 8.

---

## C. Reconciliation entries

Each entry: the Spec 54 assumption, the actual behavior (one-line), and the recommended resolution path. Resolutions are **advisory** — Empressa decides at desktop whether to modify Spec 54, modify the client, or defer.

### C.1 — Endpoint shapes (B.1)

- **Assumption:** Single `/v1/renders` resource with POST / GET / DELETE.
- **Actual:** Per-capability POSTs + a shared `GET /v1/status/{id}`; no DELETE.
- **Recommended resolution: Modify the client.** Keep the public client interface (`triggerRender`, `getRenderStatus`, `cancelRender`) stable as Spec 54 already authorizes ("If actual mnml.ai endpoints differ, HttpMnmlClient adapts; the public client interface stays stable" — §5). Internally, `triggerRender` dispatches by `viewpoint.kind` (still / elevation / video) plus a sub-discriminator (interior vs exterior for stills) to the right `/v1/<capability>` endpoint. `getRenderStatus` always hits `/v1/status/{id}`. `cancelRender` becomes a structured `not-supported` response that the api-server records as a `viewpoint-render.cancellation-unsupported` audit event without changing the atom's status. **Spec 54 §5 endpoint table needs a footnote** acknowledging this; otherwise the substantive design holds.

### C.2 — Async pattern status enum (B.3)

- **Assumption:** Polling primary with status enum `queued | rendering | ready | failed`.
- **Actual:** Polling primary with status enum `starting | processing | success | failed | canceled`.
- **Recommended resolution: Modify the client (translation layer).** The viewpoint-render atom keeps Spec 54's enum (it is the contract for downstream consumers; changing it would ripple through the chat path, gallery, freshness logic). The client's `getRenderStatus` translates: `starting → queued`, `processing → rendering`, `success → ready`, `failed → failed`, `canceled → failed` (with a structured cancel reason). No spec change required.

### C.3 — Input format (B.4)

- **Assumption:** Upload IFC (preferred) or glb to mnml.ai.
- **Actual:** mnml.ai accepts only 2D images (multipart/form-data), not 3D scene files.
- **Recommended resolution: Modify Spec 54.** This is the largest substantive change required. Spec 54 §5 "Input format to mnml.ai" needs to be rewritten around a **viewport-capture pipeline**: from the bim-model (which we already render in DA-MV-1's Three.js viewer), the api-server programmatically renders a viewport screenshot at the requested camera position / target / FOV, optionally overlaying neighboring-context massing, and uploads that PNG/JPG as the `image` parameter. The `imageType="3dmass"` value is the right discriminator for the bim-model viewport. Camera positioning logic (Spec 54 §4 "Still" and "Elevation") still belongs in our codebase — it just produces *images* at those positions instead of *being passed through* to mnml. **This unblocks DA-RP-1's Phase 1 design**: we do not need any IFC export plumbing from the Revit connector for Wave 2.

### C.4 — Output format (B.5)

- **Assumption:** Single response object with explicitly-roled output URLs.
- **Actual:** `message` array of URLs (or base64 inline for virtual-staging); URLs may expire; no native video thumbnail.
- **Recommended resolution: Modify the client + minor spec note.** Three concrete pieces:
  1. The HttpMnmlClient must mirror every URL in `message[]` to our own object storage **immediately** on `success` and rewrite the `outputUrls` field on the `render-output` atom to the mirrored URL. This is required for correctness, not optimization.
  2. The Virtual Staging response shape (base64 inline) is anomalous and must be branched in the client; `virtual-staging-ai` is not a Spec 54 v1 render kind, so this can be deferred until Spec 56+ exposes it.
  3. The `render-output` atom's `video-thumbnail` role (Spec 54 §3) cannot be sourced from mnml; it must be synthesized server-side (e.g., ffmpeg first-frame extraction). Spec 54 §3 should note this dependency or downgrade `video-thumbnail` to "post-processed" rather than "received from mnml."

### C.5 — Error categories (B.6)

- **Assumption:** Four-bucket taxonomy `invalid-scene | quota-exceeded | timeout | internal-error`.
- **Actual:** HTTP-code-driven error envelope with codes including `missing_required_field`, `invalid_image_format`, `insufficient_credits`, `rate_limit_exceeded`, `internal_server_error`, `service_unavailable`; no documented `timeout` bucket; account-level credits and request-rate limits are different errors.
- **Recommended resolution: Modify Spec 54 (and the client).** Replace Spec 54 §5's four buckets with five that match mnml's surface:
  - `invalid-scene` (400 family + 413) — geometry/image issue
  - `insufficient-credits` (403 `insufficient_credits`) — distinct remediation: "buy credits / contact admin"
  - `rate-limit-exceeded` (429 with `retry_after`) — distinct remediation: "wait and retry automatically"
  - `service-unavailable` (500 / 503 with `retry_after`) — transient, retry with backoff
  - `unknown` — for any 4xx/5xx not in the above
  Drop the `timeout` bucket (not a category mnml exposes) or keep it as a client-side wall-clock guard around the polling loop, separately from mnml's own errors.

### C.6 — Rate limits + pricing (B.7)

- **Assumption:** Per-engagement-per-day numeric caps, dollar-denominated cost estimate before confirm; numeric rate limits left as cost-guardrail config.
- **Actual:** Pricing is credit-based (Lite/Plus/Studio + one-time pack); per-call credit cost is documented for some endpoints (Imagine 0.5, Virtual Staging 2, Video 10) and inferable for others; numeric request-rate limits are **not** publicly documented.
- **Recommended resolution: Modify Spec 54 + defer the unknowns to Empressa.**
  - **Modify:** The cost-estimate UI in DA-RP-2 should display **credits**, not dollars. Per-call credit cost should come from a small lookup table seeded from the published numbers (Imagine 0.5, Virtual Staging 2, Video 10, Exterior/Interior ≈ 10 from the FAQ "main tools" wording) **and** be reconciled live from `403 insufficient_credits.details.required_credits` when mnml refuses.
  - **Defer (OQ-4 Empressa):** the dollar-to-credit conversion for the displayed estimate (depends on which plan our pilot tenants are on); whether the Studio plan's 10,000-credit allowance covers expected pilot usage; Enterprise SSO/custom-pricing posture.
  - **Defer (OQ-7 Empressa):** numeric rate-limit policy (mnml has not published it). The client should treat 429 as authoritative regardless.

### C.7 — Video duration + path control (B.9)

- **Assumption:** Up to 60 s, four `pathKind` presets including `exterior-orbit` / `interior-walkthrough` / `fly-over`, configurable framerate, waypoint lists.
- **Actual:** **Hard cap of 10 s** (only 5 or 10 are valid values), no waypoints, no orbit/walkthrough/fly-over presets, no framerate field, single-image-driven Kling animation with one camera move (`horizontal | vertical | zoom_in | zoom_out | pan`) and a direction.
- **Recommended resolution: Modify Spec 54 (significantly).** This is the biggest change to the v1 surface. Two viable paths Empressa should choose between at desktop:
  1. **Constrain v1 to mnml's actual envelope.** Replace Spec 54 §4 "Video" with a 5-or-10-second clip generated from one viewport-capture still, with `movement_type` + `direction` as the only camera controls. Drop `pathKind`, `waypoints`, `framerate`, and the 60-second cap from Spec 54 v2. DA-RP-4 ships against this constrained surface.
  2. **Composite longer walkthroughs client-side.** Generate N consecutive 10-second clips (each from a different viewport capture along the architect's chosen path) and stitch them together server-side using ffmpeg. DA-RP-4 owns the stitcher; mnml stays in its 10-second envelope. This restores something close to the Spec 54 v1 vision but adds substantial engineering.
  Either way, OQ-3 ("video render duration cap") is **resolved** by recon: mnml's documented cap is 10 seconds, full stop.

### C.8 — Webhook support (B.10)

- **Assumption:** Webhook fallback post-v1 (HMAC + IP allowlist), polling primary in v1.
- **Actual:** No publicly documented webhook surface. Polling is the only documented retrieval path.
- **Recommended resolution: Defer to Empressa desktop.** v1 stays polling-only (this is unchanged from Spec 54 §5). The post-v1 webhook fallback paragraph in Spec 54 should be re-marked as **conditional on mnml exposing webhooks at a higher plan tier** — Empressa to confirm at desktop by checking the logged-in dashboard or contacting mnml sales/support directly. Until confirmed, no client / api-server work is needed. The important point for Tasks B and C: **no atom shape, registry entry, or client method depends on webhooks today**, so deferring causes zero downstream blockage.

---

## D. DA-RP-1 unblock list — OQ-1 through OQ-8 disposition

Eight open questions in Spec 54 §7. Recon resolves the four it can; defers the four it cannot.

### Resolved by recon

- **OQ-1 — IFC inputs.** **Resolved: NO.** mnml.ai does not accept IFC, glTF, glb, or any 3D model file at any of its documented endpoints. Inputs are 2D images (JPEG / PNG / WebP, max 10 MB, ≥ 512×512 px) only. Source: every `/v1/<capability>` API doc page on `mnmlai.dev/docs/api/`. **Action for DA-RP-1:** treat the input pipeline as "render a viewport screenshot from the bim-model at the requested camera, upload that image" (see C.3). No IFC export plumbing required for Wave 2.
- **OQ-2 — Webhook support.** **Resolved: NOT IN PUBLIC DOCS.** No webhook surface, no HMAC scheme, no IP allowlist guidance is publicly documented. Polling-primary stays correct for v1; the post-v1 webhook plan in Spec 54 §5 needs Empressa to confirm at desktop whether webhooks exist behind the dashboard. **Action for DA-RP-1:** ship polling only; no webhook endpoint registration.
- **OQ-3 — Video duration cap.** **Resolved: 10 SECONDS HARD.** mnml's Video AI endpoint accepts only `duration: 5` or `duration: 10`, with default 10. Spec 54's 60-second target is not achievable with a single API call. **Action for DA-RP-4:** see C.7 — Empressa picks between constraining v1 to 10 s or building a server-side stitcher.
- **OQ-6 — Render quality tiers.** **Resolved: YES at the API level.** `/v1/exterior` and `/v1/interior` expose `renderspeed: "fast" | "best"` as the documented preview-vs-final knob. The richer Balanced / Creative / Ultra modes documented at `docs.mnml.ai/docs/render-modes-balanced-creative-ultra/` appear product-side; whether they are exposed as API parameters is not visible in public docs and is the only piece left to Empressa for confirmation at desktop. **Action for DA-RP-2:** the cost-estimate UI can offer a Fast/Best toggle today; richer tiering follows the dashboard check.

### Deferred to Empressa desktop

- **OQ-4 — Pricing model.** **Deferred.** Public pricing is credit-based with three monthly tiers (Lite/Plus/Studio at 1,000 / 3,000 / 10,000 credits) plus a one-time 10,000-credit pack. Per-call credit costs are documented for some endpoints (Imagine 0.5, Virtual Staging 2, Video AI 10) and implied for others (FAQ: "main tools = 10 credits"). What recon **cannot** answer from public sources: which plan our pilot tenants are on, whether Enterprise pricing applies, and whether the displayed cost-estimate UI (DA-RP-2) should show credits, dollars, or both. Empressa picks plan + display unit at desktop.
- **OQ-5 — Customer-portal share-link auth.** **Deferred.** This question is internal to our portal (Wave 4 surface) and is not addressable by mnml docs at all. Recon surfaces no new context; the question stands as written in Spec 54 §7.
- **OQ-7 — Per-tenant cap policy.** **Deferred.** mnml does not publish a numeric request-rate limit; the only authoritative signal is the `429 rate_limit_exceeded` response with a `retry_after` value. Our per-engagement-per-day cap (Spec 54 §5 "Cost guardrails") is therefore a **product-side guardrail** independent of mnml's policy, and Empressa decides whether it is hardcoded or admin-configurable. Recommend admin-configurable but UI deferred to Wave 4+, matching Spec 54 §7's existing recommendation.
- **OQ-8 — Atom retention.** **Deferred.** Outside mnml's API surface entirely; this is an Empressa retention-policy decision.

### OQ count check

8 OQs total; 4 resolved (OQ-1, OQ-2, OQ-3, OQ-6); 4 deferred (OQ-4, OQ-5, OQ-7, OQ-8). Matches the "Done looks like" expectation that OQ-4 / OQ-5 / OQ-7 / OQ-8 defer to Empressa.

---

## E. Coordination notes for Tasks B and C

This section is the recon's contract with the two parallel substrate sprints. If recon completes before Tasks B / C reach Phase 2, this section is what they consume. If recon lands later, this section is the post-merge reconciliation note Empressa applies.

### E.1 — For Task B (DA-RP-0 — viewpoint-render + render-output atom registration, shape-only)

Atom shapes from Spec 54 §3 are **mostly safe to register as written**. Specific notes Task B should bake in:

1. **Status enum on `viewpoint-render.status`.** Keep Spec 54's `queued | rendering | ready | failed`. The HttpMnmlClient (Task C) translates from mnml's `starting | processing | success | failed | canceled` — the atom layer should not see mnml's enum.
2. **`viewpoint-render.kind` taxonomy.** Spec 54's `still | elevation | video` is intact. No change. (mnml's per-capability endpoint structure is hidden inside the client; the atom layer stays kind-driven as written.)
3. **`viewpoint-render.subtype` for stills.** Recommend adding an optional `stillVariant: "exterior" | "interior"` field on still-kind viewpoint-renders so the client knows which mnml endpoint to hit (`/v1/exterior` vs `/v1/interior`). This is a forward-compatible add to Spec 54 §3 that Task B can land alongside the registration without blocking. If Task B prefers to defer the field until DA-RP-1, the client can infer from the cameraTarget being inside vs outside the bim-model bounding box, but the explicit field is cleaner.
4. **`render-output.role` taxonomy.** Spec 54 §3 lists `primary | elevation-north | elevation-east | elevation-south | elevation-west | video-primary | video-thumbnail`. All seven are still correct **at the atom layer**, with the caveat that `video-thumbnail` is server-side-synthesized (ffmpeg first-frame extraction), not received from mnml. Task B can register the role without touching any synthesis code; the synthesis lands in DA-RP-4.
5. **`viewpoint-render.mnmlJobId`.** Spec 54 §3 names this field. Confirm: mnml returns `id` in the POST response, and the same `id` is passed to `GET /v1/status/{id}`. The field name can stay `mnmlJobId` on our side; the wire field is `id`.
6. **No registration of an `elevation` mnml endpoint.** mnml has no batch elevation endpoint — an elevation set is **four separate POST `/v1/exterior` calls** orchestrated by the client. Task B's atom registration does not need to know this, but the contract test for elevation should expect four `render-output` atoms to materialize after four mnml jobs all reach `success`. The viewpoint-render's `status` should not flip to `ready` until all four child outputs are in.

### E.2 — For Task C (DA-RP-INFRA — mnml.ai client factory + secrets plumbing)

Spec 54 §5 client architecture is mostly safe to implement as written. Specific notes Task C should bake in:

1. **`MNML_API_URL` default.** Spec 54 leaves this as a configurable env. Recon confirms the canonical base is `https://api.mnmlai.dev/v1` — recommend that as the default in `createMnmlClient`, overridable for staging/test.
2. **`MNML_API_KEY` shape.** Bearer token, sent as `Authorization: Bearer ${MNML_API_KEY}` on every request. Boot validation: presence check only (mnml does not document a key-format regex).
3. **Public client interface.** Keep `triggerRender(input)`, `getRenderStatus(jobId)`, `cancelRender(jobId)` as Spec 54 names them. Internal dispatch:
   - `triggerRender` switches on `input.kind`:
     - `still` + `stillVariant: "exterior"` → `POST /v1/exterior` with multipart `image` + `prompt` (+ `imageType=3dmass`, `renderspeed`)
     - `still` + `stillVariant: "interior"` → `POST /v1/interior` with same shape
     - `elevation` → fan out to **four** `POST /v1/exterior` calls (one per cardinal direction); return a synthetic parent jobId composed of the four mnml ids; `getRenderStatus` aggregates
     - `video` → `POST /v1/video-ai` (with `duration` clamped to `5` or `10`, `movement_type` + `direction` derived from the requested camera move)
   - `getRenderStatus` always hits `GET /v1/status/{id}`; for elevation parents, polls all four child ids and aggregates to the parent's status using the rule "rendering if any child is starting/processing; ready if all four are success; failed if any child is failed"
   - `cancelRender` returns a structured `not-supported` response (mnml has no documented cancel endpoint); the api-server logs an audit event but does not transition the atom status
4. **Mock client (`MockMnmlClient`) parity.** The mock should mirror this dispatch shape so a `triggerRender({ kind: "elevation" })` call returns four fixture URLs in the right roles, not one. This keeps the DA-RP-1 mock-mode flow identical to http mode.
5. **Error translation.** Map mnml's HTTP-coded errors to the recommended five-bucket taxonomy in C.5 (`invalid-scene | insufficient-credits | rate-limit-exceeded | service-unavailable | unknown`) at the client boundary, so the api-server's `viewpoint-render.failed` handler sees a stable enum regardless of which mnml endpoint failed.
6. **Output mirroring.** On `success`, the client must download every URL in `status.message[]` and mirror to our own object storage **before** returning `ready` to the api-server. mnml's URLs are short-lived per their own best-practices guidance. The mirrored URLs are what get persisted on `render-output.downloadUrl`.
7. **Pricing surface.** Recommend the client expose a small `getKnownCreditCost(kind, options)` helper seeded from public docs (Imagine 0.5, Virtual Staging 2, Video AI 10, Exterior/Interior ≈ 10) so DA-RP-2's cost-estimate UI is not coupled to a hardcoded table inside the design-tools artifact. Live reconciliation comes from `403 insufficient_credits.details.required_credits` when mnml refuses.

### E.3 — Joint note for Tasks B and C

Neither sprint is **blocked** by anything in this report. Both can proceed to Phase 2 with the notes above baked in. The single substantive Spec 54 change recon is recommending — the input-format flip from "IFC upload" to "viewport-capture screenshot" (C.3) — is not visible at either Task B's atom shape or Task C's client interface; it lives entirely inside DA-RP-1's request-preparation step. So this report does not delay the substrate sprints.

---

## F. Self-check

- ✅ One file added (`docs/wave-2/01-mnml-integration-recon.md`); no other files modified.
- ✅ All ten Spec 54 §5 sub-areas have a validation entry in §B (B.1 endpoints, B.2 auth, B.3 async, B.4 input format, B.5 output format, B.6 error categories, B.7 rate limits + pricing, B.8 render quality tiers, B.9 video duration cap, B.10 webhook support).
- ✅ Reconciliation count in §C (8) matches the No / Partial count from §B (4 No + 4 Partial = 8). The two Yes verdicts (B.2, B.8) carry no reconciliation, as expected.
- ✅ All eight OQs from Spec 54 §7 are addressed in §D (4 resolved, 4 deferred). OQ-4 / OQ-5 / OQ-7 / OQ-8 deferred to Empressa as the task brief expected.
- ✅ Coordination notes for Tasks B and C live in §E with explicit per-sprint sub-sections.
- ✅ Every external link in the report was fetched on May 1, 2026. Pages that 404'd are listed explicitly in §A under "Confirmed gaps in public documentation" and flagged as open questions for Empressa rather than silently filled with assumptions.
- ✅ No code changes, no Spec 54 modifications, no atom registrations, no client implementations were made by this task. The report is the deliverable.
