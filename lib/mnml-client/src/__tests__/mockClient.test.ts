/**
 * MockMnmlClient — covers the deterministic-output shape per render
 * kind (Spec 54 v2 §6.5: archdiffusion → 1 url; video → 1 url, no
 * thumbnail), the queued → rendering → ready transition curve, the
 * `alwaysFail` failure-branch affordance, the unknown-renderId
 * error path, and the `remainingCredits` simulation.
 *
 * The transition tests use an injected clock (the `now` option) so
 * the suite stays deterministic and fast — no real `setTimeout`
 * sleeping. A separate test exercises the real Date.now() default
 * with a small `readyAfterMs` to confirm the timer wiring works
 * against a wall clock too.
 */

import { describe, expect, it } from "vitest";
import { MockMnmlClient } from "../mockClient";
import { MnmlError } from "../types";
import type { ArchDiffusionRequest, VideoAiRequest } from "../types";

const ARCHDIFFUSION_STILL: ArchDiffusionRequest = {
  kind: "archdiffusion",
  image: new Blob([new Uint8Array([0xff, 0xd8, 0xff])]),
  prompt: "a small modern home on a hillside, photoreal",
  expertName: "exterior",
  renderStyle: "photoreal",
  expertParams: {
    camera_angle: "eye_level",
    camera_direction: "front",
  },
};

const ARCHDIFFUSION_ELEVATION_NORTH: ArchDiffusionRequest = {
  kind: "archdiffusion",
  image: new Blob([new Uint8Array([0xff, 0xd8, 0xff])]),
  prompt: "north elevation of the same home",
  expertName: "exterior",
  renderStyle: "photoreal",
  expertParams: {
    camera_angle: "elevation",
    camera_direction: "back",
  },
};

const VIDEO: VideoAiRequest = {
  kind: "video",
  image: new Blob([new Uint8Array([0xff, 0xd8, 0xff])]),
  prompt: "slow horizontal camera move across the home",
  duration: 10,
  movementType: "horizontal",
  direction: "right",
};

describe("MockMnmlClient — deterministic outputs", () => {
  it("returns one archdiffusion url on a still render", async () => {
    const client = new MockMnmlClient({ readyAfterMs: 0 });
    const { renderId } = await client.triggerRender(ARCHDIFFUSION_STILL);
    const status = await client.getRenderStatus(renderId);
    expect(status.status).toBe("ready");
    expect(status.outputUrls).toHaveLength(1);
    expect(status.outputUrls![0]).toContain("mnml.ai/mock/archdiffusion");
    expect(status.seed).toBe(12345);
  });

  it("returns one archdiffusion url on each elevation-set member call", async () => {
    // Spec 54 v2 §6.2: elevation-set fan-out lives in the api-server
    // route (4 separate triggerRender calls). The mock itself stays
    // single-call — each call returns 1 archdiffusion url. Role
    // tagging happens route-side based on the camera_direction.
    const client = new MockMnmlClient({ readyAfterMs: 0 });
    const { renderId } = await client.triggerRender(
      ARCHDIFFUSION_ELEVATION_NORTH,
    );
    const status = await client.getRenderStatus(renderId);
    expect(status.status).toBe("ready");
    expect(status.outputUrls).toHaveLength(1);
    expect(status.outputUrls![0]).toContain("mnml.ai/mock/archdiffusion");
  });

  it("returns one video url on a video render (no thumbnail)", async () => {
    // Spec 54 v2 §6.5: mock returns one video url; the video-
    // thumbnail render-output role is server-synthesized post-`ready`
    // by the api-server route via ffmpeg first-frame extraction, NOT
    // by the mock or the http client.
    const client = new MockMnmlClient({ readyAfterMs: 0 });
    const { renderId } = await client.triggerRender(VIDEO);
    const status = await client.getRenderStatus(renderId);
    expect(status.status).toBe("ready");
    expect(status.outputUrls).toHaveLength(1);
    expect(status.outputUrls![0]).toContain("mnml.ai/mock/video");
    expect(status.outputUrls![0]).toContain(".mp4");
  });

  it("uses fixedRenderId when provided", async () => {
    const client = new MockMnmlClient({ fixedRenderId: "render-abc-123" });
    const result = await client.triggerRender(ARCHDIFFUSION_STILL);
    expect(result.renderId).toBe("render-abc-123");
  });
});

describe("MockMnmlClient — remainingCredits simulation (Spec 54 v2 §4)", () => {
  it("decrements 3 credits per archdiffusion trigger", async () => {
    const client = new MockMnmlClient({ startingCredits: 100 });
    const a = await client.triggerRender(ARCHDIFFUSION_STILL);
    expect(a.remainingCredits).toBe(97);
    const b = await client.triggerRender(ARCHDIFFUSION_STILL);
    expect(b.remainingCredits).toBe(94);
  });

  it("decrements 10 credits per video trigger", async () => {
    const client = new MockMnmlClient({ startingCredits: 100 });
    const result = await client.triggerRender(VIDEO);
    expect(result.remainingCredits).toBe(90);
  });

  it("defaults the starting balance to 1000 when not pinned", async () => {
    const client = new MockMnmlClient();
    const { remainingCredits } = await client.triggerRender(ARCHDIFFUSION_STILL);
    expect(remainingCredits).toBe(997);
  });
});

describe("MockMnmlClient — queued → rendering → ready transition", () => {
  it("walks the configured timer with an injected clock", async () => {
    let now = 1_000;
    const client = new MockMnmlClient({
      readyAfterMs: 200,
      now: () => now,
    });
    const { renderId } = await client.triggerRender(ARCHDIFFUSION_STILL);

    // t=0 → queued
    expect((await client.getRenderStatus(renderId)).status).toBe("queued");

    // t=99 (< 100 = readyAfterMs/2) → still queued
    now = 1_099;
    expect((await client.getRenderStatus(renderId)).status).toBe("queued");

    // t=100 (>= readyAfterMs/2) → rendering
    now = 1_100;
    expect((await client.getRenderStatus(renderId)).status).toBe("rendering");

    // t=199 → still rendering
    now = 1_199;
    expect((await client.getRenderStatus(renderId)).status).toBe("rendering");

    // t=200 → ready
    now = 1_200;
    const ready = await client.getRenderStatus(renderId);
    expect(ready.status).toBe("ready");
    expect(ready.outputUrls).toBeDefined();
  });

  it("statusForElapsed maps elapsed → state per the half-half rule", () => {
    const client = new MockMnmlClient({ readyAfterMs: 100 });
    expect(client.statusForElapsed(0)).toBe("queued");
    expect(client.statusForElapsed(49)).toBe("queued");
    expect(client.statusForElapsed(50)).toBe("rendering");
    expect(client.statusForElapsed(99)).toBe("rendering");
    expect(client.statusForElapsed(100)).toBe("ready");
    expect(client.statusForElapsed(10_000)).toBe("ready");
  });

  it("walks the transition against the real Date.now() default", async () => {
    const client = new MockMnmlClient({ readyAfterMs: 30 });
    const { renderId } = await client.triggerRender(ARCHDIFFUSION_STILL);
    const initial = await client.getRenderStatus(renderId);
    expect(initial.status).toBe("queued");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const after = await client.getRenderStatus(renderId);
    expect(after.status).toBe("ready");
    expect(after.outputUrls).toBeDefined();
  });
});

describe("MockMnmlClient — failure + unknown-id paths", () => {
  it("alwaysFail flips the terminal status to failed (MOCK_FORCED)", async () => {
    const client = new MockMnmlClient({
      alwaysFail: true,
      readyAfterMs: 0,
    });
    const { renderId } = await client.triggerRender(ARCHDIFFUSION_STILL);
    const status = await client.getRenderStatus(renderId);
    expect(status.status).toBe("failed");
    expect(status.error?.code).toBe("MOCK_FORCED");
    expect(status.error?.message).toContain("forced failure");
  });

  it("throws MnmlError(not_found) for an unknown renderId", async () => {
    const client = new MockMnmlClient();
    await expect(client.getRenderStatus("nope")).rejects.toBeInstanceOf(
      MnmlError,
    );
    await expect(client.getRenderStatus("nope")).rejects.toMatchObject({
      kind: "not_found",
      code: "UNKNOWN_RENDER_ID",
    });
  });
});
