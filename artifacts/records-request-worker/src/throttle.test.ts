import { describe, expect, it, vi } from "vitest";
import {
  createPortalActionThrottle,
  parseThrottleMsFromEnv,
} from "./throttle.js";

describe("parseThrottleMsFromEnv", () => {
  it("defaults to 2000ms when unset", () => {
    expect(parseThrottleMsFromEnv({})).toBe(2000);
  });

  it("reads RECORDS_REQUEST_THROTTLE_MS", () => {
    expect(
      parseThrottleMsFromEnv({ RECORDS_REQUEST_THROTTLE_MS: "500" }),
    ).toBe(500);
  });
});

describe("createPortalActionThrottle", () => {
  it("waits minimum delay between actions", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let nowMs = 0;
    const throttle = createPortalActionThrottle({
      minDelayMs: 100,
      now: () => nowMs,
      sleep,
    });

    await throttle.beforeAction();
    nowMs = 40;
    await throttle.beforeAction();

    expect(sleep).toHaveBeenCalledWith(60);
  });

  it("does not sleep before the first action", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const throttle = createPortalActionThrottle({
      minDelayMs: 100,
      sleep,
    });

    await throttle.beforeAction();

    expect(sleep).not.toHaveBeenCalled();
  });
});
