/**
 * /api/chat — the tool-budget "closing" stream reads its final message and
 * applies the same stop_reason checks as the main loop (G-309 A22 c).
 *
 * The first MAX_AGENT_ITERATIONS streams (the ones sent with `tools`) each end
 * in tool_use; the next stream (no `tools`) is the closing turn and ends with
 * the scripted stop_reason.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

const mocks = vi.hoisted(() => ({
  closingStopReason: "end_turn" as string,
  closingFinalReads: 0,
  toolStreams: 0,
}));

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("chatClosingStream.test: no schema");
      return ctx.schema.db;
    },
  };
});

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: {
    beta: { messages: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stream: (args: any) => {
        const isClosing = !args.tools;
        if (!isClosing) mocks.toolStreams += 1;
        const text = isClosing ? "closing text" : "";
        return {
          [Symbol.asyncIterator]: async function* () {
            if (text) {
              await Promise.resolve();
              yield {
                type: "content_block_delta",
                delta: { type: "text_delta", text },
              };
            }
          },
          finalMessage: async () => {
            if (isClosing) mocks.closingFinalReads += 1;
            return {
              id: "msg_test",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-6",
              stop_reason: isClosing ? mocks.closingStopReason : "tool_use",
              stop_sequence: null,
              content: isClosing
                ? [{ type: "text", text }]
                : [
                    {
                      type: "tool_use",
                      id: `tu_${mocks.toolStreams}`,
                      name: "list_submissions",
                      input: {},
                    },
                  ],
              usage: { input_tokens: 0, output_tokens: 0 },
            };
          },
        };
      },
    } },
  },
}));

const { setupRouteTests } = await import("./setup");
const { engagements } = await import("@workspace/db");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeEach(() => {
  mocks.closingStopReason = "end_turn";
  mocks.closingFinalReads = 0;
  mocks.toolStreams = 0;
});

async function seedEngagement(): Promise<string> {
  if (!ctx.schema) throw new Error("schema not ready");
  const [eng] = await ctx.schema.db
    .insert(engagements)
    .values({
      name: "Closing Engagement",
      nameLower: `closing-${Math.random().toString(36).slice(2)}`,
      jurisdiction: "Moab, UT",
      address: "1 Main St",
    })
    .returning({ id: engagements.id });
  return eng.id;
}

function texts(body: string): string[] {
  const out: string[] = [];
  for (const block of body.split("\n\n")) {
    const t = block.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (payload === "[DONE]") continue;
    const j = JSON.parse(payload) as { text?: string };
    if (typeof j.text === "string") out.push(j.text);
  }
  return out;
}

async function chat(): Promise<string> {
  const engagementId = await seedEngagement();
  const res = await request(getApp())
    .post("/api/chat")
    .send({ engagementId, question: "hi" });
  expect(res.status).toBe(200);
  return res.text;
}

describe("POST /api/chat tool-budget closing stream", () => {
  it("reads the closing final message and passes normal text through", async () => {
    const out = texts(await chat());
    expect(mocks.toolStreams).toBe(8);
    expect(mocks.closingFinalReads).toBe(1);
    expect(out).toEqual(["closing text"]);
  });

  it("sends the fixed refusal line when the closing turn is a refusal", async () => {
    mocks.closingStopReason = "refusal";
    const out = texts(await chat());
    expect(out).toContain("I can't help with that request.");
  });

  it("sends the narrower-question line when the closing turn hits max_tokens", async () => {
    mocks.closingStopReason = "max_tokens";
    const out = texts(await chat());
    expect(out).toContain("That answer ran long; please ask a narrower question.");
  });
});
