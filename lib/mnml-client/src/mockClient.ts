/**
 * Hermetic stand-in for mnml.ai. Walks a deterministic
 * `queued → rendering → ready` transition on a configurable timer
 * (default 100 ms total ready) so DA-RP-1's polling logic can
 * exercise real state-machine paths without opening a network socket.
 *
 * Speaks the codebase's internal vocabulary natively (Spec 54 v2 §6.5)
 * — the wire-status translation lives in {@link HttpMnmlClient} and
 * the mock never exercises that path. Output shape matches
 * Spec 54 v2 §6.5: archdiffusion → 1 fixture URL; video → 1 fixture
 * URL (the `video-thumbnail` role is server-synthesized post-`ready`
 * by the api-server route, not returned here).
 *
 * Mirrors the {@link MockConverterClient} affordance pattern in
 * `artifacts/api-server/src/lib/converterClient.ts:88` — `alwaysFail`
 * for forcing the failed branch in tests, `fixedRenderId` for pinning
 * the id under test, plus a swappable `now` for clock control.
 *
 * `remainingCredits` simulation: each `triggerRender` decrements an
 * internal balance by the static cost from Spec 54 v2 §4 (3 credits
 * for archdiffusion, 10 for video). Tests asserting against the
 * balance can pin the starting value via {@link MockMnmlClientOptions.startingCredits}.
 *
 * `getCredits` reports the live simulated balance; `generatePrompt`
 * (doc 40c gap-fill) is synchronous, decrements the balance by 1, and
 * returns a deterministic prompt. `alwaysFail` also forces
 * `generatePrompt` down its failure branch.
 */

import { randomUUID } from "node:crypto";
import {
  MnmlError,
  type AiEraserRequest,
  type CreditsResult,
  type InpaintRequest,
  type MnmlClient,
  type PromptGeneratorRequest,
  type PromptGeneratorResult,
  type RenderEnhancerRequest,
  type RenderRequest,
  type RenderStatus,
  type RenderStatusResult,
  type StyleTransferRequest,
  type TriggerRenderResult,
  type UpscaleRequest,
} from "./types";

/** Spec 54 v2 §4 — static per-operation credit cost. */
const COST_PER_KIND = { archdiffusion: 3, video: 10 } as const;

/** doc 40c — Prompt Generator costs 1 credit per call. */
const PROMPT_GENERATOR_COST = 1;

/**
 * doc 40e — per-tool credit cost for the mock's `remainingCredits`
 * simulation. mnml documents 1 credit each for `upscale` + `ai_eraser`
 * (2026-05-23 docs capture); `enhance` / `inpaint` / `style_transfer`
 * cost is unspecified in the docs and will be discovered on first
 * live call. The mock uses 1 credit for all five as a conservative
 * placeholder; the real cost lookup lives in `cost.ts` and is the
 * source of truth for production callers once verified.
 */
const TOOL_COST_PER_KIND = {
  enhance: 1,
  upscale: 1,
  ai_eraser: 1,
  inpaint: 1,
  style_transfer: 1,
} as const;

/** Discriminator for the 5 doc 40e power tools in mock state. */
type ToolKind = keyof typeof TOOL_COST_PER_KIND;

/** Spec 54 v2 §6.5 mock-client construction options. */
export interface MockMnmlClientOptions {
  /**
   * Total wall-clock time before a render reports `"ready"`. The
   * mock splits this in half: first 50 % reports `"queued"`, second
   * 50 % reports `"rendering"`, and elapsed >= readyAfterMs reports
   * `"ready"`. Default 100 ms.
   */
  readyAfterMs?: number;
  /**
   * When true, every triggered render walks queued → rendering →
   * `"failed"` (instead of `"ready"`) with kind `validation` /
   * code `MOCK_FORCED`. Mirrors {@link MockConverterClient}'s
   * `alwaysFail` so the failure branch is exercisable from tests
   * without monkey-patching.
   */
  alwaysFail?: boolean;
  /**
   * Pin the render id (otherwise minted per call via {@link randomUUID}).
   * Useful when an assertion needs the render id to be predictable.
   */
  fixedRenderId?: string;
  /**
   * Wall-clock function. Defaults to {@link Date.now}. Tests inject a
   * controllable clock so state transitions are deterministic without
   * actual sleeping.
   */
  now?: () => number;
  /**
   * Starting credit balance for the `remainingCredits` simulation.
   * Default 1000. Each successful trigger decrements by Spec 54 v2 §4
   * cost (3 archdiffusion / 10 video). Tests asserting the post-
   * trigger balance can pin a known starting value here.
   */
  startingCredits?: number;
}

/**
 * Tracked job request in the mock state map. The five power tools
 * (doc 40e A.1) all share the trigger-then-poll pattern with
 * {@link triggerRender} but carry their own request shape — we
 * store the discriminator alongside so {@link buildMockOutputUrls}
 * can pick the right fixture per kind.
 */
type MockJobRequest =
  | { mockKind: "render"; request: RenderRequest }
  | { mockKind: ToolKind };

interface MockRenderState {
  job: MockJobRequest;
  createdAt: number;
}

/**
 * Fixture URLs the mock client returns. The host is `mnml.ai/mock/...`
 * so log lines self-identify as mock outputs and any consumer that
 * tries to actually load the asset gets a recognizable "this is the
 * mock" 404 rather than a confused empty render.
 */
const MOCK_ARCHDIFFUSION_URL = "https://mnml.ai/mock/archdiffusion.png";
const MOCK_VIDEO_URL = "https://mnml.ai/mock/video.mp4";
/** Per-tool fixture URLs — distinct so a B.5 gallery render can tell tool outputs apart in dev. */
const MOCK_TOOL_OUTPUT_URLS: Record<ToolKind, string> = {
  enhance: "https://mnml.ai/mock/enhance.png",
  upscale: "https://mnml.ai/mock/upscale.png",
  ai_eraser: "https://mnml.ai/mock/ai-eraser.png",
  inpaint: "https://mnml.ai/mock/inpaint.png",
  style_transfer: "https://mnml.ai/mock/style-transfer.png",
};
const MOCK_SEED = 12345;

export class MockMnmlClient implements MnmlClient {
  private readonly readyAfterMs: number;
  private readonly alwaysFail: boolean;
  private readonly fixedRenderId?: string;
  private readonly now: () => number;
  private readonly renders = new Map<string, MockRenderState>();
  private remainingCredits: number;

  constructor(opts: MockMnmlClientOptions = {}) {
    this.readyAfterMs = opts.readyAfterMs ?? 100;
    this.alwaysFail = opts.alwaysFail ?? false;
    this.fixedRenderId = opts.fixedRenderId;
    this.now = opts.now ?? (() => Date.now());
    this.remainingCredits = opts.startingCredits ?? 1000;
  }

  async triggerRender(input: RenderRequest): Promise<TriggerRenderResult> {
    const renderId = this.fixedRenderId ?? randomUUID();
    this.renders.set(renderId, {
      job: { mockKind: "render", request: input },
      createdAt: this.now(),
    });
    this.remainingCredits -= COST_PER_KIND[input.kind];
    return { renderId, remainingCredits: this.remainingCredits };
  }

  async getRenderStatus(renderId: string): Promise<RenderStatusResult> {
    const state = this.renders.get(renderId);
    if (!state) {
      // Mirrors mnml.ai's 404 surface for unknown renderIds (Spec 54
      // v2 §5: 404 → not_found bucket).
      throw new MnmlError(
        "not_found",
        "UNKNOWN_RENDER_ID",
        `MockMnmlClient: unknown renderId=${renderId}`,
      );
    }
    const elapsed = this.now() - state.createdAt;
    const status = this.statusForElapsed(elapsed);

    if (status === "queued" || status === "rendering") {
      return { renderId, status };
    }
    if (this.alwaysFail) {
      return {
        renderId,
        status: "failed",
        error: {
          code: "MOCK_FORCED",
          message: "MockMnmlClient: forced failure (alwaysFail=true)",
        },
      };
    }
    return {
      renderId,
      status: "ready",
      outputUrls: buildMockOutputUrls(state.job),
      seed: MOCK_SEED,
    };
  }

  async getCredits(): Promise<CreditsResult> {
    return { credits: this.remainingCredits };
  }

  async generatePrompt(
    input: PromptGeneratorRequest,
  ): Promise<PromptGeneratorResult> {
    if (this.alwaysFail) {
      // Mirror the render forced-failure surface so route tests can
      // exercise the prompt-generator error branch with the mock.
      throw new MnmlError(
        "validation",
        "MOCK_FORCED",
        "MockMnmlClient: forced prompt-generator failure (alwaysFail=true)",
      );
    }
    this.remainingCredits -= PROMPT_GENERATOR_COST;
    // Deterministic prompt — folds in the caller's keywords when given
    // so a test can assert the hint round-tripped.
    const base =
      "modern architectural rendering, photorealistic lighting, " +
      "professional exterior view, high detail";
    const keywords = input.keywords?.trim();
    return {
      prompt: keywords ? `${keywords}, ${base}` : base,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Power tools (doc 40e A.1) — five trigger-then-poll methods. Each
  // registers the renderId in the shared state map (so the existing
  // `getRenderStatus` polling state machine covers them too) and
  // returns the same {@link TriggerRenderResult} shape as
  // {@link triggerRender}.
  // ─────────────────────────────────────────────────────────────────

  async enhance(_input: RenderEnhancerRequest): Promise<TriggerRenderResult> {
    return this.recordToolTrigger("enhance");
  }

  async upscale(_input: UpscaleRequest): Promise<TriggerRenderResult> {
    return this.recordToolTrigger("upscale");
  }

  async aiErase(_input: AiEraserRequest): Promise<TriggerRenderResult> {
    return this.recordToolTrigger("ai_eraser");
  }

  async inpaint(_input: InpaintRequest): Promise<TriggerRenderResult> {
    return this.recordToolTrigger("inpaint");
  }

  async styleTransfer(
    _input: StyleTransferRequest,
  ): Promise<TriggerRenderResult> {
    return this.recordToolTrigger("style_transfer");
  }

  private recordToolTrigger(kind: ToolKind): TriggerRenderResult {
    const renderId = this.fixedRenderId ?? randomUUID();
    this.renders.set(renderId, {
      job: { mockKind: kind },
      createdAt: this.now(),
    });
    this.remainingCredits -= TOOL_COST_PER_KIND[kind];
    return { renderId, remainingCredits: this.remainingCredits };
  }

  /**
   * Internal: maps elapsed-since-trigger to a transition state.
   * First half → queued, second half → rendering, full duration →
   * ready. Public so tests can assert the curve directly without
   * round-tripping through {@link getRenderStatus}.
   */
  statusForElapsed(elapsedMs: number): RenderStatus {
    if (elapsedMs >= this.readyAfterMs) return "ready";
    if (elapsedMs >= this.readyAfterMs / 2) return "rendering";
    return "queued";
  }
}

/**
 * Spec 54 v2 §6.5 — one fixture URL per render kind (extended in
 * doc 40e A.1 for the five power tools). The `video-thumbnail` role
 * is the route's responsibility post-`ready` (ffmpeg first-frame
 * extraction) and is NOT part of the mock's return shape. The route's
 * elevation-set fan-out makes 4 separate `triggerRender(archdiffusion)`
 * calls; the role tagging happens route-side based on which
 * `camera_direction` was passed.
 */
function buildMockOutputUrls(job: MockJobRequest): string[] {
  if (job.mockKind === "render") {
    return job.request.kind === "video"
      ? [MOCK_VIDEO_URL]
      : [MOCK_ARCHDIFFUSION_URL];
  }
  return [MOCK_TOOL_OUTPUT_URLS[job.mockKind]];
}
