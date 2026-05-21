/**
 * WS-C — in-app Cortex agent tool-use loop.
 *
 * Covers the five WS-C sub-tasks against the real route + a real Postgres
 * schema, with the Anthropic SDK mocked to script a multi-turn tool-use
 * conversation: each `.stream()` call shifts the next scripted turn, so a
 * turn ending in `tool_use` drives the route to execute a tool in-process
 * and loop, and a turn ending in `end_turn` closes the stream.
 *
 *   WSC.1/2 — the agent calls a read tool, gets a result, streams an answer.
 *   WSC.3   — `create_response_tasks` inserts rows visible via GET.
 *   WSC.4   — `draft_detail_callout_spec` validates + emits a draft, persists
 *             nothing.
 *   WSC.5   — agent-created task carries the AI-origin marker + provenance
 *             footer; it is reversible via the L1 `cancelled` state.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

interface FakeTextEvent {
  type: "content_block_delta";
  delta: { type: "text_delta"; text: string };
}
interface FakeContentBlock {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}
interface FakeTurn {
  events: FakeTextEvent[];
  stopReason: "end_turn" | "tool_use";
  content: FakeContentBlock[];
}

const anthropicMocks = vi.hoisted(() => ({
  /** Scripted turns; each `.stream()` call shifts the next one. */
  turns: [] as FakeTurn[],
  /** Captured args of every `.stream()` call. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  streamCalls: [] as any[],
}));

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("chat-agent-tools.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: {
    messages: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stream: (args: any) => {
        anthropicMocks.streamCalls.push(args);
        const turn: FakeTurn =
          anthropicMocks.turns.shift() ?? {
            events: [],
            stopReason: "end_turn",
            content: [],
          };
        return {
          [Symbol.asyncIterator]: async function* () {
            for (const e of turn.events) {
              await Promise.resolve();
              yield e;
            }
          },
          finalMessage: async () => ({
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
            stop_reason: turn.stopReason,
            content: turn.content,
          }),
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

beforeEach(() => {
  anthropicMocks.turns = [];
  anthropicMocks.streamCalls = [];
});

function textEvent(text: string): FakeTextEvent {
  return { type: "content_block_delta", delta: { type: "text_delta", text } };
}

/** A turn that ends by calling one tool. */
function toolTurn(name: string, input: unknown, id = "tu_1"): FakeTurn {
  return {
    events: [],
    stopReason: "tool_use",
    content: [{ type: "tool_use", id, name, input }],
  };
}

/** A turn that ends with a plain text answer. */
function answerTurn(text: string): FakeTurn {
  return {
    events: [textEvent(text)],
    stopReason: "end_turn",
    content: [{ type: "text", text }],
  };
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

async function seedEngagement(): Promise<{ id: string }> {
  if (!ctx.schema) throw new Error("schema not ready");
  const [eng] = await ctx.schema.db
    .insert(engagements)
    .values({
      name: "Agent Tools Engagement",
      nameLower: `agent-tools-${Math.random().toString(36).slice(2)}`,
      jurisdiction: "Moab, UT",
      address: "1 Test Way",
    })
    .returning({ id: engagements.id });
  await ctx.schema.db.insert(snapshots).values({
    engagementId: eng.id,
    projectName: "Agent Tools Engagement",
    payload: { sheets: [], rooms: [] },
    sheetCount: 0,
    roomCount: 0,
    levelCount: 0,
    wallCount: 0,
  });
  return { id: eng.id };
}

describe("WS-C in-app agent tool-use", () => {
  it("WSC.1/2: calls a read tool, receives a result, and streams a final answer", async () => {
    const eng = await seedEngagement();
    anthropicMocks.turns = [
      toolTurn("list_response_tasks", {}),
      answerTurn("There are no response tasks on this engagement yet."),
    ];

    const res = await request(getApp())
      .post("/api/chat")
      .send({
        engagementId: eng.id,
        question: "what response tasks are open?",
        activeTab: "response-tasks",
      });

    expect(res.status).toBe(200);
    const frames = parseSseFrames(res.text);
    // The route emitted a tool-use status frame for the read tool.
    expect(frames).toContainEqual({
      type: "tool_use",
      tool: "list_response_tasks",
    });
    // ...then streamed the model's final text answer, then [DONE].
    expect(
      frames.some((f) => typeof f === "object" && typeof f.text === "string"),
    ).toBe(true);
    expect(frames.at(-1)).toBe("DONE");
    // One tool round-trip == two `.stream()` calls; tools were offered.
    expect(anthropicMocks.streamCalls).toHaveLength(2);
    expect(Array.isArray(anthropicMocks.streamCalls[0].tools)).toBe(true);
    expect(
      anthropicMocks.streamCalls[0].tools.some(
        (t: { name: string }) => t.name === "create_response_tasks",
      ),
    ).toBe(true);
    // The ambient active-tab context reached the system prompt.
    expect(String(anthropicMocks.streamCalls[0].system)).toContain(
      '"response-tasks" tab',
    );
  });

  it("WSC.3: create_response_tasks inserts rows visible via GET /response-tasks", async () => {
    const eng = await seedEngagement();
    anthropicMocks.turns = [
      toolTurn("create_response_tasks", {
        tasks: [
          {
            title: "Widen the egress door",
            description: "Door 101A is below the 32in clear-width minimum.",
            reasoning: "derived from a code-clearance review",
            findingId: "finding:abc:1",
            severity: "high",
            confidence: 0.92,
          },
          {
            title: "Add a handrail extension at Stair 2",
            reasoning: "derived from a code-clearance review",
          },
        ],
      }),
      answerTurn("Created two response tasks."),
    ];

    const res = await request(getApp())
      .post("/api/chat")
      .send({ engagementId: eng.id, question: "push these to response tasks" });
    expect(res.status).toBe(200);

    const frames = parseSseFrames(res.text);
    const actions = frames.filter(
      (f) => typeof f === "object" && f.type === "agent_action",
    );
    expect(actions).toHaveLength(2);

    const list = await request(getApp()).get(
      `/api/engagements/${eng.id}/response-tasks`,
    );
    expect(list.status).toBe(200);
    expect(list.body.responseTasks).toHaveLength(2);
    const titles = list.body.responseTasks.map(
      (t: { title: string }) => t.title,
    );
    expect(titles).toContain("Widen the egress door");
    expect(titles).toContain("Add a handrail extension at Stair 2");
    for (const t of list.body.responseTasks) {
      expect(t.state).toBe("open");
    }
  });

  it("WSC.5: an agent-created task carries the AI-origin marker + provenance and is reversible", async () => {
    const eng = await seedEngagement();
    anthropicMocks.turns = [
      toolTurn("create_response_tasks", {
        tasks: [
          {
            title: "Resolve the setback encroachment",
            description: "Update the site plan.",
            reasoning: "the rear setback reads 4ft against a 10ft minimum",
            findingId: "finding:abc:2",
            severity: "medium",
            confidence: 0.71,
          },
        ],
      }),
      answerTurn("Created the task."),
    ];

    await request(getApp())
      .post("/api/chat")
      .send({ engagementId: eng.id, question: "open a task for this" });

    const list = await request(getApp()).get(
      `/api/engagements/${eng.id}/response-tasks`,
    );
    expect(list.body.responseTasks).toHaveLength(1);
    const task = list.body.responseTasks[0];

    // AI-origin marker on the atom itself.
    expect(task.actorId).toBe("cortex-in-app-agent");
    // Provenance footer rides the description (no new persistence).
    expect(task.description).toContain("Update the site plan.");
    expect(task.description).toContain("[AI-drafted by the Cortex in-app agent]");
    expect(task.description).toContain(
      "the rear setback reads 4ft against a 10ft minimum",
    );
    expect(task.description).toContain("finding finding:abc:2");
    expect(task.description).toContain("severity medium");
    expect(task.description).toContain("confidence 0.71");

    // Reversible: the agent-action log's "reverse" cancels the task.
    const cancel = await request(getApp())
      .post(`/api/response-tasks/${task.entityId}/state`)
      .send({ state: "cancelled" });
    expect(cancel.status).toBe(200);
    expect(cancel.body.responseTask.state).toBe("cancelled");
  });

  it("WSC.4: draft_detail_callout_spec validates, emits a draft, and persists nothing", async () => {
    const eng = await seedEngagement();
    const spec = {
      detailType: "room-finish",
      roomName: "Lobby",
      roomNumber: "101",
      floorFinish: "Polished concrete",
      baseFinish: 'Rubber base 4"',
      wallFinish: "Painted gypsum board",
      ceilingFinish: "Acoustic tile",
      ceilingHeight: "9'-0\"",
    };
    anthropicMocks.turns = [
      toolTurn("draft_detail_callout_spec", {
        spec,
        reasoning: "room finish derived from the model and engagement context",
      }),
      answerTurn("I drafted a room-finish callout — review it in the form."),
    ];

    const res = await request(getApp())
      .post("/api/chat")
      .send({ engagementId: eng.id, question: "draft a room finish callout" });
    expect(res.status).toBe(200);

    const frames = parseSseFrames(res.text);
    const draftFrame = frames.find(
      (f) => typeof f === "object" && f.type === "agent_draft",
    ) as { draft?: { draftKind?: string; payload?: { spec?: { detailType?: string } } } } | undefined;
    expect(draftFrame).toBeTruthy();
    expect(draftFrame?.draft?.draftKind).toBe("detail-callout-spec");
    expect(draftFrame?.draft?.payload?.spec?.detailType).toBe("room-finish");

    // Draft-only: nothing was persisted to the L4 table.
    const list = await request(getApp()).get(
      `/api/engagements/${eng.id}/detail-callout-specs`,
    );
    expect(list.status).toBe(200);
    expect(list.body.detailCalloutSpecs).toHaveLength(0);
  });

  it("WSC.4: an invalid spec draft is rejected and the agent can recover", async () => {
    const eng = await seedEngagement();
    anthropicMocks.turns = [
      // First attempt: a room-finish spec missing required fields.
      toolTurn("draft_detail_callout_spec", {
        spec: { detailType: "room-finish", roomName: "Lobby" },
        reasoning: "first attempt",
      }),
      answerTurn("That draft was incomplete — I could not prepare it."),
    ];

    const res = await request(getApp())
      .post("/api/chat")
      .send({ engagementId: eng.id, question: "draft a callout" });
    expect(res.status).toBe(200);

    const frames = parseSseFrames(res.text);
    // No draft was emitted for the invalid spec.
    expect(
      frames.some((f) => typeof f === "object" && f.type === "agent_draft"),
    ).toBe(false);
    // The route still finished cleanly with a final answer.
    expect(frames.at(-1)).toBe("DONE");
  });
});
