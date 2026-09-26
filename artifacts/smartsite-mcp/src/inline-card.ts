/**
 * P-448. The answer line and the four facts are written here, on the tool
 * result, before the widget sees them. The widget displays `inlineCard` and
 * does not derive it.
 */

import { customerDate, customerSitus, customerSource, landUseCustomerName, landUseNameFromCode } from "./card/panel-lib.js";
import { customerBriefReason, isMachineCustomerString } from "./customer-brief-reason.js";

/** P-458's land-use table. The inline card does not keep a second copy. */
export function cardLandUseName(rawCode: string): string | null {
  return landUseNameFromCode(rawCode);
}

export type InlineFactState =
  | "present"
  | "absent"
  | "absent-verified"
  | "refused"
  | "unknown"
  | "not-read"
  | "gated";

export type InlineFact = {
  label: string;
  value: string;
  state: InlineFactState;
  /** Source and date already on the section, or an honest absence. The widget prints this. */
  detail?: string;
};

export type InlineItem = {
  parcelNodeId: string;
  answer: string;
  actionLabel: "Open";
  actionUrl: string | null;
};

export type InlineCard = {
  layout: "single" | "carousel";
  title: string;
  answer: string;
  facts: InlineFact[];
  expandUrl: string | null;
  shareUrl: string | null;
  items: InlineItem[];
  /** Parcels or rows past the carousel cap of 8. Zero when the set fits. */
  moreCount: number;
};

const CAROUSEL_MIN = 3;
const CAROUSEL_MAX = 8;

const FACT_ORDER = ["zoning", "land-use", "flood", "setbacks-envelope"] as const;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Customer text. A machine-shaped string is replaced, never shown. */
export function safeCustomer(text: string, fallback: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  if (!s) return fallback;
  if (isMachineCustomerString(s)) return fallback;
  if (/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/.test(s)) return fallback;
  if (/\b(adapter|degraded|provenance)\b/i.test(s)) return fallback;
  if (/\d{4}-\d{2}-\d{2}T/.test(s)) return fallback;
  if (/\b\d{5}:[A-Za-z0-9]/.test(s)) return fallback;
  const reasoned = customerBriefReason(s);
  if (!reasoned || isMachineCustomerString(reasoned)) return fallback;
  return reasoned;
}

function cleanAddress(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = customerSitus(raw);
  if (/\b\d{5}:[A-Za-z0-9]/.test(cleaned)) return null;
  if (/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/.test(cleaned)) return null;
  return safeCustomer(cleaned, "") || null;
}

function sectionsOf(host: Record<string, unknown>): Record<string, unknown>[] {
  const brief = asRecord(host.brief);
  const raw = brief && Array.isArray(brief.sections) ? brief.sections : [];
  return raw.map(asRecord).filter((s): s is Record<string, unknown> => !!s);
}

function section(host: Record<string, unknown>, id: string): Record<string, unknown> | null {
  return sectionsOf(host).find((s) => s.id === id) ?? null;
}

function disposition(sectionRec: Record<string, unknown> | null): string {
  return str(sectionRec?.disposition) ?? "unstated";
}

function stateOf(dispositionWord: string): InlineFactState {
  if (dispositionWord === "present") return "present";
  if (dispositionWord === "refused") return "refused";
  if (dispositionWord === "unknown") return "unknown";
  if (dispositionWord === "unread") return "not-read";
  if (dispositionWord === "absent-verified") return "absent-verified";
  if (dispositionWord === "gated") return "gated";
  if (dispositionWord === "absent") return "absent";
  return "absent";
}

function absentValue(state: InlineFactState): string {
  if (state === "refused") return "Refused";
  if (state === "unknown") return "unknown";
  if (state === "not-read") return "Not read";
  if (state === "gated") return "Solo plan";
  return "absent, verified";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dateLong(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return iso;
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

function factDetail(sec: Record<string, unknown> | null, state: InlineFactState): string {
  if (!sec) return "Source is not on this result.";
  const data = asRecord(sec.data);
  const refusal = asRecord(sec.refusal);
  const sourceRaw = str(data?.sourceAdapter) || str(refusal?.producer) || str(data?.provenance);
  const source = sourceRaw ? customerSource(sourceRaw) : null;
  const dated = dateLong(
    customerDate(str(sec.asOf) || str(data?.asOf) || str(data?.sourceVintage) || str(data?.vintage)) || "",
  );
  const reasonRaw = str(sec.reason) || str(refusal?.declineReason) || str(refusal?.reason);
  const reason = reasonRaw ? safeCustomer(reasonRaw, "") : "";
  const bits: string[] = [];
  if (source) bits.push(source);
  if (dated) bits.push(dated);
  if (reason) bits.push(reason);
  if (bits.length) return safeCustomer(bits.join(". "), "Source is not on this result.");
  if (state === "unknown" || state === "refused" || state === "not-read" || state === "gated") {
    return "This result does not say why.";
  }
  return "Source is not on this result.";
}

function districtCode(data: Record<string, unknown> | null): string | null {
  const code = str(data?.district);
  if (!code) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9./-]{0,12}$/.test(code)) return null;
  if (code.includes("_")) return null;
  return code;
}

function cityName(host: Record<string, unknown>): string | null {
  const city = asRecord(host.cityLimitsFact);
  const name = str(city?.cityName);
  if (!name) return null;
  return cleanAddress(name);
}

function zoningFact(host: Record<string, unknown>): InlineFact {
  const sec = section(host, "zoning");
  const state = stateOf(disposition(sec));
  if (!sec || state !== "present") {
    return { label: "Zoning", value: sec ? absentValue(state) : "Not on this result", state: sec ? state : "absent" };
  }
  const data = asRecord(sec.data);
  const code = districtCode(data);
  const city = cityName(host);
  const value = code ? (city ? `${code} in ${city}` : code) : "Not named on this result";
  return { label: "Zoning", value: safeCustomer(value, "Not named on this result"), state: "present" };
}

function landUseFact(host: Record<string, unknown>): InlineFact {
  const sec = section(host, "land-use");
  const state = stateOf(disposition(sec));
  if (!sec || state !== "present") {
    return { label: "Land use", value: sec ? absentValue(state) : "Not on this result", state: sec ? state : "absent" };
  }
  const data = asRecord(sec.data);
  const named = data ? landUseCustomerName(data) : null;
  const value = (named && cleanAddress(named)) || "Not named on this result";
  return { label: "Land use", value: safeCustomer(value, "Not named on this result"), state: "present" };
}

function floodZoneCode(data: Record<string, unknown> | null): string | null {
  const zone = str(data?.floodZone);
  if (!zone) return null;
  if (!/^[A-Za-z0-9]{1,6}$/.test(zone)) return null;
  return zone.toUpperCase();
}

function floodFact(host: Record<string, unknown>): InlineFact {
  const sec = section(host, "flood");
  const state = stateOf(disposition(sec));
  if (!sec || state !== "present") {
    return { label: "Flood", value: sec ? absentValue(state) : "Not on this result", state: sec ? state : "absent" };
  }
  const data = asRecord(sec.data);
  const zone = floodZoneCode(data);
  if (!zone) {
    return { label: "Flood", value: "Not named on this result", state: "present" };
  }
  const method = str(data?.method);
  const point = method === "point-on-surface" ? ", read at a point on the parcel" : "";
  const value = `Zone ${zone}${point}`;
  return { label: "Flood", value: safeCustomer(value, `Zone ${zone}`), state: "present" };
}

function feet(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return String(v);
}

function setbackFact(host: Record<string, unknown>): InlineFact {
  const sec = section(host, "setbacks-envelope");
  const state = stateOf(disposition(sec));
  if (!sec || state !== "present") {
    return {
      label: "Setbacks",
      value: sec ? absentValue(state) : "Not on this result",
      state: sec ? state : "absent",
    };
  }
  const data = asRecord(sec.data);
  const front = feet(data?.frontFt);
  const side = feet(data?.sideFt);
  const rear = feet(data?.rearFt);
  const corner = feet(data?.cornerFt);
  if (!front && !side && !rear && !corner) {
    return { label: "Setbacks", value: "Not named on this result", state: "present" };
  }
  const part = (n: string | null, word: string) => (n ? `${n} ft ${word}` : `${word} not stated`);
  const value = [part(front, "front"), part(side, "side"), part(rear, "rear"), part(corner, "corner")].join(", ");
  return { label: "Setbacks", value: safeCustomer(value, "Not named on this result"), state: "present" };
}

function stampFact(host: Record<string, unknown>, id: (typeof FACT_ORDER)[number], fact: InlineFact): InlineFact {
  const sec = section(host, id);
  const refusal = asRecord(sec?.refusal);
  const code = str(refusal?.code);
  let next = fact;
  if (code === "studio-gated" || code === "gated") {
    next = { ...fact, state: "gated", value: "Solo plan" };
  }
  return { ...next, detail: factDetail(sec, next.state) };
}

export function fourFacts(host: Record<string, unknown>): InlineFact[] {
  const byId: Record<(typeof FACT_ORDER)[number], InlineFact> = {
    zoning: zoningFact(host),
    "land-use": landUseFact(host),
    flood: floodFact(host),
    "setbacks-envelope": setbackFact(host),
  };
  return FACT_ORDER.map((id) => stampFact(host, id, byId[id]));
}

function factsForQuestion(host: Record<string, unknown>): InlineFact[] {
  const all = fourFacts(host);
  const question = str(host.question);
  if (!question) return all;
  const q = question.toLowerCase();
  const want: string[] = [];
  if (/flood/.test(q)) want.push("Flood");
  if (/zon/.test(q)) want.push("Zoning");
  if (/setback|build|envelope/.test(q)) want.push("Setbacks");
  if (/land use|\buse\b/.test(q)) want.push("Land use");
  if (!want.length) return all;
  const picked = all.filter((f) => want.includes(f.label));
  for (const fact of all) {
    if (picked.length >= 4) break;
    if (!picked.includes(fact)) picked.push(fact);
  }
  return picked.slice(0, 4);
}

function addressOf(host: Record<string, unknown>): string {
  const draw = asRecord(host.draw);
  const fromDraw = cleanAddress(str(draw?.label));
  if (fromDraw) return fromDraw;
  const fromLabel = cleanAddress(str(host.label));
  if (fromLabel) return fromLabel;
  const county = cleanAddress(str(asRecord(host.onRecord)?.countyName));
  if (county) return `Parcel in ${county} County`;
  return "This parcel";
}

export function answerLineFromHost(host: Record<string, unknown>): string {
  const facts = fourFacts(host).filter((f) => f.label !== "Setbacks");
  const bits = facts.map((f) => `${f.label} ${f.value}`);
  const line = `${addressOf(host)}. ${bits.join(". ")}.`;
  return safeCustomer(line, `${addressOf(host)}.`);
}

function parcelId(host: Record<string, unknown>): string | null {
  return str(host.parcelNodeId);
}

function singleCard(
  host: Record<string, unknown>,
  shareUrl: string | null,
): InlineCard {
  const address = addressOf(host);
  return {
    layout: "single",
    title: address,
    answer: answerLineFromHost(host),
    facts: factsForQuestion(host),
    expandUrl: shareUrl,
    shareUrl,
    items: [],
    moreCount: 0,
  };
}

const RAIL_WORDS: Record<string, string> = {
  zoning: "Zoning",
  landUse: "Land use",
  flood: "Flood",
  envelope: "Buildable envelope",
};

function railPhrase(name: string, raw: unknown): string {
  const label = RAIL_WORDS[name] ?? name;
  if (raw === "present") return `${label} on file`;
  if (raw === "absent" || raw === "absent-verified") return `${label} not on file`;
  if (raw === "refused") return `${label} refused`;
  if (raw === "unknown") return `${label} not verified`;
  if (raw === "unread") return `${label} not read`;
  return `${label} not read`;
}

function rowHost(row: Record<string, unknown>): { id: string | null; answer: string } {
  const id = str(row.parcelNodeId);
  const stub = asRecord(row.stub) ?? asRecord(row.rails);
  const address =
    cleanAddress(str(row.label)) ??
    cleanAddress(str(stub?.label)) ??
    cleanAddress(str(row.query)) ??
    "Parcel on this selection";
  const rails = ["zoning", "landUse", "flood", "envelope"].map((name) => railPhrase(name, stub?.[name]));
  const answer = safeCustomer(`${address}. ${rails.join(". ")}.`, address);
  return { id, answer };
}

function carousel(
  title: string,
  items: InlineItem[],
  moreCount: number,
  shareUrl: string | null,
): InlineCard {
  const shown = items.length;
  const answer =
    moreCount > 0
      ? `${shown} parcels on this card. ${moreCount} more on the card page.`
      : `${shown} parcels.`;
  return {
    layout: "carousel",
    title,
    answer: safeCustomer(answer, `${shown} parcels.`),
    facts: [],
    expandUrl: shareUrl,
    shareUrl,
    items,
    moreCount,
  };
}

function itemsFromParcels(
  parcels: unknown[],
  mint: (id: string) => string | null,
): { items: InlineItem[]; moreCount: number } {
  const hosts = parcels.map(asRecord).filter((p): p is Record<string, unknown> => !!p);
  const moreCount = Math.max(0, hosts.length - CAROUSEL_MAX);
  const items: InlineItem[] = [];
  for (const host of hosts.slice(0, CAROUSEL_MAX)) {
    const id = parcelId(host) ?? "";
    items.push({
      parcelNodeId: id,
      answer: answerLineFromHost(host),
      actionLabel: "Open",
      actionUrl: id ? mint(id) : null,
    });
  }
  return { items, moreCount };
}

function itemsFromRows(
  rows: unknown[],
  mint: (id: string) => string | null,
): { items: InlineItem[]; moreCount: number } {
  const recs = rows.map(asRecord).filter((r): r is Record<string, unknown> => !!r);
  const moreCount = Math.max(0, recs.length - CAROUSEL_MAX);
  const items: InlineItem[] = [];
  for (const row of recs.slice(0, CAROUSEL_MAX)) {
    const read = rowHost(row);
    items.push({
      parcelNodeId: read.id ?? "",
      answer: read.answer,
      actionLabel: "Open",
      actionUrl: read.id ? mint(read.id) : null,
    });
  }
  return { items, moreCount };
}

/**
 * Returns the inline card for a parcel read, a parcel list of at least three,
 * or a screen of at least three rows. Returns null when this result is not
 * one of those shapes (the widget keeps its previous view).
 */
const DECLARED_ERROR_STATUS = new Set([
  "error",
  "refused",
  "not_implemented",
  "degraded",
  "not_ready",
  "upgrade_required",
]);

export function composeInlineCard(
  data: Record<string, unknown>,
  shareUrl: string | null,
  mintParcelLink: (parcelNodeId: string) => string | null,
): InlineCard | null {
  if (typeof data.status === "string" && DECLARED_ERROR_STATUS.has(data.status)) return null;
  const parcels = Array.isArray(data.parcels) ? data.parcels : null;
  const topDraw = asRecord(data.draw);
  const topBrief = sectionsOf(data).length > 0;
  if (parcels && parcels.length >= CAROUSEL_MIN && !topDraw) {
    const built = itemsFromParcels(parcels, mintParcelLink);
    const title =
      parcels.length === built.items.length
        ? `${built.items.length} parcels`
        : `${built.items.length} parcels on this card`;
    return carousel(title, built.items, built.moreCount, shareUrl);
  }
  const rows = Array.isArray(data.rows) ? data.rows : null;
  if (rows && rows.length >= CAROUSEL_MIN && !topDraw) {
    const built = itemsFromRows(rows, mintParcelLink);
    const screen = asRecord(data.screen);
    const name = cleanAddress(str(screen?.name) ?? str(data.name));
    return carousel(name ?? "Selected parcels", built.items, built.moreCount, shareUrl);
  }
  if (topDraw || (topBrief && !(parcels && parcels.length >= CAROUSEL_MIN))) {
    return singleCard(data, shareUrl);
  }
  return null;
}

export function attachInlineCard(
  data: Record<string, unknown>,
  shareUrl: string | null,
  mintParcelLink: (parcelNodeId: string) => string | null = () => null,
): Record<string, unknown> {
  const card = composeInlineCard(data, shareUrl, mintParcelLink);
  if (!card) return data;
  return { ...data, inlineCard: card };
}
