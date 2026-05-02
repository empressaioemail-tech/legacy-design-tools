/**
 * PLR-9 — integration test for the per-submission SSE channel.
 *
 * Boots the test app on an ephemeral port, opens a raw SSE
 * subscription via node's http client (supertest does not stream),
 * exercises the audience gate, the presence snapshot frame, the
 * finding.added/accepted publish path, and presence.left on
 * disconnect.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("submission-events.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { engagements, submissions, findings, users } = await import(
  "@workspace/db"
);
const { __resetSubmissionLiveEventsForTests } = await import(
  "../lib/submissionLiveEvents"
);

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  // Bind the test app to an ephemeral port so we can open raw SSE
  // sockets against it. supertest's auto-listen path closes the
  // socket as soon as the response ends, which doesn't work for
  // a long-lived event stream.
  await new Promise<void>((resolve) => {
    server = http.createServer(getApp());
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  __resetSubmissionLiveEventsForTests();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

interface SseFrame {
  event: string;
  data: unknown;
}

/**
 * Open an SSE subscription and resolve once the predicate has seen
 * a matching frame. Caller is responsible for releasing the request
 * (return.req.destroy()) once it's done.
 */
function openSseStream(args: {
  path: string;
  headers: Record<string, string>;
}): {
  req: http.ClientRequest;
  waitFor: (
    predicate: (frame: SseFrame) => boolean,
    timeoutMs?: number,
  ) => Promise<SseFrame>;
  frames: SseFrame[];
  ready: Promise<void>;
} {
  const url = new URL(args.path, baseUrl);
  const frames: SseFrame[] = [];
  const listeners: Array<(f: SseFrame) => void> = [];

  let resolveReady: () => void;
  let rejectReady: (err: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  const req = http.request(
    {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: "GET",
      headers: { Accept: "text/event-stream", ...args.headers },
    },
    (res) => {
      if (res.statusCode !== 200) {
        rejectReady(
          new Error(`SSE stream failed to open: status=${res.statusCode}`),
        );
        return;
      }
      resolveReady();
      let buffer = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (!raw || raw.startsWith(":")) continue;
          let event = "message";
          let data = "";
          for (const line of raw.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          let parsed: unknown = data;
          try {
            parsed = JSON.parse(data);
          } catch {
            // pass through as string
          }
          const frame: SseFrame = { event, data: parsed };
          frames.push(frame);
          for (const l of listeners) l(frame);
        }
      });
    },
  );
  req.on("error", () => {
    /* expected on destroy */
  });
  req.end();

  function waitFor(
    predicate: (frame: SseFrame) => boolean,
    timeoutMs = 2000,
  ): Promise<SseFrame> {
    const matched = frames.find(predicate);
    if (matched) return Promise.resolve(matched);
    return new Promise<SseFrame>((resolve, reject) => {
      const t = setTimeout(() => {
        const idx = listeners.indexOf(handler);
        if (idx >= 0) listeners.splice(idx, 1);
        reject(
          new Error(
            `SSE waitFor: predicate did not match within ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      const handler = (f: SseFrame) => {
        if (predicate(f)) {
          clearTimeout(t);
          const idx = listeners.indexOf(handler);
          if (idx >= 0) listeners.splice(idx, 1);
          resolve(f);
        }
      };
      listeners.push(handler);
    });
  }

  return { req, waitFor, frames, ready };
}

const reviewerHeaders = (id: string) => ({
  "x-audience": "internal",
  "x-requestor": `user:${id}`,
});

async function seedSubmission(): Promise<{ submissionId: string }> {
  if (!ctx.schema) throw new Error("schema not ready");
  const [eng] = await ctx.schema.db
    .insert(engagements)
    .values({
      name: "Live Events Test",
      nameLower: "live events test",
      jurisdiction: "Bastrop, TX",
      address: "1 SSE Ln",
      status: "active",
    })
    .returning();
  const [sub] = await ctx.schema.db
    .insert(submissions)
    .values({ engagementId: eng.id, jurisdiction: "Bastrop, TX" })
    .returning();
  return { submissionId: sub.id };
}

async function seedReviewer(id: string, displayName: string): Promise<void> {
  if (!ctx.schema) throw new Error("schema not ready");
  await ctx.schema.db
    .insert(users)
    .values({ id, displayName, email: null, avatarUrl: null });
}

async function seedFindingRow(
  submissionId: string,
): Promise<{ atomId: string }> {
  if (!ctx.schema) throw new Error("schema not ready");
  const atomId = `finding:${submissionId}:SEEDFINDING000000`;
  await ctx.schema.db.insert(findings).values({
    atomId,
    submissionId,
    severity: "concern",
    category: "egress",
    status: "ai-produced",
    text: "seed finding",
    citations: [] as unknown as Record<string, unknown>[],
    confidence: "0.9",
    lowConfidence: false,
    aiGeneratedAt: new Date(),
  });
  return { atomId };
}

describe("GET /api/submissions/:id/events — audience gate", () => {
  it("403s when the caller is not internal-audience", async () => {
    const { submissionId } = await seedSubmission();
    const res = await request(getApp()).get(
      `/api/submissions/${submissionId}/events`,
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: "submission_events_require_internal_audience",
    });
  });

  it("404s when the submission does not exist", async () => {
    const res = await request(getApp())
      .get(`/api/submissions/00000000-0000-0000-0000-000000000000/events`)
      .set(reviewerHeaders("reviewer-x"));
    expect(res.status).toBe(404);
  });
});

describe("PLR-9 SSE channel — presence + finding events", () => {
  it("emits presence snapshot, fans out finding.added on mutation, and emits presence.left on disconnect", async () => {
    const { submissionId } = await seedSubmission();
    await seedReviewer("reviewer-alpha", "Alex Reviewer");
    await seedReviewer("reviewer-bravo", "Bao Reviewer");

    const a = openSseStream({
      path: `/api/submissions/${submissionId}/events`,
      headers: reviewerHeaders("reviewer-alpha"),
    });
    await a.ready;

    // Subscriber A receives a presence.joined snapshot containing
    // itself.
    const aSelf = await a.waitFor(
      (f) =>
        f.event === "presence.joined" &&
        Array.isArray((f.data as { presence?: unknown }).presence) &&
        ((f.data as { presence: Array<{ id: string }> }).presence.some(
          (u) => u.id === "reviewer-alpha",
        ) ??
          false),
    );
    expect(aSelf).toBeTruthy();

    // Second reviewer joins. A should receive a presence.joined for
    // bravo with the updated snapshot.
    const b = openSseStream({
      path: `/api/submissions/${submissionId}/events`,
      headers: reviewerHeaders("reviewer-bravo"),
    });
    await b.ready;

    const aSawBravo = await a.waitFor(
      (f) =>
        f.event === "presence.joined" &&
        (f.data as { user?: { id?: string } }).user?.id === "reviewer-bravo",
    );
    expect(aSawBravo).toBeTruthy();
    expect(
      (aSawBravo.data as { presence: Array<{ id: string }> }).presence
        .map((u) => u.id)
        .sort(),
    ).toEqual(["reviewer-alpha", "reviewer-bravo"]);

    // Reviewer A accepts a seeded finding. Both A and B should
    // receive a finding.accepted frame fanned out by the broker.
    const { atomId } = await seedFindingRow(submissionId);
    const acceptRes = await request(getApp())
      .post(`/api/findings/${encodeURIComponent(atomId)}/accept`)
      .set(reviewerHeaders("reviewer-alpha"));
    expect(acceptRes.status).toBe(200);

    const aFinding = await a.waitFor(
      (f) =>
        f.event === "finding.accepted" &&
        (f.data as { payload?: { findingId?: string } }).payload?.findingId ===
          atomId,
    );
    const bFinding = await b.waitFor(
      (f) =>
        f.event === "finding.accepted" &&
        (f.data as { payload?: { findingId?: string } }).payload?.findingId ===
          atomId,
    );
    expect(aFinding).toBeTruthy();
    expect(bFinding).toBeTruthy();

    // Bravo disconnects; alpha should observe presence.left for
    // bravo's id with the updated snapshot.
    b.req.destroy();
    const aBravoLeft = await a.waitFor(
      (f) =>
        f.event === "presence.left" &&
        (f.data as { user?: { id?: string } }).user?.id === "reviewer-bravo",
    );
    expect(aBravoLeft).toBeTruthy();
    expect(
      (aBravoLeft.data as { presence: Array<{ id: string }> }).presence.map(
        (u) => u.id,
      ),
    ).toEqual(["reviewer-alpha"]);

    a.req.destroy();
  });

  it("collapses multiple tabs from the same reviewer into one presence chip", async () => {
    const { submissionId } = await seedSubmission();
    await seedReviewer("reviewer-cassidy", "Casey Reviewer");

    const tab1 = openSseStream({
      path: `/api/submissions/${submissionId}/events`,
      headers: reviewerHeaders("reviewer-cassidy"),
    });
    await tab1.ready;
    await tab1.waitFor((f) => f.event === "presence.joined");

    const tab2 = openSseStream({
      path: `/api/submissions/${submissionId}/events`,
      headers: reviewerHeaders("reviewer-cassidy"),
    });
    await tab2.ready;
    // tab2's own presence snapshot still arrives — but tab1 should
    // NOT see a duplicate presence.joined for cassidy.
    const tab2Self = await tab2.waitFor(
      (f) => f.event === "presence.joined",
    );
    expect(
      (tab2Self.data as { presence: Array<{ id: string }> }).presence,
    ).toHaveLength(1);

    // Wait briefly to be sure no duplicate join leaks to tab1.
    await new Promise((r) => setTimeout(r, 100));
    const joinFramesOnTab1 = tab1.frames.filter(
      (f) => f.event === "presence.joined",
    );
    expect(joinFramesOnTab1).toHaveLength(1);

    tab1.req.destroy();
    tab2.req.destroy();
  });
});
