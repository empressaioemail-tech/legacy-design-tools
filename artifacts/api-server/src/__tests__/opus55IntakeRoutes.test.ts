/**
 * G-309 A25: the two intake model calls (routes/intake.ts and the
 * plan-review BFF /intake) run on the strong model with the shared guards:
 * no sampling/thinking/tool_choice/prefill params, text blocks only,
 * max_tokens 16000, effort low, refusal and max_tokens are failures,
 * server-side fallback on the beta endpoint. No network.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Pool is lazy; no connection is made (db import only needs the URL set).
process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/unused";

const mocks = vi.hoisted(() => ({
  legacyCreate: vi.fn(),
  betaCreate: vi.fn(),
}));
vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: {
    messages: { create: mocks.legacyCreate },
    beta: { messages: { create: mocks.betaCreate } },
  },
  createAnthropicClient: vi.fn(),
}));
vi.mock("../middlewares/serviceAuth", () => ({
  requireServiceTokenOrSession: (_q: unknown, _s: unknown, next: () => void) =>
    next(),
}));

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(join(here, "..", rel), "utf8");

const GOOD = {
  projectName: "Elm House",
  address: "1 Elm St",
  jurisdiction: "Bastrop, TX",
  projectType: "renovation",
  clientName: "A. Client",
  clientEmail: "a@example.com",
  clientNotes: "n",
  unverifiedFields: ["address"],
  sources: [{ kind: "PASTE", label: "pasted" }],
};
const okResponse = (text = JSON.stringify(GOOD)) => ({
  stop_reason: "end_turn",
  content: [{ type: "text", text }],
});

const { default: intakeRouter } = await import("../routes/intake");
const { default: planReviewRouter } = await import("../routes/planReviewBff");

const intakeApp = express().use(express.json()).use("/api", intakeRouter);
const prApp = express().use(express.json()).use("/plan-review", planReviewRouter);
const intakeCall = () =>
  request(intakeApp).post("/api/intake/parse").send({ mode: "paste", rawContent: "1 Elm St" });
const prCall = () =>
  request(prApp).post("/plan-review/intake").send({ mode: "paste", content: "1 Elm St" });

const ROUTES = [
  ["intake.ts", "routes/intake.ts"],
  ["planReviewBff.ts", "routes/planReviewBff.ts"],
] as const;

beforeEach(() => {
  mocks.legacyCreate.mockReset();
  mocks.betaCreate.mockReset();
});

describe("A25 static guards", () => {
  for (const [name, rel] of ROUTES) {
    it(`${name}: shared constants, no hardcoded model, no rejected params`, () => {
      const s = src(rel);
      expect(s).toContain("model: CODE_CITING_ANTHROPIC_MODEL");
      expect(s).not.toMatch(/claude-sonnet/);
      expect(s).not.toMatch(/model:\s*"claude-/);
      expect(s).toContain("max_tokens: CODE_CITING_MAX_TOKENS");
      expect(s).toContain("output_config: CODE_CITING_OUTPUT_CONFIG_LOW");
      expect(s).toContain("betas: CODE_CITING_FALLBACK_BETAS");
      expect(s).toContain("fallbacks: CODE_CITING_FALLBACKS");
      expect(s).not.toMatch(/\btemperature\s*:/);
      expect(s).not.toMatch(/\btop_[pk]\s*:/);
      expect(s).not.toMatch(/\bthinking\s*:/);
      expect(s).not.toMatch(/tool_choice/);
      expect(s).not.toMatch(/role:\s*"assistant"/);
    });
  }
});

describe("A25 intake.ts (POST /intake/parse)", () => {
  it("calls the beta endpoint with the strong model and shared guards", async () => {
    mocks.betaCreate.mockResolvedValue(okResponse());
    const res = await intakeCall();
    expect(res.status).toBe(200);
    expect(res.body.projectName).toBe("Elm House");
    expect(mocks.legacyCreate).not.toHaveBeenCalled();
    const a = mocks.betaCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(a.model).toBe("claude-opus-5-5");
    expect(a.max_tokens).toBe(16000);
    expect(a.output_config).toEqual({ effort: "low" });
    expect(a.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(a.fallbacks).toBe("default");
    for (const k of ["temperature", "top_p", "top_k", "thinking", "tool_choice"]) {
      expect(k in a).toBe(false);
    }
    const msgs = a.messages as Array<{ role: string }>;
    expect(msgs[msgs.length - 1]!.role).toBe("user");
  });

  it("reads text blocks only (ignores a thinking block)", async () => {
    mocks.betaCreate.mockResolvedValue({
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "{not json}", signature: "s" },
        { type: "text", text: JSON.stringify(GOOD) },
      ],
    });
    const res = await intakeCall();
    expect(res.status).toBe(200);
    expect(res.body.address).toBe("1 Elm St");
  });

  it("stop_reason=refusal is a failure, never parsed output", async () => {
    mocks.betaCreate.mockResolvedValue({ ...okResponse(), stop_reason: "refusal" });
    const res = await intakeCall();
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "intake_parse_invalid_response" });
  });

  it("stop_reason=max_tokens is a failure, never partial output", async () => {
    mocks.betaCreate.mockResolvedValue({ ...okResponse(), stop_reason: "max_tokens" });
    const res = await intakeCall();
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "intake_parse_invalid_response" });
  });

  it("a thrown call keeps the existing 500 shape", async () => {
    mocks.betaCreate.mockRejectedValue(new Error("boom"));
    const res = await intakeCall();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "intake_parse_failed" });
  });
});

describe("A25 planReviewBff.ts (POST /plan-review/intake)", () => {
  it("calls the beta endpoint with the strong model and shared guards", async () => {
    mocks.betaCreate.mockResolvedValue(okResponse());
    const res = await prCall();
    expect(res.status).toBe(200);
    expect(res.body[0].projectName).toBe("Elm House");
    expect(mocks.legacyCreate).not.toHaveBeenCalled();
    const a = mocks.betaCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(a.model).toBe("claude-opus-5-5");
    expect(a.max_tokens).toBe(16000);
    expect(a.output_config).toEqual({ effort: "low" });
    expect(a.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(a.fallbacks).toBe("default");
    for (const k of ["temperature", "top_p", "top_k", "thinking", "tool_choice"]) {
      expect(k in a).toBe(false);
    }
  });

  it("reads text blocks only (thinking block first)", async () => {
    mocks.betaCreate.mockResolvedValue({
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "text", text: JSON.stringify(GOOD) },
      ],
    });
    const res = await prCall();
    expect(res.body[0].projectName).toBe("Elm House");
  });

  for (const stop of ["refusal", "max_tokens"]) {
    it(`stop_reason=${stop} returns the existing raw-material fallback, never the model text`, async () => {
      mocks.betaCreate.mockResolvedValue({ ...okResponse(), stop_reason: stop });
      const res = await prCall();
      expect(mocks.betaCreate).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(200);
      expect(res.body[0].projectName).toBe("");
      expect(res.body[0].unverifiedFields).toEqual(["all"]);
      expect(res.body[0].clientNotes).toBe("1 Elm St");
    });
  }
});
