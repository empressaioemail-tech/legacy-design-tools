/**
 * Factory + boot-validation + singleton + test-override coverage.
 *
 * Each test sets / clears the three env vars (`MNML_RENDER_MODE`,
 * `MNML_API_URL`, `MNML_API_KEY`) inside its own block and resets
 * the cached singleton via `setMnmlClient(null)` afterwards so tests
 * stay independent.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __mnmlClientIsFromEnvForTests,
  createMnmlClient,
  getMnmlClient,
  resolveMnmlRenderMode,
  setMnmlClient,
  validateMnmlEnvAtBoot,
} from "../factory";
import { HttpMnmlClient } from "../httpClient";
import { MockMnmlClient } from "../mockClient";
import type {
  MnmlClient,
  RenderStatusResult,
  TriggerRenderResult,
} from "../types";

const ENV_KEYS = ["MNML_RENDER_MODE", "MNML_API_URL", "MNML_API_KEY"] as const;

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k]!;
  }
}

let envSnap: Record<string, string | undefined>;
beforeEach(() => {
  envSnap = snapshotEnv();
  setMnmlClient(null);
});
afterEach(() => {
  restoreEnv(envSnap);
  setMnmlClient(null);
});

describe("resolveMnmlRenderMode", () => {
  it("defaults to mock when unset", () => {
    delete process.env.MNML_RENDER_MODE;
    expect(resolveMnmlRenderMode()).toBe("mock");
  });
  it("returns http when set to http (case-insensitive)", () => {
    process.env.MNML_RENDER_MODE = "HTTP";
    expect(resolveMnmlRenderMode()).toBe("http");
  });
  it("falls back to mock for any unrecognized value", () => {
    process.env.MNML_RENDER_MODE = "weird";
    expect(resolveMnmlRenderMode()).toBe("mock");
  });
});

describe("createMnmlClient", () => {
  it("returns a MockMnmlClient in mock mode (default)", () => {
    delete process.env.MNML_RENDER_MODE;
    const client = createMnmlClient();
    expect(client).toBeInstanceOf(MockMnmlClient);
  });

  it("returns an HttpMnmlClient when http mode + both secrets are set", () => {
    process.env.MNML_RENDER_MODE = "http";
    process.env.MNML_API_URL = "https://api.mnml.test";
    process.env.MNML_API_KEY = "test-key";
    const client = createMnmlClient();
    expect(client).toBeInstanceOf(HttpMnmlClient);
  });

  it("throws naming MNML_API_URL when only MNML_API_KEY is set", () => {
    process.env.MNML_RENDER_MODE = "http";
    delete process.env.MNML_API_URL;
    process.env.MNML_API_KEY = "test-key";
    expect(() => createMnmlClient()).toThrow(/MNML_API_URL/);
  });

  it("throws naming both secrets when neither is set", () => {
    process.env.MNML_RENDER_MODE = "http";
    delete process.env.MNML_API_URL;
    delete process.env.MNML_API_KEY;
    expect(() => createMnmlClient()).toThrow(/MNML_API_URL and MNML_API_KEY/);
  });
});

describe("validateMnmlEnvAtBoot", () => {
  it("succeeds in mock mode (default) with no secrets configured", () => {
    delete process.env.MNML_RENDER_MODE;
    delete process.env.MNML_API_URL;
    delete process.env.MNML_API_KEY;
    expect(() => validateMnmlEnvAtBoot()).not.toThrow();
  });

  it("succeeds in http mode when both secrets are set", () => {
    process.env.MNML_RENDER_MODE = "http";
    process.env.MNML_API_URL = "https://api.mnml.test";
    process.env.MNML_API_KEY = "test-key";
    expect(() => validateMnmlEnvAtBoot()).not.toThrow();
  });

  it("fails fast in http mode without MNML_API_URL", () => {
    process.env.MNML_RENDER_MODE = "http";
    delete process.env.MNML_API_URL;
    process.env.MNML_API_KEY = "test-key";
    expect(() => validateMnmlEnvAtBoot()).toThrow(/MNML_API_URL/);
  });

  it("fails fast in http mode without MNML_API_KEY", () => {
    process.env.MNML_RENDER_MODE = "http";
    process.env.MNML_API_URL = "https://api.mnml.test";
    delete process.env.MNML_API_KEY;
    expect(() => validateMnmlEnvAtBoot()).toThrow(/MNML_API_KEY/);
  });
});

describe("getMnmlClient + setMnmlClient singleton", () => {
  it("caches the env-derived client across calls", () => {
    delete process.env.MNML_RENDER_MODE;
    const a = getMnmlClient();
    const b = getMnmlClient();
    expect(a).toBe(b);
    expect(__mnmlClientIsFromEnvForTests()).toBe(true);
  });

  it("setMnmlClient(fake) overrides the singleton and flips the env-marker", () => {
    const fake: MnmlClient = {
      triggerRender: async (): Promise<TriggerRenderResult> => ({
        renderId: "fake",
        remainingCredits: 100,
      }),
      getRenderStatus: async (renderId: string): Promise<RenderStatusResult> => ({
        renderId,
        status: "ready",
      }),
    };
    setMnmlClient(fake);
    expect(getMnmlClient()).toBe(fake);
    expect(__mnmlClientIsFromEnvForTests()).toBe(false);
  });

  it("setMnmlClient(null) resets back to the env factory", () => {
    const fake: MnmlClient = {
      triggerRender: async (): Promise<TriggerRenderResult> => ({
        renderId: "x",
        remainingCredits: 0,
      }),
      getRenderStatus: async (renderId: string): Promise<RenderStatusResult> => ({
        renderId,
        status: "ready",
      }),
    };
    setMnmlClient(fake);
    setMnmlClient(null);
    delete process.env.MNML_RENDER_MODE;
    const fresh = getMnmlClient();
    expect(fresh).toBeInstanceOf(MockMnmlClient);
    expect(__mnmlClientIsFromEnvForTests()).toBe(true);
  });
});
