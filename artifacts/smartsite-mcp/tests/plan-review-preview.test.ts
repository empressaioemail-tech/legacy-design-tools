import { describe, expect, it } from "vitest";

import {
  PLAN_REVIEW_PREVIEW_TOOL,
  PLAN_REVIEW_PREVIEW_URI,
  buildPlanReviewPreviewHtml,
  planReviewPreviewAllowed,
  registerPlanReviewPreview,
} from "../src/plan-review-preview.js";
import { runWithAuth } from "../src/request-context.js";

const ctx = (email: string | null) => ({
  userId: "u1",
  email,
  accessTier: "paid" as const,
  subscriptionTier: null,
  devRole: false,
});

function fakeServer() {
  const tools: string[] = [];
  const resources: string[] = [];
  return {
    tools,
    resources,
    registerTool: (name: string) => {
      tools.push(name);
    },
    registerResource: (_n: string, uri: string) => {
      resources.push(uri);
    },
  };
}

describe("plan review preview gate", () => {
  it("refuses when the allow-list is unset or the email is absent", () => {
    expect(planReviewPreviewAllowed("op@example.com", undefined)).toBe(false);
    expect(planReviewPreviewAllowed(null, "op@example.com")).toBe(false);
    expect(planReviewPreviewAllowed("someone@example.com", "op@example.com")).toBe(false);
  });

  it("matches case-insensitively in a comma list", () => {
    expect(planReviewPreviewAllowed("OP@Example.com", "a@b.c, op@example.com")).toBe(true);
  });

  it("registers nothing for a caller off the list", () => {
    const prev = process.env.PLAN_REVIEW_PREVIEW_EMAILS;
    process.env.PLAN_REVIEW_PREVIEW_EMAILS = "op@example.com";
    try {
      const s = fakeServer();
      const did = runWithAuth(ctx("customer@example.com"), () => registerPlanReviewPreview(s));
      expect(did).toBe(false);
      expect(s.tools).toEqual([]);
      expect(s.resources).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.PLAN_REVIEW_PREVIEW_EMAILS;
      else process.env.PLAN_REVIEW_PREVIEW_EMAILS = prev;
    }
  });

  it("registers the tool and its card for an allow-listed caller", () => {
    const prev = process.env.PLAN_REVIEW_PREVIEW_EMAILS;
    process.env.PLAN_REVIEW_PREVIEW_EMAILS = "op@example.com";
    try {
      const s = fakeServer();
      const did = runWithAuth(ctx("op@example.com"), () => registerPlanReviewPreview(s));
      expect(did).toBe(true);
      expect(s.tools).toEqual([PLAN_REVIEW_PREVIEW_TOOL]);
      expect(s.resources).toEqual([PLAN_REVIEW_PREVIEW_URI]);
    } finally {
      if (prev === undefined) delete process.env.PLAN_REVIEW_PREVIEW_EMAILS;
      else process.env.PLAN_REVIEW_PREVIEW_EMAILS = prev;
    }
  });
});

describe("plan review preview page", () => {
  const html = buildPlanReviewPreviewHtml();
  it("is the precheck design, labelled a fixture", () => {
    expect(html).toContain("Check your plans before you submit");
    expect(html).toContain("Findings for 908 PINE ST");
    expect(html).toContain("FIXTURE");
  });
  it("loads nothing from another origin", () => {
    expect(html).not.toMatch(/(src|href)=["']https?:/);
    expect(html).not.toContain("support.js");
  });
  it("does the app handshake, reports its height and can ask for fullscreen", () => {
    expect(html).toContain("ui/initialize");
    expect(html).toContain("ui/notifications/size-changed");
    expect(html).toContain("ui/request-display-mode");
  });
  it("cannot end its own script early", () => {
    const body = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
    expect(body).not.toContain("</script");
  });
});
