/** P-91 Wave I — Open turn and parcel draw. I1/I5/I6. No fourteenth tool. */

export const APP_RESOURCE_URI = "ui://smartsite/app-p558.html";
export const APP_MIME = "text/html;profile=mcp-app";
export const APP_HOST_TOOLS = [
  "create_screen",
  "list_screens",
  "get_smart_site",
] as const;

export const RAILS = [
  "situs",
  "zoning",
  "landUse",
  "flood",
  "drainage",
  "envelope",
] as const;

export type RailName = (typeof RAILS)[number];
export type CellState =
  | "present"
  | "absent-verified"
  | "unknown"
  | "refused"
  | "unread";

export type BoardRow = {
  query: string;
  parcelNodeId: string | null;
  resolution: "resolved" | "ambiguous" | "unresolved";
  rails: Record<RailName, CellState>;
};

export type OverlayRow = {
  id: string;
  state: string;
  label: string;
  reason?: string;
  /** D4: flood only; absent when the wire does not state it. */
  sfha?: boolean;
  draw?: string;
  /** F5: as the wire carries them; absent when it does not. */
  provenance?: string;
  vintage?: string;
  /** F1: https citations only; a non-https string is never kept. */
  citations?: string[];
  citationsDegraded?: boolean;
  /** F5: what the panel paints. absent-verified only when earned; otherwise the wire's state, or unknown. */
  paint?: CellState;
  /** A client-side downgrade note; only when the wire carries no reason of its own. */
  paintReason?: string;
};

/** The refusal object a brief section may carry, field by field; a missing field is null, never a default. */
export type SectionRefusal = {
  code: string | null;
  producer: string | null;
  declineReason: string | null;
  reason: string | null;
};

/** One brief section as the p543/p558 wire carries it, plus what the panel paints for it (F5/F6). */
export type BriefSection = {
  id: string;
  title: string;
  /** The wire's word (present | refused | absent | unread) or "unstated" when it carries none. */
  disposition: string;
  asOf: string | null;
  reason?: string;
  refusal?: SectionRefusal;
  data: Record<string, unknown> | null;
  /** https only. */
  citations: string[];
  citationsDegraded: boolean;
  zoneExposureSummary?: string;
  agentGuidance?: string;
  paint: CellState;
  paintReason?: string;
};

export type RingPt = { x: number; y: number };

export type DrawEdge = {
  i?: number;
  seg?: [number, number];
  role?: string;
  adjacency?: string;
  neighbor?: string | null;
  road?: string | null;
  roadNode?: string | null;
  roadClass?: string | null;
  ft?: number | null;
  lengthFt?: number | null;
  bearing?: string | null;
};

export type DrawZoning = {
  v: string;
  jurisdiction: string | null;
  state: string;
  /** First https citation of the brief's zoning section; null prints the district without a link. */
  url: string | null;
};

export type DrawFrame = {
  units: string | null;
  quality: string | null;
};

export type PanelKind = "board" | "parcel" | "empty" | "miss" | "refused" | "unreadable";
export type MissClass = "absent" | "unbaked" | "unstated";
export type MissRow = {
  parcelNodeId: string;
  county: string;
  missClass: MissClass;
  reason: string;
  parcelExists: boolean | "unmeasured";
};
export type RefusedRow = { parcelNodeId: string; reason: string };

export type PanelModel = {
  kind: PanelKind;
  screenId?: string;
  rows: BoardRow[];
  parcelNodeId?: string;
  label?: string;
  overlays: OverlayRow[];
  ring?: RingPt[];
  edges?: DrawEdge[];
  misses?: MissRow[];
  refused?: RefusedRow[];
  stubsDegraded?: boolean;
  zoning?: DrawZoning;
  frame?: DrawFrame;
  /** F1 F2 F6 R1: the brief's sections in wire order; absent when the result carries none. */
  sections?: BriefSection[];
};

export function appMetaFor(name: string): { ui: { resourceUri: string } } | undefined {
  if ((APP_HOST_TOOLS as readonly string[]).includes(name)) {
    return { ui: { resourceUri: APP_RESOURCE_URI } };
  }
  return undefined;
}

export function glyphClass(state: CellState): string {
  return `g-${state}`;
}

export function looksLikeParcelNodeId(query: string): boolean {
  return /^\d{5}:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(query.trim());
}

export function unresolvedCaption(query: string): "node unresolved" | "situs unresolved" {
  return looksLikeParcelNodeId(query) ? "node unresolved" : "situs unresolved";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function railState(value: unknown): CellState {
  if (value === "present") return "present";
  if (value === "absent-verified" || value === "absent") return "absent-verified";
  if (value === "refused") return "refused";
  if (value === "unread") return "unread";
  if (value === "unknown") return "unknown";
  return "unread";
}

/** Plan 4.4 sentences. One state, one sentence; unknown, refused, and unread never share one. */
export const OPEN_SENT = "Sent to chat. Press Send to open.";
export const NOT_ON_FILE_PREFIX = "Not on file in";
export const NO_BAKED_SNAPSHOT_PREFIX = "No baked snapshot yet for";
export const NOT_RETURNED = "Not returned";
export const UPGRADE_TO_OPEN = "Upgrade to open this parcel";
export const OPEN_REFUSED = "Open refused";
export const RESULT_NOT_READABLE = "Result not readable";
export const RESULT_NOT_READABLE_BODY = "The tool result carried no JSON text part. Ask again in the chat.";
export const RAILS_PARTLY_UNREAD = "Some rails on this screen were not read";

/** CAPCOG county names by fips prefix. Source: artifacts/api-server/src/countyCoverageScoreCli.ts. */
export const COUNTY_BY_FIPS: Record<string, string> = {
  "48021": "Bastrop",
  "48055": "Caldwell",
  "48209": "Hays",
  "48453": "Travis",
  "48491": "Williamson",
};
export const COUNTY_UNKNOWN = "this county";

export function countyForNodeId(id: unknown): string {
  const m = typeof id === "string" ? /^(\d{5}):/.exec(id.trim()) : null;
  const county = m ? COUNTY_BY_FIPS[m[1]] : undefined;
  return typeof county === "string" ? county : COUNTY_UNKNOWN;
}

export function notOnFileSentence(id: unknown): string {
  return NOT_ON_FILE_PREFIX + " " + countyForNodeId(id);
}

export function noBakedSnapshotSentence(id: unknown): string {
  return NO_BAKED_SNAPSHOT_PREFIX + " " + String(id == null ? "" : id);
}

export function escapeHtml(value: unknown): string {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stringList(value: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) out.push(item);
  }
  return out;
}

function emptyModel(kind: PanelKind): PanelModel {
  return { kind, rows: [], overlays: [], ring: [], edges: [] };
}

function rowFromUnknown(raw: unknown): BoardRow | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const query = typeof rec.query === "string" ? rec.query : "";
  const parcelNodeId =
    typeof rec.parcelNodeId === "string"
      ? rec.parcelNodeId
      : typeof rec.id === "string"
        ? rec.id
        : null;
  const resolution =
    rec.resolution === "resolved" ||
    rec.resolution === "ambiguous" ||
    rec.resolution === "unresolved"
      ? rec.resolution
      : parcelNodeId
        ? "resolved"
        : "unresolved";
  const stub = asRecord(rec.stub) ?? asRecord(rec.rails) ?? asRecord(rec.d);
  const rails = {} as Record<RailName, CellState>;
  for (const rail of RAILS) {
    rails[rail] = stub ? railState(stub[rail]) : "unread";
  }
  if (!query && !parcelNodeId) return null;
  return { query: query || parcelNodeId || "situs unresolved", parcelNodeId, resolution, rails };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function envelopeHuman(reason: string | undefined): string | undefined {
  if (reason === "atom_path_pending") return "Withheld, setbacks unruled";
  return reason;
}

export function ringFromDraw(draw: Record<string, unknown>): RingPt[] {
  if (!Array.isArray(draw.ring)) return [];
  const out: RingPt[] = [];
  for (const raw of draw.ring) {
    if (Array.isArray(raw) && raw.length >= 2) {
      const x = numberOrNull(raw[0]);
      const y = numberOrNull(raw[1]);
      if (x !== null && y !== null) out.push({ x, y });
      continue;
    }
    const rec = asRecord(raw);
    if (!rec) continue;
    const x = numberOrNull(rec.x);
    const y = numberOrNull(rec.y);
    if (x !== null && y !== null) out.push({ x, y });
  }
  return out;
}

export function edgesFromDraw(draw: Record<string, unknown>): DrawEdge[] {
  if (!Array.isArray(draw.edges)) return [];
  const out: DrawEdge[] = [];
  for (const raw of draw.edges) {
    const rec = asRecord(raw);
    if (!rec) continue;
    const seg =
      Array.isArray(rec.seg) && rec.seg.length >= 2
        ? ([numberOrNull(rec.seg[0]) ?? 0, numberOrNull(rec.seg[1]) ?? 0] as [number, number])
        : undefined;
    out.push({
      i: typeof rec.i === "number" ? rec.i : undefined,
      seg,
      role: stringOrNull(rec.role) ?? undefined,
      adjacency: stringOrNull(rec.adjacency) ?? undefined,
      neighbor: stringOrNull(rec.neighbor),
      road: stringOrNull(rec.road),
      roadNode: stringOrNull(rec.roadNode),
      roadClass: stringOrNull(rec.roadClass),
      ft: numberOrNull(rec.ft),
      lengthFt: numberOrNull(rec.lengthFt),
      bearing: stringOrNull(rec.bearing),
    });
  }
  return out;
}

export function edgeCaption(edge: DrawEdge): string {
  const bits: string[] = [];
  if (edge.role) bits.push(edge.role);
  if (edge.adjacency) bits.push(edge.adjacency);
  if (edge.neighbor) bits.push(edge.neighbor);
  if (edge.roadNode) bits.push(edge.roadNode);
  if (edge.road) bits.push(edge.road);
  const ft = edge.ft ?? edge.lengthFt;
  if (ft != null) bits.push(`${ft} ft`);
  if (edge.bearing) bits.push(edge.bearing);
  return bits.join(" · ");
}

export function edgeIndex(edge: DrawEdge, fallback: number): number {
  if (typeof edge.i === "number") return edge.i;
  if (edge.seg && typeof edge.seg[0] === "number") return edge.seg[0];
  return fallback;
}

export function edgeHasRoad(edge: DrawEdge): boolean {
  return Boolean(edge.roadNode || edge.road);
}

/** D1: adjacency and role words. Keys are the wire enum; any other value prints verbatim. */
export const EDGE_WORDS: Record<string, string> = {
  front: "front",
  side: "side",
  rear: "rear",
  side_corner: "corner side",
  alley: "alley",
  ROW: "right of way",
  "neighbor-parcel": "neighbor",
  unmapped: "unmapped",
};
/** D2 / O3: a neighbor across a ROW is named, never opened. */
export const ACROSS_ROW = "across the right of way";
/** Tip at rest. UI copy, not a parcel fact. */
export const EDGE_TIP_HINT = "Point at a property line to read it. Click a line to keep it.";
/** D7: the scale bar is the one derived thing on the drawing, and it is labelled as such. */
export const UNIT_REFERENCE = "unit reference";
export const SCALE_BAR_FT = [200, 100, 50, 25, 10] as const;
export type ZoneFamily = "residential" | "commercial" | "mixed" | "public";
/** D3: family tints are existing Stone tokens; residential is the ring's own stroke. */
export const ZONE_TINT: Record<ZoneFamily, string> = {
  residential: "--ss-t3",
  commercial: "--ss-blue",
  mixed: "--ss-atom",
  public: "--ss-t5",
};

/** F1: a section or overlay that claims a fact without an https citation says so; the text, never a link. */
export const CITATION_DEGRADED = "citation degraded";
/** F6: a present claim with no as-of paints unknown and says why. Panel copy, not a wire field. */
export const AS_OF_MISSING = "as-of missing";
/** F5: an absence claim with neither provenance nor a known vintage paints unknown; only when the wire carries no reason of its own. */
export const ABSENCE_UNVERIFIED = "absence unverified; no provenance on the wire";
/** A section whose disposition is not one of the wire's four words paints unread and says why. */
export const DISPOSITION_UNSTATED = "disposition not on the wire";
/** F2: base flood elevation when the record carries null. */
export const BFE_NONE = "none on record";
/** P1 fallback words. Every other slot in the why turn is a field from the result. */
export const UNSTATED = "unstated";
export const WHY_NO_REASON = "no reason on the wire";
/** Unique opener. A turn with this prefix is a P1 why click. */
export const WHY_TURN_OPENER = "Why is";
export const WHY_TURN_INSTRUCTION = "Answer from the record and the atom path; do not invent a value.";
export const WHY_LABEL = "why";
/** C1: the save_property status enum, verbatim (tools.ts CRM_STATUSES). */
export const SAVE_STATUSES = ["New", "Watching", "Chasing", "Passed"] as const;
export const SAVE_LABEL = "Save property";
/** C2: the door's second control. */
export const ADD_TO_SCREEN_LABEL = "Add to screen";
/** R1: the local toggle and the empty report. */
export const REPORT_TOGGLE = "Report";
export const NO_BRIEF = "No brief sections on this result.";
/** The five-state legend words, one per paint state. */
export const STATE_WORDS: Record<CellState, string> = {
  present: "present",
  "absent-verified": "absent, verified",
  unknown: "unknown",
  refused: "refused",
  unread: "unread",
};
/** P1: an overlay borrows the refusal of the brief section on the same subject, when the wire carries one. */
export const SECTION_FOR_OVERLAY: Record<string, string> = {
  envelope: "setbacks-envelope",
  "setbacks-envelope": "setbacks-envelope",
  flood: "flood",
  landUse: "land-use",
  "land-use": "land-use",
  drainage: "drainage",
  zoning: "zoning",
};

export function edgeWord(value: string | null | undefined): string | null {
  if (!value) return null;
  const word = EDGE_WORDS[value];
  return typeof word === "string" ? word : value;
}

export function edgeIsRow(edge: DrawEdge): boolean {
  return edge.adjacency === "ROW";
}

/** D2: a shared line is a door only when the wire names a neighbor and the line is not a ROW. */
export function edgeDoor(edge: DrawEdge): string | null {
  return edge.neighbor && !edgeIsRow(edge) ? edge.neighbor : null;
}

/** D1 tooltip. Every value is the edge object's own; ft prints only when the wire carries it (I7). */
export function edgeTipHtml(edge: DrawEdge, index: number): string {
  const bits: string[] = [];
  const role = edgeWord(edge.role);
  const adj = edgeWord(edge.adjacency);
  if (role) bits.push(`<span class="tw">${escapeHtml(role)}</span>`);
  if (adj && adj !== role) bits.push(`<span class="tw">${escapeHtml(adj)}</span>`);
  const ft = edge.ft ?? edge.lengthFt;
  if (ft != null) bits.push(`<span class="tf">${escapeHtml(ft)} ft</span>`);
  if (edge.bearing) bits.push(`<span class="tb">${escapeHtml(edge.bearing)}</span>`);
  const roadId = edge.roadNode || edge.road;
  const roadBits = roadId
    ? `<span class="tn">${escapeHtml(roadId)}</span>${edge.roadClass ? `<span class="tw">${escapeHtml(edge.roadClass)}</span>` : ""}`
    : "";
  if (edgeIsRow(edge)) {
    if (roadBits) bits.push(roadBits);
    if (edge.neighbor) {
      bits.push(`<span class="tn">${escapeHtml(edge.neighbor)}</span><span class="tw">${ACROSS_ROW}</span>`);
    }
  } else if (edge.neighbor) {
    bits.push(`<span class="tn">${escapeHtml(edge.neighbor)}</span>`);
  } else if (roadBits) {
    bits.push(roadBits);
  }
  const door = edgeDoor(edge);
  /* C2: the door carries Add to screen beside Open; both name the neighbor the wire names and nothing else. */
  const open = door
    ? `<button type="button" class="btn" data-act="open" data-node="${escapeHtml(door)}" onclick="window.__ss&&window.__ss.open(this)">Open</button><button type="button" class="btn" data-act="addscreen" data-node="${escapeHtml(door)}" onclick="window.__ss&&window.__ss.addToScreen(this)">${ADD_TO_SCREEN_LABEL}</button>`
    : "";
  return `<span class="tipbody" data-edge-tip="${index}">${bits.join("")}${open}</span>`;
}

export function zoneFamily(district: string | null | undefined): ZoneFamily | null {
  const v = typeof district === "string" ? district.trim().toUpperCase() : "";
  if (!v) return null;
  if (/^(SF|R)-/.test(v)) return "residential";
  if (/^GC(-|$)/.test(v) || /^C-/.test(v)) return "commercial";
  if (/^MU(-|$)/.test(v)) return "mixed";
  if (/^PI(-|$)/.test(v) || /^P\/OS(-|$)/.test(v)) return "public";
  return null;
}

export type FloodTint = "light" | "heavy";

/** D4: tint only on a tint-ring overlay whose sfha the wire states; MINIMAL never tints. */
export function floodTint(flood: OverlayRow | null | undefined): FloodTint | null {
  if (!flood || flood.draw !== "tint-ring") return null;
  if (/MINIMAL/i.test(flood.label)) return null;
  if (flood.sfha === true) return "heavy";
  if (flood.sfha === false) return "light";
  return null;
}

/** The zone of a producer label ("Zone AE FLOODWAY" prints as "Zone AE floodway"); any other label prints verbatim. */
export function floodZoneLabel(label: string): string {
  const m = /^Zone\s+(\S+)(.*)$/i.exec(label.trim());
  if (!m) return label.trim();
  const zone = `Zone ${m[1]}`;
  return /floodway/i.test(m[2] ?? "") ? `${zone} floodway` : zone;
}

export function floodOverlayOf(overlays: OverlayRow[]): OverlayRow | null {
  for (const o of overlays) if (o.id === "flood") return o;
  return null;
}

/** D7: the largest round length that fits half the ring's east-west extent; 10 when nothing does. */
export function scaleBarFt(extentFt: number): number {
  for (const n of SCALE_BAR_FT) if (n <= extentFt / 2) return n;
  return SCALE_BAR_FT[SCALE_BAR_FT.length - 1] ?? 10;
}

export function edgeEnds(edge: DrawEdge, fallback: number, n: number): [number, number] {
  const a = edgeIndex(edge, fallback);
  const b = edge.seg && typeof edge.seg[1] === "number" ? edge.seg[1] : (a + 1) % n;
  return [a, b];
}

export type DrawCues = { zoning?: DrawZoning | null; flood?: OverlayRow | null; frame?: DrawFrame | null };

export function ringSvg(ring: RingPt[], edges: DrawEdge[], cues?: DrawCues): string {
  if (ring.length < 3) return "";
  const xs = ring.map((p) => p.x);
  const ys = ring.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const pad = 28;
  const w = 320;
  const h = 220;
  const s = Math.min((w - pad * 2) / Math.max(maxX - minX, 1), (h - pad * 2) / Math.max(maxY - minY, 1));
  const ox = (w - (maxX - minX) * s) / 2;
  const oy = (h - (maxY - minY) * s) / 2;
  const pt = (p: RingPt) => {
    const x = ox + (p.x - minX) * s;
    const y = h - (oy + (p.y - minY) * s);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };
  const pts = ring.map(pt).join(" ");
  const n = ring.length;
  const seg = (e: DrawEdge, i: number): string | null => {
    const ends = edgeEnds(e, i, n);
    const a = ring[ends[0]];
    const b = ring[ends[1]];
    return a && b ? `${pt(a)} ${pt(b)}` : null;
  };
  const road = edges
    .map((e, i) => {
      const p = seg(e, i);
      if (!edgeHasRoad(e) || !p) return "";
      return `<polyline points="${p}" fill="none" stroke="var(--ss-t3)" stroke-width="7" stroke-linecap="square" opacity=".35"/>`;
    })
    .join("");
  const neigh = edges
    .map((e, i) => {
      const p = seg(e, i);
      if (!e.neighbor || edgeHasRoad(e) || !p) return "";
      return `<polyline points="${p}" fill="none" stroke="var(--ss-t6)" stroke-width="2" stroke-dasharray="4 3"/>`;
    })
    .join("");
  const zoning = cues && cues.zoning && cues.zoning.state === "present" && cues.zoning.v ? cues.zoning : null;
  const family = zoning ? zoneFamily(zoning.v) : null;
  const stroke = family ? ZONE_TINT[family] : "--ss-t3";
  const ringPoly = `<polygon class="ring-fill" points="${pts}" fill="var(--ss-void)" fill-opacity=".55" stroke="var(${stroke})" stroke-width="2"${family ? ` data-zone-family="${family}"` : ""}/>`;
  const flood = cues && cues.flood ? cues.flood : null;
  const tint = floodTint(flood);
  const tintPoly = tint
    ? `<polygon class="flood-tint" data-flood-tint="${tint}" points="${pts}" fill="var(--ss-blue)" fill-opacity="${tint === "heavy" ? ".32" : ".14"}"/>`
    : "";
  const zoneText = tint && flood ? escapeHtml(floodZoneLabel(flood.label)) : "";
  const floodText = zoneText
    ? `<text class="fz" data-flood-zone="${zoneText}" x="${(w / 2).toFixed(1)}" y="${(oy - 6).toFixed(1)}" text-anchor="middle">${zoneText}</text>`
    : "";
  const hits = edges
    .map((e, i) => {
      const p = seg(e, i);
      return p ? `<polyline class="edge" data-edge="${i}" points="${p}"/>` : "";
    })
    .join("");
  const district = zoning
    ? `<text class="zn${zoning.url ? " link" : ""}" data-zoning="${escapeHtml(zoning.v)}"${zoning.url ? ` data-zoning-url="${escapeHtml(zoning.url)}"` : ""} x="${(w / 2).toFixed(1)}" y="${(h / 2).toFixed(1)}" text-anchor="middle">${escapeHtml(zoning.v)}</text>${
        zoning.jurisdiction
          ? `<text class="zj" x="${(w / 2).toFixed(1)}" y="${(h / 2 + 15).toFixed(1)}" text-anchor="middle">${escapeHtml(zoning.jurisdiction)}</text>`
          : ""
      }`
    : "";
  const frame = cues && cues.frame ? cues.frame : null;
  const north = frame
    ? `<g class="north" data-north="up"><line x1="${w - 22}" y1="24" x2="${w - 22}" y2="9" stroke="var(--ss-t5)" stroke-width="1.5"/><polygon points="${w - 26},13 ${w - 22},6 ${w - 18},13" fill="var(--ss-t5)"/><text x="${w - 14}" y="22">N</text></g>`
    : "";
  const barFt = frame && frame.units === "ft" ? scaleBarFt(maxX - minX) : null;
  let scale = "";
  if (barFt !== null) {
    const x2 = (pad + barFt * s).toFixed(1);
    const y = h - 12;
    scale = `<g class="scale" data-scale-ft="${barFt}"><line x1="${pad}" y1="${y}" x2="${x2}" y2="${y}" stroke="var(--ss-t5)" stroke-width="2"/><line x1="${pad}" y1="${y - 4}" x2="${pad}" y2="${y + 4}" stroke="var(--ss-t5)" stroke-width="1.5"/><line x1="${x2}" y1="${y - 4}" x2="${x2}" y2="${y + 4}" stroke="var(--ss-t5)" stroke-width="1.5"/><text class="sl" x="${pad}" y="${y - 7}">${barFt} ft <tspan class="sm">${UNIT_REFERENCE}</tspan></text></g>`;
  }
  return `<svg class="ring" viewBox="0 0 ${w} ${h}" aria-label="parcel ring">${road}${neigh}${ringPoly}${tintPoly}${hits}${floodText}${district}${north}${scale}</svg>`;
}

/** D7: frame.quality printed as it arrives, under the drawing. */
export function frameNoteHtml(frame: DrawFrame | null | undefined): string {
  if (!frame || !frame.quality) return "";
  return `<div class="fnote" data-frame-quality="${escapeHtml(frame.quality)}">frame ${escapeHtml(frame.quality)}</div>`;
}

/*
 * P-91 v2 facts and actions (S7). Everything below the drawing reads a field
 * off the tool result or prints a literal fallback word; the panel never
 * composes prose and never fills a slot the wire left empty. Every function
 * here is embedded by source (INLINE_SHARED) so the served panel and the
 * exported twin cannot drift; none may use object or array spread, because
 * a transpiler helper would not exist in the served scope.
 */

/** F5: a vintage the record spells UNKNOWN, or does not carry, is not a known vintage. */
export function knownVintage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toUpperCase() === "UNKNOWN") return null;
  return trimmed;
}

/** F1: https strings only, trimmed; anything else is dropped and never becomes a link. */
export function httpsCitations(value: unknown): string[] {
  const out: string[] = [];
  for (const item of stringList(value)) {
    const c = item.trim();
    if (/^https:\/\//i.test(c)) out.push(c);
  }
  return out;
}

/** F5: absent-verified is earned by provenance present or a known vintage; a bare claim paints unknown. */
export function overlayPaint(
  o: Pick<OverlayRow, "state" | "provenance" | "vintage" | "reason">,
): { paint: CellState; paintReason?: string } {
  const s = railState(o.state);
  if (s !== "absent-verified") return { paint: s };
  if (o.provenance === "present" || knownVintage(o.vintage) !== null) return { paint: "absent-verified" };
  if (o.reason) return { paint: "unknown" };
  return { paint: "unknown", paintReason: ABSENCE_UNVERIFIED };
}

function refusalFrom(value: unknown): SectionRefusal | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  return {
    code: stringOrNull(rec.code),
    producer: stringOrNull(rec.producer),
    declineReason: stringOrNull(rec.declineReason),
    reason: stringOrNull(rec.reason),
  };
}

/** F6 and F5 for a section: present needs an as-of; absent needs a known vintage on its data; a word off the wire's four paints unread. */
export function sectionPaint(
  disposition: string,
  asOf: string | null,
  data: Record<string, unknown> | null,
): { paint: CellState; paintReason?: string } {
  if (disposition === "present") return asOf ? { paint: "present" } : { paint: "unknown", paintReason: AS_OF_MISSING };
  if (disposition === "refused") return { paint: "refused" };
  if (disposition === "unread") return { paint: "unread" };
  if (disposition === "absent") {
    const vintage = data ? (data.sourceVintage !== undefined ? data.sourceVintage : data.vintage) : null;
    return knownVintage(vintage) !== null
      ? { paint: "absent-verified" }
      : { paint: "unknown", paintReason: ABSENCE_UNVERIFIED };
  }
  return { paint: "unread", paintReason: DISPOSITION_UNSTATED };
}

/** F6: data.sourceAdapter, else refusal.producer, else a string data.provenance; never a guess. */
export function sourceOf(s: Pick<BriefSection, "data" | "refusal">): string | null {
  const adapter = s.data ? stringOrNull(s.data.sourceAdapter) : null;
  if (adapter) return adapter;
  if (s.refusal && s.refusal.producer) return s.refusal.producer;
  return s.data ? stringOrNull(s.data.provenance) : null;
}

/** Date only: the leading YYYY-MM-DD of an ISO instant; any other string prints as it arrived. */
export function dateOnly(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso.trim());
  return m && m[1] ? m[1] : iso.trim();
}

export function stateWord(state: CellState): string {
  return STATE_WORDS[state];
}

/** F1: one control per https citation, posting ui/open-link on click; degraded prints the text and never a link. */
export function citationHtml(citations: string[], degraded: boolean): string {
  if (degraded) return `<span class="cite-deg" data-cite-degraded="1">${CITATION_DEGRADED}</span>`;
  const safe: string[] = [];
  for (const c of citations) if (typeof c === "string" && /^https:\/\//i.test(c)) safe.push(c);
  return safe
    .map(
      (u, i) =>
        `<button type="button" class="cite" data-act="cite" data-url="${escapeHtml(u)}" onclick="window.__ss&&window.__ss.cite(this)">citation${safe.length > 1 ? ` ${i + 1}` : ""}</button>`,
    )
    .join(" ");
}

/** P1: a control only on unknown, refused or unread; the draft is built on click from the model, never stored in the DOM. */
export function whyControlHtml(
  kind: "rail" | "overlay" | "section",
  paint: CellState,
  ref: Record<string, string>,
  inner?: string,
): string {
  if (paint === "present" || paint === "absent-verified") return "";
  let attrs = "";
  for (const k of Object.keys(ref)) attrs += ` data-why-${k}="${escapeHtml(ref[k])}"`;
  return `<button type="button" class="${inner ? "cell" : "ask"}" data-act="why" data-why-kind="${kind}"${attrs} onclick="window.__ss&&window.__ss.why(this)">${inner ? inner : WHY_LABEL}</button>`;
}

export function reasonLineHtml(key: string, text: string, attr?: string): string {
  return `<span class="why"${attr ? ` ${attr}` : ""}><span class="key">${escapeHtml(key)}</span> <span class="reason">${escapeHtml(text)}</span></span>`;
}

/** F6: as-of (date only) and source when the wire carries them; vintage and provenance for an overlay. */
export function metaHtml(
  asOf: string | null,
  source: string | null,
  vintage?: string | null,
  provenance?: string | null,
): string {
  const bits: string[] = [];
  const d = dateOnly(asOf);
  if (d) bits.push(`<span data-as-of="${escapeHtml(d)}"><span class="key">as of</span> ${escapeHtml(d)}</span>`);
  if (source) bits.push(`<span data-source="${escapeHtml(source)}"><span class="key">source</span> ${escapeHtml(source)}</span>`);
  if (vintage) bits.push(`<span data-vintage="${escapeHtml(vintage)}"><span class="key">vintage</span> ${escapeHtml(vintage)}</span>`);
  if (provenance) bits.push(`<span data-provenance="${escapeHtml(provenance)}"><span class="key">provenance</span> ${escapeHtml(provenance)}</span>`);
  return bits.length ? `<span class="meta">${bits.join(" ")}</span>` : "";
}

/** One overlay row: the paint state (F5), citations (F1), vintage and provenance, the why control (P1). Spans only, no nested div. */
export function overlayRowHtml(o: OverlayRow, i: number): string {
  const p = overlayPaint(o);
  const extra = o.id === "flood" ? " flood" : p.paint === "refused" ? " refused" : "";
  const shown = envelopeHuman(o.reason);
  const why = shown ? reasonLineHtml("reason", shown) : "";
  const note = p.paintReason ? reasonLineHtml("note", p.paintReason, `data-paint-reason="${escapeHtml(p.paintReason)}"`) : "";
  const citations = o.citations ? o.citations : [];
  const degraded = o.citationsDegraded === true || (p.paint === "present" && citations.length === 0);
  const cites = citationHtml(citations, degraded);
  const ask = whyControlHtml("overlay", p.paint, { i: String(i) });
  return `<div class="ovl${extra}" data-overlay="${escapeHtml(o.id)}" data-paint="${p.paint}"><span class="g ${glyphClass(p.paint)}" title="${stateWord(p.paint)}"></span> <span class="key">${escapeHtml(o.id)}</span> <span class="lbl">${escapeHtml(o.label)}</span>${cites ? ` ${cites}` : ""}${ask ? ` ${ask}` : ""}${metaHtml(null, null, o.vintage, o.provenance)}${why}${note}</div>`;
}

/** F2: the flood row under the drawing, every value read off the flood section's data; a non-present section prints its state. */
export function floodFactsHtml(s: BriefSection, i: number): string {
  const head = `<span class="g ${glyphClass(s.paint)}" title="${stateWord(s.paint)}"></span> <span class="key">flood</span> <span class="lbl">${escapeHtml(s.title)}</span>`;
  const meta = metaHtml(s.asOf, sourceOf(s));
  const cites = citationHtml(s.citations, s.citationsDegraded);
  const ask = whyControlHtml("section", s.paint, { i: String(i) });
  const reason = s.reason ? s.reason : s.refusal && s.refusal.reason ? s.refusal.reason : null;
  const why = reason ? reasonLineHtml("reason", reason) : "";
  const note = s.paintReason ? reasonLineHtml("note", s.paintReason, `data-paint-reason="${escapeHtml(s.paintReason)}"`) : "";
  if (s.paint !== "present") {
    return `<div class="facts flood" data-flood-state="${s.paint}">${head} <span class="sw">${stateWord(s.paint)}</span>${cites ? ` ${cites}` : ""}${ask ? ` ${ask}` : ""}${meta}${why}${note}</div>`;
  }
  const d: Record<string, unknown> = s.data ? s.data : {};
  const str = (k: string): string => stringOrNull(d[k]) ?? UNSTATED;
  const sfha = d.inSpecialFloodHazardArea === true ? "yes" : d.inSpecialFloodHazardArea === false ? "no" : UNSTATED;
  const bfe = numberOrNull(d.baseFloodElevation);
  /* data-fact-*, not data-flood-*: the drawing already owns data-flood-zone and data-flood-tint (D4) */
  const kv = (k: string, v: string, attr: string): string =>
    `<span class="kv" data-fact-${attr}="${escapeHtml(v)}"><span class="key">${k}</span> ${escapeHtml(v)}</span>`;
  const rows = [
    kv("zone", str("floodZone"), "zone"),
    kv("subtype", str("zoneSubtype"), "subtype"),
    kv("SFHA", sfha, "sfha"),
    kv("base flood elevation", bfe === null ? BFE_NONE : String(bfe), "bfe"),
    kv("source adapter", str("sourceAdapter"), "adapter"),
    kv("source vintage", str("sourceVintage"), "vintage"),
    kv("evaluated at", dateOnly(stringOrNull(d.evaluatedAt)) ?? UNSTATED, "evaluated"),
  ].join(" ");
  const summary = s.zoneExposureSummary
    ? `<div class="fsum" data-zone-exposure="1">${escapeHtml(s.zoneExposureSummary)}</div>`
    : "";
  return `<div class="facts flood" data-flood-state="present">${head}${cites ? ` ${cites}` : ""}${meta}<div class="kvs">${rows}</div>${summary}${why}${note}</div>`;
}

/** R1 (fork 3.1 narrow): every section in wire order with title, glyph and word, as-of, source, citation control, guidance. No values, no prose. */
export function reportHtml(sections: BriefSection[]): string {
  if (sections.length === 0) return `<div class="report" data-report="1"><p class="empty">${NO_BRIEF}</p></div>`;
  const rows = sections
    .map((s, i) => {
      const reason = s.reason ? s.reason : s.refusal && s.refusal.reason ? s.refusal.reason : null;
      const cites = citationHtml(s.citations, s.citationsDegraded);
      const ask = whyControlHtml("section", s.paint, { i: String(i) });
      const note = s.paintReason ? reasonLineHtml("note", s.paintReason, `data-paint-reason="${escapeHtml(s.paintReason)}"`) : "";
      const guide = s.agentGuidance ? `<div class="guide" data-agent-guidance="1">${escapeHtml(s.agentGuidance)}</div>` : "";
      return `<div class="rsec" data-report-section="${escapeHtml(s.id)}" data-report-state="${s.paint}"><span class="g ${glyphClass(s.paint)}" title="${stateWord(s.paint)}"></span> <span class="rt">${escapeHtml(s.title)}</span> <span class="sw">${stateWord(s.paint)}</span>${cites ? ` ${cites}` : ""}${ask ? ` ${ask}` : ""}${metaHtml(s.asOf, sourceOf(s))}${reason ? reasonLineHtml("reason", reason) : ""}${note}${guide}</div>`;
    })
    .join("");
  return `<div class="report" data-report="1"><div class="req">${REPORT_TOGGLE}</div>${rows}</div>`;
}

/** C1: the Save control is a chooser; each status is a button carrying the enum word. */
export function saveChooserHtml(): string {
  let buttons = "";
  for (const s of SAVE_STATUSES) {
    buttons += ` <button type="button" class="btn" data-act="save" data-status="${s}" onclick="window.__ss&&window.__ss.save(this)">${s}</button>`;
  }
  return `<span class="savegrp" data-save-chooser="1"><span class="key">${SAVE_LABEL}</span>${buttons}</span>`;
}

export function pairedSection(model: Pick<PanelModel, "sections">, overlayId: string): BriefSection | null {
  const id = SECTION_FOR_OVERLAY[overlayId];
  if (!id) return null;
  for (const s of model.sections ? model.sections : []) if (s.id === id) return s;
  return null;
}

export type WhyQuestion = {
  field: string;
  state: CellState;
  parcelNodeId: string;
  label: string | null;
  reason: string | null;
  producer: string | null;
  code: string | null;
};

/**
 * P1: the question behind a why click. Null for a present or verified cell,
 * for a rail or node the board does not carry, and for an index off the
 * model, so a forged control drafts nothing. Every slot is a field from the
 * result or null; the fallback words live in whyMessage.
 */
export function whyQuestion(
  model: PanelModel,
  kind: string | null,
  ref: { i?: string | null; rail?: string | null; node?: string | null },
): WhyQuestion | null {
  if (kind === "rail") {
    const node = ref.node ? ref.node : null;
    const rail = ref.rail ? ref.rail : null;
    if (!node || !rail || (RAILS as readonly string[]).indexOf(rail) < 0) return null;
    let row: BoardRow | null = null;
    for (const r of model.rows) {
      if (r.parcelNodeId === node) {
        row = r;
        break;
      }
    }
    if (!row) return null;
    const state = row.rails[rail as RailName];
    if (state === "present" || state === "absent-verified") return null;
    return { field: rail, state, parcelNodeId: node, label: row.query, reason: null, producer: null, code: null };
  }
  if (!model.parcelNodeId) return null;
  const label = model.label && model.label !== model.parcelNodeId ? model.label : null;
  const i = ref.i == null || ref.i === "" ? -1 : Number(ref.i);
  if (kind === "overlay") {
    const o = i >= 0 ? model.overlays[i] : undefined;
    if (!o) return null;
    const p = overlayPaint(o).paint;
    if (p === "present" || p === "absent-verified") return null;
    const sec = pairedSection(model, o.id);
    const r = sec && sec.refusal ? sec.refusal : null;
    const reason = o.reason ? o.reason : r && r.reason ? r.reason : null;
    const producer = r && r.producer ? r.producer : o.provenance ? o.provenance : null;
    const code = r && r.code ? r.code : r && r.declineReason ? r.declineReason : null;
    return { field: o.id, state: p, parcelNodeId: model.parcelNodeId, label, reason, producer, code };
  }
  if (kind === "section") {
    const sections = model.sections ? model.sections : [];
    const s = i >= 0 ? sections[i] : undefined;
    if (!s) return null;
    if (s.paint === "present" || s.paint === "absent-verified") return null;
    const r = s.refusal ? s.refusal : null;
    const reason = s.reason ? s.reason : r && r.reason ? r.reason : null;
    const producer = r && r.producer ? r.producer : null;
    const code = r && r.code ? r.code : r && r.declineReason ? r.declineReason : null;
    return { field: s.id, state: s.paint, parcelNodeId: model.parcelNodeId, label, reason, producer, code };
  }
  return null;
}

export function whyMessage(q: WhyQuestion): string {
  const who = q.label ? `${q.parcelNodeId} (${q.label})` : q.parcelNodeId;
  return `${WHY_TURN_OPENER} ${q.field} ${q.state} for ${who}? The record says: ${q.reason ? q.reason : WHY_NO_REASON}; producer ${q.producer ? q.producer : UNSTATED}; code ${q.code ? q.code : UNSTATED}. ${WHY_TURN_INSTRUCTION}`;
}

export function saveMessage(node: string, status: string): string {
  return `${SAVE_LABEL} ${node} with save_property, status ${status}. Do not change any screen.`;
}

export function addToScreenMessage(neighbor: string): string {
  return `Add ${neighbor} to the screen this parcel was opened from with add_to_screen, source walk. Do not save it.`;
}

/** Sections in wire order. A section with no id names nothing and is skipped; every field is read or left null. */
function sectionsFromBrief(host: Record<string, unknown>): BriefSection[] {
  const brief = asRecord(host.brief);
  const raw = brief && Array.isArray(brief.sections) ? brief.sections : [];
  const out: BriefSection[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = stringOrNull(rec.id);
    if (!id) continue;
    const disposition = stringOrNull(rec.disposition) ?? "unstated";
    const asOf = stringOrNull(rec.asOf);
    const data = asRecord(rec.data);
    const citations = httpsCitations(rec.citations);
    const painted = sectionPaint(disposition, asOf, data);
    const section: BriefSection = {
      id,
      title: stringOrNull(rec.title) ?? id,
      disposition,
      asOf,
      data,
      citations,
      citationsDegraded: rec.citationsDegraded === true || (disposition === "present" && citations.length === 0),
      paint: painted.paint,
    };
    const reason = stringOrNull(rec.reason);
    if (reason) section.reason = reason;
    const refusal = refusalFrom(rec.refusal);
    if (refusal) section.refusal = refusal;
    const summary = stringOrNull(rec.zoneExposureSummary);
    if (summary) section.zoneExposureSummary = summary;
    const guidance = stringOrNull(rec.agentGuidance);
    if (guidance) section.agentGuidance = guidance;
    if (painted.paintReason) section.paintReason = painted.paintReason;
    out.push(section);
  }
  return out;
}

export function renderParcelDraw(
  model: Pick<PanelModel, "ring" | "edges" | "overlays" | "label" | "parcelNodeId" | "zoning" | "frame" | "sections">,
): string {
  const node = model.parcelNodeId
    ? `<div class="pn atom">${escapeHtml(model.parcelNodeId)}</div>`
    : "";
  const svg = ringSvg(model.ring ?? [], model.edges ?? [], {
    zoning: model.zoning ?? null,
    flood: floodOverlayOf(model.overlays),
    frame: model.frame ?? null,
  });
  const tip = svg ? `<div class="tip" data-tip="1">${EDGE_TIP_HINT}</div>${frameNoteHtml(model.frame ?? null)}` : "";
  const edgeList = (model.edges ?? []).length
    ? `<ul class="edges">${(model.edges ?? [])
        .map((e) => `<li>${escapeHtml(edgeCaption(e))}</li>`)
        .join("")}</ul>`
    : "";
  const rows = model.overlays.map((o, i) => overlayRowHtml(o, i)).join("");
  const sections = model.sections ?? [];
  let floodFacts = "";
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (s && s.id === "flood") {
      floodFacts = floodFactsHtml(s, i);
      break;
    }
  }
  return `${node}${model.label ? `<div class="pl">${escapeHtml(model.label)}</div>` : ""}${svg}${tip}${edgeList}${rows}${floodFacts}`;
}

function overlaysFromDraw(draw: Record<string, unknown>): OverlayRow[] {
  const overlays = Array.isArray(draw.overlays) ? draw.overlays : [];
  const rows: OverlayRow[] = [];
  for (const item of overlays) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = typeof rec.id === "string" ? rec.id : "";
    const state = typeof rec.state === "string" ? rec.state : "unknown";
    const label = typeof rec.label === "string" ? rec.label : id;
    const reason = typeof rec.reason === "string" ? rec.reason : undefined;
    if (!id) continue;
    const row: OverlayRow = { id, state, label, reason };
    if (typeof rec.sfha === "boolean") row.sfha = rec.sfha;
    const drawKind = stringOrNull(rec.draw);
    if (drawKind) row.draw = drawKind;
    /* F5 F1: provenance, vintage and https citations as the wire carries them */
    const provenance = stringOrNull(rec.provenance);
    if (provenance) row.provenance = provenance;
    const vintage = stringOrNull(rec.vintage);
    if (vintage) row.vintage = vintage;
    const citations = httpsCitations(rec.citations);
    if (citations.length > 0) row.citations = citations;
    if (rec.citationsDegraded === true) row.citationsDegraded = true;
    const painted = overlayPaint(row);
    row.paint = painted.paint;
    if (painted.paintReason) row.paintReason = painted.paintReason;
    rows.push(row);
  }
  return rows;
}

function zoningCitationUrl(host: Record<string, unknown>): string | null {
  const brief = asRecord(host.brief);
  const sections = brief && Array.isArray(brief.sections) ? brief.sections : [];
  for (const raw of sections) {
    const section = asRecord(raw);
    if (!section || section.id !== "zoning") continue;
    for (const c of stringList(section.citations)) {
      if (/^https:\/\//i.test(c.trim())) return c.trim();
    }
    return null;
  }
  return null;
}

function zoningFromDraw(draw: Record<string, unknown>, host: Record<string, unknown>): DrawZoning | null {
  const attrs = asRecord(draw.attrs);
  const zoning = attrs ? asRecord(attrs.zoning) : null;
  if (!zoning) return null;
  const v = stringOrNull(zoning.v);
  if (!v) return null;
  return {
    v,
    jurisdiction: stringOrNull(zoning.jurisdiction),
    state: stringOrNull(zoning.state) ?? "unknown",
    url: zoningCitationUrl(host),
  };
}

function frameFromDraw(draw: Record<string, unknown>): DrawFrame | null {
  const frame = asRecord(draw.frame);
  if (!frame) return null;
  return { units: stringOrNull(frame.units), quality: stringOrNull(frame.quality) };
}

function batchRowsFrom(rec: Record<string, unknown>): BoardRow[] | null {
  if (!Array.isArray(rec.parcels)) return null;
  const rows: BoardRow[] = [];
  for (const raw of rec.parcels) {
    const p = asRecord(raw);
    if (!p || typeof p.parcelNodeId !== "string" || p.parcelNodeId.length === 0) continue;
    /* p556: the live server sends the six rails FLAT on the parcel record. A nested stub object wins when present. */
    const stub = asRecord(p.stub) ?? p;
    const rails = {} as Record<RailName, CellState>;
    for (const rail of RAILS) rails[rail] = railState(stub[rail]);
    const label = typeof p.label === "string" && p.label.length > 0 ? p.label : p.parcelNodeId;
    rows.push({ query: label, parcelNodeId: p.parcelNodeId, resolution: "resolved", rails });
  }
  for (const id of stringList(rec.notFound)) {
    const rails = {} as Record<RailName, CellState>;
    for (const rail of RAILS) rails[rail] = "unread";
    rows.push({ query: id, parcelNodeId: null, resolution: "unresolved", rails });
  }
  return rows.length > 0 ? rows : null;
}

function missRowsFrom(rec: Record<string, unknown>): MissRow[] | null {
  const reason = rec.reason;
  if (typeof reason !== "string" || reason.length === 0) return null;
  if (!Array.isArray(rec.parcels) || rec.parcels.length > 0) return null;
  const ids = stringList(rec.notFound);
  if (ids.length === 0) return null;
  const parcelExists: boolean | "unmeasured" =
    rec.parcelExists === true ? true : rec.parcelExists === false ? false : "unmeasured";
  const missClass: MissClass =
    reason === "parcel_not_found" || parcelExists === false
      ? "absent"
      : reason === "baked_snapshot_not_found"
        ? "unbaked"
        : "unstated";
  const out: MissRow[] = [];
  for (const id of ids) {
    out.push({ parcelNodeId: id, county: countyForNodeId(id), missClass, reason, parcelExists });
  }
  return out;
}

function refusedRowsFrom(rec: Record<string, unknown>): RefusedRow[] | null {
  if (!Array.isArray(rec.refused) || rec.refused.length === 0) return null;
  if (Array.isArray(rec.parcels) && rec.parcels.length > 0) return null;
  const out: RefusedRow[] = [];
  for (const raw of rec.refused) {
    const r = asRecord(raw);
    if (!r || typeof r.parcelNodeId !== "string" || r.parcelNodeId.length === 0) continue;
    const reason = typeof r.reason === "string" && r.reason.length > 0 ? r.reason : "unstated";
    out.push({ parcelNodeId: r.parcelNodeId, reason });
  }
  return out.length > 0 ? out : null;
}

/**
 * Board source is a screen or a batch stub result. Saved-list payloads are
 * ignored even if they appear in the same JSON. This is also the served parser:
 * buildAppHtml() embeds this function and its helpers by source (INLINE_SHARED),
 * so the iframe runs this code, not a hand copy.
 */
export function parseToolResult(text: string): PanelModel {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyModel("unreadable");
  }
  const rec = asRecord(parsed);
  if (!rec) return emptyModel("unreadable");
  if (Array.isArray(rec.savedProperties) && !rec.rows && !rec.screens) {
    return emptyModel("empty");
  }

  const draw = asRecord(rec.draw);
  const firstParcel = Array.isArray(rec.parcels) ? asRecord(rec.parcels[0]) : null;
  const parcelDraw = draw ?? (firstParcel ? asRecord(firstParcel.draw) : null);
  if (parcelDraw && (parcelDraw.ring || parcelDraw.overlays || parcelDraw.label || parcelDraw.edges)) {
    const parcelNodeId =
      typeof rec.parcelNodeId === "string"
        ? rec.parcelNodeId
        : typeof firstParcel?.parcelNodeId === "string"
          ? firstParcel.parcelNodeId
          : undefined;
    const label =
      typeof parcelDraw.label === "string"
        ? parcelDraw.label
        : typeof rec.label === "string"
          ? rec.label
          : parcelNodeId;
    const model: PanelModel = {
      kind: "parcel",
      rows: [],
      overlays: overlaysFromDraw(parcelDraw),
      ring: ringFromDraw(parcelDraw),
      edges: edgesFromDraw(parcelDraw),
      parcelNodeId,
      label,
    };
    const host = draw ? rec : (firstParcel ?? rec);
    const zoning = zoningFromDraw(parcelDraw, host);
    if (zoning) model.zoning = zoning;
    const frame = frameFromDraw(parcelDraw);
    if (frame) model.frame = frame;
    const sections = sectionsFromBrief(host);
    if (sections.length > 0) model.sections = sections;
    return model;
  }

  const refused = refusedRowsFrom(rec);
  if (refused) return { kind: "refused", rows: [], overlays: [], ring: [], edges: [], refused };
  const misses = missRowsFrom(rec);
  if (misses) return { kind: "miss", rows: [], overlays: [], ring: [], edges: [], misses };
  const batch = batchRowsFrom(rec);
  if (batch) return { kind: "board", rows: batch, overlays: [], ring: [], edges: [] };

  const screen = asRecord(rec.screen) ?? rec;
  const rawRows = Array.isArray(rec.rows) ? rec.rows : Array.isArray(screen.rows) ? screen.rows : [];
  const rows: BoardRow[] = [];
  for (const raw of rawRows) {
    const row = rowFromUnknown(raw);
    if (row) rows.push(row);
  }
  if (rows.length > 0) {
    const screenId =
      typeof rec.id === "string" ? rec.id : typeof screen.id === "string" ? screen.id : undefined;
    const degraded = typeof rec.stubsDegraded === "boolean" ? rec.stubsDegraded : screen.stubsDegraded;
    const model: PanelModel = { kind: "board", screenId, rows, overlays: [], ring: [], edges: [] };
    if (typeof degraded === "boolean") model.stubsDegraded = degraded;
    return model;
  }
  return emptyModel("empty");
}

export function firstTextPart(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    const rec = asRecord(part);
    if (rec && rec.type === "text" && typeof rec.text === "string") return rec.text;
  }
  return null;
}

/** A tool result with no text part is unreadable, never empty. Scans every part. */
export function parseToolContent(result: unknown): PanelModel {
  if (typeof result === "string") return parseToolResult(result);
  const rec = asRecord(result);
  const text = rec ? firstTextPart(rec.content) : null;
  return text === null ? emptyModel("unreadable") : parseToolResult(text);
}

/**
 * The served script's parser is this module's parser, embedded by source.
 * Every function the parser reaches must be listed here. The served suite
 * (tests/mcp-app-served.test.ts) runs the embedded copy and fails on a missing one.
 */
const INLINE_SHARED: ReadonlyArray<Function> = [
  asRecord,
  railState,
  numberOrNull,
  stringOrNull,
  stringList,
  emptyModel,
  countyForNodeId,
  notOnFileSentence,
  noBakedSnapshotSentence,
  escapeHtml,
  rowFromUnknown,
  ringFromDraw,
  edgesFromDraw,
  overlaysFromDraw,
  batchRowsFrom,
  missRowsFrom,
  refusedRowsFrom,
  parseToolResult,
  firstTextPart,
  parseToolContent,
  zoningCitationUrl,
  zoningFromDraw,
  frameFromDraw,
  edgeCaption,
  edgeIndex,
  edgeHasRoad,
  edgeEnds,
  edgeWord,
  edgeIsRow,
  edgeDoor,
  edgeTipHtml,
  zoneFamily,
  floodTint,
  floodZoneLabel,
  floodOverlayOf,
  scaleBarFt,
  ringSvg,
  frameNoteHtml,
  /* S7 facts and actions */
  glyphClass,
  knownVintage,
  httpsCitations,
  overlayPaint,
  refusalFrom,
  sectionPaint,
  sourceOf,
  dateOnly,
  stateWord,
  citationHtml,
  whyControlHtml,
  reasonLineHtml,
  metaHtml,
  overlayRowHtml,
  floodFactsHtml,
  reportHtml,
  saveChooserHtml,
  pairedSection,
  whyQuestion,
  whyMessage,
  saveMessage,
  addToScreenMessage,
  sectionsFromBrief,
];

export function inlineSharedSource(): string {
  return INLINE_SHARED.map((fn) => "  " + fn.toString()).join("\n");
}

export function panelFingerprint(model: PanelModel): string {
  return JSON.stringify({
    kind: model.kind,
    screenId: model.screenId ?? null,
    rows: model.rows.map((row) => ({
      query: row.query,
      parcelNodeId: row.parcelNodeId,
      resolution: row.resolution,
      rails: row.rails,
    })),
    parcelNodeId: model.parcelNodeId ?? null,
    overlays: model.overlays.map((o) => ({ id: o.id, state: o.state, reason: o.reason ?? null })),
    ring: model.ring ?? [],
    edges: (model.edges ?? []).map((e) => edgeCaption(e)),
  });
}

/** Unique opener. A guarded turn with this prefix is the listing click. */
export const LISTING_TURN_OPENER = "Find listing history for";
/** Local-only ack. Visible before postMessage. Needs no host. */
export const LISTING_ACK_LABEL = "Requesting listing history";
/** Positive destination. Answer here is working. */
export const LISTING_TURN_DESTINATION =
  "Search the public web for prior sales, price cuts, and listing copy. Put the answer only in this transcript.";
/** Paired guard. ask_the_map after this turn is guard_failed. */
export const LISTING_TURN_GUARD =
  "Do not call ask_the_map. Do not start Smart Site research. Do not write it into the Smart Site board or parcel panel.";

export const LISTING_TURN_INSTRUCTION = `${LISTING_TURN_DESTINATION} ${LISTING_TURN_GUARD}`;

/** Unique opener. A turn with this prefix is the board Open click. */
export const OPEN_TURN_OPENER = "Open this parcel";
export const OPEN_TURN_INSTRUCTION =
  "Call get_smart_site once with depth node for this id. Do not call save_property. Do not search the web.";

export const EMPTY_BOARD_TITLE = "No screen yet";
export const EMPTY_BOARD_BODY = "Paste addresses in the chat. This panel does not search.";
export const NOTHING_TO_OPEN = "Nothing to open until this resolves";
export const OPEN_DID_NOT_REACH_ME = "Open did not reach me";
/** Host silence after Open click. Late tool results still replace this. */
export const OPEN_DEAD_MS = 12000;

export function openParcelMessage(node: string): string {
  return `${OPEN_TURN_OPENER} ${node}. ${OPEN_TURN_INSTRUCTION}`;
}

export type ListingClickOutcome =
  | "handler_unbound"
  | "host_drop"
  | "guard_failed"
  | "working";

export type ListingClickObservation = {
  turnText: string | null;
  /** True only when the button showed LISTING_ACK_LABEL before postMessage. */
  localAck: boolean;
  toolsCalled: readonly string[];
  answeredInTranscript: boolean;
};

export function listingHistoryWho(model: Pick<PanelModel, "label" | "parcelNodeId">): string {
  return model.label || model.parcelNodeId || "this parcel";
}

export function listingHistoryMessage(model: PanelModel): string {
  return `${LISTING_TURN_OPENER} ${listingHistoryWho(model)}. ${LISTING_TURN_INSTRUCTION}`;
}

export function listingTurnIsGuarded(text: string): boolean {
  return (
    text.includes(LISTING_TURN_OPENER) &&
    text.includes("Do not call ask_the_map") &&
    /public web/i.test(text) &&
    /this transcript/i.test(text)
  );
}

/**
 * Absence of a turn is not host_drop by itself. A dead handler, a dropped
 * postMessage, and a discarded payload look the same in the transcript.
 * localAck is the local-only split: no ack means the listener never ran.
 */
export function classifyListingOutcome(obs: ListingClickObservation): ListingClickOutcome {
  if (!obs.turnText && obs.localAck !== true) return "handler_unbound";
  if (!obs.turnText) return "host_drop";
  if (!listingTurnIsGuarded(obs.turnText) || obs.toolsCalled.includes("ask_the_map")) {
    return "guard_failed";
  }
  if (obs.answeredInTranscript) return "working";
  throw new Error("listing_outcome_unclassified");
}

export function listingHistoryClick(model: PanelModel): {
  message: string;
  fingerprintBefore: string;
  fingerprintAfter: string;
} {
  const fingerprintBefore = panelFingerprint(model);
  return {
    message: listingHistoryMessage(model),
    fingerprintBefore,
    fingerprintAfter: panelFingerprint(model),
  };
}

const PRIVATE_ORIGIN = /localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d+|192\.168\.|fonts\.googleapis|fonts\.gstatic/i;

export function htmlContractViolations(html: string): string[] {
  const violations: string[] = [];
  if (PRIVATE_ORIGIN.test(html)) {
    violations.push("private_or_font_origin");
  }
  if (!html.includes("g-unread") || !html.includes("g-unknown")) {
    violations.push("missing_unread_or_unknown_glyph");
  }
  if (html.includes("g-unread") && html.includes("g-unknown")) {
    const unread = html.indexOf(".g-unread");
    const unknown = html.indexOf(".g-unknown");
    if (unread < 0 || unknown < 0) violations.push("glyph_selectors_missing");
  }
  if (/coverage %|42\s*%/i.test(html) || /column totals?\s+\d/i.test(html)) {
    violations.push("aggregate_or_invented_pct");
  }
  if (/list_my_properties/.test(html) && /board source/.test(html) === false) {
    /* allowed only as a refused source note */
  }
  if (/fetch\(|XMLHttpRequest|WebSocket/.test(html)) {
    violations.push("direct_network");
  }
  if (/#F3F5F1|#F5F5F0|#EAEEE7/i.test(html)) {
    violations.push("cream_host_theme");
  }
  if (!html.includes('data-theme="claude"') || !html.includes("btn primary")) {
    violations.push("missing_claude_chrome");
  }
  if (/\bask_the_map\s*\(/.test(html)) {
    violations.push("ask_the_map_call");
  }
  if (!/Do not call ask_the_map/.test(html)) {
    violations.push("listing_missing_ask_the_map_guard");
  }
  if (
    !html.includes("String(d.id)===String(initId)") ||
    !html.includes("function flushReady")
  ) {
    violations.push("handshake_no_wait");
  }
  if (
    /method:"ui\/initialize"[\s\S]{0,280}parent\.postMessage\(\{jsonrpc:"2\.0",method:"ui\/notifications\/initialized"\}/.test(
      html,
    )
  ) {
    violations.push("handshake_fire_before_reply");
  }
  if (html.includes('params:{role:"user",content:{type:"text"')) {
    violations.push("ui_message_content_object");
  }
  if (!html.includes('content:[{type:"text",text:text}]')) {
    violations.push("ui_message_content_not_array");
  }
  if (!html.includes("function paintBoot") || !html.includes("handshake=")) {
    violations.push("handshake_not_visible");
  }
  if (!html.includes("hostCapabilities") || !html.includes("message=none")) {
    violations.push("caps_unread");
  }
  if (!html.includes("pendingMsg") || !html.includes("reply=")) {
    violations.push("message_reply_unread");
  }
  if (/html,body\{[^}]*height:100%/.test(html)) {
    violations.push("iframe_fills_host");
  }
  if (!html.includes("function fitHost") || !html.includes("ui/notifications/size-changed")) {
    violations.push("iframe_size_unreported");
  }
  if (html.includes("atom_path_pending")) {
    violations.push("machine_envelope_reason");
  }
  if (html.includes("4429") || html.includes("4430") || html.includes("4431")) {
    violations.push("invented_road_node");
  }
  if (html.includes("save_to_screen") || html.includes("find_listing_history")) {
    violations.push("ghost_catalog_tool");
  }
  if (/Save to screen/.test(html)) {
    violations.push("save_to_screen_label");
  }
  if (/Not read yet/.test(html)) {
    violations.push("hatch_labeled_unread");
  }
  if (!html.includes('addEventListener("pointerenter"') || !html.includes('data-edge="')) {
    violations.push("edge_hover_unbound");
  }
  if (!/adjacency\s*===\s*"ROW"/.test(html) || !html.includes(ACROSS_ROW)) {
    violations.push("row_door_unguarded");
  }
  if (!html.includes('method:"ui/open-link"')) {
    violations.push("open_link_unbound");
  }
  /* S7: each item's mechanism must be present in the served script, or the item is a claim */
  if (!html.includes('data-act="cite"') || !html.includes("function sendCite") || !html.includes(CITATION_DEGRADED)) {
    violations.push("citation_link_unbound");
  }
  if (
    !html.includes('data-act="why"') ||
    !html.includes("function sendWhy") ||
    !html.includes(WHY_TURN_OPENER) ||
    !html.includes(WHY_TURN_INSTRUCTION)
  ) {
    violations.push("why_turn_unbound");
  }
  if (!html.includes('data-act="save"') || SAVE_STATUSES.some((s) => !html.includes(`"${s}"`))) {
    violations.push("save_statuses_unbound");
  }
  if (!html.includes('data-act="report"') || !html.includes("function toggleReport")) {
    violations.push("report_toggle_unbound");
  }
  if (!html.includes('data-act="addscreen"') || !html.includes("add_to_screen") || !html.includes("function sendAddToScreen")) {
    violations.push("add_to_screen_unbound");
  }
  const boundCopy = [
    NOTHING_TO_OPEN,
    OPEN_DID_NOT_REACH_ME,
    OPEN_SENT,
    NOT_ON_FILE_PREFIX,
    NO_BAKED_SNAPSHOT_PREFIX,
    UPGRADE_TO_OPEN,
    RESULT_NOT_READABLE,
  ];
  if (boundCopy.some((copy) => !html.includes(copy))) {
    violations.push("miss_copy_unbound");
  }
  const listenerAt = html.indexOf('addEventListener("message"');
  const from = listenerAt < 0 ? 0 : listenerAt;
  const guardAt = html.indexOf("if(ev.source!==window.parent)", from);
  const dataReadAt = html.indexOf("var d=ev.data", from);
  if (listenerAt < 0 || guardAt < 0 || dataReadAt < 0 || guardAt > dataReadAt) {
    violations.push("origin_unchecked");
  }
  if (!html.includes(EMPTY_BOARD_TITLE)) {
    violations.push("empty_board_unbound");
  }
  return violations;
}

export function buildAppHtml(): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="claude">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Smart Site board</title>
<style>
:root{
--ss-ink:#323234;--ss-raised:#3F4043;--ss-void:#2A2A2B;
--ss-line-06:#414247;--ss-line-14:#56575C;
--ss-t3:#D6D8DB;--ss-t5:#A9ABAF;--ss-t6:#999B9F;
--ss-blue:#86ADDF;--ss-gold:#E8963B;--ss-atom:#6FC1B8;--ss-slate:#A9ABAF;--ss-warn:#CFB165;
--ss-ui:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
--ss-fs-meta:12.5px;--ss-fs-body:14.5px;--ss-r-tip:12px;
--bg:#1c1c1c}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--ss-t3);font:var(--ss-fs-body)/1.45 var(--ss-ui)}
#root{padding:2px;min-height:420px}
.card{border:1px solid var(--ss-line-14);border-radius:var(--ss-r-tip);background:var(--ss-ink);overflow:visible;display:flex;flex-direction:column;min-height:400px}
.hdr{display:flex;align-items:center;gap:8px;padding:10px 12px;color:var(--ss-t5);flex:0 0 auto}
.mark{width:12px;height:12px;border:1.5px solid var(--ss-t5);border-radius:50%;position:relative;flex:0 0 12px}
.mark:after{content:"";position:absolute;inset:3px;border:1.5px solid var(--ss-t5);border-radius:50%}
.well{margin:0 10px 10px;background:var(--ss-void);border-radius:8px;padding:10px 12px;overflow:visible}
.req{font-size:var(--ss-fs-meta);color:var(--ss-t5);margin:0 0 8px}
table{width:100%;border-collapse:collapse}
th{font:var(--ss-fs-meta)/1.2 ui-monospace,Consolas,monospace;letter-spacing:.06em;text-transform:uppercase;text-align:left;padding:0 6px 8px;border-bottom:1px solid var(--ss-line-06);color:var(--ss-t5);cursor:pointer}
td{padding:7px 6px;border-bottom:1px solid var(--ss-line-06);vertical-align:middle}
tr.row{cursor:pointer}
tr.row:hover td{background:var(--ss-raised)}
.pl{font-weight:500}
.pn,.unres,.why,.mono,.reason{font:var(--ss-fs-meta)/1.4 ui-monospace,Consolas,monospace}
.pn,.mono{color:var(--ss-t5)}
.pn.atom{color:var(--ss-atom)}
.key{color:var(--ss-t6)}
.unres{color:var(--ss-slate)}
.g{width:12px;height:12px;display:inline-block;vertical-align:-1px;border:1.4px solid currentColor}
.g-present{background:var(--ss-t3);border-color:var(--ss-t3)}
.g-absent-verified{background:transparent;border-color:var(--ss-t6)}
.g-unknown{background:repeating-linear-gradient(45deg,var(--ss-t5),var(--ss-t5) 2px,transparent 2px,transparent 4px);border-color:var(--ss-t5)}
.g-refused{background:transparent;border-style:dashed;border-color:var(--ss-warn);background-image:linear-gradient(135deg,transparent 46%,var(--ss-warn) 46%,var(--ss-warn) 54%,transparent 54%)}
.g-unread{background:var(--ss-gold);border:none;border-radius:50%;width:8px;height:8px;vertical-align:1px}
.legend{display:flex;flex-wrap:wrap;gap:10px;padding:0 12px 10px;font:var(--ss-fs-meta) ui-monospace,Consolas,monospace;color:var(--ss-t5);flex:0 0 auto}
.ovl{padding:6px 0;border-bottom:1px solid var(--ss-line-06)}
.ovl:last-child{border-bottom:none}
.ovl.refused .lbl{color:var(--ss-slate);font-weight:600}
.ovl.flood{opacity:.72}
svg.ring{display:block;width:100%;height:auto;margin:8px 0}
.edges{margin:0 0 10px;padding:0;list-style:none;color:var(--ss-t6);font:var(--ss-fs-meta)/1.4 ui-monospace,Consolas,monospace}
.edges li{margin:0 0 4px}
.why{display:block;color:var(--ss-slate);margin-top:2px}
.reason{color:var(--ss-slate)}
.edge{fill:none;stroke:var(--ss-t3);stroke-opacity:0;stroke-width:10;stroke-linecap:round;pointer-events:stroke;cursor:pointer}
.edge.hot{stroke-opacity:1;stroke-width:4}
svg.ring text{font:var(--ss-fs-meta) ui-monospace,Consolas,monospace;fill:var(--ss-t5);pointer-events:none}
svg.ring .zn{font:600 var(--ss-fs-body) var(--ss-ui);fill:var(--ss-t3);pointer-events:auto}
svg.ring .zn.link{cursor:pointer;text-decoration:underline}
svg.ring .fz{fill:var(--ss-blue)}
svg.ring .sm{fill:var(--ss-t6)}
.flood-tint,.north,.scale{pointer-events:none}
.tip{font:var(--ss-fs-meta)/1.6 ui-monospace,Consolas,monospace;color:var(--ss-t5);margin:0 0 8px;min-height:1.6em}
.tip span{margin-right:8px}
.tip .tn{color:var(--ss-atom)}
.tip .tf,.tip .tb{color:var(--ss-t3)}
.tip .btn{padding:3px 8px;font-size:var(--ss-fs-meta)}
.fnote{font:var(--ss-fs-meta)/1.4 ui-monospace,Consolas,monospace;color:var(--ss-t6);margin:0 0 8px}
.acts{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;padding:8px 10px 12px;flex:0 0 auto;position:sticky;bottom:0;background:var(--ss-ink);z-index:2}
.btn{font:var(--ss-fs-body)/1.2 var(--ss-ui);border:1px solid var(--ss-line-14);background:var(--ss-raised);color:var(--ss-t3);border-radius:8px;padding:7px 12px;cursor:pointer}
.btn.primary{background:var(--ss-blue);color:var(--ss-void);border-color:var(--ss-blue)}
.btn:hover{filter:brightness(1.08)}
.btn:active{filter:brightness(0.92)}
.btn:disabled{cursor:default;filter:none;opacity:.72}
.ack{font:var(--ss-fs-meta)/1.3 ui-monospace,Consolas,monospace;color:var(--ss-t5);padding:0 10px 10px;text-align:right}
.empty{color:var(--ss-t5);padding:12px}
.empty b{display:block;color:var(--ss-t3);font-weight:650;margin:0 0 4px}
.slot{color:var(--ss-slate);font-size:var(--ss-fs-meta);text-align:right;max-width:11em}
.fail{color:var(--ss-slate);padding:8px 12px;font-size:var(--ss-fs-body)}
.note{color:var(--ss-t5);padding:8px 12px;font-size:var(--ss-fs-body)}
.miss{padding:6px 0;border-bottom:1px solid var(--ss-line-06)}
.miss:last-child{border-bottom:none}
.miss b{display:block;color:var(--ss-t3);font-weight:650;margin:0 0 4px}
.boot{font:var(--ss-fs-meta)/1.3 ui-monospace,Consolas,monospace;color:var(--ss-t5);padding:2px 10px;flex:0 0 auto;white-space:normal;word-break:break-word}
.cite{font:var(--ss-fs-meta)/1.2 ui-monospace,Consolas,monospace;border:1px solid var(--ss-line-14);background:var(--ss-raised);color:var(--ss-blue);border-radius:6px;padding:1px 6px;cursor:pointer;text-decoration:underline}
.cite-deg{font:var(--ss-fs-meta)/1.2 ui-monospace,Consolas,monospace;color:var(--ss-slate)}
.ask{font:var(--ss-fs-meta)/1.2 ui-monospace,Consolas,monospace;border:1px dashed var(--ss-line-14);background:transparent;color:var(--ss-t5);border-radius:6px;padding:1px 6px;cursor:pointer}
.ask:hover,.cite:hover{filter:brightness(1.08)}
.cell{border:none;background:transparent;padding:0;margin:0;cursor:pointer;font:inherit}
.meta{display:block;font:var(--ss-fs-meta)/1.4 ui-monospace,Consolas,monospace;color:var(--ss-t6);margin-top:2px}
.meta span{margin-right:10px}
.sw{color:var(--ss-t5);font:var(--ss-fs-meta)/1.4 ui-monospace,Consolas,monospace}
.facts{padding:8px 0;border-top:1px solid var(--ss-line-06);margin-top:6px}
.kvs{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:4px;font:var(--ss-fs-meta)/1.4 ui-monospace,Consolas,monospace}
.fsum{color:var(--ss-t5);margin-top:4px}
.report{margin-top:10px;border-top:1px solid var(--ss-line-14);padding-top:8px}
.rsec{padding:6px 0;border-bottom:1px solid var(--ss-line-06)}
.rsec:last-child{border-bottom:none}
.rt{font-weight:500}
.guide{color:var(--ss-t5);font-size:var(--ss-fs-meta);margin-top:2px}
.savegrp{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;margin-right:auto}
.btn.on{border-color:var(--ss-blue);color:var(--ss-blue)}
</style>
</head>
<body>
<div id="boot" class="boot" data-script="off">script-off</div>
<div id="root"><p class="empty"><b>${EMPTY_BOARD_TITLE}</b>${EMPTY_BOARD_BODY}</p></div>
<script>
(function(){
  var boot=document.getElementById("boot");
  var handshake="off";
  var capText="caps=unread";
  var msgCap="message=unread";
  var replyText="reply=none";
  var foreignCount=0;
  var pendingMsg=Object.create(null);
  function paintBoot(){
    if(!boot) return;
    boot.setAttribute("data-script","ran");
    boot.setAttribute("data-handshake",handshake);
    boot.setAttribute("data-caps",capText);
    boot.setAttribute("data-message-cap",msgCap);
    boot.setAttribute("data-reply",replyText);
    boot.setAttribute("data-foreign",String(foreignCount));
    boot.textContent=["script-ran","handshake="+handshake,capText,msgCap,replyText,"foreign="+foreignCount].join(" ");
  }
  paintBoot();
  var RAILS=${JSON.stringify(RAILS)};
  var NODE_RE=/^\\d{5}:[A-Za-z0-9][A-Za-z0-9._-]*$/;
  var COUNTY_BY_FIPS=${JSON.stringify(COUNTY_BY_FIPS)};
  var COUNTY_UNKNOWN=${JSON.stringify(COUNTY_UNKNOWN)};
  var NOT_ON_FILE_PREFIX=${JSON.stringify(NOT_ON_FILE_PREFIX)};
  var NO_BAKED_SNAPSHOT_PREFIX=${JSON.stringify(NO_BAKED_SNAPSHOT_PREFIX)};
  var EDGE_WORDS=${JSON.stringify(EDGE_WORDS)};
  var ACROSS_ROW=${JSON.stringify(ACROSS_ROW)};
  var EDGE_TIP_HINT=${JSON.stringify(EDGE_TIP_HINT)};
  var UNIT_REFERENCE=${JSON.stringify(UNIT_REFERENCE)};
  var SCALE_BAR_FT=${JSON.stringify(SCALE_BAR_FT)};
  var ZONE_TINT=${JSON.stringify(ZONE_TINT)};
  var CITATION_DEGRADED=${JSON.stringify(CITATION_DEGRADED)};
  var AS_OF_MISSING=${JSON.stringify(AS_OF_MISSING)};
  var ABSENCE_UNVERIFIED=${JSON.stringify(ABSENCE_UNVERIFIED)};
  var DISPOSITION_UNSTATED=${JSON.stringify(DISPOSITION_UNSTATED)};
  var BFE_NONE=${JSON.stringify(BFE_NONE)};
  var UNSTATED=${JSON.stringify(UNSTATED)};
  var WHY_NO_REASON=${JSON.stringify(WHY_NO_REASON)};
  var WHY_TURN_OPENER=${JSON.stringify(WHY_TURN_OPENER)};
  var WHY_TURN_INSTRUCTION=${JSON.stringify(WHY_TURN_INSTRUCTION)};
  var WHY_LABEL=${JSON.stringify(WHY_LABEL)};
  var SAVE_STATUSES=${JSON.stringify(SAVE_STATUSES)};
  var SAVE_LABEL=${JSON.stringify(SAVE_LABEL)};
  var ADD_TO_SCREEN_LABEL=${JSON.stringify(ADD_TO_SCREEN_LABEL)};
  var REPORT_TOGGLE=${JSON.stringify(REPORT_TOGGLE)};
  var NO_BRIEF=${JSON.stringify(NO_BRIEF)};
  var STATE_WORDS=${JSON.stringify(STATE_WORDS)};
  var SECTION_FOR_OVERLAY=${JSON.stringify(SECTION_FOR_OVERLAY)};
${inlineSharedSource()}
  var esc=escapeHtml;
  var model=emptyModel("empty");
  var openWait=null;
  var openFail=null;
  var openSent=null;
  var openTimer=null;
  function clearOpenTimer(){ if(openTimer){ clearTimeout(openTimer); openTimer=null; } }
  var sortKey="query";
  var sortDir=1;
  var listingAck=null;
  var hotEl=null;
  var pinnedEl=null;
  /* R1: local view state (I8). Reset on every accepted result; never read from anywhere. */
  var reportOpen=false;
  var rpcId=1;
  var initId=rpcId++;
  var ready=false;
  var pending=[];
  function markHandshake(state){
    handshake=state;
    paintBoot();
  }
  function summarizeCaps(result){
    var hc=result&&result.hostCapabilities;
    if(!hc||typeof hc!=="object"){
      capText="caps=none";
      msgCap="message=none";
      return;
    }
    var keys=[];
    for(var k in hc){if(Object.prototype.hasOwnProperty.call(hc,k)&&k!=="message") keys.push(k)}
    capText="caps="+(keys.length?keys.join(","):"empty");
    if(hc.message==null){
      msgCap="message=none";
    } else if(hc.message===true){
      msgCap="message=yes";
    } else if(typeof hc.message==="object"){
      var mods=[];
      for(var m in hc.message){if(hc.message[m]) mods.push(m)}
      msgCap="message="+(mods.length?mods.join(","):"yes");
    } else {
      msgCap="message="+String(hc.message);
    }
  }
  function postMessage(text){
    var id=rpcId++;
    pendingMsg[id]=1;
    pendingMsg[String(id)]=1;
    parent.postMessage({jsonrpc:"2.0",id:id,method:"ui/message",params:{role:"user",content:[{type:"text",text:text}]}},"*");
  }
  function flushReady(){
    if(ready) return;
    ready=true;
    parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/initialized"},"*");
    while(pending.length) postMessage(pending.shift());
  }
  var host={
    sendMessage:function(text){
      if(!ready){pending.push(text);return;}
      postMessage(text);
    }
  };
  function listingHistoryMessage(m){
    var who=m.label||m.parcelNodeId||"this parcel";
    return ${JSON.stringify(LISTING_TURN_OPENER)}+" "+who+". "+${JSON.stringify(LISTING_TURN_INSTRUCTION)};
  }
  function openParcelMessage(node){
    return ${JSON.stringify(OPEN_TURN_OPENER)}+" "+node+". "+${JSON.stringify(OPEN_TURN_INSTRUCTION)};
  }
  function envelopeHuman(reason){
    if(reason===["atom","path","pending"].join("_")) return "Withheld, setbacks unruled";
    return reason;
  }
  function openLink(url){
    if(!url) return;
    parent.postMessage({jsonrpc:"2.0",id:rpcId++,method:"ui/open-link",params:{url:url}},"*");
  }
  function tipEl(){
    var root=document.getElementById("root");
    return root&&typeof root.querySelector==="function"?root.querySelector("[data-tip]"):null;
  }
  function showEdge(n){
    var idx=Number(n.getAttribute("data-edge"));
    var e=model.edges&&model.edges[idx];
    if(!e) return;
    if(hotEl&&hotEl!==n) hotEl.setAttribute("class","edge");
    n.setAttribute("class","edge hot");
    hotEl=n;
    var tip=tipEl();
    if(tip){ tip.innerHTML=edgeTipHtml(e,idx); tip.setAttribute("data-edge-shown",String(idx)); }
  }
  function clearEdge(){
    if(hotEl) hotEl.setAttribute("class","edge");
    hotEl=null;
    var tip=tipEl();
    if(tip){ tip.innerHTML=EDGE_TIP_HINT; tip.setAttribute("data-edge-shown","none"); }
  }
  function edgeEnter(n){ showEdge(n); }
  function edgeLeave(n){
    if(pinnedEl){ if(pinnedEl!==n) showEdge(pinnedEl); return; }
    clearEdge();
  }
  function edgeToggle(n){
    if(pinnedEl===n){ pinnedEl=null; clearEdge(); return; }
    pinnedEl=n;
    showEdge(n);
  }
  function bindDrawing(){
    hotEl=null;
    pinnedEl=null;
    var root=document.getElementById("root");
    if(!root||typeof root.querySelectorAll!=="function") return;
    var lines=root.querySelectorAll("[data-edge]");
    for(var i=0;i<lines.length;i++){
      (function(n){
        n.addEventListener("pointerenter",function(){ edgeEnter(n); });
        n.addEventListener("pointerleave",function(){ edgeLeave(n); });
        n.addEventListener("pointerdown",function(){ edgeToggle(n); });
      })(lines[i]);
    }
    var links=root.querySelectorAll("[data-zoning-url]");
    for(var k=0;k<links.length;k++){
      (function(n){ n.addEventListener("click",function(){ openLink(n.getAttribute("data-zoning-url")); }); })(links[k]);
    }
  }
  function fingerprint(m){
    return JSON.stringify({kind:m.kind,screenId:m.screenId||null,rows:m.rows,parcelNodeId:m.parcelNodeId||null,overlays:m.overlays,ring:m.ring||[],edges:(m.edges||[]).map(edgeCaption)});
  }
  function looksNode(q){return NODE_RE.test(String(q||"").trim())}
  function queryCell(r){
    if(r.resolution!=="unresolved") return '<div class="pl">'+esc(r.query)+"</div>";
    var cap=looksNode(r.query)?"node unresolved":"situs unresolved";
    var cls="pn";
    return '<div class="unres">'+cap+'</div><div class="'+cls+'">'+esc(r.query)+"</div>";
  }
  function glyph(state){
    var s=railState(state);
    return '<span class="g g-'+esc(s)+'" title="'+esc(s)+'"></span>';
  }
  function idLine(id){ return '<span class="pn atom">'+esc(id)+"</span>"; }
  function reasonLine(reason){ return '<span class="why"><span class="key">reason</span> <span class="reason">'+esc(reason)+"</span></span>"; }
  function missLine(m){
    if(m.missClass==="absent") return '<p class="miss"><b>'+esc(notOnFileSentence(m.parcelNodeId))+"</b>"+idLine(m.parcelNodeId)+"</p>";
    if(m.missClass==="unbaked") return '<p class="miss"><b>'+esc(noBakedSnapshotSentence(m.parcelNodeId))+"</b>"+idLine(m.parcelNodeId)+"</p>";
    return '<p class="miss"><b>'+${JSON.stringify(NOT_RETURNED)}+"</b>"+idLine(m.parcelNodeId)+reasonLine(m.reason)+"</p>";
  }
  function refusedLine(r){
    if(r.reason==="upgrade_required") return '<p class="miss"><b>'+${JSON.stringify(UPGRADE_TO_OPEN)}+"</b>"+idLine(r.parcelNodeId)+"</p>";
    return '<p class="miss"><b>'+${JSON.stringify(OPEN_REFUSED)}+"</b>"+idLine(r.parcelNodeId)+reasonLine(r.reason)+"</p>";
  }
  function stateLines(){
    return (openFail?'<p class="fail">'+esc(openFail)+"</p>":"")+(openSent?'<p class="note">'+${JSON.stringify(OPEN_SENT)}+"</p>":"");
  }
  function card(title,inner){
    return '<div class="card"><div class="hdr"><span class="mark"></span>Smart Site · '+title+' <span data-script="ran">script-ran</span></div>'+inner+"</div>";
  }
  function render(){
    var root=document.getElementById("root");
    if(model.kind==="board"){
      var rows=model.rows.slice().sort(function(a,b){
        var av=sortKey==="query"?a.query:(a.parcelNodeId||"");
        var bv=sortKey==="query"?b.query:(b.parcelNodeId||"");
        return av<bv?-sortDir:av>bv?sortDir:0;
      });
      var head="<tr><th data-k=query>Query</th><th data-k=id>Node</th>"+RAILS.map(function(r){return "<th>"+r+"</th>"}).join("")+"<th></th></tr>";
      var body=rows.map(function(r,i){
        var open=r.parcelNodeId
          ?'<button type="button" class="btn" data-act="open" data-node="'+esc(r.parcelNodeId)+'" onclick="window.__ss&&window.__ss.open(this)">Open</button>'
          :'<div class="slot">'+${JSON.stringify(NOTHING_TO_OPEN)}+"</div>";
        return '<tr class="row" data-i="'+i+'"><td>'+queryCell(r)+'</td><td class="pn atom">'+esc(r.parcelNodeId||"—")+"</td>"+RAILS.map(function(k){
          var g=glyph(r.rails[k]);
          var ask=r.parcelNodeId?whyControlHtml("rail",railState(r.rails[k]),{rail:k,node:r.parcelNodeId},g):"";
          return "<td>"+(ask||g)+"</td>";
        }).join("")+"<td>"+open+"</td></tr>";
      }).join("");
      var note=model.stubsDegraded===true?'<p class="note">'+${JSON.stringify(RAILS_PARTLY_UNREAD)}+"</p>":"";
      root.innerHTML=card("screen board",stateLines()+note+'<div class="well"><div class="req">Rows</div><table><thead>'+head+"</thead><tbody>"+body+"</tbody></table></div>"+
        '<div class="legend"><span>'+glyph("present")+" present</span><span>"+glyph("absent-verified")+' absent, verified</span><span>'+glyph("unknown")+" unknown</span><span>"+glyph("refused")+" refused</span><span>"+glyph("unread")+" unread</span></div>");
    } else if(model.kind==="parcel"){
      var ov=model.overlays.map(function(o,i){return overlayRowHtml(o,i)}).join("")||'<p class="empty">No overlays on this draw.</p>';
      var node=model.parcelNodeId?'<div class="pn atom">'+esc(model.parcelNodeId)+"</div>":"";
      var flood=floodOverlayOf(model.overlays);
      var svg=ringSvg(model.ring||[],model.edges||[],{zoning:model.zoning||null,flood:flood,frame:model.frame||null});
      var tip=svg?'<div class="tip" data-tip="1">'+EDGE_TIP_HINT+"</div>"+frameNoteHtml(model.frame||null):"";
      var edgeList=(model.edges&&model.edges.length)?'<ul class="edges">'+model.edges.map(function(e){return "<li>"+esc(edgeCaption(e))+"</li>"}).join("")+"</ul>":"";
      var secs=model.sections||[];
      var floodFacts="";
      for(var fi=0;fi<secs.length;fi++){ if(secs[fi].id==="flood"){ floodFacts=floodFactsHtml(secs[fi],fi); break; } }
      var report=reportOpen?reportHtml(secs):"";
      root.innerHTML=card(esc(model.label||model.parcelNodeId||"parcel"),stateLines()+'<div class="well">'+node+svg+tip+edgeList+ov+floodFacts+report+"</div>"+
        '<div class="acts">'+saveChooserHtml()+'<button type="button" class="btn'+(reportOpen?" on":"")+'" data-act="report" data-report-open="'+(reportOpen?"1":"0")+'" onclick="window.__ss&&window.__ss.report()">'+REPORT_TOGGLE+'</button><button type="button" class="btn primary" data-act="listing" onclick="window.__ss&&window.__ss.listing(this)">Find listing history</button></div>'+(listingAck?'<div class="ack" data-listing-chars="'+esc(listingAck.chars)+'">Posted '+esc(listingAck.chars)+" chars</div>":""));
      var listing=root.querySelector('[data-act="listing"]');
      if(listing&&listingAck){
        listing.textContent=${JSON.stringify(LISTING_ACK_LABEL)};
        listing.disabled=true;
        listing.setAttribute("data-listing-ack","1");
        listing.setAttribute("data-listing-chars",String(listingAck.chars));
      }
      bindDrawing();
    } else if(model.kind==="miss"){
      root.innerHTML=card("lookup",'<div class="well">'+(model.misses||[]).map(missLine).join("")+"</div>");
    } else if(model.kind==="refused"){
      root.innerHTML=card("refused",'<div class="well">'+(model.refused||[]).map(refusedLine).join("")+"</div>");
    } else if(model.kind==="unreadable"){
      root.innerHTML=card("result",'<p class="empty"><b>'+${JSON.stringify(RESULT_NOT_READABLE)}+"</b>"+${JSON.stringify(RESULT_NOT_READABLE_BODY)}+"</p>");
    } else {
      root.innerHTML=card("waiting",stateLines()+'<p class="empty"><b>'+${JSON.stringify(EMPTY_BOARD_TITLE)}+"</b>"+${JSON.stringify(EMPTY_BOARD_BODY)}+"</p>");
    }
    requestAnimationFrame(function(){ fitHost(); });
  }
  function fitHost(){
    document.documentElement.style.height="";
    document.body.style.height="";
    var measured=Math.ceil(Math.max(document.body.scrollHeight,document.documentElement.scrollHeight,420));
    document.documentElement.style.height=measured+"px";
    parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/size-changed",params:{height:measured}},"*");
  }
  function armListing(btn){
    if(!btn||btn.getAttribute("data-listing-ack")==="1") return null;
    btn.textContent=${JSON.stringify(LISTING_ACK_LABEL)};
    btn.disabled=true;
    btn.setAttribute("data-listing-ack","1");
    var text=listingHistoryMessage(model);
    listingAck={chars:text.length};
    btn.setAttribute("data-listing-chars",String(text.length));
    btn.setAttribute("title",text);
    var acts=btn.parentNode;
    if(acts&&acts.parentNode&&!acts.parentNode.querySelector(".ack")){
      var note=document.createElement("div");
      note.className="ack";
      note.setAttribute("data-listing-chars",String(text.length));
      note.textContent="Posted "+text.length+" chars";
      acts.parentNode.appendChild(note);
    }
    return text;
  }
  function sendListing(btn){
    var text=armListing(btn);
    if(!text) return;
    var before=fingerprint(model);
    host.sendMessage(text);
    if(fingerprint(model)!==before) throw new Error("i5_panel_mutated");
  }
  function sendOpen(btn){
    var node=btn&&btn.getAttribute("data-node");
    if(!node) return;
    clearOpenTimer();
    openWait=node;
    openFail=null;
    openSent=null;
    openTimer=setTimeout(function(){
      if(openWait){
        openFail=${JSON.stringify(OPEN_DID_NOT_REACH_ME)};
        openWait=null;
        render();
      }
    },${OPEN_DEAD_MS});
    host.sendMessage(openParcelMessage(node));
  }
  function attr(btn,name){
    return btn&&typeof btn.getAttribute==="function"?btn.getAttribute(name):null;
  }
  /* C1: one draft per choice; a status off the enum drafts nothing; no saved state is read (I6). */
  function sendSave(btn){
    var status=attr(btn,"data-status");
    if(!model.parcelNodeId||!status||SAVE_STATUSES.indexOf(status)<0) return;
    host.sendMessage(saveMessage(model.parcelNodeId,status));
  }
  /* F1: the control's own https url, through the same ui/open-link path as the district. */
  function sendCite(btn){
    var url=attr(btn,"data-url");
    if(!url||String(url).slice(0,8).toLowerCase()!=="https://") return;
    openLink(url);
  }
  /* P1: a question, not an Open: same sendMessage path, no timer, no ack. */
  function sendWhy(btn){
    var q=whyQuestion(model,attr(btn,"data-why-kind"),{i:attr(btn,"data-why-i"),rail:attr(btn,"data-why-rail"),node:attr(btn,"data-why-node")});
    if(!q) return;
    host.sendMessage(whyMessage(q));
  }
  /* C2: the neighbor the door names; the screen id stays with Claude. */
  function sendAddToScreen(btn){
    var node=attr(btn,"data-node");
    if(!node) return;
    host.sendMessage(addToScreenMessage(node));
  }
  /* R1: local toggle (I8); render posts size-changed and nothing else. */
  function toggleReport(){
    if(model.kind!=="parcel") return;
    reportOpen=!reportOpen;
    render();
  }
  window.__ss={listing:sendListing,open:sendOpen,save:sendSave,cite:sendCite,why:sendWhy,addToScreen:sendAddToScreen,report:toggleReport,parse:parseToolResult};
  document.body.addEventListener("click",function(ev){
    var el=ev.target;
    if(!el||!el.closest) return;
    var th=el.closest("th[data-k]");
    if(th){
      sortKey=th.getAttribute("data-k");
      sortDir*=-1;
      render();
    }
  });
  function accept(result){
    clearOpenTimer();
    openWait=null;
    openFail=null;
    openSent=null;
    reportOpen=false;
    model=parseToolContent(result);
    render();
  }
  window.addEventListener("message",function(ev){
    if(ev.source!==window.parent){ foreignCount++; paintBoot(); return; }
    var d=ev.data;
    if(!d) return;
    if(String(d.id)===String(initId)&&(d.result!==undefined||d.error)){
      if(d.error){
        capText="caps=error";
        msgCap="message=error";
        markHandshake("error");
      } else {
        summarizeCaps(d.result);
        markHandshake("ready");
      }
      flushReady();
      return;
    }
    if(d.id!=null&&pendingMsg[d.id]){
      delete pendingMsg[d.id];
      delete pendingMsg[String(d.id)];
      if(d.error){
        replyText="reply="+(d.error.code!=null?String(d.error.code):"error");
        if(openWait){
          clearOpenTimer();
          openFail=${JSON.stringify(OPEN_DID_NOT_REACH_ME)};
          openWait=null;
          openSent=null;
          render();
        }
      } else if(d.result&&d.result.isError){
        replyText="reply=isError";
        accept(d.result);
      } else if(d.result!==undefined){
        replyText="reply=ok";
        if(d.result&&d.result.content) accept(d.result);
        else if(openWait){
          clearOpenTimer();
          openSent=openWait;
          openWait=null;
          openFail=null;
          render();
        }
      } else {
        replyText="reply=empty";
      }
      paintBoot();
      return;
    }
    if(d.method==="ui/notifications/tool-result"&&d.params) accept(d.params);
  });
  markHandshake("wait");
  parent.postMessage({jsonrpc:"2.0",id:initId,method:"ui/initialize",params:{protocolVersion:"2026-01-26",appInfo:{name:"SmartSiteBoard",version:"1"},appCapabilities:{availableDisplayModes:["inline"]}}},"*");
  setTimeout(function(){
    if(!ready){markHandshake("timeout");flushReady();}
  },2000);
})();
</script>
</body>
</html>`;
}

export function registerMcpApp(server: {
  registerResource?: (
    name: string,
    uri: string,
    config: Record<string, unknown>,
    handler: (uri: { href: string }) => Promise<{
      contents: Array<{
        uri: string;
        mimeType: string;
        text: string;
        _meta?: Record<string, unknown>;
      }>;
    }>,
  ) => void;
  resource?: (
    name: string,
    uri: string,
    config: Record<string, unknown>,
    handler: (uri: { href: string }) => Promise<{
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    }>,
  ) => void;
}): void {
  const handler = async (uri: { href: string }) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: APP_MIME,
        text: buildAppHtml(),
        _meta: {
          ui: {
            prefersBorder: false,
            csp: { connectDomains: [], resourceDomains: [] },
          },
        },
      },
    ],
  });
  if (typeof server.registerResource === "function") {
    server.registerResource("Smart Site board", APP_RESOURCE_URI, { mimeType: APP_MIME }, handler);
    return;
  }
  if (typeof server.resource === "function") {
    server.resource("Smart Site board", APP_RESOURCE_URI, { mimeType: APP_MIME }, handler);
  }
}
