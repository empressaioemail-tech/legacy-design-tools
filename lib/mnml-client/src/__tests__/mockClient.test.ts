/**
 * MockMnmlClient — covers the deterministic-output shape per render
 * kind, the queued → rendering → ready transition curve, the
 * `alwaysFail` failure-branch affordance, the cancel happy path, and
 * the unknown-renderId error path.
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
import type {
  ElevationRenderRequest,
  ExteriorOrbitVideoRequest,
  StillRenderRequest,
} from "../types";

const STILL: StillRenderRequest = {
  kind: "still",
  cameraPosition: { x: 0, y: 0, z: 0 },
  cameraTarget: { x: 1, y: 0, z: 0 },
  fieldOfView: 35,
  resolution: "1920x1080",
};

const ELEVATION: ElevationRenderRequest = {
  kind: "elevation",
  buildingCenter: { x: 0, y: 0, z: 0 },
  cameraDistance: 30,
  cameraHeight: 5,
  resolution: "3840x2160",
};

const VIDEO: ExteriorOrbitVideoRequest = {
  kind: "video",
  pathKind: "exterior-orbit",
  durationSeconds: 30,
  resolution: "1920x1080",
  framerate: 30,
};

describe("MockMnmlClient — deterministic outputs", () => {
  it("returns one primary png output for a still render", async () => {
    const client = new MockMnmlClient({ readyAfterMs: 0 });
    const { renderId } = await client.triggerRender(STILL);
    const status = await client.getRenderStatus(renderId);
    expect(status.status).toBe("ready");
    expect(status.outputs).toHaveLength(1);
    expect(status.outputs![0]!.role).toBe("primary");
    expect(status.outputs![0]!.format).toBe("png");
    expect(status.outputs![0]!.url).toContain("mnml.ai/mock/still");
    expect(status.outputs![0]!.resolution).toBe("1920x1080");
  });

  it("returns four cardinal elevation outputs for an elevation render", async () => {
    const client = new MockMnmlClient({ readyAfterMs: 0 });
    const { renderId } = await client.triggerRender(ELEVATION);
    const status = await client.getRenderStatus(renderId);
    expect(status.status).toBe("ready");
    const roles = status.outputs!.map((o) => o.role).sort();
    expect(roles).toEqual([
      "elevation-east",
      "elevation-north",
      "elevation-south",
      "elevation-west",
    ]);
    for (const out of status.outputs!) {
      expect(out.format).toBe("png");
      expect(out.resolution).toBe("3840x2160");
      expect(out.url).toContain("mnml.ai/mock/elevation");
    }
  });

  it("returns video-primary + video-thumbnail for a video render", async () => {
    const client = new MockMnmlClient({ readyAfterMs: 0 });
    const { renderId } = await client.triggerRender(VIDEO);
    const status = await client.getRenderStatus(renderId);
    expect(status.status).toBe("ready");
    expect(status.outputs).toHaveLength(2);
    const primary = status.outputs!.find((o) => o.role === "video-primary");
    expect(primary).toBeTruthy();
    expect(primary!.format).toBe("mp4");
    expect(primary!.durationSeconds).toBe(30);
    expect(primary!.thumbnailUrl).toContain("video-thumbnail");
    const thumb = status.outputs!.find((o) => o.role === "video-thumbnail");
    expect(thumb).toBeTruthy();
    expect(thumb!.format).toBe("png");
  });

  it("uses fixedRenderId when provided", async () => {
    const client = new MockMnmlClient({ fixedRenderId: "render-abc-123" });
    const result = await client.triggerRender(STILL);
    expect(result.renderId).toBe("render-abc-123");
    expect(result.status).toBe("queued");
  });
});

describe("MockMnmlClient — queued → rendering → ready transition", () => {
  it("walks the configured timer with an injected clock", async () => {
    let now = 1_000;
    const client = new MockMnmlClient({
      readyAfterMs: 200,
      now: () => now,
    });
    const { renderId } = await client.triggerRender(STILL);

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
    expect(ready.outputs).toBeDefined();
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
    const { renderId } = await client.triggerRender(STILL);
    const initial = await client.getRenderStatus(renderId);
    expect(initial.status).toBe("queued");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const after = await client.getRenderStatus(renderId);
    expect(after.status).toBe("ready");
    expect(after.outputs).toBeDefined();
  });
});

describe("MockMnmlClient — failure + cancel + unknown-id paths", () => {
  it("alwaysFail flips the terminal status to failed", async () => {
    const client = new MockMnmlClient({
      alwaysFail: true,
      readyAfterMs: 0,
    });
    const { renderId } = await client.triggerRender(STILL);
    const status = await client.getRenderStatus(renderId);
    expect(status.status).toBe("failed");
    expect(status.error?.code).toBe("internal_error");
    expect(status.error?.message).toContain("forced failure");
  });

  it("cancelRender flips status to cancelled even after ready time", async () => {
    let now = 0;
    const client = new MockMnmlClient({
      readyAfterMs: 100,
      now: () => now,
    });
    const { renderId } = await client.triggerRender(STILL);
    const cancelled = await client.cancelRender(renderId);
    expect(cancelled.status).toBe("cancelled");

    // Even at t > readyAfterMs the cancelled flag wins.
    now = 1_000;
    const status = await client.getRenderStatus(renderId);
    expect(status.status).toBe("cancelled");
  });

  it("throws MnmlError(invalid_scene) for an unknown renderId", async () => {
    const client = new MockMnmlClient();
    await expect(client.getRenderStatus("nope")).rejects.toBeInstanceOf(
      MnmlError,
    );
    await expect(client.cancelRender("nope")).rejects.toBeInstanceOf(MnmlError);
  });
});
