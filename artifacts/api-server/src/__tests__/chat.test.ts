/**
 * /api/chat — happy path, error path, and validation errors.
 *
 * Mocks the Anthropic SDK so .messages.stream returns a deterministic async
 * iterable of SDK-shaped events. The route translates `content_block_delta`
 * events with `text_delta` payloads into SSE `data: {"text":...}\n\n` frames
 * and finishes with `data: [DONE]\n\n`.
 */

import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

interface FakeStreamEvent {
  type: "content_block_delta";
  delta: { type: "text_delta"; text: string };
}

const anthropicMocks = vi.hoisted(() => ({
  /** When set, .messages.stream returns this async iterable. */
  events: null as null | Iterable<FakeStreamEvent>,
  /** When set, .messages.stream throws this synchronously. */
  throwOnStream: null as null | Error,
  /** Captured args from the most recent .messages.stream() call. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lastArgs: null as any,
}));

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("chat.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: {
    messages: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stream: (args: any) => {
        anthropicMocks.lastArgs = args;
        if (anthropicMocks.throwOnStream) throw anthropicMocks.throwOnStream;
        const events = anthropicMocks.events ?? [];
        return {
          [Symbol.asyncIterator]: async function* () {
            for (const e of events) {
              // Tiny await so the route's `for await` actually yields.
              await Promise.resolve();
              yield e;
            }
          },
        };
      },
    },
  },
}));

const { setupRouteTests } = await import("./setup");
const { engagements, snapshots } = await import("@workspace/db");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

async function seedEngagementWithSnapshot(opts?: {
  withSnapshot?: boolean;
}): Promise<{ id: string }> {
  if (!ctx.schema) throw new Error("schema not ready");
  const withSnapshot = opts?.withSnapshot ?? true;
  const [eng] = await ctx.schema.db
    .insert(engagements)
    .values({
      name: "Test Engagement",
      nameLower: `test-engagement-${Math.random().toString(36).slice(2)}`,
      jurisdiction: "Moab, UT",
      address: "123 Main St",
    })
    .returning({ id: engagements.id });
  if (withSnapshot) {
    await ctx.schema.db.insert(snapshots).values({
      engagementId: eng.id,
      projectName: "Test Engagement",
      payload: { sheets: [], rooms: [] },
      sheetCount: 0,
      roomCount: 0,
      levelCount: 0,
      wallCount: 0,
    });
  }
  return { id: eng.id };
}

function parseSseFrames(body: string): Array<Record<string, unknown> | "DONE"> {
  const frames: Array<Record<string, unknown> | "DONE"> = [];
  for (const line of body.split("\n\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") frames.push("DONE");
    else frames.push(JSON.parse(payload));
  }
  return frames;
}

describe("POST /api/chat", () => {
  it("400s when the request body is invalid", async () => {
    const res = await request(getApp())
      .post("/api/chat")
      .send({ engagementId: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid chat request" });
  });

  it("404s when the engagement does not exist", async () => {
    const res = await request(getApp())
      .post("/api/chat")
      .send({
        engagementId: "00000000-0000-0000-0000-000000000000",
        question: "hi",
      });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Engagement not found" });
  });

  it("400 with no_snapshots when the engagement has no snapshot yet", async () => {
    const eng = await seedEngagementWithSnapshot({ withSnapshot: false });
    const res = await request(getApp())
      .post("/api/chat")
      .send({ engagementId: eng.id, question: "hi" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_snapshots");
  });

  it("happy path: streams text deltas as SSE frames followed by [DONE]", async () => {
    anthropicMocks.events = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "lo " } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "world" } },
    ];
    const eng = await seedEngagementWithSnapshot();

    const res = await request(getApp())
      .post("/api/chat")
      .send({ engagementId: eng.id, question: "Anything?" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

    const frames = parseSseFrames(res.text);
    expect(frames).toEqual([
      { text: "Hel" },
      { text: "lo " },
      { text: "world" },
      "DONE",
    ]);
    // The route also forwards the assembled prompt to the SDK — sanity check.
    expect(anthropicMocks.lastArgs).toBeTruthy();
    expect(anthropicMocks.lastArgs.model).toMatch(/^claude-/);
    expect(anthropicMocks.lastArgs.system).toEqual(expect.any(String));
    expect(Array.isArray(anthropicMocks.lastArgs.messages)).toBe(true);
  });

  it("error path: when the SDK throws, emits {error:'stream_failed'} then [DONE]", async () => {
    anthropicMocks.throwOnStream = new Error("upstream 500");
    const eng = await seedEngagementWithSnapshot();

    const res = await request(getApp())
      .post("/api/chat")
      .send({ engagementId: eng.id, question: "Anything?" });
    expect(res.status).toBe(200);

    const frames = parseSseFrames(res.text);
    expect(frames).toEqual([{ error: "stream_failed" }, "DONE"]);

    // Reset for any subsequent tests in this file (afterEach truncates DB but
    // not module-local mock state).
    anthropicMocks.throwOnStream = null;
  });
});
