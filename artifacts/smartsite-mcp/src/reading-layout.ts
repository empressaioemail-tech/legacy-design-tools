/**
 * P-447. Text-first tool results for hosts that do not render MCP Apps.
 */

type BriefSection = {
  id?: string;
  title?: string;
  data?: Record<string, unknown> | null;
  disposition?: string;
  dispositionDisplayText?: string;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function sectionValue(section: BriefSection): string {
  if (section.disposition !== "present" || !section.data) return "—";
  const d = section.data;
  switch (section.id) {
    case "zoning":
      return String(d.district ?? "?");
    case "flood":
      return String(d.floodZone ?? "?");
    case "land-use":
      return String(d.landUseLabel ?? d.landUseCode ?? "?");
    case "setbacks-envelope":
      return `${d.frontFt ?? "-"}/${d.sideFt ?? "-"}/${d.rearFt ?? "-"}/${d.cornerFt ?? "-"} ft`;
    default:
      return JSON.stringify(d);
  }
}

function answerLine(data: Record<string, unknown>): string {
  const draw = asRecord(data.draw);
  const onRecord = asRecord(data.onRecord);
  const label =
    (typeof draw?.label === "string" ? draw.label.replace(/\s+,/, ",").trim() : null) ??
    (onRecord?.apn ? `parcel APN ${onRecord.apn}` : null) ??
    (typeof data.parcelNodeId === "string" ? data.parcelNodeId : "this parcel");
  const sections = ((asRecord(data.brief)?.sections ?? []) as BriefSection[]).slice(0, 4);
  const facts = sections
    .map((s) => `${s.title ?? s.id ?? "fact"}: ${sectionValue(s)}`)
    .join("; ");
  return facts ? `${label}. ${facts}.` : `${label}.`;
}

function compactListTable(data: Record<string, unknown>): string | null {
  const parcels = data.parcels;
  if (!Array.isArray(parcels) || parcels.length === 0) return null;
  const rows = parcels.slice(0, 8).map((raw, i) => {
    const p = asRecord(raw);
    const id = typeof p?.parcelNodeId === "string" ? p.parcelNodeId : `#${i + 1}`;
    const situs =
      typeof p?.situs === "string"
        ? p.situs
        : typeof p?.label === "string"
          ? p.label
          : id;
    return `| ${i + 1} | ${situs} | ${id} |`;
  });
  return ["| # | Situs | Parcel id |", "| --- | --- | --- |", ...rows].join("\n");
}

export function buildReadingLayoutText(
  data: Record<string, unknown>,
  link: { url: string; expiresAt: string; expiryReason: string },
  hostHints?: { openInBrowser?: boolean },
): string {
  const lines: string[] = [];
  lines.push(`Answer: ${answerLine(data)}`);
  const sections = ((asRecord(data.brief)?.sections ?? []) as BriefSection[]).slice(0, 4);
  if (sections.length > 0) {
    lines.push("");
    lines.push("Four facts:");
    for (const s of sections) {
      lines.push(
        `- ${s.title ?? s.id ?? "fact"}: ${sectionValue(s)} (${s.dispositionDisplayText ?? s.disposition ?? "unknown"})`,
      );
    }
  }
  const table = compactListTable(data);
  if (table) {
    lines.push("");
    lines.push(table);
  }
  lines.push("");
  lines.push(`Open this answer as a web page: ${link.url}`);
  lines.push(`Link expires: ${link.expiresAt}. ${link.expiryReason}`);
  if (hostHints?.openInBrowser) {
    lines.push(
      "Claude in Chrome: open the link above in a new browser tab beside the chat so the user sees the full Smart Site card.",
    );
  }
  return lines.join("\n");
}

export function injectCardPageLink(
  text: string,
  link: { url: string; expiresAt: string; expiryReason: string },
): string {
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    data.cardPageLink = link.url;
    data.cardPageLinkExpiresAt = link.expiresAt;
    data.cardPageLinkExpiryReason = link.expiryReason;
    return JSON.stringify(data);
  } catch {
    return `${text.trim()}\n\ncardPageLink: ${link.url}\nexpires: ${link.expiresAt}\n${link.expiryReason}`;
  }
}
