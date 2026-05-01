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
const { logger } = await import("../lib/logger");

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

  it("snapshot focus mode (Task #39): explicit `snapshotFocus: true` flag injects the raw payload into a <snapshot_focus> block", async () => {
    // Default chat is JSON-free (Task #34); focus mode is the opt-in
    // escape hatch for questions that need structured payload data
    // ("what's the area of room 204?", "list every door schedule
    // entry"). We seed a snapshot with a unique marker string in its
    // payload, fire a chat with `snapshotFocus: true`, and assert the
    // marker now lands in the system prompt — proving the prompt
    // assembly actually flips on focus mode end-to-end (route → DB
    // payload load → buildChatPrompt → <snapshot_focus> block).
    if (!ctx.schema) throw new Error("schema not ready");
    const FOCUS_MARKER = "FOCUS_MODE_FLAG_CANARY_b3e7f1";
    const [eng] = await ctx.schema.db
      .insert(engagements)
      .values({
        name: "Focus Mode Flag",
        nameLower: `focus-mode-flag-${Math.random().toString(36).slice(2)}`,
        jurisdiction: "Moab, UT",
        address: "123 Main St",
      })
      .returning({ id: engagements.id });
    const [snap] = await ctx.schema.db
      .insert(snapshots)
      .values({
        engagementId: eng.id,
        projectName: "Focus Project",
        payload: {
          markerField: FOCUS_MARKER,
          rooms: [{ number: "204", areaSqft: 312 }],
        },
        sheetCount: 0,
        roomCount: 1,
        levelCount: 0,
        wallCount: 0,
      })
      .returning({ id: snapshots.id });

    anthropicMocks.events = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
    ];
    const res = await request(getApp())
      .post("/api/chat")
      .send({
        engagementId: eng.id,
        question: "what's the area of room 204?",
        snapshotFocus: true,
      });
    expect(res.status).toBe(200);

    const system = String(anthropicMocks.lastArgs.system);
    // Focus block + marker payload + snapshot id in attribution.
    expect(system).toContain("<snapshot_focus");
    expect(system).toContain(`snapshot_id="${snap.id}"`);
    expect(system).toContain(FOCUS_MARKER);
    expect(system).toContain('"number": "204"');
    // The instruction line names the snapshot id in the citation form
    // so the model has an unambiguous attribution target.
    expect(system).toContain(`{{atom|snapshot|${snap.id}|focus}}`);
  });

  it("snapshot focus mode (Task #39): inline {{atom|snapshot|<id>|focus}} reference in the question text triggers payload injection", async () => {
    // Equivalent to the explicit-flag path above, but exercising the
    // inline-reference channel. A power user (or the chat orchestrator
    // chaining off a snapshot atom card) embeds
    // `{{atom|snapshot|<latestSnapshotId>|focus}}` in the question
    // and the route should reach the same focus-mode branch.
    if (!ctx.schema) throw new Error("schema not ready");
    const INLINE_MARKER = "FOCUS_MODE_INLINE_CANARY_c2a4d8";
    const [eng] = await ctx.schema.db
      .insert(engagements)
      .values({
        name: "Focus Mode Inline",
        nameLower: `focus-mode-inline-${Math.random().toString(36).slice(2)}`,
        jurisdiction: "Moab, UT",
        address: "123 Main St",
      })
      .returning({ id: engagements.id });
    const [snap] = await ctx.schema.db
      .insert(snapshots)
      .values({
        engagementId: eng.id,
        projectName: "Inline Focus Project",
        payload: { markerField: INLINE_MARKER, doorSchedule: [{ tag: "D-101" }] },
        sheetCount: 0,
        roomCount: 0,
        levelCount: 0,
        wallCount: 0,
      })
      .returning({ id: snapshots.id });

    anthropicMocks.events = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
    ];
    const res = await request(getApp())
      .post("/api/chat")
      .send({
        engagementId: eng.id,
        // Note: NO `snapshotFocus: true` flag. The inline reference
        // alone has to flip focus on.
        question: `list the door schedule {{atom|snapshot|${snap.id}|focus}} please`,
      });
    expect(res.status).toBe(200);

    const system = String(anthropicMocks.lastArgs.system);
    expect(system).toContain("<snapshot_focus");
    expect(system).toContain(`snapshot_id="${snap.id}"`);
    expect(system).toContain(INLINE_MARKER);
    expect(system).toContain('"tag": "D-101"');
  });

  it("snapshot focus mode (Task #39): inline reference targeting a STALE snapshot id does NOT trigger focus mode", async () => {
    // The inline-reference channel only opts in when the id matches
    // the engagement's *current* latest snapshot — a copy-pasted
    // reference from a chat turn before a new push landed should not
    // cause focus mode to fire against the new snapshot's payload
    // (which would be confusing) and equally must not leak the stale
    // snapshot's payload (cross-snapshot leakage).
    if (!ctx.schema) throw new Error("schema not ready");
    const STALE_MARKER = "FOCUS_STALE_CANARY_e4f9a2";
    const [eng] = await ctx.schema.db
      .insert(engagements)
      .values({
        name: "Focus Stale Id",
        nameLower: `focus-stale-${Math.random().toString(36).slice(2)}`,
        jurisdiction: "Moab, UT",
        address: "123 Main St",
      })
      .returning({ id: engagements.id });
    // Newer snapshot (engagement atom returns this one as the latest).
    await ctx.schema.db.insert(snapshots).values({
      engagementId: eng.id,
      projectName: "Newer Focus Project",
      payload: { markerField: STALE_MARKER },
      sheetCount: 0,
      roomCount: 0,
      levelCount: 0,
      wallCount: 0,
      receivedAt: new Date("2026-05-01T00:00:00.000Z"),
    });

    anthropicMocks.events = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
    ];
    const res = await request(getApp())
      .post("/api/chat")
      .send({
        engagementId: eng.id,
        // Reference points at a snapshot id that doesn't exist on this
        // engagement at all — the route's focus check matches against
        // the resolved latestSnapshotId, so this should fall through.
        question:
          "what's in here? {{atom|snapshot|00000000-0000-0000-0000-deadbeef0000|focus}}",
      });
    expect(res.status).toBe(200);

    const system = String(anthropicMocks.lastArgs.system);
    expect(system).not.toContain("<snapshot_focus");
    expect(system).not.toContain(STALE_MARKER);
  });

  it("snapshot focus mode (Task #44): explicit `snapshotFocusIds` lets a turn drill into multiple snapshots, emitting one block per id", async () => {
    // Comparison-style questions ("how did the room schedule change
    // between yesterday's push and today's?") need the model to mine
    // more than just the latest snapshot's payload. We seed two
    // snapshots with distinct marker strings, request both via the new
    // `snapshotFocusIds` body field, and assert both payloads land in
    // the system prompt inside their own `<snapshot_focus>` blocks.
    if (!ctx.schema) throw new Error("schema not ready");
    const OLDER_MARKER = "FOCUS_OLDER_SNAPSHOT_CANARY_a1b2";
    const NEWER_MARKER = "FOCUS_NEWER_SNAPSHOT_CANARY_c3d4";
    const [eng] = await ctx.schema.db
      .insert(engagements)
      .values({
        name: "Multi-Focus Engagement",
        nameLower: `multi-focus-${Math.random().toString(36).slice(2)}`,
        jurisdiction: "Moab, UT",
        address: "123 Main St",
      })
      .returning({ id: engagements.id });
    const [older] = await ctx.schema.db
      .insert(snapshots)
      .values({
        engagementId: eng.id,
        projectName: "Older Project",
        payload: {
          markerField: OLDER_MARKER,
          rooms: [{ number: "204", areaSqft: 300 }],
        },
        sheetCount: 0,
        roomCount: 1,
        levelCount: 0,
        wallCount: 0,
        receivedAt: new Date("2026-04-01T00:00:00.000Z"),
      })
      .returning({ id: snapshots.id });
    const [newer] = await ctx.schema.db
      .insert(snapshots)
      .values({
        engagementId: eng.id,
        projectName: "Newer Project",
        payload: {
          markerField: NEWER_MARKER,
          rooms: [{ number: "204", areaSqft: 312 }],
        },
        sheetCount: 0,
        roomCount: 1,
        levelCount: 0,
        wallCount: 0,
        receivedAt: new Date("2026-05-01T00:00:00.000Z"),
      })
      .returning({ id: snapshots.id });

    anthropicMocks.events = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
    ];
    const res = await request(getApp())
      .post("/api/chat")
      .send({
        engagementId: eng.id,
        question: "how did the room schedule change between these two pushes?",
        snapshotFocusIds: [older.id, newer.id],
      });
    expect(res.status).toBe(200);

    const system = String(anthropicMocks.lastArgs.system);
    // Both blocks present, tagged with their own snapshot ids.
    expect(system).toContain(`<snapshot_focus snapshot_id="${older.id}">`);
    expect(system).toContain(`<snapshot_focus snapshot_id="${newer.id}">`);
    // Both payloads' marker strings are in the prompt — proving the
    // route loaded each row's `payload` column independently and the
    // formatter didn't collapse them into one block.
    expect(system).toContain(OLDER_MARKER);
    expect(system).toContain(NEWER_MARKER);
    // Instruction line names *both* snapshot ids as candidate
    // citation targets so the model can attribute each piece of its
    // answer to the right snapshot.
    expect(system).toContain(`{{atom|snapshot|${older.id}|focus}}`);
    expect(system).toContain(`{{atom|snapshot|${newer.id}|focus}}`);
    // Plural-block phrasing — single-block tests use the singular
    // form "A `<snapshot_focus>` block below", the multi-snapshot
    // path swaps in "N `<snapshot_focus>` blocks below".
    expect(system).toContain("`<snapshot_focus>` blocks below");
  });

  it("snapshot focus mode (Task #44): inline {{atom|snapshot|<olderId>|focus}} reference now triggers focus on the older snapshot too", async () => {
    // Pre-Task-#44 the inline channel only matched the engagement's
    // *latest* snapshot id — pasting a reference to an older snapshot
    // (e.g. from a prior chat turn) was silently ignored and the
    // older payload could never reach the model. Task #44 lifts that
    // restriction: any inline `{{atom|snapshot|<id>|focus}}` whose id
    // belongs to the engagement now opts that snapshot into focus
    // mode for this turn.
    if (!ctx.schema) throw new Error("schema not ready");
    const OLDER_MARKER = "INLINE_OLDER_FOCUS_CANARY_e5f6";
    const [eng] = await ctx.schema.db
      .insert(engagements)
      .values({
        name: "Inline Older Focus",
        nameLower: `inline-older-${Math.random().toString(36).slice(2)}`,
        jurisdiction: "Moab, UT",
        address: "123 Main St",
      })
      .returning({ id: engagements.id });
    const [older] = await ctx.schema.db
      .insert(snapshots)
      .values({
        engagementId: eng.id,
        projectName: "Older Inline Project",
        payload: { markerField: OLDER_MARKER },
        sheetCount: 0,
        roomCount: 0,
        levelCount: 0,
        wallCount: 0,
        receivedAt: new Date("2026-04-01T00:00:00.000Z"),
      })
      .returning({ id: snapshots.id });
    // Newer snapshot — engagement atom resolves this as "latest" so
    // the framing sentence + framework atom both key off it. The
    // inline reference below targets the OLDER id specifically.
    await ctx.schema.db.insert(snapshots).values({
      engagementId: eng.id,
      projectName: "Newer Inline Project",
      payload: { rooms: [] },
      sheetCount: 0,
      roomCount: 0,
      levelCount: 0,
      wallCount: 0,
      receivedAt: new Date("2026-05-01T00:00:00.000Z"),
    });

    anthropicMocks.events = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
    ];
    const res = await request(getApp())
      .post("/api/chat")
      .send({
        engagementId: eng.id,
        question: `what was in {{atom|snapshot|${older.id}|focus}} originally?`,
      });
    expect(res.status).toBe(200);

    const system = String(anthropicMocks.lastArgs.system);
    // Older snapshot's focus block + its marker land in the prompt.
    expect(system).toContain(`<snapshot_focus snapshot_id="${older.id}">`);
    expect(system).toContain(OLDER_MARKER);
  });

  it("snapshot focus mode (Task #44): foreign `snapshotFocusIds` (cross-engagement leak attempt) returns 400 and never loads the payload", async () => {
    // Access-control denial: a programmatic caller passing a snapshot
    // id from a *different* engagement must be rejected before any
    // payload row is loaded — the engagement atom's `relatedAtoms` is
    // the single source of truth for what counts as "this
    // engagement's snapshots", so an id outside that set can never
    // reach `<snapshot_focus>`. We verify the error response shape
    // AND that the foreign payload's marker never appears in any
    // prompt sent to the SDK (which it can't, because the SDK is
    // never invoked on the 400 branch).
    if (!ctx.schema) throw new Error("schema not ready");
    const FOREIGN_MARKER = "CROSS_ENGAGEMENT_SHOULD_NOT_LEAK_g7h8";
    // Engagement A: the chat target. Has its own snapshot.
    const [engA] = await ctx.schema.db
      .insert(engagements)
      .values({
        name: "Engagement A",
        nameLower: `engagement-a-${Math.random().toString(36).slice(2)}`,
        jurisdiction: "Moab, UT",
        address: "123 Main St",
      })
      .returning({ id: engagements.id });
    await ctx.schema.db.insert(snapshots).values({
      engagementId: engA.id,
      projectName: "A's Project",
      payload: { ownMarker: "A_OWN" },
      sheetCount: 0,
      roomCount: 0,
      levelCount: 0,
      wallCount: 0,
    });
    // Engagement B: belongs to a different project, holds the
    // payload the attacker wants to exfiltrate.
    const [engB] = await ctx.schema.db
      .insert(engagements)
      .values({
        name: "Engagement B",
        nameLower: `engagement-b-${Math.random().toString(36).slice(2)}`,
        jurisdiction: "Other City, UT",
        address: "999 Other St",
      })
      .returning({ id: engagements.id });
    const [foreign] = await ctx.schema.db
      .insert(snapshots)
      .values({
        engagementId: engB.id,
        projectName: "B's Secret Project",
        payload: { markerField: FOREIGN_MARKER },
        sheetCount: 0,
        roomCount: 0,
        levelCount: 0,
        wallCount: 0,
      })
      .returning({ id: snapshots.id });

    // Reset the mock so we can prove the SDK was NOT invoked on the
    // denial path (would-be events stay buffered, .lastArgs stays
    // null after this point).
    anthropicMocks.lastArgs = null;
    anthropicMocks.events = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
    ];
    const res = await request(getApp())
      .post("/api/chat")
      .send({
        engagementId: engA.id,
        // The attacker chats against Engagement A but tries to focus
        // Engagement B's snapshot id. Server must refuse.
        question: "what's in here?",
        snapshotFocusIds: [foreign.id],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("snapshot_not_in_engagement");
    // The SDK was never called — confirms the route fails *closed*
    // before any payload load + prompt assembly.
    expect(anthropicMocks.lastArgs).toBeNull();
  });

  it("snapshot focus mode (Task #44): `snapshotFocus: true` + explicit `snapshotFocusIds` ship one block per id with the latest auto-included", async () => {
    // Combining the legacy boolean flag with the new explicit list
    // should be additive — the latest snapshot id gets folded in
    // once, de-duplicated against the explicit list. This pins the
    // backwards-compat contract: the existing UI button (which sends
    // `snapshotFocus: true` alone) keeps working, and a future
    // "compare with snapshot X" UI that sends both fields gets the
    // expected superset without surprising re-orderings.
    if (!ctx.schema) throw new Error("schema not ready");
    const OLDER_MARKER = "COMBINED_OLDER_MARKER_i9j0";
    const NEWER_MARKER = "COMBINED_NEWER_MARKER_k1l2";
    const [eng] = await ctx.schema.db
      .insert(engagements)
      .values({
        name: "Combined Focus",
        nameLower: `combined-focus-${Math.random().toString(36).slice(2)}`,
        jurisdiction: "Moab, UT",
        address: "123 Main St",
      })
      .returning({ id: engagements.id });
    const [older] = await ctx.schema.db
      .insert(snapshots)
      .values({
        engagementId: eng.id,
        projectName: "Combined Older",
        payload: { markerField: OLDER_MARKER },
        sheetCount: 0,
        roomCount: 0,
        levelCount: 0,
        wallCount: 0,
        receivedAt: new Date("2026-04-01T00:00:00.000Z"),
      })
      .returning({ id: snapshots.id });
    const [newer] = await ctx.schema.db
      .insert(snapshots)
      .values({
        engagementId: eng.id,
        projectName: "Combined Newer",
        payload: { markerField: NEWER_MARKER },
        sheetCount: 0,
        roomCount: 0,
        levelCount: 0,
        wallCount: 0,
        receivedAt: new Date("2026-05-01T00:00:00.000Z"),
      })
      .returning({ id: snapshots.id });

    anthropicMocks.events = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
    ];
    const res = await request(getApp())
      .post("/api/chat")
      .send({
        engagementId: eng.id,
        question: "compare these",
        snapshotFocus: true,
        snapshotFocusIds: [older.id],
      });
    expect(res.status).toBe(200);
    const system = String(anthropicMocks.lastArgs.system);
    // Both markers + both block headers present.
    expect(system).toContain(`<snapshot_focus snapshot_id="${older.id}">`);
    expect(system).toContain(`<snapshot_focus snapshot_id="${newer.id}">`);
    expect(system).toContain(OLDER_MARKER);
    expect(system).toContain(NEWER_MARKER);
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

  it("snapshot focus mode (Task #51): warn fires end-to-end when cumulative cap downgrades focus payloads", async () => {
    // Task #51 wired a `req.log.warn("snapshot focus payloads downgraded
    // by cumulative cap")` whenever the cumulative
    // `MAX_SNAPSHOT_FOCUS_TOTAL_PAYLOAD_CHARS` (120K) cap forces any
    // `<snapshot_focus>` block to be truncated or omitted. The unit
    // tests in `lib/codes/src/promptFormatter.test.ts` cover the stats
    // computation in isolation, but the chat route's branch that
    // actually composes + emits the warn payload is not exercised
    // there. We seed 4 snapshots with oversized payloads that
    // collectively blow past the cap, fire a chat with all 4 ids in
    // `snapshotFocusIds`, and assert the warn-level log carries the
    // expected operational fields.
    //
    // The chat route resolves `req.log` first and falls back to the
    // singleton `logger` when pino-http isn't wired (which is the
    // case for this in-process test harness — see setup.ts: no
    // pino-http middleware), so spying on the singleton is the right
    // observation point.
    if (!ctx.schema) throw new Error("schema not ready");
    const warnSpy = vi.spyOn(logger, "warn");
    try {
      const [eng] = await ctx.schema.db
        .insert(engagements)
        .values({
          name: "Focus Cap Warn",
          nameLower: `focus-cap-warn-${Math.random().toString(36).slice(2)}`,
          jurisdiction: "Moab, UT",
          address: "123 Main St",
        })
        .returning({ id: engagements.id });

      // Each payload is a shapeable object (real Revit-shaped:
      // top-level keys with a small high-priority `rooms` array
      // alongside a bulky low-priority `families` blob) whose
      // `JSON.stringify(_, null, 2)` form is ~50 KB. That means the
      // per-block cap (60 KB in promptFormatter.ts) lets each block
      // through INTACT, but the cumulative cap (120 KB) starts
      // biting partway through:
      //   block 1 (~50K, intact, cumulative=50K)
      //   block 2 (~50K, intact, cumulative=100K)
      //   block 3 (~50K wanted, only ~20K cumulative room → smart-
      //            trim path drops `families`, emits a structurally-
      //            valid JSON subset + COMBINED_CAP_TRUNC_MARKER)
      //   block 4 (smart-trim path again)
      //
      // Pre-Task #68 the smart-trim branch in
      // `formatSnapshotFocusBlocks` did NOT increment
      // `combinedCapTruncatedCount`, so this warn never fired for
      // shapeable object payloads — exactly the shape real Revit
      // pushes have. The previous version of this test had to use a
      // top-level ARRAY payload to coerce the formatter into the
      // tail-truncation branch (which DID update the counter) — that
      // workaround papered over the bug being fixed here. We're back
      // on the realistic shape now to prove the warn fires end-to-
      // end on payloads that match production.
      //
      // The omitted bucket is harder to reach with shapeable
      // payloads (smart-trim collapses each block to a few hundred
      // bytes once the cumulative cap is biting, leaving plenty of
      // room for later blocks), so we only assert on
      // `combinedCapTruncatedCount > 0` + the derived
      // `downgradedCount > 0`. The unit test in
      // `lib/codes/src/promptFormatter.test.ts` exercises the
      // omitted bucket directly with engineered fixtures.
      const FILLER = "x".repeat(50_000);
      const seedSnap = async (
        marker: string,
      ): Promise<{ id: string }> => {
        const [row] = await ctx.schema!.db
          .insert(snapshots)
          .values({
            engagementId: eng.id,
            projectName: `Focus Project ${marker}`,
            payload: {
              rooms: [{ id: `room-${marker}`, name: `Room ${marker}` }],
              families: { lib: FILLER, marker },
            },
            sheetCount: 0,
            roomCount: 1,
            levelCount: 0,
            wallCount: 0,
          })
          .returning({ id: snapshots.id });
        return row;
      };
      const s1 = await seedSnap("S1");
      const s2 = await seedSnap("S2");
      const s3 = await seedSnap("S3");
      const s4 = await seedSnap("S4");

      anthropicMocks.events = [
        {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "ok" },
        },
      ];
      // Reset spy state so we only capture warns from THIS request
      // (seeding above can run logger.warn paths in other code).
      warnSpy.mockClear();

      const res = await request(getApp())
        .post("/api/chat")
        .send({
          engagementId: eng.id,
          question: "compare all four",
          snapshotFocusIds: [s1.id, s2.id, s3.id, s4.id],
        });
      expect(res.status).toBe(200);

      // Find the downgrade warn by its message. The route also fires
      // an `info` log with most of the same fields under the message
      // "chat with snapshot focus payload" — assertion targets the
      // warn specifically so a regression that drops the warn but
      // keeps the info still fails.
      const downgradeWarn = warnSpy.mock.calls.find(
        ([, msg]) =>
          typeof msg === "string" &&
          msg === "snapshot focus payloads downgraded by cumulative cap",
      );
      expect(downgradeWarn).toBeTruthy();
      const payload = downgradeWarn![0] as {
        engagementId?: string;
        snapshotIds?: string[];
        focusCount?: number;
        downgradedCount?: number;
        combinedCapTruncatedCount?: number;
        combinedCapOmittedCount?: number;
        // Cap is char-counted (not byte-counted) — see chat.ts
        // comment near the warn site for why the field is named
        // "Chars" and not "Bytes" despite the task description.
        cumulativeCapChars?: number;
      };
      expect(payload.engagementId).toBe(eng.id);
      expect(payload.snapshotIds).toEqual([s1.id, s2.id, s3.id, s4.id]);
      expect(payload.focusCount).toBe(4);
      // Truncated bucket fires for the realistic shapeable-object
      // case (Task #68 fix). Omitted bucket is unreachable here
      // because once smart trim collapses the over-cap blocks they
      // each take only a few hundred bytes, so there's always room
      // for the next snapshot to be smart-trimmed too — the unit
      // tests exercise the omitted bucket directly with engineered
      // fixtures.
      expect(payload.combinedCapTruncatedCount).toBeGreaterThan(0);
      // downgradedCount == truncated + omitted (chat.ts derives it
      // from the two stats fields).
      expect(payload.downgradedCount).toBe(
        (payload.combinedCapTruncatedCount ?? 0) +
          (payload.combinedCapOmittedCount ?? 0),
      );
      expect(payload.downgradedCount).toBeGreaterThan(0);
      // Operators tuning the cap need to see what value was active
      // at the time of the warn — pin the wired-in constant so a
      // future cap change requires touching this assertion too.
      expect(payload.cumulativeCapChars).toBe(120_000);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("snapshot focus mode (Task #51): warn does NOT fire when cumulative cap was not exceeded", async () => {
    // Complementary half of the previous test: focus mode is on but
    // every payload comfortably fits inside the cumulative cap, so
    // the route's `downgradedCount > 0` guard short-circuits and no
    // warn-level log should be emitted. A regression that fires the
    // warn unconditionally (e.g. dropping the `if (downgradedCount >
    // 0)` guard) would trip this test.
    if (!ctx.schema) throw new Error("schema not ready");
    const warnSpy = vi.spyOn(logger, "warn");
    try {
      const [eng] = await ctx.schema.db
        .insert(engagements)
        .values({
          name: "Focus Cap No Warn",
          nameLower: `focus-cap-no-warn-${Math.random()
            .toString(36)
            .slice(2)}`,
          jurisdiction: "Moab, UT",
          address: "123 Main St",
        })
        .returning({ id: engagements.id });
      const [snap] = await ctx.schema.db
        .insert(snapshots)
        .values({
          engagementId: eng.id,
          projectName: "Tiny Project",
          // Tiny payload — JSON-stringified form is well under 1KB,
          // so a single focus block can never approach the 120K cap.
          payload: { rooms: [{ number: "101", areaSqft: 120 }] },
          sheetCount: 0,
          roomCount: 1,
          levelCount: 0,
          wallCount: 0,
        })
        .returning({ id: snapshots.id });

      anthropicMocks.events = [
        {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "ok" },
        },
      ];
      warnSpy.mockClear();

      const res = await request(getApp())
        .post("/api/chat")
        .send({
          engagementId: eng.id,
          question: "what's in the room schedule?",
          snapshotFocus: true,
          snapshotFocusIds: [snap.id],
        });
      expect(res.status).toBe(200);

      // Sanity: focus mode actually fired (the prompt carries the
      // focus block) — without this the no-warn assertion below
      // could trivially pass for the wrong reason (focus mode
      // skipped entirely).
      const system = String(anthropicMocks.lastArgs.system);
      expect(system).toContain(`<snapshot_focus snapshot_id="${snap.id}">`);

      // No downgrade warn from the chat route.
      const downgradeWarn = warnSpy.mock.calls.find(
        ([, msg]) =>
          typeof msg === "string" &&
          msg === "snapshot focus payloads downgraded by cumulative cap",
      );
      expect(downgradeWarn).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
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
