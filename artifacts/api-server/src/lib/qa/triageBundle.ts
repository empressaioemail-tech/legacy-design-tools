/**
 * Renders triage items as a single markdown brief that reviewers can
 * paste into the planning agent. One section per item with title,
 * source, severity, error excerpt, suggested next step, and a link
 * back to the originating run / finding / checklist when available.
 *
 * Pure function — kept separate from the route layer so the
 * vitest suite can exercise it directly without spinning up Express.
 */

import type { QaTriageItem } from "@workspace/db";

export interface TriageBundleOptions {
  /**
   * Optional public-facing host (e.g. `https://qa.example.com`) used
   * to build deep links back to the dashboard. When omitted, links
   * fall back to relative paths the dashboard can resolve client-side.
   */
  baseUrl?: string | null;
}

const SOURCE_LABEL: Record<QaTriageItem["sourceKind"], string> = {
  autopilot_finding: "Autopilot finding",
  run: "Run history",
  suite_failure: "Suite failure",
  checklist_item: "Manual checklist",
};

function formatLink(item: QaTriageItem, baseUrl: string | null): string | null {
  const root = (baseUrl ?? "").replace(/\/+$/, "");
  const kind = item.sourceKind;
  if (kind === "autopilot_finding") {
    const runId = item.sourceRunId;
    if (!runId) return null;
    return `${root}/qa/autopilot?run=${encodeURIComponent(runId)}&finding=${encodeURIComponent(item.sourceId)}`;
  }
  if (kind === "run") {
    return `${root}/qa/history?run=${encodeURIComponent(item.sourceId)}`;
  }
  if (kind === "suite_failure") {
    return `${root}/qa/?suite=${encodeURIComponent(item.sourceId)}`;
  }
  if (kind === "checklist_item") {
    const [checklistId] = item.sourceId.split("/");
    return `${root}/qa/checklists?checklist=${encodeURIComponent(checklistId ?? item.sourceId)}`;
  }
  return null;
}

function fenceExcerpt(excerpt: string): string {
  if (!excerpt.trim()) return "_(no excerpt)_";
  const truncated =
    excerpt.length > 4000 ? excerpt.slice(0, 4000) + "\n…(truncated)…" : excerpt;
  return "```\n" + truncated.replace(/```/g, "ʼʼʼ") + "\n```";
}

export function renderTriageBundle(
  items: ReadonlyArray<QaTriageItem>,
  opts: TriageBundleOptions = {},
): string {
  if (items.length === 0) {
    return "# QA triage brief\n\n_(no items)_\n";
  }
  const baseUrl = opts.baseUrl ?? null;
  const header = `# QA triage brief\n\n${items.length} item${items.length === 1 ? "" : "s"} forwarded from the QA dashboard.\n`;
  const sections = items.map((item, idx) => {
    const link = formatLink(item, baseUrl);
    const lines: string[] = [];
    lines.push(`## ${idx + 1}. ${item.title}`);
    lines.push("");
    lines.push(`- **Source:** ${SOURCE_LABEL[item.sourceKind]}${item.suiteId ? ` — \`${item.suiteId}\`` : ""}`);
    lines.push(`- **Severity:** ${item.severity}`);
    lines.push(`- **Created:** ${item.createdAt.toISOString()}`);
    if (link) lines.push(`- **Link:** ${link}`);
    lines.push("");
    lines.push("**Error excerpt:**");
    lines.push("");
    lines.push(fenceExcerpt(item.excerpt));
    lines.push("");
    lines.push("**Suggested next step:**");
    lines.push("");
    lines.push(item.suggestedNextStep.trim() || "_Investigate and propose a fix._");
    return lines.join("\n");
  });
  return [header, ...sections, ""].join("\n");
}
