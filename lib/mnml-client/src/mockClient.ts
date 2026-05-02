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
 */

import { randomUUID } from "node:crypto";
import {
  MnmlError,
  type MnmlClient,
  type RenderRequest,
  type RenderStatus,
  type RenderStatusResult,
  type TriggerRenderResult,
} from "./types";

/** Spec 54 v2 §4 — static per-operation credit cost. */
const COST_PER_KIND = { archdiffusion: 3, video: 10 } as const;

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

interface MockRenderState {
  request: RenderRequest;
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
      request: input,
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
      outputUrls: buildMockOutputUrls(state.request),
      seed: MOCK_SEED,
    };
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
 * Spec 54 v2 §6.5 — one fixture URL per render kind. The
 * `video-thumbnail` role is the route's responsibility post-`ready`
 * (ffmpeg first-frame extraction) and is NOT part of the mock's
 * return shape. The route's elevation-set fan-out makes 4 separate
 * `triggerRender(archdiffusion)` calls; the role tagging happens
 * route-side based on which `camera_direction` was passed.
 */
function buildMockOutputUrls(request: RenderRequest): string[] {
  if (request.kind === "video") {
    return [MOCK_VIDEO_URL];
  }
  return [MOCK_ARCHDIFFUSION_URL];
}
