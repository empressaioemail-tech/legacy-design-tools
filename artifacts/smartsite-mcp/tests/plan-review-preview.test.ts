import { describe, expect, it } from "vitest";

import { APP_RESOURCE_URI, parseToolResult } from "../src/card/panel-lib.js";
import { precheckDeepHtml, precheckInlineHtml } from "../src/card/precheck-html.js";
import {
  PLAN_REVIEW_PREVIEW_TOOL,
  PRECHECK_FIXTURE,
  planReviewPreviewAllowed,
  registerPlanReviewPreview,
} from "../src/plan-review-preview.js";
import { runWithAuth } from "../src/request-context.js";

const ctx = (email: string | null) => ({ userId: "u1", email, accessTier: "paid" as const, subscriptionTier: null, devRole: false });

function fakeServer() {
  const tools: { name: string; config: Record<string, unknown>; handler: () => Promise<any> }[] = [];
  return { tools, registerTool: (name: string, config: Record<string, unknown>, handler: () => Promise<any>) => tools.push({ name, config, handler }) };
}

function withAllowList<T>(fn: () => T): T {
  const prev = process.env.PLAN_REVIEW_PREVIEW_EMAILS;
  process.env.PLAN_REVIEW_PREVIEW_EMAILS = "op@example.com";
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.PLAN_REVIEW_PREVIEW_EMAILS; else process.env.PLAN_REVIEW_PREVIEW_EMAILS = prev;
  }
}

describe("plan review preview gate", () => {
  it("refuses when the allow-list is unset or the email is absent or other", () => {
    expect(planReviewPreviewAllowed("op@example.com", undefined)).toBe(false);
    expect(planReviewPreviewAllowed(null, "op@example.com")).toBe(false);
    expect(planReviewPreviewAllowed("someone@example.com", "op@example.com")).toBe(false);
    expect(planReviewPreviewAllowed("OP@Example.com", "a@b.c, op@example.com")).toBe(true);
  });
  it("registers nothing for a caller off the list", () => {
    withAllowList(() => {
      const s = fakeServer();
      expect(runWithAuth(ctx("customer@example.com"), () => registerPlanReviewPreview(s))).toBe(false);
      expect(s.tools).toEqual([]);
    });
  });
});

describe("plan review preview renders in the Smart Site card", () => {
  it("points at the Smart Site app and its result parses to the precheck view", async () => {
    await withAllowList(async () => {
      const s = fakeServer();
      runWithAuth(ctx("op@example.com"), () => registerPlanReviewPreview(s));
      expect(s.tools.map((t) => t.name)).toEqual([PLAN_REVIEW_PREVIEW_TOOL]);
      expect((s.tools[0].config._meta as any).ui.resourceUri).toBe(APP_RESOURCE_URI);
      const result = await s.tools[0].handler();
      const model = parseToolResult(result.content[0].text);
      expect(model.kind).toBe("precheck");
      expect(model.precheck?.findings).toHaveLength(9);
    });
  });
  it("inline and deep views carry the design's content", () => {
    const inline = precheckInlineHtml(PRECHECK_FIXTURE);
    expect(inline).toContain("908 PINE ST");
    expect(inline).toContain("Front setback");
    expect(inline).toContain("FIXTURE");
    expect(inline).toContain("Open findings");
    const deep = precheckDeepHtml(PRECHECK_FIXTURE);
    expect(deep).toContain("The city reviews these");
    expect(deep).toContain("No issue found");
    expect(deep).toContain("<svg");
  });
});
