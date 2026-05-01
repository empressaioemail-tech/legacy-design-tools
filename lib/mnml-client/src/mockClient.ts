/**
 * Hermetic stand-in for the mnml.ai API. Walks a deterministic
 * `queued → rendering → ready` transition on a configurable timer
 * (default 100 ms total ready) so DA-RP-1's polling logic can exercise
 * real state-machine paths without opening a network socket.
 *
 * Mirrors the {@link MockConverterClient} affordance pattern in
 * `artifacts/api-server/src/lib/converterClient.ts:88` — `alwaysFail`
 * for forcing the failed branch in tests, `fixedRenderId` for pinning
 * the id under test, plus a swappable `now` for clock control.
 */

import { randomUUID } from "node:crypto";
import {
  MnmlError,
  type CancelRenderResult,
  type MnmlClient,
  type RenderOutput,
  type RenderRequest,
  type RenderStatusResult,
  type RenderStatus,
  type TriggerRenderResult,
} from "./types";

/** Spec 54 §5 mock-client construction options. */
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
   * `"failed"` (instead of `"ready"`) with code `internal_error`.
   * Mirrors {@link MockConverterClient.opts.alwaysFail} so the failure
   * branch is exercisable from tests without monkey-patching.
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
}

interface MockRenderState {
  request: RenderRequest;
  createdAt: number;
  cancelled: boolean;
}

/**
 * Fixture URLs the mock client returns. These point at well-known
 * placeholder hosts so any consumer that tries to actually load the
 * asset gets a recognizable "this is the mock" image rather than a
 * broken link. The host is `mnml.ai/mock/...` so log lines self-
 * identify as mock outputs.
 */
const MOCK_STILL_URL = "https://mnml.ai/mock/still.png";
const MOCK_ELEVATION_URLS: Record<
  "elevation-north" | "elevation-east" | "elevation-south" | "elevation-west",
  string
> = {
  "elevation-north": "https://mnml.ai/mock/elevation-north.png",
  "elevation-east": "https://mnml.ai/mock/elevation-east.png",
  "elevation-south": "https://mnml.ai/mock/elevation-south.png",
  "elevation-west": "https://mnml.ai/mock/elevation-west.png",
};
const MOCK_VIDEO_URL = "https://mnml.ai/mock/video.mp4";
const MOCK_VIDEO_THUMB_URL = "https://mnml.ai/mock/video-thumbnail.png";

export class MockMnmlClient implements MnmlClient {
  private readonly readyAfterMs: number;
  private readonly alwaysFail: boolean;
  private readonly fixedRenderId?: string;
  private readonly now: () => number;
  private readonly renders = new Map<string, MockRenderState>();

  constructor(opts: MockMnmlClientOptions = {}) {
    this.readyAfterMs = opts.readyAfterMs ?? 100;
    this.alwaysFail = opts.alwaysFail ?? false;
    this.fixedRenderId = opts.fixedRenderId;
    this.now = opts.now ?? (() => Date.now());
  }

  async triggerRender(input: RenderRequest): Promise<TriggerRenderResult> {
    const renderId = this.fixedRenderId ?? randomUUID();
    this.renders.set(renderId, {
      request: input,
      createdAt: this.now(),
      cancelled: false,
    });
    return { renderId, status: "queued" };
  }

  async getRenderStatus(renderId: string): Promise<RenderStatusResult> {
    const state = this.renders.get(renderId);
    if (!state) {
      throw new MnmlError(
        "invalid_scene",
        `MockMnmlClient: unknown renderId=${renderId}`,
      );
    }
    if (state.cancelled) {
      return { renderId, status: "cancelled" };
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
          code: "internal_error",
          message: "MockMnmlClient: forced failure (alwaysFail=true)",
        },
      };
    }
    return {
      renderId,
      status: "ready",
      outputs: buildMockOutputs(state.request),
    };
  }

  async cancelRender(renderId: string): Promise<CancelRenderResult> {
    const state = this.renders.get(renderId);
    if (!state) {
      throw new MnmlError(
        "invalid_scene",
        `MockMnmlClient: unknown renderId=${renderId}`,
      );
    }
    state.cancelled = true;
    return { renderId, status: "cancelled" };
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

function buildMockOutputs(request: RenderRequest): RenderOutput[] {
  if (request.kind === "still") {
    return [
      {
        role: "primary",
        url: MOCK_STILL_URL,
        format: "png",
        resolution: request.resolution,
        sizeBytes: 0,
        mnmlOutputId: "mock-still",
      },
    ];
  }
  if (request.kind === "elevation") {
    return (
      [
        "elevation-north",
        "elevation-east",
        "elevation-south",
        "elevation-west",
      ] as const
    ).map((role) => ({
      role,
      url: MOCK_ELEVATION_URLS[role],
      format: "png" as const,
      resolution: request.resolution,
      sizeBytes: 0,
      mnmlOutputId: `mock-${role}`,
    }));
  }
  // video
  return [
    {
      role: "video-primary",
      url: MOCK_VIDEO_URL,
      format: "mp4",
      resolution: request.resolution,
      sizeBytes: 0,
      durationSeconds: request.durationSeconds,
      thumbnailUrl: MOCK_VIDEO_THUMB_URL,
      mnmlOutputId: "mock-video-primary",
    },
    {
      role: "video-thumbnail",
      url: MOCK_VIDEO_THUMB_URL,
      format: "png",
      resolution: request.resolution,
      sizeBytes: 0,
      mnmlOutputId: "mock-video-thumbnail",
    },
  ];
}
