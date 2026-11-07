/**
 * ICC plan review preview (demo only).
 *
 * Returns a fixture City of Bastrop plan precheck (908 PINE ST) that the Smart
 * Site card renders as its own "precheck" view (card/precheck-html.ts), inline
 * and in the fullscreen deep view. Content follows the SmartCity design canvas
 * artboards PrecheckStart and PrecheckFindings. Nothing reads a real
 * submission, and the card says so.
 *
 * Registered only for the emails in PLAN_REVIEW_PREVIEW_EMAILS. With the
 * variable unset the tool does not exist, so no customer session lists it.
 */
import { APP_MIME, APP_RESOURCE_URI } from "./card/panel-lib.js";
import type { PrecheckData } from "./card/precheck-html.js";
import { getAuthContext } from "./request-context.js";

export const PLAN_REVIEW_PREVIEW_TOOL = "plan_review_preview";

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

const BDC = "City of Bastrop Building Block B3 Section 14-02-003 (bastrop_tx-bdc-2026-adopted)";

export const PRECHECK_FIXTURE: PrecheckData = {
  address: "908 PINE ST",
  city: "Bastrop, TX",
  parcelNodeId: "48021:34137",
  project: "New single-family home",
  precheckId: "PC-7K2F-9QD4",
  version: "version 1 · 8 Sep 2026",
  when: "8 Sep 2026, 14:12",
  lot: [
    { label: "Zoning district", value: "SF-1", source: "City record" },
    { label: "Lot area", value: "7,200 SF", source: "City record" },
    { label: "FEMA flood zone", value: "X", source: "FEMA map" },
    { label: "Front / side / rear", value: "25′ / 5′ / 20′ min", source: "City record" },
    { label: "Height, coverage", value: "35′ / 45% max", source: "City record" },
  ],
  sheets: ["A-101", "A-102", "A-201", "S-101", "C-101", "E-101"],
  findings: [
    { n: 1, title: "Front setback", status: "suggestion", reading: "22′-0″", rule: "25′-0″ minimum", sheet: "A-101", note: "Your site plan shows 22′-0″ where this lot requires 25′-0″ minimum. Move the house back, or plan to ask the city about it.", citation: BDC },
    { n: 5, title: "Building height", status: "not-read", rule: "35′-0″ maximum", sheet: "A-201", note: "We could not find an overall building height on A-201, your elevation sheet. Add the dimension and run the check again.", citation: BDC },
    { n: 7, title: "Permitted use", status: "city-reviews", note: "Use is not a measurement, so nothing here can check it automatically. The city reviews it.", citation: "City of Bastrop Building Block B3 Section 14-02-008 (bastrop_tx-bdc-2026-adopted)" },
    { n: 8, title: "Exterior walls", status: "city-reviews", note: "The city has not set its residential code edition in this check, so no citation can be built and the rule does not run.", citation: "No citation (R302.1, edition not set)" },
    { n: 9, title: "Driveway width", status: "city-reviews", note: "Not part of this check yet. The city reviews it.", citation: "No citation" },
    { n: 2, title: "Side setback, west", status: "no-issue", reading: "6′-0″", rule: "5′-0″ minimum", sheet: "A-101", note: "Meets the minimum.", citation: BDC },
    { n: 3, title: "Side setback, east", status: "no-issue", reading: "14′-0″", rule: "5′-0″ minimum", sheet: "A-101", note: "Meets the minimum.", citation: BDC },
    { n: 4, title: "Rear setback", status: "no-issue", reading: "20′-0″", rule: "20′-0″ minimum", sheet: "A-101", note: "Meets the minimum exactly.", citation: BDC },
    { n: 6, title: "Lot coverage", status: "no-issue", reading: "2,880 SF footprint", rule: "45% maximum", sheet: "A-101", note: "40.0% of the 7,200 SF lot on the city record.", citation: BDC },
  ],
};

const SUMMARY =
  "ILLUSTRATIVE PREVIEW of plan review in Claude: the City of Bastrop plan precheck on a fixture (908 PINE ST, new single-family home), not a review of any real submission. The Smart Site card shows the lot facts with their sources, 9 checks (2 suggested before you submit, 3 the city reviews, 4 no issue found), each with its reading, rule and citation; Open findings shows the A-101 sheet with numbered pins. Every number is an AI reading, not a plan review, permit or approval. Reply in one or two sentences inviting the user to use the card; do not list the findings and never call it a real review.";

type PreviewServer = {
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

/** Registers the preview tool only for allow-listed operators. The card is the Smart Site app. */
export function registerPlanReviewPreview(server: PreviewServer): boolean {
  if (!planReviewPreviewAllowed(getAuthContext()?.email)) return false;
  const payload = { precheck: PRECHECK_FIXTURE, summary: SUMMARY, fixture: true };
  server.registerTool(
    PLAN_REVIEW_PREVIEW_TOOL,
    {
      title: "Plan review preview (demo)",
      description:
        "DEMO ONLY. Opens a City of Bastrop plan precheck in the Smart Site card: lot facts with sources, the checks with their readings, rules and citations, and the site plan with numbered pins. Use when the user asks for an ICC review, a plan review, a plan precheck, or a code review of a plan set. Fixture data; present it as a preview of plan review in Claude, never as a real review or a determination.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: APP_RESOURCE_URI } },
    },
    async () => ({
      // The card reads the first text part as JSON, as for every Smart Site tool.
      content: [
        { type: "text" as const, text: JSON.stringify(payload) },
        {
          type: "resource_link" as const,
          uri: APP_RESOURCE_URI,
          name: "Smart Site board",
          mimeType: APP_MIME,
          description: "Smart Site card: plan precheck preview.",
        },
      ],
      _meta: { ui: { resourceUri: APP_RESOURCE_URI } },
      structuredContent: payload as unknown as Record<string, unknown>,
    }),
  );
  return true;
}
