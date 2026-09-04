/**
 * POST /api/pe-help/chat — P-118 Help widget backend.
 *
 * Mocks the Anthropic SDK (same convention as chat.test.ts — TESTING.md's
 * "Mocked LLM" rule: no real network call from a test). What THIS suite
 * proves that a mock alone cannot: the route is reachable with zero auth of
 * any kind, and the exact PRODUCTION system prompt (imported for real, never
 * a shortened test placeholder) is what actually gets sent to the model.
 */

import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

const anthropicMocks = vi.hoisted(() => ({
  /** When set, .messages.create resolves with this Message. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: null as any,
  /** When set, .messages.create rejects with this Error. */
  throwOnCreate: null as null | Error,
  /** Captured args from the most recent .messages.create() call. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lastArgs: null as any,
}));

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("peHelp.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: {
    messages: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: async (args: any) => {
        anthropicMocks.lastArgs = args;
        if (anthropicMocks.throwOnCreate) throw anthropicMocks.throwOnCreate;
        return (
          anthropicMocks.response ?? {
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            stop_reason: "end_turn",
            stop_sequence: null,
            content: [{ type: "text", text: "default test answer" }],
            usage: { input_tokens: 0, output_tokens: 0 },
          }
        );
      },
    },
  },
}));

const { setupRouteTests } = await import("./setup");
const { PE_HELP_WIDGET_SYSTEM_PROMPT } = await import(
  "../lib/peHelpWidgetPrompt"
);

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

describe("POST /api/pe-help/chat", () => {
  it("succeeds with ZERO auth of any kind — no cookie, no API key, no install id", async () => {
    anthropicMocks.response = {
      content: [{ type: "text", text: "Solo is $49/month." }],
      stop_reason: "end_turn",
    };
    const res = await request(getApp())
      .post("/api/pe-help/chat")
      .send({ message: "What does Solo cost?" });
    // No .set() of any auth header at all — this is the whole point of the
    // route, and every other route in this file set would 401/403 here.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: "Solo is $49/month." });
  });

  it("sends the REAL production system prompt, not a placeholder", async () => {
    await request(getApp())
      .post("/api/pe-help/chat")
      .send({ message: "How does sharing work?" });
    expect(anthropicMocks.lastArgs.system).toBe(PE_HELP_WIDGET_SYSTEM_PROMPT);
    // Sanity: the real prompt is long and grounded, not a stub string.
    expect(PE_HELP_WIDGET_SYSTEM_PROMPT.length).toBeGreaterThan(2000);
  });

  it("forwards the message as the final user turn", async () => {
    await request(getApp())
      .post("/api/pe-help/chat")
      .send({ message: "What is the X-ray?" });
    const messages = anthropicMocks.lastArgs.messages;
    expect(messages[messages.length - 1]).toEqual({
      role: "user",
      content: "What is the X-ray?",
    });
  });

  it("accepts up to 8 history turns and forwards all of them in order", async () => {
    const history = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `turn ${i}`,
    }));
    const res = await request(getApp())
      .post("/api/pe-help/chat")
      .send({ message: "latest", history });
    expect(res.status).toBe(200);
    const messages = anthropicMocks.lastArgs.messages;
    // 8 history turns + the new user message = 9.
    expect(messages).toHaveLength(9);
    expect(messages[0]).toEqual({ role: "user", content: "turn 0" });
    expect(messages[8]).toEqual({ role: "user", content: "latest" });
  });

  it("400s on more than 8 history turns — fails closed, never silently truncates", async () => {
    const history = Array.from({ length: 9 }, (_, i) => ({
      role: "user" as const,
      content: `turn ${i}`,
    }));
    const res = await request(getApp())
      .post("/api/pe-help/chat")
      .send({ message: "latest", history });
    expect(res.status).toBe(400);
  });

  it("400s on a missing message", async () => {
    const res = await request(getApp()).post("/api/pe-help/chat").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("400s on an empty message", async () => {
    const res = await request(getApp())
      .post("/api/pe-help/chat")
      .send({ message: "   " });
    expect(res.status).toBe(400);
  });

  it("400s on an oversized message rather than forwarding it uncapped", async () => {
    const res = await request(getApp())
      .post("/api/pe-help/chat")
      .send({ message: "x".repeat(5000) });
    expect(res.status).toBe(400);
  });

  it("400s on a malformed history entry (wrong role)", async () => {
    const res = await request(getApp())
      .post("/api/pe-help/chat")
      .send({ message: "hi", history: [{ role: "system", content: "x" }] });
    expect(res.status).toBe(400);
  });

  it("returns an HONEST error when the model call fails — never a fabricated answer", async () => {
    anthropicMocks.throwOnCreate = new Error("upstream boom");
    const res = await request(getApp())
      .post("/api/pe-help/chat")
      .send({ message: "anything" });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("upstream_error");
    // The failure body must not contain an invented "message" answer field
    // shaped like a real reply.
    expect(res.body.message).not.toMatch(/\$49|Solo|X-ray/);
    anthropicMocks.throwOnCreate = null;
  });

  it("returns an honest 502 when the model responds with no text content", async () => {
    anthropicMocks.response = { content: [], stop_reason: "end_turn" };
    const res = await request(getApp())
      .post("/api/pe-help/chat")
      .send({ message: "anything" });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("no_answer");
  });
});
