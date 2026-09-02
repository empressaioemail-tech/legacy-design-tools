/** P-91 Wave I — Open turn and parcel draw. I1/I5/I6. No fourteenth tool. */

/* Types only. Nothing in this module may import a VALUE from parcel-anchor.js:
 * half of this file is embedded into the served script by source (INLINE_SHARED)
 * and an imported binding would not exist in that scope. The compile time link
 * that keeps the two shapes in step is PANEL_ANCHOR_ACCEPTS_WIRE below. */
import type { AnchorReadStatus, ParcelAnchor } from "./parcel-anchor.js";

export const APP_RESOURCE_URI = "ui://smartsite/app-p562.html";
export const APP_MIME = "text/html;profile=mcp-app";

/* p559 probe: three channels for the map-ground decision (v3 scoping measurement 6).
 * Read-only; results paint into the boot strip and change no behavior. */
export const PROBE_RESOURCE_URI = "ui://smartsite/probe-p559.txt";
export const PROBE_RESOURCE_TEXT = "probe-ok";
export const PROBE_NET_TARGETS = [
  { key: "esri", url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/0/0/0" },
  { key: "gcs", url: "https://storage.googleapis.com/hauska-map-tiles/parcels" },
  { key: "svc7", url: "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Zoned_Parcels/FeatureServer/83?f=json" },
  { key: "self", url: "https://mcp.smartsite.cloud/health" },
] as const;
export const PROBE_CSP_DOMAINS = [
  "https://server.arcgisonline.com",
  "https://storage.googleapis.com",
  "https://services7.arcgis.com",
  "https://mcp.smartsite.cloud",
] as const;
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

/** B1: a candidate on an ambiguous screen row, as the wire carries it (peScreenSave ScreenCandidate). */
export type ScreenCandidate = { parcelNodeId: string; label: string; countyFips?: string };
/** B2: how a row's stub was obtained (peScreenSave StubReadState). */
export type StubReadState = "ok" | "error" | "skipped";

export type BoardRow = {
  query: string;
  parcelNodeId: string | null;
  resolution: "resolved" | "ambiguous" | "unresolved";
  rails: Record<RailName, CellState>;
  /** B1: present only on an ambiguous row that carries candidates. */
  candidates?: ScreenCandidate[];
  /** B2: present when the wire states it; error and skipped force every rail to unread. */
  stubRead?: StubReadState;
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
  /** The wire's word: present | refused | absent | unread, or (P-91 v3 item 1) unknown |
   * absent-verified when a section claims one of those directly, or "unstated" when it carries none. */
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

/**
 * M-2: the panel's reading of the absolute point the M-1 lane put on the wire.
 * The panel prints and places what the wire carried and invents no component of
 * it, so precision and source are read as plain strings rather than pinned to
 * this module's idea of what the producer emits.
 */
export type PanelAnchor = {
  lat: number;
  lon: number;
  precision: string | null;
  source: string | null;
};

/** `status` is the producer's four value union; `anchor` exists only under "ok". */
export type PanelAnchorRead = {
  status: AnchorReadStatus;
  reason: string | null;
};

/**
 * Compile time link, not a comment: a wire anchor as parcel-anchor.ts declares
 * it must still be readable as a PanelAnchor. If that module renames or retypes
 * a component, `true` stops being assignable to `never` and typecheck fails
 * here rather than the panel silently reading undefined off the wire.
 */
export type PanelAnchorAcceptsWire = ParcelAnchor extends PanelAnchor ? true : never;
export const PANEL_ANCHOR_ACCEPTS_WIRE: PanelAnchorAcceptsWire = true;

/**
 * M-4: the array's anchor phase as the producer declared it. `attempted` counts
 * reads issued, not reads that returned a coordinate, so this object is never
 * read as coverage; whether one parcel has a coordinate is on that parcel.
 */
export type PanelAnchorBatch = {
  cap: number;
  received: number;
  attempted: number;
  notAttempted: number;
  reason: string | null;
};

/**
 * M-4: one parcel of a node-depth array, exactly as the wire carried it. A row
 * with no draw is kept, with an empty ring, because a parcel that cannot be
 * drawn has to be nameable; dropping it here is how a canvas quietly shows four
 * of seven.
 */
export type PanelParcel = {
  parcelNodeId: string;
  label: string;
  ring: RingPt[];
  edges: DrawEdge[];
  zoning: DrawZoning | null;
  frame: DrawFrame | null;
  anchor: PanelAnchor | null;
  anchorRead: PanelAnchorRead | null;
  /** False only for an id the lookup did not return at all. */
  returned: boolean;
};

export type PanelKind = "board" | "parcel" | "parcels" | "empty" | "miss" | "refused" | "unreadable" | "screens" | "declared";
export type MissClass = "absent" | "unbaked" | "unstated";
export type MissRow = {
  parcelNodeId: string;
  county: string;
  missClass: MissClass;
  reason: string;
  parcelExists: boolean | "unmeasured";
};
export type RefusedRow = { parcelNodeId: string; reason: string };
/** B2: a later query that resolved to a node an earlier query already held; declared, never written (peScreenSave ScreenDuplicate). */
export type ScreenDuplicate = { query: string; parcelNodeId: string; keptQuery: string };
export type ScreenDegraded = { timedOut?: string[]; duplicates?: ScreenDuplicate[] };
/** B3: one row of the bare list_screens summary; rowCount only when the wire carries a whole number. */
export type ScreenSummary = { id: string; name: string; rowCount?: number; updatedAt: string | null; createdAt: string | null };
/** H1: the top-level status words the p558 server emits on a body that names its own state. */
export const DECLARED_STATUSES = ["error", "refused", "not_implemented", "degraded", "not_ready", "upgrade_required"] as const;
export type DeclaredStatus = (typeof DECLARED_STATUSES)[number];
export type DeclaredBody = {
  status: DeclaredStatus;
  reason: string | null;
  message?: string;
  cap?: number;
  received?: number;
  depth?: string;
  tool?: string;
  upstreamStatus?: number | "unmeasured";
  tier?: string;
  /** Only under upstream_non_json: the upstream text, shown verbatim and escaped. */
  brief?: string;
};

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
  /** B2: declared degradation on a create_screen response; absent when the wire declares none. */
  degraded?: ScreenDegraded;
  /** B3: the bare list_screens summary, newest updatedAt first. */
  screens?: ScreenSummary[];
  /** H1: a body that names its own state. */
  declared?: DeclaredBody;
  /** M-2: the absolute point, present only when anchorRead.status is "ok". */
  anchor?: PanelAnchor;
  /** M-2: the declared outcome of the anchor read, absent when the wire carried none. */
  anchorRead?: PanelAnchorRead;
  /** M-4: every parcel a node-depth array returned, drawable or not. */
  parcels?: PanelParcel[];
  /** M-4: what the array's anchor phase did, as the producer declared it. */
  anchorBatch?: PanelAnchorBatch;
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
/* P-101 item 10. UPGRADE_TO_OPEN is about a PARCEL and is not reused for a
 * screen: a user told "Upgrade to open this parcel" after clicking Add to
 * screen is told about the wrong thing. This is its sibling, keyed off the
 * refusal reason the api-server screens gate emits (`studio_screens`), which
 * travels intact because declareUpstreamNonOk carries the upstream body's own
 * `reason`. The screens gate is the only producer of that string today. */
export const UPGRADE_SCREENS_REASON = "studio_screens";
export const UPGRADE_TO_SCREEN = "Upgrade to build a screen";
export const OPEN_REFUSED = "Open refused";
export const RESULT_NOT_READABLE = "Result not readable";
export const RESULT_NOT_READABLE_BODY = "The tool result carried no JSON text part. Ask again in the chat.";
export const RAILS_PARTLY_UNREAD = "Some rails on this screen were not read";
/* P-91 v2 board (S8) copy. UI words, never parcel facts. */
export const USE_THIS_LABEL = "Use this";
export const LOOK_UP_LABEL = "Look this up";
/** The wire's own resolution word, printed as the caption of a row that has candidates and no node. */
export const AMBIGUOUS_CAPTION = "ambiguous";
export const NO_SCREENS_YET = "No screens yet.";
export const NO_SCREENS_BODY = "Paste addresses in the chat to make one.";
export const UNRESOLVED_GROUP = "Unresolved";
export const STUB_READ_NOTE = "rails not read";
export const DUP_SAME_PARCEL = "is the same parcel as";
export const DUP_NOT_ADDED = "not added twice.";
export const TIMED_OUT_NOTE = "did not resolve in time; unresolved for now.";
export const REFUSED_PREFIX = "Refused";
export const NOT_IMPLEMENTED_PREFIX = "Not implemented";
export const NOT_READY_INFIX = "is not ready";
export const UPSTREAM_KEY = "upstream";
export const SORT_COMPLETENESS_LABEL = "by completeness";

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

function stubReadOf(value: unknown): StubReadState | undefined {
  return value === "ok" || value === "error" || value === "skipped" ? value : undefined;
}

/** B1: a candidate must name a node; the label falls back to the node id; county only when carried. */
function candidatesFrom(value: unknown): ScreenCandidate[] {
  const out: ScreenCandidate[] = [];
  if (!Array.isArray(value)) return out;
  for (const raw of value) {
    const c = asRecord(raw);
    if (!c) continue;
    const parcelNodeId = stringOrNull(c.parcelNodeId);
    if (!parcelNodeId) continue;
    const cand: ScreenCandidate = { parcelNodeId, label: stringOrNull(c.label) ?? parcelNodeId };
    const fips = stringOrNull(c.countyFips);
    if (fips) cand.countyFips = fips;
    out.push(cand);
  }
  return out;
}

function rowFromUnknown(raw: unknown): BoardRow | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const query = typeof rec.query === "string" ? rec.query : "";
  /* An explicit null is the wire saying no node; the legacy id fallback binds only when parcelNodeId is absent and the id has the node shape. A row id is never a node. */
  const parcelNodeId =
    typeof rec.parcelNodeId === "string"
      ? rec.parcelNodeId
      : rec.parcelNodeId === undefined && typeof rec.id === "string" && looksLikeParcelNodeId(rec.id)
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
  const stubRead = stubReadOf(rec.stubRead);
  /* B2: a stub under an errored or skipped read is a claim that read did not make; every rail stays unread */
  const readable = stubRead !== "error" && stubRead !== "skipped";
  const rails = {} as Record<RailName, CellState>;
  for (const rail of RAILS) {
    rails[rail] = stub && readable ? railState(stub[rail]) : "unread";
  }
  if (!query && !parcelNodeId) return null;
  const row: BoardRow = { query: query || parcelNodeId || "situs unresolved", parcelNodeId, resolution, rails };
  const candidates = candidatesFrom(rec.candidates);
  if (candidates.length > 0) row.candidates = candidates;
  if (stubRead) row.stubRead = stubRead;
  return row;
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
/** A section whose disposition is not one of the wire's six words paints unread and says why. */
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

/**
 * The one placement of the local foot frame into the 320x220 viewBox. Extracted
 * from ringSvg so the aerial ground is placed by the same arithmetic that placed
 * the ring, rather than by a second copy that has to be kept in step. Output of
 * ringSvg is unchanged by the extraction.
 *
 * `s` is viewBox units per ground foot. Fewer than three points is not a ring.
 */
export type RingFit = {
  w: number;
  h: number;
  pad: number;
  s: number;
  ox: number;
  oy: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export function ringFit(ring: RingPt[]): RingFit | null {
  if (ring.length < 3) return null;
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
  return { w, h, pad, s, ox, oy, minX, minY, maxX, maxY };
}

/**
 * A point of the local foot frame in viewBox units. Screen y grows downward and
 * the frame's y axis is true north, so y inverts here and nowhere else. The
 * frame's origin is the parcel centroid, which is the point the anchor names, so
 * ringPixel(fit, 0, 0) is BOTH the ring origin and the anchor: one call, so
 * registration is by construction and not by adjustment.
 */
export function ringPixel(fit: RingFit, x: number, y: number): RingPt {
  return { x: fit.ox + (x - fit.minX) * fit.s, y: fit.h - (fit.oy + (y - fit.minY) * fit.s) };
}

export function ringSvg(ring: RingPt[], edges: DrawEdge[], cues?: DrawCues): string {
  const fit = ringFit(ring);
  if (!fit) return "";
  const minX = fit.minX;
  const maxX = fit.maxX;
  const pad = fit.pad;
  const w = fit.w;
  const h = fit.h;
  const s = fit.s;
  const oy = fit.oy;
  const pt = (p: RingPt) => {
    const q = ringPixel(fit, p.x, p.y);
    return `${q.x.toFixed(1)},${q.y.toFixed(1)}`;
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
 * P-91 v3 M-2: the aerial ground under the drawing.
 *
 * The ring lives in a local foot frame whose origin is the parcel's own
 * centroid, so the only thing that can put it on the earth is the anchor the
 * M-1 lane reads. Without that anchor there is no ground at all: today's void,
 * never a default coordinate, never a stand in tile, never a grey box standing
 * for imagery.
 *
 * No map library. Web Mercator is arithmetic and it is done here, and the
 * mosaic is a handful of <img> elements placed in the same coordinate space the
 * ring was placed in by ringFit and ringPixel. No pan, no zoom, no camera.
 */

/**
 * Esri orders this path z / row / column, which is z / y / x, NOT z/x/y.
 * Transposing the last two segments fetches real imagery of the wrong place,
 * which renders beautifully and is a confident lie. This string is the single
 * source for both the fetched url and the origin declared in the resource CSP.
 */
export const GROUND_TILE_URL_TEMPLATE =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

/** Derived from the template above, never a second copy of the host. */
export const GROUND_TILE_ORIGIN = new URL(GROUND_TILE_URL_TEMPLATE).origin;

/**
 * What the page LOADS, as opposed to what it connects to. The ground's origin is
 * derived from the template rather than written a second time, so a template
 * pointed at another host declares that host or declares nothing, never the
 * wrong one. The p559 probe origins already include the imagery host, so today
 * this list equals PROBE_CSP_DOMAINS; it stops equalling it the moment the
 * template moves, which is the point of deriving it.
 */
export const RESOURCE_CSP_DOMAINS: readonly string[] = ((): string[] => {
  const out: string[] = PROBE_CSP_DOMAINS.slice();
  if (out.indexOf(GROUND_TILE_ORIGIN) < 0) out.push(GROUND_TILE_ORIGIN);
  return out;
})();

export const GROUND_TILE_PX = 256;

/**
 * Web Mercator metres per pixel at zoom 0 on a 256 pixel tile: the circumference
 * of the EPSG:3857 sphere over 256. Ground resolution at any level is this times
 * cos(latitude) over 2**zoom. Dropping the cosine makes every parcel about 15
 * percent wrong at Texas latitudes: a drawing that does not match the roof.
 */
export const GROUND_EQUATOR_MPP = 156543.03392804097;

/** The US survey foot, 1200/3937 m, the factor the draw frame declares. Not 0.3048. */
export const US_SURVEY_FOOT_M = 1200 / 3937;

export const GROUND_ZOOM_MIN = 14;

/**
 * Esri publishes World Imagery to level 19 broadly and past 19 only in selected
 * areas, where an over zoomed request answers with a placeholder rather than
 * imagery. 19 is the last level that is imagery everywhere we serve, so it is
 * the cap, and a small parcel is honestly upscaled rather than dishonestly
 * detailed.
 */
export const GROUND_ZOOM_MAX = 19;

/** The 320 unit viewBox paints at roughly twice its unit width on a retina panel. */
export const GROUND_SUPERSAMPLE = 2;

/** A mosaic larger than this is refused rather than painted. */
export const GROUND_MAX_TILES = 36;

export const GROUND_SOURCE_LABEL = "Aerial: Esri World Imagery";
/** Esri publishes no per tile capture date, so we state that we do not know it. */
export const GROUND_VINTAGE_NOTE = "capture date unstated";
export const GROUND_TOGGLE_LABEL = "Aerial";

/** Ground resolution in metres per pixel at this latitude and zoom. */
export function groundMetresPerPixel(lat: number, z: number): number {
  return (GROUND_EQUATOR_MPP * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, z);
}

/** Map pixels per ground foot: metres per foot over metres per pixel. */
export function groundPixelsPerFoot(lat: number, z: number): number {
  return US_SURVEY_FOOT_M / groundMetresPerPixel(lat, z);
}

/** Web Mercator world pixel of a coordinate at one zoom. Y grows southward. */
export function groundWorldPixel(lat: number, lon: number, z: number): { wx: number; wy: number } {
  const n = Math.pow(2, z) * GROUND_TILE_PX;
  const latRad = (lat * Math.PI) / 180;
  const wx = ((lon + 180) / 360) * n;
  const wy = (0.5 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / (2 * Math.PI)) * n;
  return { wx, wy };
}

/** The inverse of groundWorldPixel, so the pair can be round tripped in a test. */
export function groundLatLon(wx: number, wy: number, z: number): { lat: number; lon: number } {
  const n = Math.pow(2, z) * GROUND_TILE_PX;
  const lon = (wx / n) * 360 - 180;
  const m = Math.PI * (1 - 2 * (wy / n));
  const lat = (Math.atan(Math.sinh(m)) * 180) / Math.PI;
  return { lat, lon };
}

/** The tile holding a coordinate. x is the column, y is the row. */
export function groundTileId(lat: number, lon: number, z: number): { z: number; x: number; y: number } {
  const p = groundWorldPixel(lat, lon, z);
  return {
    z: z,
    x: Math.floor(p.wx / GROUND_TILE_PX),
    y: Math.floor(p.wy / GROUND_TILE_PX),
  };
}

/** z / y / x. The row goes before the column. */
export function groundTileUrl(z: number, x: number, y: number): string {
  return GROUND_TILE_URL_TEMPLATE.replace("{z}", String(z))
    .replace("{y}", String(y))
    .replace("{x}", String(x));
}

/**
 * The coarsest level whose imagery carries at least GROUND_SUPERSAMPLE image
 * pixels per viewBox unit, clamped to the published range. Ground resolution
 * rises monotonically with z, so the first level that clears the target is the
 * one to use; a parcel small enough to want more than level 19 is clamped and
 * upscaled rather than sent to a level that answers with a placeholder.
 */
export function groundZoomFor(lat: number, viewBoxUnitsPerFoot: number): number {
  const want = viewBoxUnitsPerFoot * GROUND_SUPERSAMPLE;
  for (let z = GROUND_ZOOM_MIN; z <= GROUND_ZOOM_MAX; z++) {
    if (groundPixelsPerFoot(lat, z) >= want) return z;
  }
  return GROUND_ZOOM_MAX;
}

export type GroundTile = {
  z: number;
  x: number;
  y: number;
  url: string;
  /** viewBox units */
  left: number;
  top: number;
  size: number;
};

export type GroundPlan = {
  z: number;
  lat: number;
  lon: number;
  metresPerPixel: number;
  pixelsPerFoot: number;
  /** viewBox units per map pixel; the whole conversion between the two scales */
  vbPerMapPx: number;
  anchorPx: RingPt;
  worldPx: { wx: number; wy: number };
  fit: RingFit;
  tiles: GroundTile[];
};

/** A plan or a declared reason there is none. Never a plan built on a guess. */
export type GroundOutcome = { plan: GroundPlan | null; reason: string | null };

/** One world pixel expressed in viewBox units, through the anchor. */
export function groundVbFromWorld(plan: GroundPlan, wx: number, wy: number): RingPt {
  return {
    x: plan.anchorPx.x + (wx - plan.worldPx.wx) * plan.vbPerMapPx,
    y: plan.anchorPx.y + (wy - plan.worldPx.wy) * plan.vbPerMapPx,
  };
}

/** One coordinate expressed in viewBox units, through the same path the tiles take. */
export function groundProject(plan: GroundPlan, lat: number, lon: number): RingPt {
  const p = groundWorldPixel(lat, lon, plan.z);
  return groundVbFromWorld(plan, p.wx, p.wy);
}

/**
 * Fail closed. Any read that is not "ok", any missing or unusable coordinate,
 * any ring too small to place, and any mosaic over the cap all return a null
 * plan and a reason. Nothing here substitutes a coordinate it did not receive.
 */
export function groundPlan(
  ring: RingPt[],
  anchor: PanelAnchor | null | undefined,
  read: PanelAnchorRead | null | undefined,
): GroundOutcome {
  if (!read) return { plan: null, reason: "ground_anchor_unread" };
  if (read.status !== "ok") return { plan: null, reason: "ground_anchor_" + read.status };
  if (!anchor) return { plan: null, reason: "ground_anchor_missing" };
  const lat = anchor.lat;
  const lon = anchor.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return { plan: null, reason: "ground_anchor_missing" };
  if (!isFinite(lat) || !isFinite(lon)) return { plan: null, reason: "ground_anchor_missing" };
  if (lat === 0 || lon === 0) return { plan: null, reason: "ground_anchor_missing" };
  if (lat > 85 || lat < -85 || lon > 180 || lon < -180) return { plan: null, reason: "ground_anchor_off_world" };
  const fit = ringFit(ring);
  if (!fit) return { plan: null, reason: "ground_no_ring" };
  const z = groundZoomFor(lat, fit.s);
  const mpp = groundMetresPerPixel(lat, z);
  const ppf = groundPixelsPerFoot(lat, z);
  if (!(mpp > 0) || !(ppf > 0)) return { plan: null, reason: "ground_scale_unresolved" };
  const world = groundWorldPixel(lat, lon, z);
  const plan: GroundPlan = {
    z: z,
    lat: lat,
    lon: lon,
    metresPerPixel: mpp,
    pixelsPerFoot: ppf,
    vbPerMapPx: fit.s / ppf,
    anchorPx: ringPixel(fit, 0, 0),
    worldPx: world,
    fit: fit,
    tiles: [],
  };
  const k = plan.vbPerMapPx;
  const side = Math.pow(2, z);
  const wxMin = world.wx + (0 - plan.anchorPx.x) / k;
  const wxMax = world.wx + (fit.w - plan.anchorPx.x) / k;
  const wyMin = world.wy + (0 - plan.anchorPx.y) / k;
  const wyMax = world.wy + (fit.h - plan.anchorPx.y) / k;
  const txMin = Math.max(0, Math.floor(wxMin / GROUND_TILE_PX));
  const txMax = Math.min(side - 1, Math.floor(wxMax / GROUND_TILE_PX));
  const tyMin = Math.max(0, Math.floor(wyMin / GROUND_TILE_PX));
  const tyMax = Math.min(side - 1, Math.floor(wyMax / GROUND_TILE_PX));
  if (txMax < txMin || tyMax < tyMin) return { plan: null, reason: "ground_off_world" };
  if ((txMax - txMin + 1) * (tyMax - tyMin + 1) > GROUND_MAX_TILES) {
    return { plan: null, reason: "ground_tile_cap" };
  }
  const size = GROUND_TILE_PX * k;
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      const at = groundVbFromWorld(plan, tx * GROUND_TILE_PX, ty * GROUND_TILE_PX);
      plan.tiles.push({
        z: z,
        x: tx,
        y: ty,
        url: groundTileUrl(z, tx, ty),
        left: at.x,
        top: at.y,
        size: size,
      });
    }
  }
  return { plan: plan, reason: null };
}

/** viewBox units as a percentage of the box, which is what the mosaic is positioned in. */
export function groundPct(value: number, span: number): string {
  return ((value / span) * 100).toFixed(4) + "%";
}

/**
 * The mosaic. Percentages of the wrapper, whose box is the svg's box, whose
 * aspect ratio is the viewBox's, so a percentage here is a viewBox unit there.
 */
export function groundLayerHtml(plan: GroundPlan): string {
  const fit = plan.fit;
  let imgs = "";
  for (let i = 0; i < plan.tiles.length; i++) {
    const t = plan.tiles[i];
    if (!t) continue;
    const style =
      "left:" +
      groundPct(t.left, fit.w) +
      ";top:" +
      groundPct(t.top, fit.h) +
      ";width:" +
      groundPct(t.size, fit.w) +
      ";height:" +
      groundPct(t.size, fit.h);
    imgs +=
      `<img class="gt" alt="" draggable="false" decoding="async" data-tile="${t.z}/${t.y}/${t.x}"` +
      ` src="${escapeHtml(t.url)}" style="${style}">`;
  }
  return `<div class="ground" aria-hidden="true" data-ground-z="${plan.z}" data-ground-tiles="${plan.tiles.length}">${imgs}</div>`;
}

/** Source and vintage, then the toggle. The vintage is stated as unknown, never implied. */
export function groundNoteHtml(plan: GroundPlan | null, on: boolean): string {
  if (!plan) return "";
  const label = GROUND_SOURCE_LABEL + ", " + GROUND_VINTAGE_NOTE;
  return (
    `<div class="gnote" data-ground-note="1"><span data-ground-source="1">${escapeHtml(label)}</span>` +
    `<button type="button" class="btn${on ? " on" : ""}" data-act="ground" data-ground-on="${on ? "1" : "0"}"` +
    ` onclick="window.__ss&&window.__ss.ground()">${GROUND_TOGGLE_LABEL}</button></div>`
  );
}

/**
 * The drawing with ground under it, or the drawing exactly as it renders today.
 * A null plan returns the svg untouched: no wrapper, no note, no toggle and no
 * tile url anywhere in the html.
 */
export function groundWrapHtml(svg: string, plan: GroundPlan | null, on: boolean): string {
  if (!svg || !plan) return svg;
  const layer = on ? groundLayerHtml(plan) : "";
  return `<div class="gwrap" data-ground="${on ? "on" : "off"}">${layer}${svg}</div>` + groundNoteHtml(plan, on);
}

/*
 * P-91 v3 M-4: more than one parcel on one canvas.
 *
 * Each parcel's ring arrives in its OWN local foot frame, origin at that
 * parcel's own centroid, so two rings drawn straight from the wire stack on one
 * point. The anchor is what breaks the tie: M-1 puts a real latitude and
 * longitude on each single-id read and M-4 puts one on each row of a node
 * array, and two rings composed from their own anchors land in correct relative
 * position by construction. Nobody invents a shared origin: the origin IS the
 * first drawable parcel's anchor, a coordinate that was read.
 *
 * There is no new projection here and no second copy of the fit. The parcels
 * are composed into ONE foot frame and handed to ringFit, ringPixel and
 * groundPlan, the same three functions that place a single parcel. That is why
 * the ground registers with the rings: it is the same arithmetic, not a second
 * arithmetic kept in step.
 *
 * The honesty rules are the point of the card. A parcel that cannot be drawn is
 * NAMED with its reason beside the canvas and never omitted. Fewer than two
 * drawable parcels is no canvas at all. A set too wide for the imagery gets its
 * rings and no ground, with the threshold stated. Nothing here counts anything
 * as coverage, averages a position, or calls a bounding box a location.
 */

/** Two rings are the smallest thing that can show relative position. One is a parcel. */
export const MULTI_MIN_DRAWN = 2;

/**
 * The widest set extent, in feet, the aerial ground is painted under. One mile.
 *
 * Two independent reasons, and this is the smaller of the two bounds, so it
 * binds first and the refusal can be stated in feet rather than surfacing as a
 * tile count nobody can interpret.
 *
 * Legibility. The drawing area is 264 viewBox units wide (320 less two 28 unit
 * pads). At a one mile extent a 120 foot frontage is 264 * 120 / 5280 = 6 units.
 * Below that a ring is a dot and imagery under dots is decoration.
 *
 * Imagery. At the zoom floor (GROUND_ZOOM_MIN) and Texas latitude the ground
 * resolution is about 8.3 m per map pixel, and a one mile extent mosaics in a
 * handful of tiles, well inside GROUND_MAX_TILES. So the tile cap is still
 * armed and still fails closed, but it is not what a user meets first.
 */
export const MULTI_GROUND_MAX_EXTENT_FT = 5280;

export const MULTI_GROUND_EXTENT_REASON = "multi_ground_extent";
export const MULTI_TOO_FEW_REASON = "multi_fewer_than_two_drawable";
export const MULTI_NO_PARCELS_REASON = "multi_no_parcels";

/** Reasons a parcel is named beside the canvas instead of drawn on it. */
export const MULTI_NO_RING = "no ring on the wire";
export const MULTI_NO_ANCHOR = "no anchor";
export const MULTI_ANCHOR_UNDECLARED = "no anchor read on the wire";

export const MULTI_UNDRAWN_TITLE = "Not on this canvas";
export const MULTI_DRAWN_TITLE = "On this canvas";
export const MULTI_CARD_TITLE = "parcel set";
export const MULTI_ANCHORS_READ = "Anchors read for";
export const MULTI_ANCHORS_NOT_READ = "not read";
export const MULTI_GROUND_TOO_WIDE_PREFIX = "Set spans more than";
export const MULTI_GROUND_TOO_WIDE_SUFFIX = "ft; rings drawn without imagery.";

/**
 * The zoom the composition arithmetic runs at. Web Mercator world pixels are
 * exactly proportional to 2**z, so the composed frame has the same shape at
 * every level and this choice cannot change a relative position. It is fixed
 * only so the numbers are reproducible.
 */
export const MULTI_REF_ZOOM = GROUND_ZOOM_MAX;

export type PlacedParcel = {
  parcelNodeId: string;
  label: string;
  /** The ring in viewBox units of the SET's fit, not of its own. */
  vb: RingPt[];
  /** The parcel's own anchor in viewBox units. Where its label sits. */
  at: RingPt;
};

export type UndrawnParcel = { parcelNodeId: string; label: string; reason: string };

export type MultiPlan = {
  fit: RingFit;
  extentXFt: number;
  extentYFt: number;
  placed: PlacedParcel[];
  undrawn: UndrawnParcel[];
  /** Null exactly when groundReason is set. Never both, never neither. */
  ground: GroundPlan | null;
  groundReason: string | null;
};

export type MultiOutcome = { multi: MultiPlan | null; reason: string | null };

/** How the wire's read reads in a sentence beside the canvas. */
export function anchorReadWords(read: PanelAnchorRead | null): string {
  if (!read) return MULTI_ANCHOR_UNDECLARED;
  return read.reason ? read.status + ": " + read.reason : read.status;
}

/**
 * Why a parcel cannot go on the canvas, or null when it can. Both reasons are
 * reported when both apply: a row that has neither a ring nor an anchor is two
 * separate absences and naming one of them hides the other.
 */
export function undrawnReason(p: PanelParcel): string | null {
  const parts: string[] = [];
  if (!p.returned) parts.push(NOT_RETURNED);
  if (!p.ring || p.ring.length < 3) parts.push(MULTI_NO_RING);
  if (!p.anchor) parts.push(MULTI_NO_ANCHOR + " (" + anchorReadWords(p.anchorRead) + ")");
  return parts.length > 0 ? parts.join("; ") : null;
}

/** The one predicate. The parser and the plan ask the same question of the same function. */
export function multiDrawableCount(parcels: PanelParcel[]): number {
  let n = 0;
  for (let i = 0; i < parcels.length; i++) {
    const p = parcels[i];
    if (p && undrawnReason(p) === null) n++;
  }
  return n;
}

/** The sentence under a canvas whose set is too wide for the imagery to mean anything. */
export function multiGroundReasonWords(reason: string): string {
  if (reason === MULTI_GROUND_EXTENT_REASON) {
    return (
      MULTI_GROUND_TOO_WIDE_PREFIX +
      " " +
      MULTI_GROUND_MAX_EXTENT_FT +
      " " +
      MULTI_GROUND_TOO_WIDE_SUFFIX
    );
  }
  return reason;
}

/**
 * Compose the drawable parcels into one foot frame and place them.
 *
 * The frame's origin is the FIRST drawable parcel's anchor, which is a read
 * coordinate. It is never a mean of the anchors and never a bounding box
 * centre: an invented point would be indistinguishable from a read one once it
 * reached the fit, and there is no need for one.
 *
 * Each parcel's own feet are converted into reference feet by the ratio of the
 * two Mercator scales. Over a block that ratio is one to about seven decimal
 * places, and applying it costs nothing and is correct at any separation, so it
 * is applied rather than assumed away.
 */
export function multiParcelPlan(parcels: PanelParcel[]): MultiOutcome {
  if (!parcels || parcels.length === 0) return { multi: null, reason: MULTI_NO_PARCELS_REASON };
  const undrawn: UndrawnParcel[] = [];
  const drawable: Array<{ p: PanelParcel; anchor: PanelAnchor }> = [];
  for (let i = 0; i < parcels.length; i++) {
    const p = parcels[i];
    if (!p) continue;
    const why = undrawnReason(p);
    if (why !== null) {
      undrawn.push({ parcelNodeId: p.parcelNodeId, label: p.label, reason: why });
      continue;
    }
    const a = p.anchor;
    if (!a) {
      /* Unreachable while undrawnReason names a null anchor. Declared rather
       * than dropped, so a future edit that splits the two cannot lose a row. */
      undrawn.push({ parcelNodeId: p.parcelNodeId, label: p.label, reason: MULTI_NO_ANCHOR });
      continue;
    }
    drawable.push({ p: p, anchor: a });
  }
  if (drawable.length < MULTI_MIN_DRAWN) return { multi: null, reason: MULTI_TOO_FEW_REASON };

  const ref = drawable[0];
  if (!ref) return { multi: null, reason: MULTI_TOO_FEW_REASON };
  const refLat = ref.anchor.lat;
  const refLon = ref.anchor.lon;
  const refW = groundWorldPixel(refLat, refLon, MULTI_REF_ZOOM);
  const refPpf = groundPixelsPerFoot(refLat, MULTI_REF_ZOOM);
  if (!(refPpf > 0)) return { multi: null, reason: "multi_scale_unresolved" };

  const composed: RingPt[] = [];
  const frames: Array<{ p: PanelParcel; pts: RingPt[]; at: RingPt }> = [];
  for (let i = 0; i < drawable.length; i++) {
    const d = drawable[i];
    if (!d) continue;
    const w = groundWorldPixel(d.anchor.lat, d.anchor.lon, MULTI_REF_ZOOM);
    const ppf = groundPixelsPerFoot(d.anchor.lat, MULTI_REF_ZOOM);
    /* World pixel y grows SOUTHWARD and the draw frame's y is true north, so
     * the north component inverts here. Dropping this inversion mirrors every
     * parcel about the reference and still looks like a plausible block. */
    const at: RingPt = { x: (w.wx - refW.wx) / refPpf, y: -(w.wy - refW.wy) / refPpf };
    const scale = ppf / refPpf;
    const pts: RingPt[] = [];
    for (let j = 0; j < d.p.ring.length; j++) {
      const q = d.p.ring[j];
      if (!q) continue;
      const c: RingPt = { x: at.x + q.x * scale, y: at.y + q.y * scale };
      pts.push(c);
      composed.push(c);
    }
    frames.push({ p: d.p, pts: pts, at: at });
  }

  const fit = ringFit(composed);
  if (!fit) return { multi: null, reason: "multi_no_ring" };

  const placed: PlacedParcel[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (!f) continue;
    const vb: RingPt[] = [];
    for (let j = 0; j < f.pts.length; j++) {
      const q = f.pts[j];
      if (!q) continue;
      vb.push(ringPixel(fit, q.x, q.y));
    }
    placed.push({
      parcelNodeId: f.p.parcelNodeId,
      label: f.p.label,
      vb: vb,
      at: ringPixel(fit, f.at.x, f.at.y),
    });
  }

  const extentXFt = fit.maxX - fit.minX;
  const extentYFt = fit.maxY - fit.minY;
  let ground: GroundPlan | null = null;
  let groundReason: string | null = null;
  if (Math.max(extentXFt, extentYFt) > MULTI_GROUND_MAX_EXTENT_FT) {
    groundReason = MULTI_GROUND_EXTENT_REASON;
  } else {
    /* The SAME constructor a single parcel's ground uses, on the composed ring
     * and the reference anchor. Its own ringFit call reproduces `fit`, so the
     * tiles and the rings are placed by one fit and cannot drift. */
    const outcome = groundPlan(composed, ref.anchor, { status: "ok", reason: null });
    ground = outcome.plan;
    groundReason = outcome.reason;
  }

  return {
    multi: {
      fit: fit,
      extentXFt: extentXFt,
      extentYFt: extentYFt,
      placed: placed,
      undrawn: undrawn,
      ground: ground,
      groundReason: groundReason,
    },
    reason: null,
  };
}

/**
 * M-4 item 4 (P-91 v3 operator walk). `.plbl`'s font is `--ss-fs-meta`,
 * 12.5px, set via CSS inside this SVG's own coordinate system: an SVG
 * text element's CSS font-size resolves in the SVG's user units, the same
 * units the viewBox and every ring/edge coordinate in this file are
 * already in, so 12.5 here is 12.5 of those units, not 12.5 CSS reference
 * pixels of whatever width the host renders the panel at. ui-monospace and
 * Consolas average close to 0.6em advance width per character; MULTI_LABEL_H
 * is font-size plus a small margin for descenders and the declutter gap.
 */
export const MULTI_LABEL_CHAR_W = 7.5;
export const MULTI_LABEL_H = 14;
/** Vertical step a colliding label is pushed down by. */
export const MULTI_LABEL_STEP = MULTI_LABEL_H + 3;
/** Bound on how many times one label is pushed before the loop gives up and
 * leaves it where it landed: a crowded label is legible, an infinite loop
 * is not, and a label pushed off the bottom of the canvas is worse than
 * either -- see the clamp in resolveLabelPositions below. */
export const MULTI_LABEL_MAX_PUSH = 8;

/**
 * M-4 item 4. Every parcel keeps its own full label; none is ever dropped
 * to solve a collision (an unlabelled ring is worse than a crowded one,
 * because the reader can no longer tell which parcel they are looking at).
 * A label whose estimated box would overlap one already placed is pushed
 * straight down, in fixed steps, until it clears every label placed before
 * it, the push bound is reached, or it would leave the viewBox, whichever
 * comes first. `placed[i].at` (the true anchor, used for the ring and the
 * click target) is never altered; this returns where the TEXT sits, one
 * point per input parcel, same order, same length.
 */
export function resolveLabelPositions(placed: PlacedParcel[], fit: RingFit): RingPt[] {
  type LabelBox = { minX: number; maxX: number; minY: number; maxY: number };
  const boxAt = (id: string, at: RingPt): LabelBox => {
    const halfW = (id.length * MULTI_LABEL_CHAR_W) / 2;
    return { minX: at.x - halfW, maxX: at.x + halfW, minY: at.y - MULTI_LABEL_H, maxY: at.y };
  };
  const overlap = (a: LabelBox, b: LabelBox): boolean =>
    a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
  const maxY = fit.h - fit.pad;
  const boxes: LabelBox[] = [];
  const out: RingPt[] = [];
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i];
    if (!p) {
      out.push({ x: 0, y: 0 });
      continue;
    }
    let at = p.at;
    let box = boxAt(p.parcelNodeId, at);
    let pushes = 0;
    while (
      pushes < MULTI_LABEL_MAX_PUSH &&
      at.y + MULTI_LABEL_STEP <= maxY &&
      boxes.some((b) => overlap(box, b))
    ) {
      at = { x: at.x, y: at.y + MULTI_LABEL_STEP };
      box = boxAt(p.parcelNodeId, at);
      pushes++;
    }
    boxes.push(box);
    out.push(at);
  }
  return out;
}

/**
 * The canvas. One polygon per drawn parcel in its correct relative position,
 * each labelled with its node id and each clickable. The click drafts the
 * ordinary Open turn through the existing handler: nothing is fetched behind
 * the user's back, and there is no second open path to keep in step.
 *
 * Item 4: the label TEXT is placed at resolveLabelPositions's declutter
 * point, not always the raw anchor; a thin leader line ties a displaced
 * label back to its ring whenever the two differ, so a pushed-down label
 * cannot be misread as belonging to whichever ring it now sits nearest.
 */
export function multiCanvasSvg(m: MultiPlan): string {
  let out = "";
  const labelAt = resolveLabelPositions(m.placed, m.fit);
  for (let i = 0; i < m.placed.length; i++) {
    const p = m.placed[i];
    if (!p) continue;
    let pts = "";
    for (let j = 0; j < p.vb.length; j++) {
      const q = p.vb[j];
      if (!q) continue;
      pts += (j > 0 ? " " : "") + q.x.toFixed(1) + "," + q.y.toFixed(1);
    }
    const id = escapeHtml(p.parcelNodeId);
    const lp = labelAt[i] ?? p.at;
    const moved = lp.x !== p.at.x || lp.y !== p.at.y;
    const leader = moved
      ? '<line class="pll" x1="' + p.at.x.toFixed(1) + '" y1="' + p.at.y.toFixed(1) + '"' +
        ' x2="' + lp.x.toFixed(1) + '" y2="' + lp.y.toFixed(1) + '"/>'
      : "";
    out +=
      '<g class="pset" data-parcel="' + id + '">' +
      '<polygon class="ring-fill" points="' + pts + '" fill="var(--ss-void)" fill-opacity=".55" stroke="var(--ss-t3)" stroke-width="2"/>' +
      '<polygon class="phit" data-act="open" data-node="' + id + '" points="' + pts + '"' +
      ' onclick="window.__ss&&window.__ss.open(this)"><title>' + escapeHtml(p.label) + "</title></polygon>" +
      leader +
      '<text class="plbl" data-label-moved="' + (moved ? "1" : "0") + '" x="' + lp.x.toFixed(1) + '" y="' + lp.y.toFixed(1) + '" text-anchor="middle">' + id + "</text>" +
      "</g>";
  }
  return (
    '<svg class="ring set" viewBox="0 0 ' + m.fit.w + " " + m.fit.h + '" aria-label="parcel set"' +
    ' data-parcels="' + m.placed.length + '">' + out + "</svg>"
  );
}

/** Every parcel that IS on the canvas, named in full with its own Open. */
export function multiDrawnHtml(placed: PlacedParcel[]): string {
  if (placed.length === 0) return "";
  let rows = "";
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i];
    if (!p) continue;
    const id = escapeHtml(p.parcelNodeId);
    rows +=
      '<div class="pcell" data-drawn="' + id + '"><span class="pn atom">' + id + "</span> " +
      '<span class="lbl">' + escapeHtml(p.label) + "</span> " +
      '<button type="button" class="btn" data-act="open" data-node="' + id + '"' +
      ' onclick="window.__ss&&window.__ss.open(this)">Open</button></div>';
  }
  return '<div class="pset-list"><div class="req">' + MULTI_DRAWN_TITLE + " (" + placed.length + ")</div>" + rows + "</div>";
}

/**
 * Every parcel that is NOT on the canvas, named with its reason. This list is
 * the card: a canvas that quietly shows four of seven is the defect, and the
 * only thing that stops it is an enumeration of the other three.
 *
 * M-5: the title is a parameter because the SAME list is now painted in a
 * second place, under a panel with no canvas at all. One renderer, two titles,
 * so a fix to the row shape cannot reach one caller and miss the other. The
 * parameter is optional rather than defaulted: a default value would be a
 * second place the canvas title is written.
 */
export function multiUndrawnHtml(list: UndrawnParcel[], title?: string): string {
  if (list.length === 0) return "";
  const head = title ? title : MULTI_UNDRAWN_TITLE;
  let rows = "";
  for (let i = 0; i < list.length; i++) {
    const u = list[i];
    if (!u) continue;
    rows +=
      '<div class="pcell" data-undrawn="' + escapeHtml(u.parcelNodeId) + '">' +
      '<span class="pn atom">' + escapeHtml(u.parcelNodeId) + "</span> " +
      '<span class="lbl">' + escapeHtml(u.label) + "</span> " +
      '<span class="reason">' + escapeHtml(u.reason) + "</span></div>";
  }
  return '<div class="pset-list"><div class="req">' + escapeHtml(head) + " (" + list.length + ")</div>" + rows + "</div>";
}

/** Why there is no ground under this canvas. Empty when there is one. */
export function multiGroundNoteHtml(m: MultiPlan): string {
  if (!m.groundReason) return "";
  return (
    '<div class="gnote" data-ground-refused="' + escapeHtml(m.groundReason) + '"' +
    ' data-extent-ft="' + Math.round(Math.max(m.extentXFt, m.extentYFt)) + '">' +
    escapeHtml(multiGroundReasonWords(m.groundReason)) + "</div>"
  );
}

/**
 * The truncation, stated. Silent when nothing truncated, because there is
 * nothing to declare; loud the moment one parcel went unread.
 */
export function anchorBatchNoteHtml(b: PanelAnchorBatch | null): string {
  if (!b || b.notAttempted <= 0) return "";
  return (
    '<div class="fnote" data-anchor-attempted="' + b.attempted + '"' +
    ' data-anchor-not-read="' + b.notAttempted + '"' +
    ' data-anchor-cap="' + b.cap + '">' +
    MULTI_ANCHORS_READ + " " + b.attempted + " of " + b.received + "; " +
    b.notAttempted + " " + MULTI_ANCHORS_NOT_READ +
    (b.reason ? " (" + escapeHtml(b.reason) + ")" : "") + "</div>"
  );
}

/** The whole set: canvas over ground, then who is on it, then who is not. */
export function renderParcelSet(
  model: Pick<PanelModel, "parcels" | "anchorBatch">,
  groundOn?: boolean,
): string {
  const outcome = multiParcelPlan(model.parcels ?? []);
  const m = outcome.multi;
  if (!m) return "";
  const drawn = groundWrapHtml(multiCanvasSvg(m), m.ground, groundOn === undefined ? true : groundOn);
  return (
    drawn +
    multiGroundNoteHtml(m) +
    anchorBatchNoteHtml(model.anchorBatch ?? null) +
    multiDrawnHtml(m.placed) +
    multiUndrawnHtml(m.undrawn)
  );
}

/*
 * P-91 v3 M-5 item 1: what could not be drawn is named whether or not there is
 * a canvas.
 *
 * M-4 shipped the naming CONDITIONAL on the canvas existing. Below two drawable
 * parcels the parser hands the body to the single parcel branch, that branch
 * paints parcels[0] alone, and the other rows were named nowhere. A seven parcel
 * result with one drawable parcel said nothing at all about the other six, which
 * is the exact silent omission M-4 exists to end, surviving inside M-4's own
 * fallback.
 *
 * The rule here is not "name the undrawable ones". It is: every parcel the
 * result carried that this panel did not draw is named with a reason. That
 * covers the case the narrower rule misses, where parcels[0] is itself
 * undrawable and a DRAWABLE parcel further down the array is the one going
 * unnamed. Both are omissions and only one of them is an undrawable row.
 */

/** The list's title when there is no canvas. Not the canvas title: there is no canvas. */
export const MULTI_OFF_CANVAS_TITLE = "Not drawn here";

/** Why a drawable parcel is still not drawn: this panel drew a different one and there is no canvas. */
export const MULTI_NO_CANVAS = "drawable; no canvas under " + MULTI_MIN_DRAWN + " drawable parcels";

export const MULTI_NO_CANVAS_PREFIX = "No canvas:";
export const MULTI_NO_CANVAS_DRAWABLE = "parcels could be drawn;";
export const MULTI_NO_CANVAS_NEEDED = "are needed.";

/** "No canvas: 1 of 7 parcels could be drawn; 2 are needed." */
export function multiNoCanvasWords(drawable: number, total: number): string {
  return (
    MULTI_NO_CANVAS_PREFIX + " " + drawable + " of " + total + " " +
    MULTI_NO_CANVAS_DRAWABLE + " " + MULTI_MIN_DRAWN + " " + MULTI_NO_CANVAS_NEEDED
  );
}

export function multiNoCanvasNoteHtml(drawable: number, total: number): string {
  return (
    '<div class="gnote" data-no-canvas="' + drawable + '" data-parcels-in-result="' + total + '">' +
    escapeHtml(multiNoCanvasWords(drawable, total)) + "</div>"
  );
}

/**
 * Every parcel this panel did not draw, with why. `shownId` is the parcel the
 * single parcel panel painted; it is excluded ONLY when it actually has a ring
 * and an anchor, because a shown parcel that could not be drawn is still a
 * parcel nobody can see and has to be named like the rest.
 *
 * undrawnReason is the same predicate multiDrawableCount and multiParcelPlan
 * ask. There is no second definition of drawable here.
 */
export function offCanvasParcels(parcels: PanelParcel[], shownId: string | null): UndrawnParcel[] {
  const out: UndrawnParcel[] = [];
  for (let i = 0; i < parcels.length; i++) {
    const p = parcels[i];
    if (!p) continue;
    const why = undrawnReason(p);
    if (why === null && p.parcelNodeId === shownId) continue;
    out.push({
      parcelNodeId: p.parcelNodeId,
      label: p.label,
      reason: why === null ? MULTI_NO_CANVAS : why,
    });
  }
  return out;
}

/**
 * The block a single parcel panel carries when its result held more than one
 * parcel. Silent on a genuine single parcel result, because there is nothing
 * omitted to declare.
 */
export function offCanvasHtml(
  model: Pick<PanelModel, "parcels" | "anchorBatch" | "parcelNodeId">,
): string {
  const parcels = model.parcels ? model.parcels : [];
  if (parcels.length < 2) return "";
  const others = offCanvasParcels(parcels, model.parcelNodeId ? model.parcelNodeId : null);
  return (
    multiNoCanvasNoteHtml(multiDrawableCount(parcels), parcels.length) +
    anchorBatchNoteHtml(model.anchorBatch ? model.anchorBatch : null) +
    multiUndrawnHtml(others, MULTI_OFF_CANVAS_TITLE)
  );
}

/*
 * P-91 v3 M-5 item 2: the paint only preview channel.
 *
 * The panel already holds every parcel in its own result. The one thing it does
 * NOT hold is the neighbour a shared boundary edge names: the edge carries a
 * `neighbor` id and nothing else about that parcel. Learning anything about it
 * costs a conversation turn. So a dwell on a door tooltip may read that
 * neighbour's stub rails through an app initiated tools/call and paint them,
 * and ONLY paint them.
 *
 * Two invariants, both mechanised below and in htmlContractViolations:
 *
 * 1. A paint only result never claims to be in the conversation. The block is
 *    visually distinct from tool result facts (its own class, its own rule) and
 *    carries an explicit line saying it was not sent to the chat. Every state
 *    carries that line, so it cannot be lost by taking one branch.
 *
 * 2. Anything acted on still drafts a turn. The Open and Add to screen controls
 *    in the door tooltip are untouched: they draft the ordinary ui/message and
 *    the user still sends it. Nothing here populates, pre-fills, or shortcuts a
 *    turn, and the preview is never an argument to one.
 *
 * Fail closed is the whole difficulty. serverTools is UNMEASURED: the p559 probe
 * measured resources/read, which is a different method. So every path where the
 * channel does not work states that no preview is available and why, in one
 * line, and emits no rail glyph at all. An empty rail set would be
 * indistinguishable from a parcel with no data, which is the confusion this
 * program exists to prevent.
 */

/** The tool the preview reads. Already in APP_HOST_TOOLS; the catalog stays at 13. */
export const PREVIEW_TOOL = "get_smart_site";
/** An array argument reads at stub depth. Stated rather than defaulted. */
export const PREVIEW_DEPTH = "stub";

/**
 * Dwell before a preview fires, in ms. A pointer crossing an edge on its way
 * somewhere else is on it for well under 200 ms; a hover held past 350 ms is a
 * decision. Below that the panel would call on transit, which is the behaviour
 * the card refuses.
 */
export const PREVIEW_DWELL_MS = 350;

/**
 * How long a preview waits before it declares itself unanswered, in ms. Shorter
 * than the p559 probe's 6000 and much shorter than OPEN_DEAD_MS, because those
 * two wait on a panel a user is looking at, while this waits on a tooltip a
 * user is holding a pointer over. Past about four seconds the hover is gone and
 * a late answer would paint into a tooltip that no longer asked.
 */
export const PREVIEW_TIMEOUT_MS = 4000;

export const PREVIEW_TITLE = "Preview of";
/** Invariant 1, in one sentence, on every state. */
export const PREVIEW_NOT_IN_CHAT = "Not sent to the chat. Claude cannot see this.";
export const PREVIEW_PENDING = "Reading stub rails.";
export const PREVIEW_UNSUPPORTED = "No preview available: this host does not offer app tool calls.";
export const PREVIEW_TIMED_OUT = "No preview available: the tool call did not answer in time.";
export const PREVIEW_ERROR = "No preview available: the tool call returned an error";
export const PREVIEW_DECLINED = "No preview available: the tool declined this read.";
export const PREVIEW_EMPTY = "No preview available: the result carried no rails for this parcel.";
export const PREVIEW_BUSY = "No preview available: another preview is still open.";
/** Fail closed on a state word nothing above names. Never an empty block. */
export const PREVIEW_UNSTATED = "No preview available: state not stated.";

/** One short line per state. Never blank: a blank line is a silent nothing. */
export function previewLine(state: string, code: string | null): string {
  if (state === "pending") return PREVIEW_PENDING;
  if (state === "unsupported") return PREVIEW_UNSUPPORTED;
  if (state === "timeout") return PREVIEW_TIMED_OUT;
  if (state === "busy") return PREVIEW_BUSY;
  if (state === "declined") return PREVIEW_DECLINED;
  if (state === "empty") return PREVIEW_EMPTY;
  if (state === "error") return code ? PREVIEW_ERROR + " " + code : PREVIEW_ERROR + ".";
  return PREVIEW_UNSTATED;
}

/** The six rails, as glyphs, from the row the same parser produced. */
export function previewRailsHtml(row: Pick<BoardRow, "rails">): string {
  let out = "";
  for (let i = 0; i < RAILS.length; i++) {
    const k = RAILS[i];
    if (!k) continue;
    const s = railState(row.rails[k]);
    out +=
      '<span class="pvr"><span class="g ' + glyphClass(s) + '" title="' + escapeHtml(s) + '"></span>' +
      escapeHtml(k) + "</span>";
  }
  return out;
}

/**
 * The block itself. Rails paint under exactly one condition, "ok" with a row;
 * every other state paints one stated line and NO glyph. There is no third
 * branch, so there is no path that renders an empty rail set.
 */
export function previewBlockHtml(
  node: string,
  state: string,
  row: Pick<BoardRow, "rails"> | null,
  code: string | null,
): string {
  const id = escapeHtml(node);
  const drawn = state === "ok" && row ? true : false;
  const body = drawn && row
    ? '<span class="pvrails">' + previewRailsHtml(row) + "</span>"
    : '<span class="pvmiss">' + escapeHtml(previewLine(state, code)) + "</span>";
  return (
    '<span class="pv" data-preview="' + id + '" data-preview-state="' + escapeHtml(state) + '">' +
    '<span class="pvt">' + PREVIEW_TITLE + " " + id + "</span>" + body +
    '<span class="pvnote">' + PREVIEW_NOT_IN_CHAT + "</span></span>"
  );
}

/**
 * The neighbour's row out of a tools/call result, through the SAME parser the
 * panel uses on a tool result it was handed. A body that does not parse as a
 * board, or that carries no row for the id asked for, is no row at all: the
 * caller states an absence rather than painting a shape.
 */
export function previewRowFrom(result: unknown, node: string): BoardRow | null {
  const m = parseToolContent(result);
  if (m.kind !== "board") return null;
  for (let i = 0; i < m.rows.length; i++) {
    const r = m.rows[i];
    if (r && r.parcelNodeId === node) return r;
  }
  return null;
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

/**
 * F6 and F5 for a section: present needs an as-of; absent needs a known
 * vintage on its data to earn absent-verified, else it paints the more
 * conservative unknown; a word off the wire's six paints unread.
 *
 * P-91 v3 item 1. `unknown` and `absent-verified` are now wire words a
 * section can claim directly (tool-honesty.ts sectionDisposition), and both
 * are trusted as claimed, not re-earned here: `absent`'s vintage check
 * exists because a bare `absent` is a WEAK claim the panel independently
 * verifies before it will paint the stronger absent-verified; a section
 * that already claims `absent-verified` is claiming the stronger state
 * itself, and re-deriving over a claim this union recognises is exactly the
 * strengthen-by-discarding defect item 1 fixed on the wire side. `unknown`
 * has nothing to earn -- it is already the most conservative paint there
 * is -- so it passes straight through too.
 */
export function sectionPaint(
  disposition: string,
  asOf: string | null,
  data: Record<string, unknown> | null,
): { paint: CellState; paintReason?: string } {
  if (disposition === "present") return asOf ? { paint: "present" } : { paint: "unknown", paintReason: AS_OF_MISSING };
  if (disposition === "refused") return { paint: "refused" };
  if (disposition === "unread") return { paint: "unread" };
  if (disposition === "unknown") return { paint: "unknown" };
  if (disposition === "absent-verified") return { paint: "absent-verified" };
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

/**
 * R1 (fork 3.1 narrow): every section in wire order with title, glyph and
 * word, as-of, source, citation control, guidance. No values, no prose.
 *
 * P-91 v3 item 2 exception, flood only. Zone X shaded (0.2% annual-chance
 * band) and Zone X unshaded (minimal flood hazard) both carry disposition
 * present and, until now, this row painted them identically: same glyph,
 * same word "present", nothing else. Those are two materially different
 * findings, and this is the one row every depth-node caller reads, not the
 * facts card under the drawing (floodFactsHtml) which only ever shows for
 * a caller who opens the panel and scrolls to it. The fix carries the
 * source's own classification word, `data.zoneSubtype`, next to the state
 * word on the flood row only -- not a ranking, not a computed risk level,
 * the same string floodFactsHtml already prints, read the same way.
 */
export function reportHtml(sections: BriefSection[]): string {
  if (sections.length === 0) return `<div class="report" data-report="1"><p class="empty">${NO_BRIEF}</p></div>`;
  const rows = sections
    .map((s, i) => {
      const reason = s.reason ? s.reason : s.refusal && s.refusal.reason ? s.refusal.reason : null;
      const cites = citationHtml(s.citations, s.citationsDegraded);
      const ask = whyControlHtml("section", s.paint, { i: String(i) });
      const note = s.paintReason ? reasonLineHtml("note", s.paintReason, `data-paint-reason="${escapeHtml(s.paintReason)}"`) : "";
      const guide = s.agentGuidance ? `<div class="guide" data-agent-guidance="1">${escapeHtml(s.agentGuidance)}</div>` : "";
      const subtype = s.id === "flood" && s.paint === "present" ? stringOrNull(s.data ? s.data.zoneSubtype : null) : null;
      const subtypeHtml = subtype
        ? ` <span class="fsub" data-flood-subtype="${escapeHtml(subtype)}">${escapeHtml(subtype)}</span>`
        : "";
      return `<div class="rsec" data-report-section="${escapeHtml(s.id)}" data-report-state="${s.paint}"><span class="g ${glyphClass(s.paint)}" title="${stateWord(s.paint)}"></span> <span class="rt">${escapeHtml(s.title)}</span> <span class="sw">${stateWord(s.paint)}</span>${subtypeHtml}${cites ? ` ${cites}` : ""}${ask ? ` ${ask}` : ""}${metaHtml(s.asOf, sourceOf(s))}${reason ? reasonLineHtml("reason", reason) : ""}${note}${guide}</div>`;
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

/*
 * P-91 v2 board (S8). Candidates, declared degradation, the reopen picker,
 * county groups, the completeness order and the declared bodies. Same rule
 * as S7: every function here is embedded by source (INLINE_SHARED), so no
 * spread and nothing that needs a transpiler helper; every slot painted is
 * a wire field or a literal fallback word.
 */

export function countyFipsOf(id: string | null | undefined): string | null {
  const m = typeof id === "string" ? /^(\d{5}):/.exec(id.trim()) : null;
  return m && m[1] ? m[1] : null;
}

export type BoardGroup = { fips: string | null; title: string | null; rows: BoardRow[] };

/** B4: one group per county prefix when there is more than one, in fips order; unresolved rows last; one county paints no group. */
export function boardGroups(rows: BoardRow[]): { grouped: boolean; groups: BoardGroup[] } {
  const byFips: Record<string, BoardRow[]> = {};
  const order: string[] = [];
  const loose: BoardRow[] = [];
  for (const r of rows) {
    const f = countyFipsOf(r.parcelNodeId);
    if (!f) {
      loose.push(r);
      continue;
    }
    let list = byFips[f];
    if (!list) {
      list = [];
      byFips[f] = list;
      order.push(f);
    }
    list.push(r);
  }
  if (order.length < 2) return { grouped: false, groups: [{ fips: null, title: null, rows }] };
  order.sort();
  const groups: BoardGroup[] = [];
  for (const f of order) {
    const name = COUNTY_BY_FIPS[f];
    groups.push({ fips: f, title: typeof name === "string" ? name : f, rows: byFips[f] || [] });
  }
  if (loose.length > 0) groups.push({ fips: null, title: UNRESOLVED_GROUP, rows: loose });
  return { grouped: true, groups };
}

/** B5: how many rails are present on a row. Orders rows only; never painted (I2). */
export function knownRank(row: Pick<BoardRow, "rails">): number {
  let n = 0;
  for (const rail of RAILS) if (row.rails[rail] === "present") n += 1;
  return n;
}

/** B5: a new array; completeness is fewest present first with ties by query; query and id are the v1 sorts. */
export function sortBoardRows(rows: BoardRow[], key: string, dir: number): BoardRow[] {
  const out = rows.slice();
  out.sort((a, b) => {
    if (key === "completeness") {
      const d = knownRank(a) - knownRank(b);
      if (d !== 0) return d * dir;
      return a.query < b.query ? -1 : a.query > b.query ? 1 : 0;
    }
    const av = key === "id" ? a.parcelNodeId || "" : a.query;
    const bv = key === "id" ? b.parcelNodeId || "" : b.query;
    return av < bv ? -dir : av > bv ? dir : 0;
  });
  return out;
}

/** B1: the draft names the chosen node and the query it answers; the screen is the one Claude holds. */
export function useCandidateMessage(node: string, query: string): string {
  return `Add ${node} to this screen with add_to_screen, source pasted. It is the parcel for "${query}". Do not save it.`;
}

export function lookupMessage(query: string): string {
  return `Run find_parcel for "${query}". Do not add anything to a screen yet.`;
}

/** B3: a reopen is an Open on a screen; it never creates one. */
export function reopenScreenMessage(id: string): string {
  return `Reopen screen ${id} with list_screens. Do not create a new screen.`;
}

/** B1: a forged control drafts nothing; the candidate must sit on the ambiguous row the panel painted for that query. */
export function candidateFor(model: Pick<PanelModel, "rows">, node: string | null, query: string | null): ScreenCandidate | null {
  if (!node || query === null) return null;
  for (const r of model.rows) {
    if (r.query !== query || r.resolution !== "ambiguous" || !r.candidates) continue;
    for (const c of r.candidates) if (c.parcelNodeId === node) return c;
  }
  return null;
}

/** B1: only a situs that resolved to nothing is looked up; a node id that is not on file is not a search. */
export function lookupRowFor(model: Pick<PanelModel, "rows">, query: string | null): BoardRow | null {
  if (query === null) return null;
  for (const r of model.rows) {
    if (r.query === query && r.parcelNodeId === null && !(r.candidates && r.candidates.length > 0) && !looksLikeParcelNodeId(r.query)) return r;
  }
  return null;
}

export function screenSummaryFor(model: Pick<PanelModel, "screens">, id: string | null): ScreenSummary | null {
  if (!id) return null;
  for (const s of model.screens ? model.screens : []) if (s.id === id) return s;
  return null;
}

/** B1: the candidates of an ambiguous row, each with Use this; the row itself gets no Open and nothing is picked. County only when the wire carries it. */
export function candidateControlsHtml(row: Pick<BoardRow, "query" | "resolution" | "candidates">): string {
  if (row.resolution !== "ambiguous" || !row.candidates || row.candidates.length === 0) return "";
  let items = "";
  for (const c of row.candidates) {
    const fips = c.countyFips ? c.countyFips : null;
    const named = fips ? COUNTY_BY_FIPS[fips] : undefined;
    const county = fips ? `<span class="mono" data-candidate-county="${escapeHtml(fips)}">${escapeHtml(typeof named === "string" ? named : fips)}</span>` : "";
    items += `<div class="cand" data-candidate="${escapeHtml(c.parcelNodeId)}"><span class="pn atom">${escapeHtml(c.parcelNodeId)}</span> <span class="lbl">${escapeHtml(c.label)}</span>${county ? ` ${county}` : ""} <button type="button" class="btn" data-act="usecand" data-node="${escapeHtml(c.parcelNodeId)}" data-query="${escapeHtml(row.query)}" onclick="window.__ss&&window.__ss.useCandidate(this)">${USE_THIS_LABEL}</button></div>`;
  }
  return `<div class="cands" data-candidates="${escapeHtml(row.query)}">${items}</div>`;
}

/** B1: an unresolved situs offers a lookup beside the slot; a node id that is not on file offers nothing. */
export function lookupControlHtml(row: Pick<BoardRow, "query" | "parcelNodeId" | "candidates">): string {
  if (row.parcelNodeId || (row.candidates && row.candidates.length > 0) || looksLikeParcelNodeId(row.query)) return "";
  return `<button type="button" class="btn" data-act="lookup" data-query="${escapeHtml(row.query)}" onclick="window.__ss&&window.__ss.lookup(this)">${LOOK_UP_LABEL}</button>`;
}

/** B2: a row whose stub was not read says so beside the query; ok and absent say nothing. */
export function stubReadNoteHtml(row: Pick<BoardRow, "stubRead">): string {
  if (row.stubRead !== "error" && row.stubRead !== "skipped") return "";
  return reasonLineHtml(STUB_READ_NOTE, row.stubRead, `data-stub-read="${row.stubRead}"`);
}

/** B2: one note per declared duplicate and per timed-out query. Every slot is the wire's; the sentence is the panel's. */
export function degradedNotesHtml(degraded: ScreenDegraded | null | undefined): string {
  if (!degraded) return "";
  let out = "";
  for (const d of degraded.duplicates ? degraded.duplicates : []) {
    out += `<p class="note" data-duplicate="${escapeHtml(d.parcelNodeId)}">"${escapeHtml(d.query)}" ${DUP_SAME_PARCEL} "${escapeHtml(d.keptQuery)}" (${escapeHtml(d.parcelNodeId)}); ${DUP_NOT_ADDED}</p>`;
  }
  for (const q of degraded.timedOut ? degraded.timedOut : []) {
    out += `<p class="note" data-timed-out="${escapeHtml(q)}">"${escapeHtml(q)}" ${TIMED_OUT_NOTE}</p>`;
  }
  return out;
}

/** B3: newest first (ordered at parse); name, the row count only when carried, the updated date; one Open per screen. */
export function screensListHtml(screens: ScreenSummary[]): string {
  if (screens.length === 0) return `<p class="empty" data-screens="none"><b>${NO_SCREENS_YET}</b>${NO_SCREENS_BODY}</p>`;
  let out = "";
  for (const s of screens) {
    const count = typeof s.rowCount === "number" ? `<span class="mono" data-row-count="${s.rowCount}">${s.rowCount} ${s.rowCount === 1 ? "row" : "rows"}</span>` : "";
    const updated = dateOnly(s.updatedAt);
    const when = updated ? `<span class="mono" data-updated="${escapeHtml(updated)}"><span class="key">updated</span> ${escapeHtml(updated)}</span>` : "";
    out += `<div class="scr" data-screen="${escapeHtml(s.id)}"><span class="pl">${escapeHtml(s.name)}</span> <span class="pn">${escapeHtml(s.id)}</span>${count ? ` ${count}` : ""}${when ? ` ${when}` : ""} <button type="button" class="btn" data-act="reopen" data-screen="${escapeHtml(s.id)}" onclick="window.__ss&&window.__ss.reopen(this)">Open</button></div>`;
  }
  return `<div class="screens" data-screens="list">${out}</div>`;
}

/** H1: one sentence per declared body, in the five-state language; nothing painted that the body does not carry. */
export function declaredLineHtml(d: DeclaredBody): string {
  const reason = d.reason ? d.reason : UNSTATED;
  const bits: string[] = [];
  let head = "";
  if (d.status === "error" && d.reason === UPGRADE_SCREENS_REASON) {
    /* A screens refusal arrives as an upstream non-ok, so its top-level status
     * is "error"; the capability is named by the reason, not inferred. Painted
     * as an upgrade prompt rather than as a failure, because it is neither a
     * fault nor a bare refusal: it is a rung the account does not hold. */
    head = UPGRADE_TO_SCREEN;
    if (typeof d.upstreamStatus === "number") bits.push(`<span class="mono" data-upstream-status="${d.upstreamStatus}">${UPSTREAM_KEY} ${d.upstreamStatus}</span>`);
    if (d.tier) bits.push(reasonLineHtml("tier", d.tier));
  } else if (d.status === "error" || d.status === "degraded") {
    head = `${NOT_RETURNED}: ${escapeHtml(reason)}`;
    if (typeof d.upstreamStatus === "number") bits.push(`<span class="mono" data-upstream-status="${d.upstreamStatus}">${UPSTREAM_KEY} ${d.upstreamStatus}</span>`);
    if (d.tool) bits.push(reasonLineHtml("tool", d.tool));
  } else if (d.status === "refused") {
    head = `${REFUSED_PREFIX}: ${escapeHtml(reason)}`;
    if (typeof d.cap === "number") bits.push(`<span class="mono" data-cap="${d.cap}">cap ${d.cap}</span>`);
    if (typeof d.received === "number") bits.push(`<span class="mono" data-received="${d.received}">received ${d.received}</span>`);
    if (d.depth) bits.push(reasonLineHtml("depth", d.depth));
  } else if (d.status === "not_implemented") {
    head = `${NOT_IMPLEMENTED_PREFIX}: ${escapeHtml(d.depth ? d.depth : reason)}`;
  } else if (d.status === "not_ready") {
    head = `${escapeHtml(d.tool ? d.tool : "This tool")} ${NOT_READY_INFIX}: ${escapeHtml(reason)}`;
  } else {
    head = UPGRADE_TO_OPEN;
    bits.push(reasonLineHtml("reason", reason));
    if (d.tier) bits.push(reasonLineHtml("tier", d.tier));
  }
  if (d.message) bits.push(reasonLineHtml("message", d.message));
  const brief = d.brief ? `<pre class="brief" data-brief="1">${escapeHtml(d.brief)}</pre>` : "";
  return `<div class="miss" data-declared="${d.status}" data-reason="${escapeHtml(reason)}"><b>${head}</b>${bits.join("")}${brief}</div>`;
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
  model: Pick<
    PanelModel,
    | "ring"
    | "edges"
    | "overlays"
    | "label"
    | "parcelNodeId"
    | "zoning"
    | "frame"
    | "sections"
    | "anchor"
    | "anchorRead"
    /* M-5: the rest of the result's parcels, so the panel can name what it did
     * not draw. Absent on a genuine single parcel result and silent then. */
    | "parcels"
    | "anchorBatch"
  >,
  groundOn?: boolean,
): string {
  const node = model.parcelNodeId
    ? `<div class="pn atom">${escapeHtml(model.parcelNodeId)}</div>`
    : "";
  const svg = ringSvg(model.ring ?? [], model.edges ?? [], {
    zoning: model.zoning ?? null,
    flood: floodOverlayOf(model.overlays),
    frame: model.frame ?? null,
  });
  /* M-2: ground under the drawing when the anchor was read, otherwise the svg
   * exactly as it renders with no anchor on the wire. */
  const drawn = groundWrapHtml(
    svg,
    groundPlan(model.ring ?? [], model.anchor ?? null, model.anchorRead ?? null).plan,
    groundOn === undefined ? true : groundOn,
  );
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
  return `${node}${model.label ? `<div class="pl">${escapeHtml(model.label)}</div>` : ""}${drawn}${tip}${edgeList}${rows}${floodFacts}${offCanvasHtml(model)}`;
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

/**
 * M-2: anchorRead is an OBJECT carrying one of four statuses, not a bare string.
 * A body whose anchorRead is a string, or carries a status outside the union, is
 * read as no declaration at all, which paints no ground.
 */
function anchorReadFrom(value: unknown): PanelAnchorRead | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const s = rec.status;
  if (s !== "ok" && s !== "absent" && s !== "error" && s !== "skipped") return null;
  return { status: s, reason: stringOrNull(rec.reason) };
}

/**
 * M-2: a coordinate is read only under an "ok" read, and only when both
 * components are finite, non zero and on the world. Anything else is no anchor,
 * which paints no ground rather than a placed guess.
 */
function anchorFrom(value: unknown, read: PanelAnchorRead | null): PanelAnchor | null {
  if (!read || read.status !== "ok") return null;
  const rec = asRecord(value);
  if (!rec) return null;
  const lat = numberOrNull(rec.lat);
  const lon = numberOrNull(rec.lon);
  if (lat === null || lon === null) return null;
  if (lat === 0 || lon === 0) return null;
  if (lat > 85 || lat < -85 || lon > 180 || lon < -180) return null;
  return { lat: lat, lon: lon, precision: stringOrNull(rec.precision), source: stringOrNull(rec.source) };
}

/**
 * M-4: the array's own declaration of what its anchor phase did. A body whose
 * anchorBatch is not an object with whole-number counts is read as no
 * declaration, which prints no truncation note rather than a made up one.
 */
function anchorBatchFrom(value: unknown): PanelAnchorBatch | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const cap = numberOrNull(rec.cap);
  const received = numberOrNull(rec.received);
  const attempted = numberOrNull(rec.attempted);
  const notAttempted = numberOrNull(rec.notAttempted);
  if (cap === null || received === null || attempted === null || notAttempted === null) return null;
  return {
    cap: cap,
    received: received,
    attempted: attempted,
    notAttempted: notAttempted,
    reason: stringOrNull(rec.reason),
  };
}

/**
 * M-4: every parcel a node-depth array returned, plus every id it did not.
 *
 * A row with no draw is KEPT with an empty ring, and a notFound id is kept with
 * `returned` false, because the whole point of the set view is that a parcel
 * which cannot be drawn is named rather than dropped. Filtering here is how a
 * canvas quietly shows four of seven.
 */
function parcelsFromBatch(rec: Record<string, unknown>): PanelParcel[] | null {
  if (!Array.isArray(rec.parcels)) return null;
  const out: PanelParcel[] = [];
  for (const raw of rec.parcels) {
    const row = asRecord(raw);
    if (!row) continue;
    const id = typeof row.parcelNodeId === "string" ? row.parcelNodeId : "";
    if (id.length === 0) continue;
    const draw = asRecord(row.draw);
    const label = draw && typeof draw.label === "string" && draw.label.length > 0 ? draw.label : id;
    const read = anchorReadFrom(row.anchorRead);
    out.push({
      parcelNodeId: id,
      label: label,
      ring: draw ? ringFromDraw(draw) : [],
      edges: draw ? edgesFromDraw(draw) : [],
      zoning: draw ? zoningFromDraw(draw, row) : null,
      frame: draw ? frameFromDraw(draw) : null,
      anchor: anchorFrom(row.anchor, read),
      anchorRead: read,
      returned: true,
    });
  }
  for (const id of stringList(rec.notFound)) {
    out.push({
      parcelNodeId: id,
      label: id,
      ring: [],
      edges: [],
      zoning: null,
      frame: null,
      anchor: null,
      anchorRead: null,
      returned: false,
    });
  }
  return out.length > 0 ? out : null;
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

/** B2: timedOut as a string list; a duplicate needs all three slots or it is dropped; null when nothing is declared. */
function degradedFrom(value: unknown): ScreenDegraded | null {
  const d = asRecord(value);
  if (!d) return null;
  const out: ScreenDegraded = {};
  const timedOut = stringList(d.timedOut);
  if (timedOut.length > 0) out.timedOut = timedOut;
  const dups: ScreenDuplicate[] = [];
  if (Array.isArray(d.duplicates)) {
    for (const raw of d.duplicates) {
      const r = asRecord(raw);
      if (!r) continue;
      const query = stringOrNull(r.query);
      const parcelNodeId = stringOrNull(r.parcelNodeId);
      const keptQuery = stringOrNull(r.keptQuery);
      if (!query || !parcelNodeId || !keptQuery) continue;
      dups.push({ query, parcelNodeId, keptQuery });
    }
  }
  if (dups.length > 0) out.duplicates = dups;
  return out.timedOut || out.duplicates ? out : null;
}

/** B3: a screen needs a string id; rowCount only as a whole number; newest updatedAt first, undated last. */
function screensFrom(value: unknown): ScreenSummary[] | null {
  if (!Array.isArray(value)) return null;
  const out: ScreenSummary[] = [];
  for (const raw of value) {
    const s = asRecord(raw);
    if (!s) continue;
    const id = stringOrNull(s.id);
    if (!id) continue;
    const row: ScreenSummary = { id, name: stringOrNull(s.name) ?? id, updatedAt: stringOrNull(s.updatedAt), createdAt: stringOrNull(s.createdAt) };
    const n = numberOrNull(s.rowCount);
    if (n !== null && n >= 0 && Math.floor(n) === n) row.rowCount = n;
    out.push(row);
  }
  out.sort((a, b) => {
    const au = a.updatedAt ? a.updatedAt : "";
    const bu = b.updatedAt ? b.updatedAt : "";
    return bu < au ? -1 : bu > au ? 1 : 0;
  });
  return out;
}

/** H1: a top-level status in the declared enum, with only the fields the body carries in the shape the server emits them. */
function declaredFrom(rec: Record<string, unknown>): DeclaredBody | null {
  const status = rec.status;
  if (typeof status !== "string" || (DECLARED_STATUSES as readonly string[]).indexOf(status) < 0) return null;
  const out: DeclaredBody = { status: status as DeclaredStatus, reason: stringOrNull(rec.reason) };
  const message = stringOrNull(rec.message);
  if (message) out.message = message;
  const cap = numberOrNull(rec.cap);
  if (cap !== null) out.cap = cap;
  const received = numberOrNull(rec.received);
  if (received !== null) out.received = received;
  const depth = stringOrNull(rec.depth);
  if (depth) out.depth = depth;
  const tool = stringOrNull(rec.tool);
  if (tool) out.tool = tool;
  const up = rec.upstreamStatus;
  if (typeof up === "number" && Number.isFinite(up)) out.upstreamStatus = up;
  else if (up === "unmeasured") out.upstreamStatus = "unmeasured";
  const tier = stringOrNull(rec.tier);
  if (tier) out.tier = tier;
  if (out.reason === "upstream_non_json") {
    const brief = stringOrNull(rec.brief);
    if (brief) out.brief = brief;
  }
  return out;
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

  /* M-4: a node array with two or more DRAWABLE parcels is a set, and it is
   * read before the single-parcel branch below, because that branch takes
   * parcels[0] and paints it alone. Painting one of three is the silent
   * omission this card exists to end. Fewer than two drawable parcels falls
   * through to that branch and renders exactly as it does today. */
  const parcelSet = parcelsFromBatch(rec);
  if (parcelSet && multiDrawableCount(parcelSet) >= MULTI_MIN_DRAWN) {
    const model: PanelModel = {
      kind: "parcels",
      rows: [],
      overlays: [],
      ring: [],
      edges: [],
      parcels: parcelSet,
    };
    const batch = anchorBatchFrom(rec.anchorBatch);
    if (batch) model.anchorBatch = batch;
    return model;
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
    /* M-2: the anchor lane attaches its outcome at the TOP level of the body, as
     * siblings of draw, so it is read off rec and never off the draw or a parcel
     * row. An array result carries a "skipped" read and no coordinate. */
    const anchorRead = anchorReadFrom(rec.anchorRead);
    if (anchorRead) {
      model.anchorRead = anchorRead;
      const anchor = anchorFrom(rec.anchor, anchorRead);
      if (anchor) model.anchor = anchor;
    }
    /* M-5: this branch paints parcels[0] alone. When the body carried more than
     * one parcel, the whole set travels with the model so the panel can name
     * every parcel it did not draw. The set is attached, never drawn: the canvas
     * still needs MULTI_MIN_DRAWN drawable parcels and that test is unchanged. */
    if (parcelSet && parcelSet.length > 1) {
      model.parcels = parcelSet;
      const setBatch = anchorBatchFrom(rec.anchorBatch);
      if (setBatch) model.anchorBatch = setBatch;
    }
    return model;
  }

  const refused = refusedRowsFrom(rec);
  if (refused) return { kind: "refused", rows: [], overlays: [], ring: [], edges: [], refused };
  const misses = missRowsFrom(rec);
  if (misses) return { kind: "miss", rows: [], overlays: [], ring: [], edges: [], misses };
  const batch = batchRowsFrom(rec);
  if (batch) return { kind: "board", rows: batch, overlays: [], ring: [], edges: [] };
  /* H1: a body that names its own state paints that state, never the empty copy */
  const declared = declaredFrom(rec);
  if (declared) return { kind: "declared", rows: [], overlays: [], ring: [], edges: [], declared };
  /* B3: the bare list_screens summary */
  const screens = screensFrom(rec.screens);
  if (screens && !Array.isArray(rec.rows) && !asRecord(rec.screen)) {
    return { kind: "screens", rows: [], overlays: [], ring: [], edges: [], screens };
  }

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
    /* B2: the create_screen response's declared duplicates and timeouts */
    const declaredDegradation = degradedFrom(rec.degraded !== undefined ? rec.degraded : screen.degraded);
    if (declaredDegradation) model.degraded = declaredDegradation;
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
  ringFit,
  ringPixel,
  ringSvg,
  frameNoteHtml,
  /* M-2 aerial ground */
  anchorReadFrom,
  anchorFrom,
  groundMetresPerPixel,
  groundPixelsPerFoot,
  groundWorldPixel,
  groundTileUrl,
  groundZoomFor,
  groundVbFromWorld,
  groundPlan,
  groundPct,
  groundLayerHtml,
  groundNoteHtml,
  groundWrapHtml,
  /* M-4 multi parcel canvas */
  anchorBatchFrom,
  parcelsFromBatch,
  anchorReadWords,
  undrawnReason,
  multiDrawableCount,
  multiGroundReasonWords,
  multiParcelPlan,
  resolveLabelPositions,
  multiCanvasSvg,
  multiDrawnHtml,
  multiUndrawnHtml,
  multiGroundNoteHtml,
  anchorBatchNoteHtml,
  renderParcelSet,
  /* M-5 off canvas naming */
  multiNoCanvasWords,
  multiNoCanvasNoteHtml,
  offCanvasParcels,
  offCanvasHtml,
  /* M-5 paint only preview */
  previewLine,
  previewRailsHtml,
  previewBlockHtml,
  previewRowFrom,
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
  /* S8 board */
  looksLikeParcelNodeId,
  stubReadOf,
  candidatesFrom,
  degradedFrom,
  screensFrom,
  declaredFrom,
  countyFipsOf,
  boardGroups,
  knownRank,
  sortBoardRows,
  useCandidateMessage,
  lookupMessage,
  reopenScreenMessage,
  candidateFor,
  lookupRowFor,
  screenSummaryFor,
  candidateControlsHtml,
  lookupControlHtml,
  stubReadNoteHtml,
  degradedNotesHtml,
  screensListHtml,
  declaredLineHtml,
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
  {
    /* p559: the probe block is the one admitted network region. It is a different
     * kind of thing than app code, so it is split out by explicit markers rather
     * than the check being widened; outside the markers the rule still fires, and
     * a missing, unbalanced, or duplicated block is its own violation. */
    const beginCount = html.split("/*P559_PROBE_BEGIN*/").length - 1;
    const endCount = html.split("/*P559_PROBE_END*/").length - 1;
    if (beginCount !== endCount || beginCount > 1) {
      violations.push("probe_block_malformed");
    }
    const scanned =
      beginCount === 1 && endCount === 1
        ? html.replace(/\/\*P559_PROBE_BEGIN\*\/[\s\S]*?\/\*P559_PROBE_END\*\//, "")
        : html;
    if (/fetch\(|XMLHttpRequest|WebSocket/.test(scanned)) {
      violations.push("direct_network");
    }
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
  /* M-2: the ground's mechanism must be in the served script, or the ground is a claim.
   * Tile <img> elements are not fetch, XMLHttpRequest or WebSocket, so the
   * direct_network rule above is neither tripped nor widened by them. */
  if (
    !html.includes('data-act="ground"') ||
    !html.includes("function toggleGround") ||
    !html.includes("function groundPlan") ||
    !html.includes("function groundWrapHtml") ||
    !html.includes(GROUND_TILE_URL_TEMPLATE) ||
    !html.includes(GROUND_VINTAGE_NOTE)
  ) {
    violations.push("ground_unbound");
  }
  /* Esri orders the path z / row / column. A transposed template fetches real
   * imagery of the wrong place, so the transposition is refused at the page. */
  if (!html.includes("/tile/{z}/{y}/{x}") || html.includes("/tile/{z}/{x}/{y}")) {
    violations.push("ground_tile_axis_transposed");
  }
  /* M-4: the canvas, the two named lists and the truncation note must each be in
   * the served script, or the set view is a claim. The undrawn list is checked
   * by name because it is the control that stops a canvas showing four of
   * seven, and a canvas without it is worse than no canvas. */
  if (
    !html.includes("function multiParcelPlan") ||
    !html.includes("function multiCanvasSvg") ||
    !html.includes("function renderParcelSet") ||
    !html.includes("function multiUndrawnHtml") ||
    !html.includes("function anchorBatchNoteHtml") ||
    !html.includes("data-parcels=") ||
    !html.includes("data-undrawn=") ||
    !html.includes("data-drawn=") ||
    !html.includes(MULTI_UNDRAWN_TITLE) ||
    !html.includes(MULTI_DRAWN_TITLE)
  ) {
    violations.push("multi_canvas_unbound");
  }
  /* M-5: the off canvas list must be in the served script and must NOT be
   * reachable only through the canvas. Separate code from multi_canvas_unbound
   * so a page that keeps the canvas and drops the fallback naming is
   * distinguishable from one that dropped the canvas. */
  {
    /* The call site, not the definition. `function offCanvasHtml(model) {` is
     * itself a substring match for "offCanvasHtml(model)", so a presence check
     * on that text is satisfied by the declaration and passes on a page that
     * never calls it. Found by mutation on this file's own first pass. An
     * occurrence preceded by "function " is the declaration and is not counted. */
    let calls = 0;
    let at = html.indexOf("offCanvasHtml(model)");
    while (at >= 0) {
      if (!html.slice(at - "function ".length, at).endsWith("function ")) calls += 1;
      at = html.indexOf("offCanvasHtml(model)", at + 1);
    }
    if (
      calls < 1 ||
      !html.includes("function offCanvasParcels") ||
      !html.includes("function offCanvasHtml") ||
      !html.includes("function multiNoCanvasWords") ||
      !html.includes("data-no-canvas=") ||
      !html.includes(MULTI_OFF_CANVAS_TITLE) ||
      !html.includes(MULTI_NO_CANVAS)
    ) {
      violations.push("off_canvas_list_unbound");
    }
  }
  {
    /* M-5: the app initiated tool call. Two independently derived readings of
     * the same page have to agree: where the markers are, and where the literal
     * method name is. A second call site outside the block, or a block that
     * moved off the call, fails; and unlike the p559 net block this one is NOT
     * exempted from direct_network, so a fetch smuggled inside it still fires. */
    const begin = html.split("/*P561_TOOLS_BEGIN*/").length - 1;
    const end = html.split("/*P561_TOOLS_END*/").length - 1;
    const calls = html.split('method:"tools/call"').length - 1;
    if (begin !== 1 || end !== 1 || calls !== 1) {
      violations.push("tools_call_unmarked");
    } else {
      const at = html.indexOf('method:"tools/call"');
      const from = html.indexOf("/*P561_TOOLS_BEGIN*/");
      const to = html.indexOf("/*P561_TOOLS_END*/");
      if (!(from < at && at < to)) violations.push("tools_call_unmarked");
    }
  }
  /* M-5 invariant 1 and the fail closed lines. Both rules read the BODY of the
   * served function rather than the page, because every sentence below is also
   * a `var` declaration in the served scope: a presence check on the page is
   * satisfied by the declaration whether or not anything paints it. Deleting the
   * not-in-conversation line from previewBlockHtml left the page still
   * containing that sentence, and the first version of these rules passed on it.
   * The helper cuts one embedded function out of the page; inlineSharedSource
   * emits each at exactly two spaces of indent, which is the boundary. */
  const servedFn = (name: string): string => {
    const at = html.indexOf("function " + name);
    if (at < 0) return "";
    const next = html.indexOf("\n  function ", at + 1);
    return next < 0 ? html.slice(at) : html.slice(at, next);
  };
  {
    const block = servedFn("previewBlockHtml");
    if (
      block.length === 0 ||
      !block.includes("PREVIEW_NOT_IN_CHAT") ||
      !block.includes('class="pv"') ||
      !block.includes("data-preview-state=") ||
      !block.includes("previewRailsHtml(") ||
      !block.includes("previewLine(") ||
      !html.includes(".tip .pv{") ||
      !html.includes(PREVIEW_NOT_IN_CHAT)
    ) {
      violations.push("preview_not_marked");
    }
  }
  {
    /* Every state the channel can reach has a sentence, and previewLine is what
     * reaches for it. A word declared and never read is a state that paints an
     * empty block. */
    const line = servedFn("previewLine");
    const names = [
      "PREVIEW_UNSUPPORTED",
      "PREVIEW_TIMED_OUT",
      "PREVIEW_ERROR",
      "PREVIEW_DECLINED",
      "PREVIEW_EMPTY",
      "PREVIEW_BUSY",
      "PREVIEW_UNSTATED",
      "PREVIEW_PENDING",
    ];
    const copy = [
      PREVIEW_UNSUPPORTED,
      PREVIEW_TIMED_OUT,
      PREVIEW_ERROR,
      PREVIEW_DECLINED,
      PREVIEW_EMPTY,
      PREVIEW_BUSY,
      PREVIEW_UNSTATED,
      PREVIEW_PENDING,
    ];
    if (
      line.length === 0 ||
      names.some((n) => !line.includes(n)) ||
      copy.some((c) => !html.includes(c)) ||
      !html.includes("function previewRowFrom")
    ) {
      violations.push("preview_absence_unstated");
    }
  }
  /* M-5: the dwell, the single flight, the timeout and the boot token. A
   * preview fired on pointer transit, or one with no bound, is the behaviour
   * the card refuses; each has a named mechanism here. */
  if (
    !html.includes("var PREVIEW_DWELL_MS=" + PREVIEW_DWELL_MS) ||
    !html.includes("var PREVIEW_TIMEOUT_MS=" + PREVIEW_TIMEOUT_MS) ||
    !html.includes("function armPreviewDwell") ||
    !html.includes("armPreviewDwell(door)") ||
    !html.includes("previewInFlight") ||
    !html.includes('var toolsText="tools=unread"') ||
    !html.includes('"data-tools"')
  ) {
    violations.push("preview_unbounded");
  }
  if (!html.includes('data-act="addscreen"') || !html.includes("add_to_screen") || !html.includes("function sendAddToScreen")) {
    violations.push("add_to_screen_unbound");
  }
  /* S8 board: each item's mechanism must be present in the served script, or the item is a claim */
  if (
    !html.includes('data-act="usecand"') ||
    !html.includes("function sendUseCandidate") ||
    !html.includes(JSON.stringify(USE_THIS_LABEL)) ||
    !html.includes("source pasted") ||
    !html.includes('data-act="lookup"') ||
    !html.includes(JSON.stringify(LOOK_UP_LABEL))
  ) {
    violations.push("candidate_control_unbound");
  }
  if (
    !html.includes("data-duplicate=") ||
    !html.includes("data-timed-out=") ||
    !html.includes("data-stub-read=") ||
    !html.includes(JSON.stringify(DUP_NOT_ADDED)) ||
    !html.includes(JSON.stringify(TIMED_OUT_NOTE))
  ) {
    violations.push("duplicate_note_unbound");
  }
  if (
    !html.includes('data-act="reopen"') ||
    !html.includes("function sendReopen") ||
    !html.includes("Reopen screen") ||
    !html.includes("Do not create a new screen") ||
    !html.includes(JSON.stringify(NO_SCREENS_YET))
  ) {
    violations.push("reopen_opener_unbound");
  }
  if (!html.includes("data-county-group=") || !html.includes("function boardGroups") || !html.includes(JSON.stringify(UNRESOLVED_GROUP))) {
    violations.push("county_group_unmarked");
  }
  if (!html.includes('var sortKey="completeness"') || !html.includes("function sortBoardRows") || !html.includes('data-k="completeness"')) {
    violations.push("completeness_sort_unbound");
  }
  if (
    !html.includes("data-declared=") ||
    !html.includes("data-brief=") ||
    !html.includes("function declaredLineHtml") ||
    !html.includes(JSON.stringify(REFUSED_PREFIX)) ||
    !html.includes(JSON.stringify(NOT_IMPLEMENTED_PREFIX)) ||
    !html.includes(JSON.stringify(NOT_READY_INFIX)) ||
    /* P-101: the screens upgrade branch reads this reason inside the embedded
     * declaredLineHtml; without the var the branch throws in the iframe. */
    !html.includes(JSON.stringify(UPGRADE_SCREENS_REASON))
  ) {
    violations.push("declared_body_unbound");
  }
  const boundCopy = [
    NOTHING_TO_OPEN,
    OPEN_DID_NOT_REACH_ME,
    OPEN_SENT,
    NOT_ON_FILE_PREFIX,
    NO_BAKED_SNAPSHOT_PREFIX,
    UPGRADE_TO_OPEN,
    /* P-101: declaredLineHtml is embedded BY SOURCE, so a constant it closes
     * over that is not emitted as a `var` throws ReferenceError in the iframe
     * and paints nothing. A unit test on declaredLineHtml alone cannot catch
     * that; this can. */
    UPGRADE_TO_SCREEN,
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
/* M-2 ground. The wrapper carries the drawing's margin so its box is the svg's
   box exactly: no margin collapsing question, and a percentage inside it is a
   viewBox unit. The layer paints no background, so a tile that does not load
   leaves the panel's own void rather than a grey stand-in for imagery. */
.gwrap{position:relative;margin:8px 0;border-radius:6px;overflow:hidden}
.gwrap svg.ring{margin:0;position:relative;z-index:1}
.ground{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.ground img{position:absolute;display:block;max-width:none;user-select:none}
/* The ring's void fill is a 55 percent scrim, which is right over nothing and
   wrong over imagery. Scoped to ground on, so with the ground off the drawing
   renders exactly as it does today. */
.gwrap[data-ground="on"] .ring-fill{fill-opacity:.16}
.gnote{font:var(--ss-fs-meta)/1.4 ui-monospace,Consolas,monospace;color:var(--ss-t6);margin:0 0 8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.gnote .btn{padding:3px 8px;font-size:var(--ss-fs-meta)}
/* M-4 set canvas. The rings reuse .ring-fill, so the ground-on scrim rule above
   applies to them unchanged. The hit polygon carries no paint of its own: it is
   the click target and nothing else, so it can never be mistaken for a drawn
   parcel boundary. */
svg.ring.set .plbl{font:var(--ss-fs-meta) ui-monospace,Consolas,monospace;fill:var(--ss-t3);paint-order:stroke;stroke:var(--ss-void);stroke-width:3px;stroke-linejoin:round}
svg.ring.set .phit{fill:transparent;stroke:none;pointer-events:all;cursor:pointer}
svg.ring.set .pll{stroke:var(--ss-t6);stroke-width:1;stroke-dasharray:2 2;pointer-events:none}
.pset-list{margin:0 0 10px}
.pcell{padding:5px 0;border-bottom:1px solid var(--ss-line-06);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pcell:last-child{border-bottom:none}
.pcell .lbl{color:var(--ss-t5);font-size:var(--ss-fs-meta)}
.pcell .reason{color:var(--ss-slate);font-size:var(--ss-fs-meta)}
.tip{font:var(--ss-fs-meta)/1.6 ui-monospace,Consolas,monospace;color:var(--ss-t5);margin:0 0 8px;min-height:1.6em}
.tip span{margin-right:8px}
.tip .tn{color:var(--ss-atom)}
.tip .tf,.tip .tb{color:var(--ss-t3)}
.tip .btn{padding:3px 8px;font-size:var(--ss-fs-meta)}
/* M-5 paint only preview. Invariant 1 is carried visually here: the block sits
   on its own line behind a dashed rail, in italic, in the dimmest text colour,
   and none of its parts use .tn, .tf or .tb, the three classes that mark facts
   that came from the tool result. A reader cannot mistake one for the other,
   and the pvnote line says so in words as well. */
.tip .pv{display:block;margin-top:6px;padding-left:8px;border-left:2px dashed var(--ss-line-14);color:var(--ss-t6);font-style:italic}
.tip .pv .pvt{display:block;color:var(--ss-slate)}
.tip .pv .pvrails{display:block;font-style:normal}
.tip .pv .pvr{margin-right:10px;white-space:nowrap}
.tip .pv .pvr .g{margin-right:4px}
.tip .pv .pvmiss{display:block;color:var(--ss-slate)}
.tip .pv .pvnote{display:block;color:var(--ss-warn)}
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
.fsub{color:var(--ss-t6);font:var(--ss-fs-meta)/1.4 ui-monospace,Consolas,monospace}
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
.grp th{font:var(--ss-fs-meta)/1.2 var(--ss-ui);letter-spacing:0;text-transform:none;color:var(--ss-t3);padding:10px 6px 4px;border-bottom:1px solid var(--ss-line-14);cursor:default}
.cands{margin-top:4px}
.cand{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:3px 0;font-size:var(--ss-fs-meta)}
.cand .btn,.slot+.btn{padding:3px 8px;font-size:var(--ss-fs-meta)}
.screens{display:flex;flex-direction:column}
.scr{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--ss-line-06)}
.scr:last-child{border-bottom:none}
.scr .btn{margin-left:auto}
.sortc{cursor:pointer;text-decoration:underline dotted;margin-left:6px}
.brief{font:var(--ss-fs-meta)/1.4 ui-monospace,Consolas,monospace;color:var(--ss-t5);background:var(--ss-void);border-radius:6px;padding:8px;margin:6px 0 0;white-space:pre-wrap;word-break:break-word;overflow-x:auto}
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
  var netText="net=unread";
  var glText="gl=unread";
  var bridgeText="bridge=unread";
  /* M-5 item 3: the fourth channel. p559 measured net, gl and resources/read;
   * an app initiated tools/call is a DIFFERENT method and was never measured.
   * This token says what happened to one: unread until a door dwell fires one
   * (the panel makes no unrequested tool call), then pending, then ok, err<code>
   * or timeout; unsupported the moment the handshake settles without serverTools. */
  var toolsText="tools=unread";
  var pendingMsg=Object.create(null);
  function paintBoot(){
    if(!boot) return;
    boot.setAttribute("data-script","ran");
    boot.setAttribute("data-handshake",handshake);
    boot.setAttribute("data-caps",capText);
    boot.setAttribute("data-message-cap",msgCap);
    boot.setAttribute("data-reply",replyText);
    boot.setAttribute("data-foreign",String(foreignCount));
    boot.setAttribute("data-net",netText.slice(4));
    boot.setAttribute("data-gl",glText.slice(3));
    boot.setAttribute("data-bridge",bridgeText.slice(7));
    boot.setAttribute("data-tools",toolsText.slice(6));
    boot.textContent=["script-ran","handshake="+handshake,capText,msgCap,replyText,"foreign="+foreignCount,netText,glText,bridgeText,toolsText].join(" ");
  }
  paintBoot();
  /*P559_PROBE_BEGIN*/
  /* p559 probe. gl: synchronous context check. net: per-origin fetch, cors then no-cors
   * (ok<status> = reachable with CORS; opq = reachable, no CORS; blk = blocked; to = timeout).
   * bridge: resources/read through the host rpc once the handshake is ready. */
  try{
    var glc=document.createElement("canvas");
    glText=glc.getContext("webgl2")?"gl=webgl2":(glc.getContext("webgl")||glc.getContext("experimental-webgl"))?"gl=webgl1":"gl=none";
  }catch(eGl){glText="gl=err"}
  paintBoot();
  var PROBE_NET=${JSON.stringify(PROBE_NET_TARGETS)};
  var PROBE_URI=${JSON.stringify(PROBE_RESOURCE_URI)};
  var netParts=Object.create(null);
  var probeIds=Object.create(null);
  var bridgeTimer=null;
  function paintNet(){
    var out=[];
    for(var ni=0;ni<PROBE_NET.length;ni++){var nk=PROBE_NET[ni].key;out.push(nk+":"+(netParts[nk]||"pending"))}
    netText="net="+out.join(",");
    paintBoot();
  }
  function probeOne(t){
    netParts[t.key]="pending";
    var done=false;
    var timer=setTimeout(function(){if(!done){done=true;netParts[t.key]="to";paintNet();}},6000);
    function finish(v){if(done)return;done=true;clearTimeout(timer);netParts[t.key]=v;paintNet();}
    try{
      fetch(t.url,{mode:"cors"}).then(function(r){finish("ok"+r.status)},function(){
        try{
          fetch(t.url,{mode:"no-cors"}).then(function(){finish("opq")},function(){finish("blk")});
        }catch(eNc){finish("blk")}
      });
    }catch(eF){finish("blk")}
  }
  function startNetProbe(){
    if(typeof fetch!=="function"){netText="net=nofetch";paintBoot();return;}
    for(var pi=0;pi<PROBE_NET.length;pi++) probeOne(PROBE_NET[pi]);
    paintNet();
  }
  function startBridgeProbe(){
    if(bridgeText!=="bridge=unread") return;
    bridgeText="bridge=pending";
    var bid=rpcId++;
    probeIds[bid]=1;probeIds[String(bid)]=1;
    bridgeTimer=setTimeout(function(){bridgeText="bridge=timeout";paintBoot();},6000);
    parent.postMessage({jsonrpc:"2.0",id:bid,method:"resources/read",params:{uri:PROBE_URI}},"*");
    paintBoot();
  }
  startNetProbe();
  /*P559_PROBE_END*/
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
  var NOT_RETURNED=${JSON.stringify(NOT_RETURNED)};
  var UPGRADE_TO_OPEN=${JSON.stringify(UPGRADE_TO_OPEN)};
  var UPGRADE_TO_SCREEN=${JSON.stringify(UPGRADE_TO_SCREEN)};
  var UPGRADE_SCREENS_REASON=${JSON.stringify(UPGRADE_SCREENS_REASON)};
  var USE_THIS_LABEL=${JSON.stringify(USE_THIS_LABEL)};
  var LOOK_UP_LABEL=${JSON.stringify(LOOK_UP_LABEL)};
  var AMBIGUOUS_CAPTION=${JSON.stringify(AMBIGUOUS_CAPTION)};
  var NO_SCREENS_YET=${JSON.stringify(NO_SCREENS_YET)};
  var NO_SCREENS_BODY=${JSON.stringify(NO_SCREENS_BODY)};
  var UNRESOLVED_GROUP=${JSON.stringify(UNRESOLVED_GROUP)};
  var STUB_READ_NOTE=${JSON.stringify(STUB_READ_NOTE)};
  var DUP_SAME_PARCEL=${JSON.stringify(DUP_SAME_PARCEL)};
  var DUP_NOT_ADDED=${JSON.stringify(DUP_NOT_ADDED)};
  var TIMED_OUT_NOTE=${JSON.stringify(TIMED_OUT_NOTE)};
  var REFUSED_PREFIX=${JSON.stringify(REFUSED_PREFIX)};
  var NOT_IMPLEMENTED_PREFIX=${JSON.stringify(NOT_IMPLEMENTED_PREFIX)};
  var NOT_READY_INFIX=${JSON.stringify(NOT_READY_INFIX)};
  var UPSTREAM_KEY=${JSON.stringify(UPSTREAM_KEY)};
  var SORT_COMPLETENESS_LABEL=${JSON.stringify(SORT_COMPLETENESS_LABEL)};
  var DECLARED_STATUSES=${JSON.stringify(DECLARED_STATUSES)};
  /* M-2 aerial ground. The served scope gets the same constants the tested
   * helpers read, so the tile url and the CSP origin cannot drift apart. */
  var GROUND_TILE_URL_TEMPLATE=${JSON.stringify(GROUND_TILE_URL_TEMPLATE)};
  var GROUND_TILE_PX=${JSON.stringify(GROUND_TILE_PX)};
  var GROUND_EQUATOR_MPP=${JSON.stringify(GROUND_EQUATOR_MPP)};
  var US_SURVEY_FOOT_M=${JSON.stringify(US_SURVEY_FOOT_M)};
  var GROUND_ZOOM_MIN=${JSON.stringify(GROUND_ZOOM_MIN)};
  var GROUND_ZOOM_MAX=${JSON.stringify(GROUND_ZOOM_MAX)};
  var GROUND_SUPERSAMPLE=${JSON.stringify(GROUND_SUPERSAMPLE)};
  var GROUND_MAX_TILES=${JSON.stringify(GROUND_MAX_TILES)};
  var GROUND_SOURCE_LABEL=${JSON.stringify(GROUND_SOURCE_LABEL)};
  var GROUND_VINTAGE_NOTE=${JSON.stringify(GROUND_VINTAGE_NOTE)};
  var GROUND_TOGGLE_LABEL=${JSON.stringify(GROUND_TOGGLE_LABEL)};
  /* M-4 multi parcel canvas. Same rule as the ground constants above: the served
   * scope reads the constants the tested helpers read, so the cap, the extent
   * threshold and every sentence have one source. */
  var MULTI_MIN_DRAWN=${JSON.stringify(MULTI_MIN_DRAWN)};
  var MULTI_GROUND_MAX_EXTENT_FT=${JSON.stringify(MULTI_GROUND_MAX_EXTENT_FT)};
  var MULTI_GROUND_EXTENT_REASON=${JSON.stringify(MULTI_GROUND_EXTENT_REASON)};
  var MULTI_TOO_FEW_REASON=${JSON.stringify(MULTI_TOO_FEW_REASON)};
  var MULTI_NO_PARCELS_REASON=${JSON.stringify(MULTI_NO_PARCELS_REASON)};
  var MULTI_NO_RING=${JSON.stringify(MULTI_NO_RING)};
  var MULTI_NO_ANCHOR=${JSON.stringify(MULTI_NO_ANCHOR)};
  var MULTI_ANCHOR_UNDECLARED=${JSON.stringify(MULTI_ANCHOR_UNDECLARED)};
  var MULTI_UNDRAWN_TITLE=${JSON.stringify(MULTI_UNDRAWN_TITLE)};
  var MULTI_DRAWN_TITLE=${JSON.stringify(MULTI_DRAWN_TITLE)};
  var MULTI_CARD_TITLE=${JSON.stringify(MULTI_CARD_TITLE)};
  var MULTI_ANCHORS_READ=${JSON.stringify(MULTI_ANCHORS_READ)};
  var MULTI_ANCHORS_NOT_READ=${JSON.stringify(MULTI_ANCHORS_NOT_READ)};
  var MULTI_GROUND_TOO_WIDE_PREFIX=${JSON.stringify(MULTI_GROUND_TOO_WIDE_PREFIX)};
  var MULTI_GROUND_TOO_WIDE_SUFFIX=${JSON.stringify(MULTI_GROUND_TOO_WIDE_SUFFIX)};
  var MULTI_REF_ZOOM=${JSON.stringify(MULTI_REF_ZOOM)};
  var MULTI_LABEL_CHAR_W=${JSON.stringify(MULTI_LABEL_CHAR_W)};
  var MULTI_LABEL_H=${JSON.stringify(MULTI_LABEL_H)};
  var MULTI_LABEL_STEP=${JSON.stringify(MULTI_LABEL_STEP)};
  var MULTI_LABEL_MAX_PUSH=${JSON.stringify(MULTI_LABEL_MAX_PUSH)};
  /* M-5 off canvas naming and the paint only preview. Same rule again: the
   * served scope reads the constants the tested helpers read. */
  var MULTI_OFF_CANVAS_TITLE=${JSON.stringify(MULTI_OFF_CANVAS_TITLE)};
  var MULTI_NO_CANVAS=${JSON.stringify(MULTI_NO_CANVAS)};
  var MULTI_NO_CANVAS_PREFIX=${JSON.stringify(MULTI_NO_CANVAS_PREFIX)};
  var MULTI_NO_CANVAS_DRAWABLE=${JSON.stringify(MULTI_NO_CANVAS_DRAWABLE)};
  var MULTI_NO_CANVAS_NEEDED=${JSON.stringify(MULTI_NO_CANVAS_NEEDED)};
  var PREVIEW_TOOL=${JSON.stringify(PREVIEW_TOOL)};
  var PREVIEW_DEPTH=${JSON.stringify(PREVIEW_DEPTH)};
  var PREVIEW_DWELL_MS=${JSON.stringify(PREVIEW_DWELL_MS)};
  var PREVIEW_TIMEOUT_MS=${JSON.stringify(PREVIEW_TIMEOUT_MS)};
  var PREVIEW_TITLE=${JSON.stringify(PREVIEW_TITLE)};
  var PREVIEW_NOT_IN_CHAT=${JSON.stringify(PREVIEW_NOT_IN_CHAT)};
  var PREVIEW_PENDING=${JSON.stringify(PREVIEW_PENDING)};
  var PREVIEW_UNSUPPORTED=${JSON.stringify(PREVIEW_UNSUPPORTED)};
  var PREVIEW_TIMED_OUT=${JSON.stringify(PREVIEW_TIMED_OUT)};
  var PREVIEW_ERROR=${JSON.stringify(PREVIEW_ERROR)};
  var PREVIEW_DECLINED=${JSON.stringify(PREVIEW_DECLINED)};
  var PREVIEW_EMPTY=${JSON.stringify(PREVIEW_EMPTY)};
  var PREVIEW_BUSY=${JSON.stringify(PREVIEW_BUSY)};
  var PREVIEW_UNSTATED=${JSON.stringify(PREVIEW_UNSTATED)};
${inlineSharedSource()}
  var esc=escapeHtml;
  var model=emptyModel("empty");
  var openWait=null;
  var openFail=null;
  var openSent=null;
  var openTimer=null;
  function clearOpenTimer(){ if(openTimer){ clearTimeout(openTimer); openTimer=null; } }
  var sortKey="completeness";
  var sortDir=1;
  var listingAck=null;
  var hotEl=null;
  var pinnedEl=null;
  /* R1: local view state (I8). Reset on every accepted result; never read from anywhere. */
  var reportOpen=false;
  /* M-2: local view state, same rule. On whenever a ground exists; the toggle turns it off. */
  var groundOn=true;
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
    /* M-5: the ONE place the preview channel's precondition is read. Absent,
     * null or false is not a capability; only a declared serverTools is. */
    serverToolsCap=hc.serverTools!=null&&hc.serverTools!==false;
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
    if(handshake==="ready"){ startBridgeProbe(); }
    else { bridgeText="bridge=nohost"; paintBoot(); }
    /* M-5: one place decides the negative case, so a handshake that errored, a
     * handshake that timed out and a host that simply does not advertise
     * serverTools all report the same measured word. Never left at unread. */
    if(!serverToolsCap){ toolsText="tools=unsupported"; paintBoot(); }
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
  /* M-5 paint only preview channel. Bounds, all four stated in the module doc:
   * one dwell before any call, one call in flight at a time, one call per
   * neighbour per panel instance (previewState[node] is set the moment a call
   * is issued and never cleared except by accept()), and one timeout after
   * which the tooltip says the call went unanswered. No state below is ever an
   * argument to a turn; the Open and Add to screen controls are untouched. */
  var serverToolsCap=false;
  var previewState=Object.create(null);
  var previewCode=Object.create(null);
  var previewRow=Object.create(null);
  var previewIds=Object.create(null);
  var previewInFlight=null;
  var previewBusyFor=null;
  var previewDwell=null;
  var previewWait=null;
  var previewNode=null;
  var previewEl=null;
  function toolsSeen(word){
    toolsText="tools="+word;
    paintBoot();
  }
  /* null means no block at all. A tooltip with no preview claims nothing; an
   * empty block would claim the neighbour has nothing. */
  function previewStateOf(node){
    var s=previewState[node];
    if(s!==undefined) return s;
    if(previewBusyFor===node) return "busy";
    return null;
  }
  function previewBlockFor(node){
    if(!node) return "";
    var s=previewStateOf(node);
    if(s===null) return "";
    return previewBlockHtml(node,s,s==="ok"?(previewRow[node]||null):null,previewCode[node]||null);
  }
  function cancelPreviewDwell(){
    if(previewDwell){clearTimeout(previewDwell);previewDwell=null;}
  }
  function repaintTip(){
    if(previewEl) showEdge(previewEl);
  }
  function armPreviewDwell(node){
    cancelPreviewDwell();
    previewDwell=setTimeout(function(){previewDwell=null;firePreview(node);},PREVIEW_DWELL_MS);
  }
  /* A door that waited out a busy window gets its dwell back once the channel
   * is free, but only while the pointer is still on it. */
  function releasePreviewBusy(){
    if(previewBusyFor===null) return;
    var n=previewBusyFor;
    previewBusyFor=null;
    if(previewNode===n&&previewState[n]===undefined) armPreviewDwell(n);
  }
  function firePreview(node){
    if(!node) return;
    if(previewState[node]!==undefined) return;
    if(!serverToolsCap){previewState[node]="unsupported";toolsSeen("unsupported");repaintTip();return;}
    if(previewInFlight){previewBusyFor=node;repaintTip();return;}
    previewState[node]="pending";
    previewInFlight=node;
    var pid=rpcId++;
    previewIds[pid]=node;
    previewIds[String(pid)]=node;
    toolsSeen("pending");
    previewWait=setTimeout(function(){
      previewWait=null;
      if(previewInFlight!==node) return;
      previewInFlight=null;
      previewState[node]="timeout";
      toolsSeen("timeout");
      releasePreviewBusy();
      repaintTip();
    },PREVIEW_TIMEOUT_MS);
    sendToolsCall(pid,node);
    repaintTip();
  }
  /*P561_TOOLS_BEGIN*/
  /* The ONE app initiated tool call in this page. It is postMessage, not fetch,
   * so this block is deliberately NOT exempted from the direct_network rule the
   * way the p559 net probe is; the markers exist so the contract can prove there
   * is exactly one tools/call site and that it is this one. The reply is routed
   * by id in the message listener and never reaches accept(), so a preview can
   * neither repaint the panel nor enter the conversation. */
  function sendToolsCall(pid,node){
    parent.postMessage({jsonrpc:"2.0",id:pid,method:"tools/call",params:{name:PREVIEW_TOOL,arguments:{parcelNodeId:[node],depth:PREVIEW_DEPTH}}},"*");
  }
  /*P561_TOOLS_END*/
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
    /* M-5: only a door carries a preview. The dwell is cancelled unconditionally
     * first, so moving from one door to another cannot leave the first door's
     * timer armed and starve the second. */
    var door=edgeDoor(e);
    cancelPreviewDwell();
    previewNode=door;
    previewEl=door?n:null;
    /* Arming is not the bound. This decides only whether the line is a door;
     * firePreview is the ONE place that decides whether a call happens, so the
     * once per neighbour rule has a single enforcement site rather than two,
     * one of which no fixture could reach. */
    if(door) armPreviewDwell(door);
    var tip=tipEl();
    if(tip){ tip.innerHTML=edgeTipHtml(e,idx)+previewBlockFor(door); tip.setAttribute("data-edge-shown",String(idx)); }
  }
  function clearEdge(){
    if(hotEl) hotEl.setAttribute("class","edge");
    hotEl=null;
    cancelPreviewDwell();
    previewNode=null;
    previewEl=null;
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
  /* B1 B2: a resolved row carries its read state; an ambiguous row keeps the typed query and offers its candidates; an unresolved row stays as typed */
  function queryCell(r){
    if(r.resolution==="resolved") return '<div class="pl">'+esc(r.query)+"</div>"+stubReadNoteHtml(r);
    if(r.resolution==="ambiguous") return '<div class="unres">'+AMBIGUOUS_CAPTION+'</div><div class="pn">'+esc(r.query)+"</div>"+candidateControlsHtml(r);
    var cap=looksNode(r.query)?"node unresolved":"situs unresolved";
    return '<div class="unres">'+cap+'</div><div class="pn">'+esc(r.query)+"</div>";
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
      /* B4 B5: groups by county prefix when there is more than one; each group in the local sort order; Open only on a resolved row */
      var grouping=boardGroups(model.rows);
      var head='<tr><th data-k="query">Query</th><th data-k="id">Node</th>'+RAILS.map(function(r){return "<th>"+r+"</th>"}).join("")+"<th></th></tr>";
      var pos=0;
      var body=grouping.groups.map(function(grp){
        var hdr=grouping.grouped?'<tr class="grp" data-county-group="'+esc(grp.fips||"unresolved")+'"><th colspan="'+(RAILS.length+3)+'">'+esc(grp.title)+"</th></tr>":"";
        return hdr+sortBoardRows(grp.rows,sortKey,sortDir).map(function(r){
        var i=pos++;
        var open=r.parcelNodeId&&r.resolution==="resolved"
          ?'<button type="button" class="btn" data-act="open" data-node="'+esc(r.parcelNodeId)+'" onclick="window.__ss&&window.__ss.open(this)">Open</button>'
          :'<div class="slot">'+${JSON.stringify(NOTHING_TO_OPEN)}+"</div>"+lookupControlHtml(r);
        return '<tr class="row" data-i="'+i+'"><td>'+queryCell(r)+'</td><td class="pn atom">'+esc(r.parcelNodeId||"—")+"</td>"+RAILS.map(function(k){
          var g=glyph(r.rails[k]);
          var ask=r.parcelNodeId?whyControlHtml("rail",railState(r.rails[k]),{rail:k,node:r.parcelNodeId},g):"";
          return "<td>"+(ask||g)+"</td>";
        }).join("")+"<td>"+open+"</td></tr>";
        }).join("");
      }).join("");
      var note=model.stubsDegraded===true?'<p class="note">'+${JSON.stringify(RAILS_PARTLY_UNREAD)}+"</p>":"";
      root.innerHTML=card("screen board",stateLines()+'<div class="well"><div class="req">Rows <span class="sortc" data-k="completeness" data-sort-active="'+(sortKey==="completeness"?"1":"0")+'">'+SORT_COMPLETENESS_LABEL+'</span></div><table data-sort="'+esc(sortKey)+'" data-dir="'+sortDir+'"><thead>'+head+"</thead><tbody>"+body+"</tbody></table>"+degradedNotesHtml(model.degraded||null)+"</div>"+note+
        '<div class="legend"><span>'+glyph("present")+" present</span><span>"+glyph("absent-verified")+' absent, verified</span><span>'+glyph("unknown")+" unknown</span><span>"+glyph("refused")+" refused</span><span>"+glyph("unread")+" unread</span></div>");
    } else if(model.kind==="parcel"){
      var ov=model.overlays.map(function(o,i){return overlayRowHtml(o,i)}).join("")||'<p class="empty">No overlays on this draw.</p>';
      var node=model.parcelNodeId?'<div class="pn atom">'+esc(model.parcelNodeId)+"</div>":"";
      var flood=floodOverlayOf(model.overlays);
      var svg=ringSvg(model.ring||[],model.edges||[],{zoning:model.zoning||null,flood:flood,frame:model.frame||null});
      /* M-2: same helpers the exported twin uses; a null plan returns svg untouched */
      var drawn=groundWrapHtml(svg,groundPlan(model.ring||[],model.anchor||null,model.anchorRead||null).plan,groundOn);
      var tip=svg?'<div class="tip" data-tip="1">'+EDGE_TIP_HINT+"</div>"+frameNoteHtml(model.frame||null):"";
      var edgeList=(model.edges&&model.edges.length)?'<ul class="edges">'+model.edges.map(function(e){return "<li>"+esc(edgeCaption(e))+"</li>"}).join("")+"</ul>":"";
      var secs=model.sections||[];
      var floodFacts="";
      for(var fi=0;fi<secs.length;fi++){ if(secs[fi].id==="flood"){ floodFacts=floodFactsHtml(secs[fi],fi); break; } }
      var report=reportOpen?reportHtml(secs):"";
      /* M-5: what this panel did NOT draw, whenever the result carried more than
       * one parcel. Not conditional on a canvas: the canvas is exactly what this
       * branch does not have. */
      root.innerHTML=card(esc(model.label||model.parcelNodeId||"parcel"),stateLines()+'<div class="well">'+node+drawn+tip+edgeList+ov+floodFacts+report+offCanvasHtml(model)+"</div>"+
        '<div class="acts">'+saveChooserHtml()+'<button type="button" class="btn'+(reportOpen?" on":"")+'" data-act="report" data-report-open="'+(reportOpen?"1":"0")+'" onclick="window.__ss&&window.__ss.report()">'+REPORT_TOGGLE+'</button><button type="button" class="btn primary" data-act="listing" onclick="window.__ss&&window.__ss.listing(this)">Find listing history</button></div>'+(listingAck?'<div class="ack" data-listing-chars="'+esc(listingAck.chars)+'">Posted '+esc(listingAck.chars)+" chars</div>":""));
      var listing=root.querySelector('[data-act="listing"]');
      if(listing&&listingAck){
        listing.textContent=${JSON.stringify(LISTING_ACK_LABEL)};
        listing.disabled=true;
        listing.setAttribute("data-listing-ack","1");
        listing.setAttribute("data-listing-chars",String(listingAck.chars));
      }
      bindDrawing();
    } else if(model.kind==="parcels"){
      /* M-4: the same helpers the exported twin uses. A set that cannot make a
       * canvas never reaches here: the parser hands it back as a single parcel. */
      root.innerHTML=card(MULTI_CARD_TITLE,stateLines()+'<div class="well">'+renderParcelSet(model,groundOn)+"</div>");
    } else if(model.kind==="miss"){
      root.innerHTML=card("lookup",'<div class="well">'+(model.misses||[]).map(missLine).join("")+"</div>");
    } else if(model.kind==="refused"){
      root.innerHTML=card("refused",'<div class="well">'+(model.refused||[]).map(refusedLine).join("")+"</div>");
    } else if(model.kind==="screens"){
      root.innerHTML=card("screens",stateLines()+'<div class="well"><div class="req">Screens</div>'+screensListHtml(model.screens||[])+"</div>");
    } else if(model.kind==="declared"){
      root.innerHTML=card(esc(model.declared?model.declared.status:"result"),stateLines()+'<div class="well">'+(model.declared?declaredLineHtml(model.declared):"")+"</div>");
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
  function armOpenWait(key){
    clearOpenTimer();
    openWait=key;
    openFail=null;
    openSent=null;
    openTimer=setTimeout(function(){
      if(openWait){
        openFail=${JSON.stringify(OPEN_DID_NOT_REACH_ME)};
        openWait=null;
        render();
      }
    },${OPEN_DEAD_MS});
  }
  function sendOpen(btn){
    var node=btn&&btn.getAttribute("data-node");
    if(!node) return;
    armOpenWait(node);
    host.sendMessage(openParcelMessage(node));
  }
  /* B3: a reopen is an Open on a screen the panel painted; same timer, same Sent line, never a new screen. */
  function sendReopen(btn){
    var id=attr(btn,"data-screen");
    if(!screenSummaryFor(model,id)) return;
    armOpenWait(id);
    host.sendMessage(reopenScreenMessage(id));
  }
  /* B1: a candidate is used only from the ambiguous row that carries it; the panel picks nothing. */
  function sendUseCandidate(btn){
    var node=attr(btn,"data-node");
    var query=attr(btn,"data-query");
    if(!candidateFor(model,node,query)) return;
    host.sendMessage(useCandidateMessage(node,query));
  }
  function sendLookup(btn){
    var query=attr(btn,"data-query");
    if(!lookupRowFor(model,query)) return;
    host.sendMessage(lookupMessage(query));
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
  /* M-2: local toggle, R1's pattern. Off removes every tile from the html; it does not hide them. */
  function toggleGround(){
    if(model.kind!=="parcel"&&model.kind!=="parcels") return;
    groundOn=!groundOn;
    render();
  }
  window.__ss={listing:sendListing,open:sendOpen,save:sendSave,cite:sendCite,why:sendWhy,addToScreen:sendAddToScreen,report:toggleReport,ground:toggleGround,useCandidate:sendUseCandidate,lookup:sendLookup,reopen:sendReopen,fp:function(){return fingerprint(model)},parse:parseToolResult};
  document.body.addEventListener("click",function(ev){
    var el=ev.target;
    if(!el||!el.closest) return;
    var th=el.closest("[data-k]");
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
    groundOn=true;
    sortKey="completeness";
    sortDir=1;
    /* M-5: a new result is a new panel instance, so the per neighbour once
     * budget resets with it and no preview of the previous parcel's neighbours
     * can survive into this one. */
    cancelPreviewDwell();
    if(previewWait){clearTimeout(previewWait);previewWait=null;}
    previewState=Object.create(null);
    previewCode=Object.create(null);
    previewRow=Object.create(null);
    previewIds=Object.create(null);
    previewInFlight=null;
    previewBusyFor=null;
    previewNode=null;
    previewEl=null;
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
    if(d.id!=null&&probeIds[d.id]){
      delete probeIds[d.id];delete probeIds[String(d.id)];
      if(bridgeTimer){clearTimeout(bridgeTimer);bridgeTimer=null;}
      if(d.error){bridgeText="bridge=err"+(d.error.code!=null?String(d.error.code):"");}
      else if(d.result&&d.result.contents&&d.result.contents.length){bridgeText="bridge=ok";}
      else if(d.result!==undefined){bridgeText="bridge=empty";}
      else {bridgeText="bridge=odd";}
      paintBoot();
      return;
    }
    /* M-5: an app initiated tools/call reply. Routed by id and handled here, so
     * it can never reach accept(): a preview repaints one tooltip and nothing
     * else. A reply for a previous panel instance finds no id (accept() drops
     * them) and falls through to be ignored. */
    if(d.id!=null&&previewIds[d.id]!==undefined){
      var pnode=previewIds[d.id];
      delete previewIds[d.id];delete previewIds[String(d.id)];
      if(previewWait){clearTimeout(previewWait);previewWait=null;}
      if(previewInFlight===pnode) previewInFlight=null;
      if(d.error){
        var pcode=d.error.code!=null?String(d.error.code):"";
        previewState[pnode]="error";
        previewCode[pnode]=pcode;
        toolsSeen("err"+pcode);
      } else if(d.result&&d.result.isError){
        /* The CHANNEL worked and the tool declined. The token measures the
         * channel; the tooltip states the decline. */
        previewState[pnode]="declined";
        toolsSeen("ok");
      } else if(d.result!==undefined){
        var prow=previewRowFrom(d.result,pnode);
        if(prow){previewRow[pnode]=prow;previewState[pnode]="ok";}
        else{previewState[pnode]="empty";}
        toolsSeen("ok");
      } else {
        previewState[pnode]="empty";
        toolsSeen("ok");
      }
      releasePreviewBusy();
      repaintTip();
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
            /* p559: declare the probe origins so the run measures the DECLARED case.
             * Empty arrays measured nothing; whether the host honors this is the question. */
            csp: {
              connectDomains: [...PROBE_CSP_DOMAINS],
              /* M-2: the ground LOADS tiles, it does not connect; its origin is
               * derived from the tile template, never a second copy. */
              resourceDomains: [...RESOURCE_CSP_DOMAINS],
            },
          },
        },
      },
    ],
  });
  const probeHandler = async (uri: { href: string }) => ({
    contents: [{ uri: uri.href, mimeType: "text/plain", text: PROBE_RESOURCE_TEXT }],
  });
  if (typeof server.registerResource === "function") {
    server.registerResource("Smart Site board", APP_RESOURCE_URI, { mimeType: APP_MIME }, handler);
    server.registerResource("Smart Site probe", PROBE_RESOURCE_URI, { mimeType: "text/plain" }, probeHandler);
    return;
  }
  if (typeof server.resource === "function") {
    server.resource("Smart Site board", APP_RESOURCE_URI, { mimeType: APP_MIME }, handler);
    server.resource("Smart Site probe", PROBE_RESOURCE_URI, { mimeType: "text/plain" }, probeHandler);
  }
}
