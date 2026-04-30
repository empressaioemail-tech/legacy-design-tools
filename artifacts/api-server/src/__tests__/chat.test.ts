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
  revitDocumentPath?: string | null;
  revitCentralGuid?: string | null;
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
      revitDocumentPath: opts?.revitDocumentPath ?? null,
      revitCentralGuid: opts?.revitCentralGuid ?? null,
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

  it("registry path: an internal session sees the Revit binding in the system prompt", async () => {
    // The engagement atom's `contextSummary` only emits the
    // "Bound to Revit document …" sentence when the scope's audience is
    // `internal` (or `ai`, or carries the architect permission claim).
    // Pre-task-29 the chat route defaulted to `internal` whenever the
    // `x-audience` header was missing, so this assertion required no
    // setup. Post-task-29 the route reads `req.session`, so the test
    // has to opt the request into an internal session — here we use
    // the dev-only `x-audience` override that `sessionMiddleware`
    // honors when NODE_ENV !== "production". A real client would set
    // the `pr_session` cookie instead.
    anthropicMocks.events = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
    ];
    const REVIT_DOC = "C:/Projects/RegistryPathTest.rvt";
    const eng = await seedEngagementWithSnapshot({
      revitDocumentPath: REVIT_DOC,
      revitCentralGuid: "deadbeef-aaaa-bbbb-cccc-000000000001",
    });

    const resInternal = await request(getApp())
      .post("/api/chat")
      .set("x-audience", "internal")
      .send({ engagementId: eng.id, question: "what's the doc path?" });
    expect(resInternal.status).toBe(200);
    const internalSystem = String(anthropicMocks.lastArgs.system);
    expect(internalSystem).toContain(REVIT_DOC);
    // Provenance round-trip: the chat path tags the framework atom
    // with `entityType="engagement"` so the LLM can attribute its
    // answer back to the registry entity.
    expect(internalSystem).toContain('entity_type="engagement"');
    expect(internalSystem).toContain(`entity_id="${eng.id}"`);
  });

  it("anonymous request is treated as applicant: Revit binding is redacted from the system prompt", async () => {
    // Acceptance criterion for task #29: an unauthenticated caller must
    // not see internal-only Revit binding fields. The session
    // middleware's least-privilege default (`audience: "user"`) drives
    // the engagement atom to omit the "Bound to Revit document …"
    // sentence; chat forwards that prose verbatim, so the model never
    // sees the document path.
    //
    // Pre-task-29 this same request would have defaulted to `internal`
    // and leaked the path — the regression guard here is the absence of
    // any audience-setting header / cookie.
    anthropicMocks.events = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
    ];
    const REVIT_DOC = "C:/Projects/AnonRedactsTest.rvt";
    const eng = await seedEngagementWithSnapshot({
      revitDocumentPath: REVIT_DOC,
      revitCentralGuid: "deadbeef-aaaa-bbbb-cccc-000000000002",
    });

    const resAnon = await request(getApp())
      .post("/api/chat")
      .send({ engagementId: eng.id, question: "what's the doc path?" });
    expect(resAnon.status).toBe(200);
    const anonSystem = String(anthropicMocks.lastArgs.system);
    expect(anonSystem).not.toContain(REVIT_DOC);
    // Engagement framing (name/address/jurisdiction) still ships on
    // the applicant variant — only the internal Revit binding is dropped.
    expect(anonSystem).toContain("Test Engagement");
    expect(anonSystem).toContain("123 Main St");
  });

  it("session cookie carries audience: pr_session={'audience':'user'} redacts the Revit binding", async () => {
    // Round-trip the canonical wire format used by real clients (FE,
    // Revit add-in once auth lands): a `pr_session` JSON cookie. The
    // route should reach the same redacted prose it does for an
    // anonymous request, proving the cookie path and the default path
    // agree on the engagement-atom scope.
    anthropicMocks.events = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
    ];
    const REVIT_DOC = "C:/Projects/CookieRedactsTest.rvt";
    const eng = await seedEngagementWithSnapshot({
      revitDocumentPath: REVIT_DOC,
      revitCentralGuid: "deadbeef-aaaa-bbbb-cccc-000000000003",
    });

    const cookie = `pr_session=${encodeURIComponent(
      JSON.stringify({
        audience: "user",
        requestor: { kind: "user", id: "applicant-1" },
      }),
    )}`;
    const resCookie = await request(getApp())
      .post("/api/chat")
      .set("Cookie", cookie)
      .send({ engagementId: eng.id, question: "what's the doc path?" });
    expect(resCookie.status).toBe(200);
    const cookieSystem = String(anthropicMocks.lastArgs.system);
    expect(cookieSystem).not.toContain(REVIT_DOC);
  });

  it("session cookie carries audience: pr_session={'audience':'internal'} sees the Revit binding (non-production only)", async () => {
    // Mirror of the previous test for the internal-staff path: a
    // properly-formed `pr_session` cookie with `audience: "internal"`
    // unlocks the Revit-binding sentence, just like the dev-only
    // `x-audience: internal` header does in tests.
    //
    // IMPORTANT: this elevation is a development-only convenience. The
    // session middleware fails closed in production (NODE_ENV ===
    // "production") so the same cookie cannot be used to escalate
    // against a deployed server. The "production fails closed" test
    // immediately below pins that contract.
    anthropicMocks.events = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
    ];
    const REVIT_DOC = "C:/Projects/CookieInternalTest.rvt";
    const eng = await seedEngagementWithSnapshot({
      revitDocumentPath: REVIT_DOC,
      revitCentralGuid: "deadbeef-aaaa-bbbb-cccc-000000000004",
    });

    const cookie = `pr_session=${encodeURIComponent(
      JSON.stringify({ audience: "internal" }),
    )}`;
    const resCookie = await request(getApp())
      .post("/api/chat")
      .set("Cookie", cookie)
      .send({ engagementId: eng.id, question: "what's the doc path?" });
    expect(resCookie.status).toBe(200);
    const cookieSystem = String(anthropicMocks.lastArgs.system);
    expect(cookieSystem).toContain(REVIT_DOC);
  });

  it("production fails closed: cookie + override headers cannot escalate audience", async () => {
    // Regression guard for the security review's central finding: an
    // unsigned `pr_session` cookie is just another piece of
    // client-controlled input, so trusting it in production would
    // recreate the spoofable-header bug task #29 was fixing. The
    // session middleware therefore strips the cookie and the dev
    // override headers when NODE_ENV === "production", forcing the
    // anonymous applicant default for every production request.
    //
    // We toggle NODE_ENV per-request (the middleware reads it on each
    // call) and we batter the request with every elevation channel at
    // once: a cookie claiming `audience: internal`, an
    // `x-audience: internal` header, and an architect permission claim.
    // None of them should land — the engagement atom's Revit binding
    // sentence must stay redacted.
    const prevEnv = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      anthropicMocks.events = [
        {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "ok" },
        },
      ];
      const REVIT_DOC = "C:/Projects/ProdFailsClosedTest.rvt";
      const eng = await seedEngagementWithSnapshot({
        revitDocumentPath: REVIT_DOC,
        revitCentralGuid: "deadbeef-aaaa-bbbb-cccc-000000000005",
      });

      const cookie = `pr_session=${encodeURIComponent(
        JSON.stringify({
          audience: "internal",
          permissions: ["plan-review:architect"],
          requestor: { kind: "user", id: "spoofed-staff" },
        }),
      )}`;
      const resProd = await request(getApp())
        .post("/api/chat")
        .set("Cookie", cookie)
        .set("x-audience", "internal")
        .set("x-permissions", "plan-review:architect")
        .send({ engagementId: eng.id, question: "what's the doc path?" });
      expect(resProd.status).toBe(200);
      const prodSystem = String(anthropicMocks.lastArgs.system);
      expect(prodSystem).not.toContain(REVIT_DOC);
      // Sanity: the prompt itself was assembled — we are exercising
      // the redaction path, not a "request rejected" branch.
      expect(prodSystem).toContain("Test Engagement");
    } finally {
      // Restore so subsequent tests in this file (and other files run
      // in the same vitest worker) keep the test-mode behavior.
      if (prevEnv === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = prevEnv;
    }
  });

  it("snapshot atom prose lands in <framework_atoms> tagged with entity_type=\"snapshot\" for the most recent snapshot", async () => {
    // Seed the engagement first, then insert TWO snapshot rows so we
    // can prove chat picks the most recent one (i.e. it's threading
    // the snapshot atom in via `engagement.relatedAtoms`, which is
    // pre-sorted most-recent-first by the engagement atom). The
    // earlier snapshot's id should NOT appear in <framework_atoms>.
    if (!ctx.schema) throw new Error("schema not ready");
    const [eng] = await ctx.schema.db
      .insert(engagements)
      .values({
        name: "Snapshot Provenance Test",
        nameLower: `snapshot-provenance-${Math.random().toString(36).slice(2)}`,
        jurisdiction: "Moab, UT",
        address: "123 Main St",
      })
      .returning({ id: engagements.id });
    // Older snapshot — receivedAt explicitly set in the past so the
    // ordering test isn't relying on insert order or microsecond
    // timing on the default `now()` value.
    const [older] = await ctx.schema.db
      .insert(snapshots)
      .values({
        engagementId: eng.id,
        projectName: "Older Project",
        payload: { sheets: [], rooms: [] },
        sheetCount: 1,
        roomCount: 0,
        levelCount: 0,
        wallCount: 0,
        receivedAt: new Date("2024-01-01T00:00:00.000Z"),
      })
      .returning({ id: snapshots.id });
    const [newer] = await ctx.schema.db
      .insert(snapshots)
      .values({
        engagementId: eng.id,
        projectName: "Newer Project",
        payload: { sheets: [], rooms: [] },
        sheetCount: 7,
        roomCount: 0,
        levelCount: 0,
        wallCount: 0,
        receivedAt: new Date("2026-04-01T00:00:00.000Z"),
      })
      .returning({ id: snapshots.id });

    anthropicMocks.events = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
    ];
    const res = await request(getApp())
      .post("/api/chat")
      .send({ engagementId: eng.id, question: "what's in the snapshot?" });
    expect(res.status).toBe(200);

    const system = String(anthropicMocks.lastArgs.system);
    // Snapshot framework atom is present and tagged with the most
    // recent snapshot's id, not the older one.
    expect(system).toContain('entity_type="snapshot"');
    expect(system).toContain(`entity_id="${newer.id}"`);
    expect(system).not.toContain(`entity_id="${older.id}"`);
    // Prose-level sanity check: the snapshot atom's prose names the
    // project + counts. If chat were ignoring the atom and only
    // shipping the raw payload, neither would appear here.
    expect(system).toContain("Newer Project");
    expect(system).toContain("7 sheets");
  });

  it("does NOT inline the raw snapshot JSON payload in the system prompt (Task #34)", async () => {
    // Pre-Task-#34 the chat route loaded the entire snapshots.payload
    // blob and pasted it into a `<snapshot received_at='…'>{full
    // JSON}</snapshot>` block — for real Revit pushes that ran tens of
    // KB and dominated the prompt token budget. The snapshot framework
    // atom now carries the same information (project name, counts,
    // compact list of sheet identities) as typed prose, so the raw
    // payload no longer ships by default.
    //
    // We seed a payload with a clearly-distinguishable marker string,
    // and assert the system prompt contains neither the marker nor the
    // wrapper tag. The framing sentence ("captured X ago") and the
    // snapshot framework atom (entity_type="snapshot") both still land
    // — we double-check those so a regression that drops the framing
    // entirely doesn't masquerade as a passing test.
    if (!ctx.schema) throw new Error("schema not ready");
    const PAYLOAD_MARKER = "PAYLOAD_LEAK_CANARY_d7e1c2";
    const [eng] = await ctx.schema.db
      .insert(engagements)
      .values({
        name: "Payload Leak Canary",
        nameLower: `payload-leak-canary-${Math.random().toString(36).slice(2)}`,
        jurisdiction: "Moab, UT",
        address: "123 Main St",
      })
      .returning({ id: engagements.id });
    await ctx.schema.db.insert(snapshots).values({
      engagementId: eng.id,
      projectName: "Canary Project",
      payload: { canaryField: PAYLOAD_MARKER, sheets: [], rooms: [] },
      sheetCount: 0,
      roomCount: 0,
      levelCount: 0,
      wallCount: 0,
    });

    anthropicMocks.events = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
    ];
    const res = await request(getApp())
      .post("/api/chat")
      .send({ engagementId: eng.id, question: "what's in here?" });
    expect(res.status).toBe(200);

    const system = String(anthropicMocks.lastArgs.system);
    // Raw payload bytes are gone — no marker, no wrapper tag.
    expect(system).not.toContain(PAYLOAD_MARKER);
    expect(system).not.toContain("<snapshot ");
    expect(system).not.toContain("</snapshot>");
    // Framing + framework atom still present so the model knows there
    // IS a snapshot and roughly when it landed.
    expect(system).toMatch(/The most recent snapshot was captured /);
    expect(system).toContain('entity_type="snapshot"');
    expect(system).toContain("Canary Project");
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
