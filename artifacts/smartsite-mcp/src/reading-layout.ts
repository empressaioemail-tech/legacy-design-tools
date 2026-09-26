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
  const card = asRecord(data.inlineCard);
  if (typeof card?.answer === "string" && card.answer.trim()) return card.answer.trim();
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

function cellText(value: unknown, fallback = "—"): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  const rec = asRecord(value);
  if (!rec) return fallback;
  if (typeof rec.value === "string" && rec.value.trim()) return rec.value.trim();
  if (typeof rec.district === "string" && rec.district.trim()) return rec.district.trim();
  if (typeof rec.landUseLabel === "string" && rec.landUseLabel.trim()) return rec.landUseLabel;
  if (typeof rec.floodZone === "string" && rec.floodZone.trim()) return rec.floodZone;
  if (typeof rec.state === "string" && rec.state.trim()) return rec.state;
  return fallback;
}

function compactListTable(data: Record<string, unknown>): string | null {
  const nearest = Array.isArray(data.nearestNeighbors)
    ? data.nearestNeighbors
    : null;
  const parcels = Array.isArray(data.parcels) ? data.parcels : null;
  const rowsSrc = nearest && nearest.length > 0 ? nearest : parcels;
  if (!rowsSrc || rowsSrc.length === 0) return null;
  const briefById = new Map<string, Record<string, unknown>>();
  if (parcels) {
    for (const raw of parcels) {
      const p = asRecord(raw);
      if (p && typeof p.parcelNodeId === "string") briefById.set(p.parcelNodeId, p);
    }
  }
  const isNearest = nearest !== null && nearest.length > 0;
  const header = isNearest
    ? "| # | Situs | Distance | Acres | Zoning | Land use | Flood | Parcel id |"
    : "| # | Situs | Parcel id |";
  const rule = isNearest
    ? "| --- | --- | --- | --- | --- | --- | --- | --- |"
    : "| --- | --- | --- |";
  const rows = rowsSrc.slice(0, 8).map((raw, i) => {
    const p = asRecord(raw);
    const id = typeof p?.parcelNodeId === "string" ? p.parcelNodeId : `#${i + 1}`;
    const brief = briefById.get(id);
    const briefSections = ((asRecord(brief?.brief)?.sections ?? []) as BriefSection[]);
    const section = (want: string) => briefSections.find((s) => s.id === want);
    const situs =
      typeof p?.label === "string"
        ? p.label
        : typeof p?.situs === "string"
          ? p.situs
          : id;
    if (!isNearest) return `| ${i + 1} | ${situs} | ${id} |`;
    const distance =
      typeof p?.distanceFt === "number" ? `${Math.round(p.distanceFt)} ft` : "—";
    const acres =
      typeof p?.acreageAcres === "number" ? String(p.acreageAcres) : "—";
    const zoning = cellText(section("zoning")?.data, cellText(p?.zoning));
    const landUse = cellText(section("land-use")?.data, cellText(p?.landUse));
    const flood = cellText(section("flood")?.data, cellText(p?.flood));
    return `| ${i + 1} | ${situs} | ${distance} | ${acres} | ${zoning} | ${landUse} | ${flood} | ${id} |`;
  });
  return [header, rule, ...rows].join("\n");
}

export function buildReadingLayoutText(
  data: Record<string, unknown>,
  link: { url: string; expiresAt: string; expiryReason: string },
  hostHints?: { openInBrowser?: boolean },
): string {
  const lines: string[] = [];
  lines.push(`Answer: ${answerLine(data)}`);
  const cardFacts = asRecord(data.inlineCard);
  const wiredFacts = Array.isArray(cardFacts?.facts) ? cardFacts.facts : null;
  if (wiredFacts && wiredFacts.length > 0) {
    lines.push("");
    lines.push("Four facts:");
    for (const raw of wiredFacts.slice(0, 4)) {
      const fact = asRecord(raw);
      if (!fact) continue;
      lines.push(`- ${fact.label ?? "fact"}: ${fact.value ?? "—"} (${fact.state ?? "unknown"})`);
    }
  }
  const sections = wiredFacts && wiredFacts.length > 0
    ? []
    : ((asRecord(data.brief)?.sections ?? []) as BriefSection[]).slice(0, 4);
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
