/**
 * ICC plan review preview (demo only).
 *
 * A fixture plan review rendered as an MCP App, to show what plan review would
 * look like inside the connector. Nothing here reads a real submission: the
 * engagement, sheet and findings are the SmartCity design fixture
 * (PR-2026-0418, 908 PINE ST), and the card says so on every view.
 *
 * Registered only for the emails in PLAN_REVIEW_PREVIEW_EMAILS. With the
 * variable unset, neither the tool nor its resource exists, so no customer
 * session ever lists it. The HTML is self-contained (no card bundle, no
 * external origins), so it cannot disturb the Smart Site board.
 */
import { getAuthContext } from "./request-context.js";
import { buildPlanReviewPreviewPage } from "./plan-review-preview-page.js";

export const PLAN_REVIEW_PREVIEW_TOOL = "plan_review_preview";
export const PLAN_REVIEW_PREVIEW_URI = "ui://smartsite/plan-review-preview-v2.html";
const APP_MIME = "text/html;profile=mcp-app";

export function planReviewPreviewAllowed(
  email: string | null | undefined,
  allowList: string | undefined = process.env.PLAN_REVIEW_PREVIEW_EMAILS,
): boolean {
  if (!email || !allowList) return false;
  const want = email.trim().toLowerCase();
  return allowList
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(want);
}

const SUMMARY_TEXT = [
  "ILLUSTRATIVE PREVIEW - a fixture plan review, not a review of any real submission.",
  "Engagement PR-2026-0418, 908 PINE ST, Bastrop TX, single-family, cycle 1, edition declared at intake.",
  "13 findings: 12 rules in scope plus 1 added by a reviewer. Fail 2, Uncertain 1, Unchecked 9, Pass 1.",
  "1 Front setback - Fail, live check: proposed 22'-0\" is below the 25'-0\" SF-1 minimum (City of Bastrop Building Block B3 Section 14-02-003).",
  "2 Fire separation distance - Uncertain, escalated to a reviewer: two adopted authorities conflict for the west wall (2018 International Building Code Section 705.5; text not reproduced).",
  "3 and 4 Side and rear setbacks - Unchecked: section not in the corpus, so no citation can be built.",
  "6 Driveway width - Fail by a reviewer, held back: no citation yet, so it cannot be issued.",
  "Correction notice (draft): 1 correction, 1 escalated, 10 not evaluated, 1 held back. None of this is an approval.",
  "How we treat the code: each finding carries a canonical citation, an atom id and a confidence object, and no ICC body text; ICC text is refused to Claude (accessPolicy platform-internal) and replaced by a deep link to codes.iccsafe.org; every reference is metered by source, book and section ($0.01 is a proof-of-concept fixture, not a quoted price).",
  "The card opens on the findings matrix (Bastrop UDC and IBC-2018 rows, each with its section, atom id, confidence and status; IBC rows marked body withheld). Clicking a row opens how it was reached; the Letter tab is the draft correction notice; the Code tab is the code library entry for IBC 1001.1 with the usage ledger. IBC citations open the section on ICC Digital Codes (1001.1 and 705.5 deep-link to the section; others open the book).",
  "Reply in one or two sentences inviting the user to click through the card. Present it as a preview of plan review in Claude; do not describe it as a real review, and do not repeat the findings as a list.",
].join("\n");

export function buildPlanReviewPreviewHtml(): string {
  return buildPlanReviewPreviewPage();
}

type ResourceHandler = (uri: { href: string }) => Promise<{
  contents: Array<{ uri: string; mimeType: string; text: string; _meta?: Record<string, unknown> }>;
}>;

type PreviewServer = {
  registerResource?: (name: string, uri: string, config: Record<string, unknown>, handler: ResourceHandler) => void;
  registerTool: (
    name: string,
    config: Record<string, unknown>,
    handler: () => Promise<{
      content: Array<{ type: "text"; text: string }>;
      structuredContent?: Record<string, unknown>;
    }>,
  ) => void;
};

/** Registers the preview tool and its card only for allow-listed operators. */
export function registerPlanReviewPreview(server: PreviewServer): boolean {
  if (!planReviewPreviewAllowed(getAuthContext()?.email)) return false;
  if (typeof server.registerResource === "function") {
    server.registerResource("Plan review preview", PLAN_REVIEW_PREVIEW_URI, { mimeType: APP_MIME }, async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: APP_MIME,
          text: buildPlanReviewPreviewHtml(),
          _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } },
        },
      ],
    }));
  }
  server.registerTool(
    PLAN_REVIEW_PREVIEW_TOOL,
    {
      title: "Plan review preview (demo)",
      description:
        "DEMO ONLY. Opens an illustrative ICC-style plan review in the card: the review console (plan sheet with pinned findings), how a finding was reached (rule, input, comparison), and the draft correction notice. Use when the user asks for an ICC review, a plan review, a code review of a plan set, or a plan review preview. The data is a fixed fixture (PR-2026-0418, 908 PINE ST, Bastrop TX); it reviews no real submission, and must be presented as a preview of plan review in Claude, never as a real review or a determination.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: PLAN_REVIEW_PREVIEW_URI } },
    },
    async () => ({
      content: [{ type: "text" as const, text: SUMMARY_TEXT }],
      structuredContent: {
        fixture: true,
        engagement: "PR-2026-0418",
        address: "908 PINE ST, Bastrop TX",
        counts: { total: 13, fail: 2, uncertain: 1, unchecked: 9, pass: 1 },
      },
    }),
  );
  return true;
}
