/** P-91 Wave I — Open turn and parcel draw. I1/I5/I6. No fourteenth tool. */

export const APP_RESOURCE_URI = "ui://smartsite/app-p555.html";
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

export function ringSvg(ring: RingPt[], edges: DrawEdge[]): string {
  if (ring.length < 3) return "";
  const xs = ring.map((p) => p.x);
  const ys = ring.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const pad = 18;
  const w = 320;
  const h = 220;
  const sx = (w - pad * 2) / Math.max(maxX - minX, 1);
  const sy = (h - pad * 2) / Math.max(maxY - minY, 1);
  const s = Math.min(sx, sy);
  const ox = (w - (maxX - minX) * s) / 2;
  const oy = (h - (maxY - minY) * s) / 2;
  const pt = (p: RingPt) => {
    const x = ox + (p.x - minX) * s;
    const y = h - (oy + (p.y - minY) * s);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };
  const pts = ring.map(pt).join(" ");
  const road = edges
    .map((e, i) => {
      const idx = edgeIndex(e, i);
      if (!edgeHasRoad(e) || !ring[idx] || !ring[(idx + 1) % ring.length]) return "";
      return `<polyline points="${pt(ring[idx])} ${pt(ring[(idx + 1) % ring.length])}" fill="none" stroke="var(--ss-t3)" stroke-width="7" stroke-linecap="square" opacity=".35"/>`;
    })
    .join("");
  const neigh = edges
    .map((e, i) => {
      const idx = edgeIndex(e, i);
      if (!e.neighbor || edgeHasRoad(e) || !ring[idx] || !ring[(idx + 1) % ring.length]) return "";
      return `<polyline points="${pt(ring[idx])} ${pt(ring[(idx + 1) % ring.length])}" fill="none" stroke="var(--ss-t6)" stroke-width="2" stroke-dasharray="4 3"/>`;
    })
    .join("");
  return `<svg class="ring" viewBox="0 0 ${w} ${h}" aria-label="parcel ring">${road}${neigh}<polygon points="${pts}" fill="var(--ss-void)" fill-opacity=".55" stroke="var(--ss-t3)" stroke-width="2"/></svg>`;
}

export function renderParcelDraw(model: Pick<PanelModel, "ring" | "edges" | "overlays" | "label" | "parcelNodeId">): string {
  const node = model.parcelNodeId
    ? `<div class="pn atom">${escapeHtml(model.parcelNodeId)}</div>`
    : "";
  const svg = ringSvg(model.ring ?? [], model.edges ?? []);
  const edgeList = (model.edges ?? []).length
    ? `<ul class="edges">${(model.edges ?? [])
        .map((e) => `<li>${escapeHtml(edgeCaption(e))}</li>`)
        .join("")}</ul>`
    : "";
  const rows = model.overlays
    .map((o) => {
      const extra = o.id === "flood" ? " flood" : o.state === "refused" ? " refused" : "";
      const shown = envelopeHuman(o.reason);
      const why = shown
        ? `<span class="why"><span class="key">reason</span> <span class="reason">${escapeHtml(shown)}</span></span>`
        : "";
      return `<div class="ovl${extra}"><span class="g ${glyphClass(railState(o.state))}"></span> <span class="key">${escapeHtml(o.id)}</span> <span class="lbl">${escapeHtml(o.label)}</span>${why}</div>`;
    })
    .join("");
  return `${node}${model.label ? `<div class="pl">${escapeHtml(model.label)}</div>` : ""}${svg}${edgeList}${rows}`;
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
    rows.push({ id, state, label, reason });
  }
  return rows;
}

function batchRowsFrom(rec: Record<string, unknown>): BoardRow[] | null {
  if (!Array.isArray(rec.parcels)) return null;
  const rows: BoardRow[] = [];
  for (const raw of rec.parcels) {
    const p = asRecord(raw);
    if (!p || typeof p.parcelNodeId !== "string" || p.parcelNodeId.length === 0) continue;
    const stub = asRecord(p.stub);
    const rails = {} as Record<RailName, CellState>;
    for (const rail of RAILS) rails[rail] = stub ? railState(stub[rail]) : "unread";
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
    return {
      kind: "parcel",
      rows: [],
      overlays: overlaysFromDraw(parcelDraw),
      ring: ringFromDraw(parcelDraw),
      edges: edgesFromDraw(parcelDraw),
      parcelNodeId,
      label,
    };
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
  function edgeCaption(e){
    var bits=[];
    if(e.role) bits.push(e.role);
    if(e.adjacency) bits.push(e.adjacency);
    if(e.neighbor) bits.push(e.neighbor);
    if(e.roadNode) bits.push(e.roadNode);
    if(e.road) bits.push(e.road);
    var ft=e.ft!=null?e.ft:e.lengthFt;
    if(ft!=null) bits.push(ft+" ft");
    if(e.bearing) bits.push(e.bearing);
    return bits.join(" · ");
  }
  function edgeIndex(e,i){
    if(typeof e.i==="number") return e.i;
    if(e.seg&&typeof e.seg[0]==="number") return e.seg[0];
    return i;
  }
  function edgeHasRoad(e){return !!(e.roadNode||e.road)}
  function ringSvg(ring,edges){
    if(!ring||ring.length<3) return "";
    var xs=ring.map(function(p){return p.x}), ys=ring.map(function(p){return p.y});
    var minX=Math.min.apply(null,xs), maxX=Math.max.apply(null,xs), minY=Math.min.apply(null,ys), maxY=Math.max.apply(null,ys);
    var pad=18,w=320,h=220;
    var s=Math.min((w-pad*2)/Math.max(maxX-minX,1),(h-pad*2)/Math.max(maxY-minY,1));
    var ox=(w-(maxX-minX)*s)/2, oy=(h-(maxY-minY)*s)/2;
    function pt(p){
      return (ox+(p.x-minX)*s).toFixed(1)+","+(h-(oy+(p.y-minY)*s)).toFixed(1);
    }
    var pts=ring.map(pt).join(" ");
    var road=(edges||[]).map(function(e,i){
      var idx=edgeIndex(e,i);
      if(!edgeHasRoad(e)||!ring[idx]||!ring[(idx+1)%ring.length]) return "";
      return '<polyline points="'+pt(ring[idx])+" "+pt(ring[(idx+1)%ring.length])+'" fill="none" stroke="var(--ss-t3)" stroke-width="7" stroke-linecap="square" opacity=".35"/>';
    }).join("");
    var neigh=(edges||[]).map(function(e,i){
      var idx=edgeIndex(e,i);
      if(!e.neighbor||edgeHasRoad(e)||!ring[idx]||!ring[(idx+1)%ring.length]) return "";
      return '<polyline points="'+pt(ring[idx])+" "+pt(ring[(idx+1)%ring.length])+'" fill="none" stroke="var(--ss-t6)" stroke-width="2" stroke-dasharray="4 3"/>';
    }).join("");
    return '<svg class="ring" viewBox="0 0 '+w+" "+h+'" aria-label="parcel ring">'+road+neigh+'<polygon points="'+pts+'" fill="var(--ss-void)" fill-opacity=".55" stroke="var(--ss-t3)" stroke-width="2"/></svg>';
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
        return '<tr class="row" data-i="'+i+'"><td>'+queryCell(r)+'</td><td class="pn atom">'+esc(r.parcelNodeId||"—")+"</td>"+RAILS.map(function(k){return "<td>"+glyph(r.rails[k])+"</td>"}).join("")+"<td>"+open+"</td></tr>";
      }).join("");
      var note=model.stubsDegraded===true?'<p class="note">'+${JSON.stringify(RAILS_PARTLY_UNREAD)}+"</p>":"";
      root.innerHTML=card("screen board",stateLines()+note+'<div class="well"><div class="req">Rows</div><table><thead>'+head+"</thead><tbody>"+body+"</tbody></table></div>"+
        '<div class="legend"><span>'+glyph("present")+" present</span><span>"+glyph("absent-verified")+' absent, verified</span><span>'+glyph("unknown")+" unknown</span><span>"+glyph("refused")+" refused</span><span>"+glyph("unread")+" unread</span></div>");
    } else if(model.kind==="parcel"){
      var ov=model.overlays.map(function(o){
        var extra=o.id==="flood"?" flood":o.state==="refused"?" refused":"";
        var shown=envelopeHuman(o.reason);
        var why=shown?reasonLine(shown):"";
        return '<div class="ovl'+extra+'">'+glyph(o.state)+' <span class="key">'+esc(o.id)+'</span> <span class="lbl">'+esc(o.label)+"</span>"+why+"</div>";
      }).join("")||'<p class="empty">No overlays on this draw.</p>';
      var node=model.parcelNodeId?'<div class="pn atom">'+esc(model.parcelNodeId)+"</div>":"";
      var svg=ringSvg(model.ring||[],model.edges||[]);
      var edgeList=(model.edges&&model.edges.length)?'<ul class="edges">'+model.edges.map(function(e){return "<li>"+esc(edgeCaption(e))+"</li>"}).join("")+"</ul>":"";
      root.innerHTML=card(esc(model.label||model.parcelNodeId||"parcel"),'<div class="well">'+node+svg+edgeList+ov+"</div>"+
        '<div class="acts"><button type="button" class="btn" data-act="save" onclick="window.__ss&&window.__ss.save()">Save property</button><button type="button" class="btn primary" data-act="listing" onclick="window.__ss&&window.__ss.listing(this)">Find listing history</button></div>'+(listingAck?'<div class="ack" data-listing-chars="'+esc(listingAck.chars)+'">Posted '+esc(listingAck.chars)+" chars</div>":""));
      var listing=root.querySelector('[data-act="listing"]');
      if(listing&&listingAck){
        listing.textContent=${JSON.stringify(LISTING_ACK_LABEL)};
        listing.disabled=true;
        listing.setAttribute("data-listing-ack","1");
        listing.setAttribute("data-listing-chars",String(listingAck.chars));
      }
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
  function sendSave(){
    if(model.parcelNodeId) host.sendMessage("Save property "+model.parcelNodeId+" with save_property. Do not change any screen.");
  }
  window.__ss={listing:sendListing,open:sendOpen,save:sendSave,parse:parseToolResult};
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
