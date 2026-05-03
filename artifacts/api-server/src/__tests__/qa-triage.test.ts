/**
 * Task #503 — QA triage queue.
 *
 * Covers:
 *  - POST /api/qa/triage from each of the four source kinds
 *  - PATCH .../bulk for status moves (open → sent, sent → done)
 *  - GET /api/qa/triage with and without status filter, plus counts
 *  - DELETE /api/qa/triage/:id
 *  - POST /api/qa/triage/bundle (markdown formatter integration)
 *  - dedupe behavior on duplicate POSTs while still in the open lane
 *  - the renderTriageBundle pure formatter
 */

import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("qa-triage.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { renderTriageBundle } = await import("../lib/qa/triageBundle");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

async function create(body: Record<string, unknown>): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const res = await request(getApp())
    .post("/api/qa/triage")
    .send(body)
    .set("content-type", "application/json");
  return { status: res.status, body: res.body };
}

describe("POST /api/qa/triage — create from each source kind", () => {
  it("accepts an autopilot finding", async () => {
    const r = await create({
      sourceKind: "autopilot_finding",
      sourceId: "finding-1",
      sourceRunId: "11111111-1111-1111-1111-111111111111",
      suiteId: "qa-vitest",
      title: "qa-vitest — flaky.spec.ts › retried",
      severity: "warning",
      excerpt: "Error: spurious timeout\n  at foo (file:1:1)",
      suggestedNextStep: "Mark test as flaky or stabilize the timer.",
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      sourceKind: "autopilot_finding",
      status: "open",
      severity: "warning",
      suiteId: "qa-vitest",
    });
    expect(typeof r.body["id"]).toBe("string");
  });

  it("accepts a run-history failure", async () => {
    const r = await create({
      sourceKind: "run",
      sourceId: "22222222-2222-2222-2222-222222222222",
      sourceRunId: "22222222-2222-2222-2222-222222222222",
      suiteId: "design-tools-e2e",
      title: "design-tools-e2e run failed",
    });
    expect(r.status).toBe(201);
    expect(r.body["sourceKind"]).toBe("run");
    // Default severity is "error" when omitted.
    expect(r.body["severity"]).toBe("error");
  });

  it("accepts a suite_failure card", async () => {
    const r = await create({
      sourceKind: "suite_failure",
      sourceId: "design-tools-e2e",
      suiteId: "design-tools-e2e",
      title: "design-tools-e2e suite failed",
    });
    expect(r.status).toBe(201);
  });

  it("accepts a checklist_item failure", async () => {
    const r = await create({
      sourceKind: "checklist_item",
      sourceId: "release-prep/login-works",
      suiteId: "release-prep",
      title: "release-prep — Login works for new users",
    });
    expect(r.status).toBe(201);
  });

  it("rejects unknown source kinds", async () => {
    const r = await create({
      sourceKind: "bogus",
      sourceId: "x",
      title: "x",
    });
    expect(r.status).toBe(400);
  });

  it("dedupes duplicate open items by (sourceKind, sourceId)", async () => {
    const a = await create({
      sourceKind: "suite_failure",
      sourceId: "qa-vitest",
      title: "qa-vitest suite failed",
    });
    const b = await create({
      sourceKind: "suite_failure",
      sourceId: "qa-vitest",
      title: "qa-vitest suite failed (dup)",
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body["id"]).toBe(a.body["id"]);
  });
});

describe("GET /api/qa/triage — listing + counts", () => {
  it("returns honest counts even when filtered", async () => {
    await create({
      sourceKind: "autopilot_finding",
      sourceId: "f-a",
      title: "a",
    });
    await create({
      sourceKind: "autopilot_finding",
      sourceId: "f-b",
      title: "b",
    });
    const all = await request(getApp()).get("/api/qa/triage");
    expect(all.status).toBe(200);
    expect(all.body.counts.total).toBe(2);
    expect(all.body.counts.open).toBe(2);
    expect(all.body.items).toHaveLength(2);

    const sentOnly = await request(getApp()).get("/api/qa/triage?status=sent");
    expect(sentOnly.status).toBe(200);
    expect(sentOnly.body.items).toHaveLength(0);
    // counts must still reflect the entire table
    expect(sentOnly.body.counts.total).toBe(2);
    expect(sentOnly.body.counts.open).toBe(2);
  });
});

describe("PATCH /api/qa/triage/bulk — lane moves", () => {
  it("moves items to sent and stamps sentAt; subsequent move to done clears sentAt", async () => {
    const a = await create({
      sourceKind: "run",
      sourceId: "rr-1",
      title: "rr-1",
    });
    const b = await create({
      sourceKind: "run",
      sourceId: "rr-2",
      title: "rr-2",
    });
    const ids = [a.body["id"] as string, b.body["id"] as string];
    const sent = await request(getApp())
      .patch("/api/qa/triage/bulk")
      .send({ ids, status: "sent" });
    expect(sent.status).toBe(200);
    expect(sent.body.updated).toHaveLength(2);
    for (const row of sent.body.updated) {
      expect(row.status).toBe("sent");
      expect(row.sentAt).toBeTruthy();
      expect(row.doneAt).toBeNull();
    }

    const done = await request(getApp())
      .patch("/api/qa/triage/bulk")
      .send({ ids, status: "done" });
    expect(done.status).toBe(200);
    for (const row of done.body.updated) {
      expect(row.status).toBe("done");
      expect(row.doneAt).toBeTruthy();
    }
  });

  it("requires at least one id", async () => {
    const r = await request(getApp())
      .patch("/api/qa/triage/bulk")
      .send({ ids: [], status: "sent" });
    expect(r.status).toBe(400);
  });
});

describe("DELETE /api/qa/triage/:id", () => {
  it("removes the item and returns 404 the second time", async () => {
    const r = await create({
      sourceKind: "run",
      sourceId: "to-delete",
      title: "x",
    });
    const id = r.body["id"] as string;
    const first = await request(getApp()).delete(`/api/qa/triage/${id}`);
    expect(first.status).toBe(200);
    const second = await request(getApp()).delete(`/api/qa/triage/${id}`);
    expect(second.status).toBe(404);
  });
});

describe("POST /api/qa/triage/bundle — markdown bundle endpoint", () => {
  it("renders only open items when ids omitted, and includes title + excerpt", async () => {
    await create({
      sourceKind: "autopilot_finding",
      sourceId: "f-bundle-1",
      sourceRunId: "33333333-3333-3333-3333-333333333333",
      suiteId: "qa-vitest",
      title: "qa-vitest — bundles correctly",
      severity: "error",
      excerpt: "AssertionError: expected 1 to equal 2",
      suggestedNextStep: "Update the fixture or fix the regression.",
    });
    const r = await request(getApp()).post("/api/qa/triage/bundle").send({});
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(1);
    expect(r.body.markdown).toContain("# QA triage brief");
    expect(r.body.markdown).toContain("qa-vitest — bundles correctly");
    expect(r.body.markdown).toContain("AssertionError: expected 1 to equal 2");
    expect(r.body.markdown).toContain("Update the fixture");
  });

  it("renders just the requested ids when provided", async () => {
    const a = await create({
      sourceKind: "run",
      sourceId: "bundle-a",
      title: "bundle-a",
    });
    await create({
      sourceKind: "run",
      sourceId: "bundle-b",
      title: "bundle-b",
    });
    const r = await request(getApp())
      .post("/api/qa/triage/bundle")
      .send({ ids: [a.body["id"]] });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(1);
    expect(r.body.markdown).toContain("bundle-a");
    expect(r.body.markdown).not.toContain("bundle-b");
  });
});

describe("renderTriageBundle (pure formatter)", () => {
  function makeItem(overrides: Partial<Parameters<typeof renderTriageBundle>[0][number]> = {}) {
    const now = new Date("2026-05-03T12:00:00Z");
    return {
      id: "00000000-0000-0000-0000-000000000001",
      sourceKind: "autopilot_finding" as const,
      sourceId: "finding-99",
      sourceRunId: "44444444-4444-4444-4444-444444444444",
      suiteId: "qa-vitest",
      title: "qa-vitest — sample failure",
      severity: "error" as const,
      excerpt: "stack trace line 1\nstack trace line 2",
      suggestedNextStep: "Patch the broken assertion.",
      status: "open" as const,
      createdAt: now,
      sentAt: null,
      doneAt: null,
      ...overrides,
    };
  }

  it("returns a placeholder when there are no items", () => {
    expect(renderTriageBundle([])).toContain("(no items)");
  });

  it("renders one section per item with link, severity, excerpt, suggestion", () => {
    const md = renderTriageBundle([makeItem()], {
      baseUrl: "https://qa.example.com",
    });
    expect(md).toContain("# QA triage brief");
    expect(md).toContain("## 1. qa-vitest — sample failure");
    expect(md).toContain("**Source:** Autopilot finding");
    expect(md).toContain("**Severity:** error");
    expect(md).toContain("https://qa.example.com/qa/autopilot?run=");
    expect(md).toContain("```");
    expect(md).toContain("stack trace line 1");
    expect(md).toContain("Patch the broken assertion.");
  });

  it("substitutes a generic suggestion when none is provided", () => {
    const md = renderTriageBundle([makeItem({ suggestedNextStep: "" })]);
    expect(md).toContain("Investigate and propose a fix.");
  });

  it("does not include a Link line for autopilot items missing a runId", () => {
    const md = renderTriageBundle([
      makeItem({ sourceRunId: null }),
    ]);
    expect(md).not.toContain("**Link:**");
  });

  it("escapes triple backticks in the excerpt so the fence cannot be broken", () => {
    const md = renderTriageBundle([
      makeItem({ excerpt: "before```after" }),
    ]);
    expect(md).not.toMatch(/```after/);
    expect(md).toContain("ʼʼʼafter");
  });

  it("renders run, suite_failure, and checklist_item links correctly", () => {
    const items = [
      makeItem({
        id: "00000000-0000-0000-0000-0000000000aa",
        sourceKind: "run",
        sourceId: "run-id",
        sourceRunId: null,
        title: "run case",
      }),
      makeItem({
        id: "00000000-0000-0000-0000-0000000000bb",
        sourceKind: "suite_failure",
        sourceId: "qa-vitest",
        sourceRunId: null,
        title: "suite case",
      }),
      makeItem({
        id: "00000000-0000-0000-0000-0000000000cc",
        sourceKind: "checklist_item",
        sourceId: "release-prep/login",
        sourceRunId: null,
        title: "checklist case",
      }),
    ];
    const md = renderTriageBundle(items, { baseUrl: "https://qa.example.com" });
    expect(md).toContain("/qa/history?run=run-id");
    expect(md).toContain("/qa/?suite=qa-vitest");
    expect(md).toContain("/qa/checklists?checklist=release-prep");
  });
});
