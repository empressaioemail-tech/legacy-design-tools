/**
 * brokerageAuth.ts — extension_public tier retirement (operator ruling
 * 2026-09-07: "cut the chrome extension we don't need it"). Confirmed dead
 * in production before retiring: 248 brokerage_brief_runs total ever, zero
 * since 2026-08-09. These are pure unit tests (no DB, no Express app) —
 * the same retirement is also asserted at the route level in
 * brokerageBrief.test.ts against a real request.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadBrokerageApiKeys,
  resetBrokerageApiKeysForTests,
  resolveBrokerageClientTier,
} from "./brokerageAuth";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  resetBrokerageApiKeysForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetBrokerageApiKeysForTests();
});

describe("extension_public tier — retired", () => {
  it("BROKERAGE_EXTENSION_PUBLIC_KEY is never loaded as a recognized key, even when set", () => {
    process.env.BROKERAGE_EXTENSION_PUBLIC_KEY = "some-real-extension-key";
    process.env.BROKERAGE_OPERATOR_API_KEYS = "operator-key-1";
    const keys = loadBrokerageApiKeys();
    expect(keys.has("some-real-extension-key")).toBe(false);
    expect(keys.has("operator-key-1")).toBe(true);
  });

  it("resolveBrokerageClientTier never returns extension_public, for any input including the real former key value", () => {
    process.env.BROKERAGE_EXTENSION_PUBLIC_KEY = "some-real-extension-key";
    expect(resolveBrokerageClientTier("some-real-extension-key")).toBe("operator");
    expect(resolveBrokerageClientTier("anything-else")).toBe("operator");
    expect(resolveBrokerageClientTier("")).toBe("operator");
  });

  it("a lone BROKERAGE_EXTENSION_PUBLIC_KEY with no other keys configured leaves the key set empty (the 503 unconfigured path, not a live tier)", () => {
    process.env.BROKERAGE_EXTENSION_PUBLIC_KEY = "some-real-extension-key";
    delete process.env.BROKERAGE_OPERATOR_API_KEYS;
    delete process.env.BROKERAGE_API_KEYS;
    const keys = loadBrokerageApiKeys();
    expect(keys.size).toBe(0);
  });
});
