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
export const PLAN_REVIEW_PREVIEW_URI = "ui://smartsite/plan-review-preview-v3.html";
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
  "ILLUSTRATIVE PREVIEW - the City of Bastrop plan precheck on a fixture engagement (908 PINE ST, 48021:34137, new single-family home), not a review of any real submission.",
  "The card opens on the precheck: lot facts from the city record with their sources, the project type, the plan upload, and what the check covers. Run the check opens the Findings: 2 suggested before you submit (front setback 22 ft against a 25 ft minimum; building height could not be read), 3 the city reviews (not checked here, each with its reason), 4 with no issue found. Every number is labelled an AI reading to compare against the sheet; it is not a plan review, a permit or an approval.",
  "Reply in one or two sentences inviting the user to click through the card (Run the check, then Expand for full screen). Do not repeat the findings as a list, and never describe this as a real review.",
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
      content: Array<{ type: "text"; text: string } | { type: "resource_link"; uri: string; name: string; mimeType: string; description: string }>;
      _meta?: Record<string, unknown>;
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
        "DEMO ONLY. Opens the City of Bastrop plan precheck as an interactive card: the lot and project screen, then the Findings for 908 PINE ST (suggested before you submit, what the city reviews, no issue found), drawn from the SmartCity precheck design. Use when the user asks for an ICC review, a plan review, a plan precheck, or a code review of a plan set. Fixture data; present it as a preview of plan review in Claude, never as a real review or a determination.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: PLAN_REVIEW_PREVIEW_URI } },
    },
    async () => ({
      content: [
        { type: "text" as const, text: SUMMARY_TEXT },
        // Same shape the Smart Site board returns, so hosts that key on the
        // result's link render the card the same way.
        {
          type: "resource_link" as const,
          uri: PLAN_REVIEW_PREVIEW_URI,
          name: "Plan review preview",
          mimeType: APP_MIME,
          description: "Interactive City of Bastrop plan precheck: lot and project, then Findings.",
        },
      ],
      _meta: { ui: { resourceUri: PLAN_REVIEW_PREVIEW_URI } },
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
