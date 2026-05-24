import type { EngagementPackageRecord } from "./types";

export function downloadClientPresentationHtml(args: {
  engagementName: string;
  packageRecord: EngagementPackageRecord;
  sheetLabels: Record<string, string>;
}): void {
  const { engagementName, packageRecord, sheetLabels } = args;
  const form = packageRecord.formSnapshot ?? {};
  const headline =
    form.clientHeadline?.trim() || `${engagementName} — design presentation`;
  const points =
    form.clientTalkingPoints?.trim() ||
    "Review the selected sheets and renderings below.";
  const sheetLines = (packageRecord.selection.sheetIds ?? [])
    .map((id) => sheetLabels[id] ?? id)
    .map((label) => `<li>${escapeHtml(label)}</li>`)
    .join("\n");

  const html = [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8" />',
    `  <title>${escapeHtml(headline)}</title>`,
    "  <style>",
    "    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #111; }",
    "    h1 { font-size: 24px; margin-bottom: 8px; }",
    "    .meta { color: #666; font-size: 14px; margin-bottom: 24px; }",
    "    .points { white-space: pre-wrap; line-height: 1.5; margin-bottom: 24px; }",
    "    ul { line-height: 1.6; }",
    "  </style>",
    "</head>",
    "<body>",
    `  <h1>${escapeHtml(headline)}</h1>`,
    `  <p class="meta">${escapeHtml(engagementName)} · exported ${new Date().toLocaleDateString()}</p>`,
    `  <div class="points">${escapeHtml(points)}</div>`,
    "  <h2>Included plan sheets</h2>",
    `  <ul>${sheetLines || "<li>No sheets selected</li>"}</ul>`,
    "  <p class=\"meta\">Open the engagement in Design Accelerator for full-resolution assets.</p>",
    "</body>",
    "</html>",
  ].join("\n");

  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slug(engagementName)}-client-presentation.html`;
  a.click();
  URL.revokeObjectURL(url);
}

function slug(raw: string): string {
  return (
    raw
      .trim()
      .replace(/[^\w.\- ]+/g, "_")
      .replace(/\s+/g, "-")
      .slice(0, 48) || "package"
  );
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
