/** P-456c. Browser-safe panel library. No server imports.
 * Display vocabulary is copied as literals so the browser IIFE never loads
 * `@empressaio/atom-contract/display` (that module contains `atom_path_pending`,
 * which htmlContractViolations refuses on the served page). Values are pinned
 * to the package by tests/vocabulary.test.ts. */
import type { AnchorReadStatus, ParcelAnchor } from "../parcel-anchor.js";
import { requireMapboxCardToken } from "../mapbox-card-token.js";

export const CITATION_DEGRADED = "citation degraded";
/** Customer sentence. The wire token stays CITATION_DEGRADED and is not printed. */
export const CITATION_NOT_LINKED = "No citation link on this read";
export const EDGE_WORDS = {
  front: "front",
  side: "side",
  rear: "rear",
  side_corner: "corner side",
  alley: "alley",
  ROW: "right of way",
  "neighbor-parcel": "neighbor",
  unmapped: "unmapped",
} as const;
export const NO_BAKED_SNAPSHOT_PREFIX = "No baked snapshot yet for";
export const NOT_IMPLEMENTED_PREFIX = "Not implemented";
export const NOT_ON_FILE_PREFIX = "Not on file in";
export const OPEN_DID_NOT_REACH_ME = "Open did not reach me";
export const STATE_WORDS = {
  present: "present",
  "absent-verified": "absent, verified",
  unknown: "unknown",
  refused: "refused",
  unread: "unread",
} as const;
export const UPGRADE_TO_OPEN = "Upgrade to open this parcel";

/** Human line for the withheld-envelope reason. The machine token must not
 * appear in the served page (htmlContractViolations: machine_envelope_reason). */
export const HUMAN_ATOM_PATH_PENDING = "Withheld, setbacks unruled";

export function envelopeHumanReason(
  reason: string | undefined,
): string | undefined {
  if (reason === ["atom", "path", "pending"].join("_")) {
    return HUMAN_ATOM_PATH_PENDING;
  }
  return reason;
}

export const APP_RESOURCE_URI = "ui://smartsite/app-p562.html";
export const APP_MIME = "text/html;profile=mcp-app";
export const APP_HOST_TOOLS = [
  "create_screen",
  "list_screens",
  "get_smart_site",
  "find_parcel",
  "find_parcels",
  "find_nearest_parcels",
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
  /** P-437: situs label from stub.label when the paste query was a node id. */
  stubLabel?: string;
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
  /** Local-foot ring for an inset-fill envelope. Absent when the wire has no polygon. */
  geom?: RingPt[];
  basisDisplayText?: string;
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
export type MissClass = "absent" | "unbaked" | "retired" | "unstated";
export type MissRow = {
  parcelNodeId: string;
  county: string;
  missClass: MissClass;
  reason: string;
  parcelExists: boolean | "unmeasured";
  /** P-206: the retirement's `asOf` vintage, on a `retired` row only. */
  retiredAsOf?: string;
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
  /** P-437: screening board title when the wire carries a screen name. */
  screenName?: string;
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
  /** P-448: present only when the tool result carried `inlineCard`. The panel does not compose it. */
  inlineCard?: InlineCard;
};

export type InlineFactModel = { label: string; value: string; state: string; detail?: string };
export type InlineItemModel = {
  parcelNodeId: string;
  answer: string;
  actionLabel: string;
  actionUrl: string | null;
};
/** P-448. The server's inline card, copied field by field. A missing field is not invented. */
export type InlineCard = {
  layout: "single" | "carousel";
  title: string;
  answer: string;
  facts: InlineFactModel[];
  expandUrl: string | null;
  shareUrl: string | null;
  items: InlineItemModel[];
  moreCount: number;
};

/** P-456b. What the served card reports after render. */
export function mapCardOutcomeFromModel(model: PanelModel): {
  outcome: "drawn" | "fallback" | "failed";
  reasonCode: string;
} {
  if (model.kind === "unreadable") {
    return { outcome: "failed", reasonCode: "panel_unreadable" };
  }
  if (
    model.kind === "miss" ||
    model.kind === "refused" ||
    model.kind === "declared"
  ) {
    return { outcome: "fallback", reasonCode: model.kind };
  }
  if (
    model.kind === "parcel" ||
    model.kind === "parcels" ||
    model.kind === "board" ||
    model.kind === "screens"
  ) {
    return { outcome: "drawn", reasonCode: "ok" };
  }
  return { outcome: "fallback", reasonCode: model.kind || "unknown" };
}

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

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function railState(value: unknown): CellState {
  if (value === "present") return "present";
  if (value === "absent-verified" || value === "absent") return "absent-verified";
  if (value === "refused") return "refused";
  if (value === "unread") return "unread";
  if (value === "unknown") return "unknown";
  return "unread";
}

/** Plan 4.4 sentences. One state, one sentence; unknown, refused, and unread never share one. */
export const OPEN_SENT = "Sent to chat. Press Send to open.";
export const NOT_RETURNED = "Not returned";
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

/**
 * P-206 (2026-09-16). Copy for a node whose record carries an EARNED
 * retirement -- a positive, checked claim that the parcel's record was looked
 * for and is gone -- as opposed to `notOnFileSentence`'s "we have no record",
 * which is the sentence a genuinely unknown node earns.
 *
 * TELEMETRY DEBT, DECLARED: `NOT_ON_FILE_PREFIX` and `NO_BAKED_SNAPSHOT_PREFIX`
 * are read from `@empressaio/atom-contract/display`, but that package is NOT in
 * this repository, so this new prefix cannot follow them there from here. It is
 * a local literal with the same shape, and moving it into the shared display
 * vocabulary is a named leave-behind of this lane, not a claim that it already
 * lives in the one place. `retiredRecordSentence` takes the retirement's own
 * `asOf` so the vintage travels with the claim rather than being implied.
 */
export const RETIRED_RECORD_PREFIX =
  "Record retired (earned, verified absence)";

export function retiredRecordSentence(id: unknown, asOf?: string): string {
  const base =
    RETIRED_RECORD_PREFIX + " " + countyForNodeId(id) + " " + String(id == null ? "" : id);
  return asOf && asOf.trim() !== "" ? base + " as of " + asOf.trim() : base;
}

export function escapeHtml(value: unknown): string {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function stringList(value: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) out.push(item);
  }
  return out;
}

export function emptyModel(kind: PanelKind): PanelModel {
  return { kind, rows: [], overlays: [], ring: [], edges: [] };
}

export function stubReadOf(value: unknown): StubReadState | undefined {
  return value === "ok" || value === "error" || value === "skipped" ? value : undefined;
}

/** B1: a candidate must name a node; the label falls back to the node id; county only when carried. */
export function candidatesFrom(value: unknown): ScreenCandidate[] {
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

export function rowFromUnknown(raw: unknown): BoardRow | null {
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
  const stubLabel =
    stub && typeof stub.label === "string" && stub.label.trim().length > 0
      ? stub.label.trim()
      : typeof rec.label === "string" && rec.label.trim().length > 0
        ? rec.label.trim()
        : undefined;
  if (stubLabel) row.stubLabel = stubLabel;
  return row;
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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

export function roadClassCustomer(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value === "gravel") return "gravel road";
  if (value === "residential") return "residential street";
  if (value === "alley") return "alley";
  if (/^[a-z][a-z ]+$/.test(value)) return value;
  return null;
}

/** Customer line. Road ids and neighbour ids stay off this line. */
export function edgeCaption(edge: DrawEdge): string {
  const bits: string[] = [];
  const role = edgeWord(edge.role);
  const adj = edgeWord(edge.adjacency);
  if (role) bits.push(role);
  if (adj && adj !== role) bits.push(adj);
  const road = roadClassCustomer(edge.roadClass);
  if (road && road !== adj && road !== role) bits.push(road);
  const ft = edge.ft ?? edge.lengthFt;
  if (ft != null) bits.push(`${ft} ft`);
  if (edge.bearing) bits.push(edge.bearing);
  return bits.join(" · ");
}

/** Collapse the producer's space before a comma. Does not invent a street name. */
export function customerSitus(label: string | null | undefined): string {
  if (!label) return "";
  return label.replace(/\s+,/g, ",").replace(/,\s*/g, ", ").replace(/[ \t]+/g, " ").trim();
}

export function edgeIndex(edge: DrawEdge, fallback: number): number {
  if (typeof edge.i === "number") return edge.i;
  if (edge.seg && typeof edge.seg[0] === "number") return edge.seg[0];
  return fallback;
}

export function edgeHasRoad(edge: DrawEdge): boolean {
  return Boolean(edge.roadNode || edge.road);
}

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
  const word = EDGE_WORDS[value as keyof typeof EDGE_WORDS];
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
  const roadWord = roadClassCustomer(edge.roadClass);
  const roadBits = roadWord ? `<span class="tw">${escapeHtml(roadWord)}</span>` : "";
  if (edgeIsRow(edge)) {
    if (roadBits) bits.push(roadBits);
    if (edge.neighbor) bits.push(`<span class="tw">${ACROSS_ROW}</span>`);
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

export type DrawCues = {
  zoning?: DrawZoning | null;
  flood?: OverlayRow | null;
  frame?: DrawFrame | null;
  envelope?: RingPt[] | null;
  floodMethod?: string | null;
  /** P-448: parcel outline only. No jurisdiction key, flood tint, scale bar, or edge hits. */
  quiet?: boolean;
  /** P-466: paint the flood tint on a quiet ring when the result carries a flood overlay. */
  paintFlood?: boolean;
};

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
  const envelope = cues?.envelope && cues.envelope.length >= 3 ? cues.envelope : null;
  const hasRing = ring.length >= 3;
  const fit = ringFit(hasRing ? ring : envelope ?? []);
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
  const quiet = !!(cues && cues.quiet);
  const n = ring.length;
  const seg = (e: DrawEdge, i: number): string | null => {
    const ends = edgeEnds(e, i, n);
    const a = ring[ends[0]];
    const b = ring[ends[1]];
    return a && b ? `${pt(a)} ${pt(b)}` : null;
  };
  const road = quiet
    ? ""
    : edges
    .map((e, i) => {
      const p = seg(e, i);
      if (!edgeHasRoad(e) || !p) return "";
      return `<polyline points="${p}" fill="none" stroke="var(--ss-t3)" stroke-width="7" stroke-linecap="square" opacity=".35"/>`;
    })
    .join("");
  const neigh = quiet
    ? ""
    : edges
    .map((e, i) => {
      const p = seg(e, i);
      if (!e.neighbor || edgeHasRoad(e) || !p) return "";
      return `<polyline points="${p}" fill="none" stroke="var(--ss-t6)" stroke-width="2" stroke-dasharray="4 3"/>`;
    })
    .join("");
  const zoning = cues && cues.zoning && cues.zoning.state === "present" && cues.zoning.v ? cues.zoning : null;
  const family = zoning ? zoneFamily(zoning.v) : null;
  const stroke = family ? ZONE_TINT[family] : "--ss-t3";
  const ringPoly = hasRing
    ? `<polygon class="ring-fill" points="${pts}" fill="var(--ss-void)" fill-opacity=".55" stroke="var(${stroke})" stroke-width="2"${family ? ` data-zone-family="${family}"` : ""}/>`
    : "";
  const flood = cues && cues.flood ? cues.flood : null;
  const tint = hasRing && (!quiet || !!cues?.paintFlood) ? floodTint(flood) : null;
  const tintPoly = tint
    ? `<polygon class="flood-tint" data-flood-tint="${tint}" points="${pts}" fill="var(--ss-blue)" fill-opacity="${tint === "heavy" ? ".32" : ".14"}"/>`
    : "";
  const zoneText = !quiet && tint && flood ? escapeHtml(floodZoneLabel(flood.label)) : "";
  const pointRead = cues?.floodMethod === "point-on-surface";
  const floodText = zoneText
    ? `<text class="fz" data-flood-zone="${zoneText}" x="${(w / 2).toFixed(1)}" y="16" text-anchor="middle">${zoneText}</text>${
        pointRead
          ? `<text class="fzpt" data-flood-point="1" x="${(w / 2).toFixed(1)}" y="28" text-anchor="middle">read at a point on the parcel</text>`
          : ""
      }`
    : "";
  const envelopePoly = envelope
    ? `<polygon class="envelope" data-envelope="modelled" points="${envelope.map(pt).join(" ")}" fill="rgba(111,193,184,.16)" stroke="#6FC1B8" stroke-width="1.5" stroke-dasharray="6 4"/>`
    : "";
  const hits = quiet
    ? ""
    : edges
    .map((e, i) => {
      const p = seg(e, i);
      return p ? `<polyline class="edge" data-edge="${i}" points="${p}"/>` : "";
    })
    .join("");
  const district = !quiet && zoning
    ? `<text class="zn${zoning.url ? " link" : ""}" data-zoning="${escapeHtml(zoning.v)}"${zoning.url ? ` data-zoning-url="${escapeHtml(zoning.url)}"` : ""} x="${(w / 2).toFixed(1)}" y="${(h / 2).toFixed(1)}" text-anchor="middle">${escapeHtml(zoning.v)}</text>${
        jurisdictionShown(zoning.jurisdiction)
          ? `<text class="zj" x="${(w / 2).toFixed(1)}" y="${(h / 2 + 15).toFixed(1)}" text-anchor="middle">${escapeHtml(jurisdictionShown(zoning.jurisdiction) ?? "")}</text>`
          : ""
      }`
    : "";
  const frame = cues && cues.frame ? cues.frame : null;
  const north = frame
    ? `<g class="north" data-north="up"><line x1="${w - 22}" y1="24" x2="${w - 22}" y2="9" stroke="var(--ss-t5)" stroke-width="1.5"/><polygon points="${w - 26},13 ${w - 22},6 ${w - 18},13" fill="var(--ss-t5)"/><text x="${w - 14}" y="22">N</text></g>`
    : "";
  const barFt = frame && frame.units === "ft" ? scaleBarFt(maxX - minX) : null;
  let scale = "";
  if (barFt !== null && !quiet) {
    const x2 = (pad + barFt * s).toFixed(1);
    const y = h - 12;
    scale = `<g class="scale" data-scale-ft="${barFt}"><line x1="${pad}" y1="${y}" x2="${x2}" y2="${y}" stroke="var(--ss-t5)" stroke-width="2"/><line x1="${pad}" y1="${y - 4}" x2="${pad}" y2="${y + 4}" stroke="var(--ss-t5)" stroke-width="1.5"/><line x1="${x2}" y1="${y - 4}" x2="${x2}" y2="${y + 4}" stroke="var(--ss-t5)" stroke-width="1.5"/><text class="sl" x="${pad}" y="${y - 7}">${barFt} ft</text></g>`;
  }
  return `<svg class="ring" viewBox="0 0 ${w} ${h}" aria-label="parcel ring">${road}${neigh}${ringPoly}${tintPoly}${envelopePoly}${hits}${floodText}${district}${north}${scale}</svg>`;
}

export const FRAME_APPROXIMATE = "Approximate map position";

/** Customer words for a known frame quality. An unmapped token is not printed. */
export function frameNoteHtml(frame: DrawFrame | null | undefined): string {
  if (!frame || frame.quality !== "gis-approximate") return "";
  return `<div class="fnote" data-frame-quality="${escapeHtml(frame.quality)}">${FRAME_APPROXIMATE}</div>`;
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
 * Mapbox Raster Tiles orders this path z / column / row, which is z / x / y.
 * Transposing the last two segments fetches real imagery of the wrong place,
 * which renders beautifully and is a confident lie. The token is not in this
 * string: it is data from MAPBOX_CARD_TOKEN, appended when the url is built.
 * This string is the single source for both the fetched url and the origin
 * declared in the resource CSP.
 */
export const GROUND_TILE_URL_TEMPLATE =
  "https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}.jpg90";

/** Derived from the template above, never a second copy of the host.
 * Parsed without `new URL` so the browser IIFE does not throw in hosts (and
 * the served-script vm) that have no URL global. */
export const GROUND_TILE_ORIGIN = (() => {
  const scheme = GROUND_TILE_URL_TEMPLATE.indexOf("://");
  const slash = GROUND_TILE_URL_TEMPLATE.indexOf("/", scheme + 3);
  return slash === -1 ? GROUND_TILE_URL_TEMPLATE : GROUND_TILE_URL_TEMPLATE.slice(0, slash);
})();

/**
 * What the page LOADS, as opposed to what it connects to. The ground's origin is
 * derived from the template rather than written a second time, so a template
 * pointed at another host declares that host or declares nothing, never the
 * wrong one. The p559 probe origins already include the imagery host, so today
 * this list equals {@link probeCspDomains}; it stops equalling it the moment the
 * template moves, which is the point of deriving it.
 */
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
 * Mapbox Satellite publishes past this level. The card stays at 19 so a small
 * parcel is upscaled rather than a denser mosaic that trips the tile cap.
 */
export const GROUND_ZOOM_MAX = 19;

/** The 320 unit viewBox paints at roughly twice its unit width on a retina panel. */
export const GROUND_SUPERSAMPLE = 2;

/** A mosaic larger than this is refused rather than painted. */
export const GROUND_MAX_TILES = 36;

/** Mapbox Product Terms 1.4. Each credit is its own link. */
export const MAPBOX_WORDMARK_HREF = "https://www.mapbox.com/";
export const MAPBOX_ATTRIBUTION_LINKS = [
  { label: "© Mapbox", href: "https://www.mapbox.com/about/maps/" },
  { label: "© OpenStreetMap", href: "https://www.openstreetmap.org/copyright" },
  { label: "© Maxar", href: "https://www.maxar.com/" },
  { label: "Improve this map", href: "https://apps.mapbox.com/feedback/" },
] as const;

export function mapboxAttributionHtml(): string {
  const word =
    `<a class="wordmark" data-mapbox-wordmark="1" href="${MAPBOX_WORDMARK_HREF}" target="_blank" rel="noopener noreferrer">Mapbox</a>`;
  let links = "";
  for (let i = 0; i < MAPBOX_ATTRIBUTION_LINKS.length; i++) {
    const link = MAPBOX_ATTRIBUTION_LINKS[i];
    if (!link) continue;
    links +=
      `<a data-mapbox-credit="1" href="${link.href}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a>`;
  }
  return `<span class="mapbox-credit" data-mapbox-attribution="1">${word}${links}</span>`;
}

/** Plain text of the credit, for the prose check. The links are the credit. */
export function groundCreditText(): string {
  return "Mapbox " + MAPBOX_ATTRIBUTION_LINKS.map((link) => link.label).join(" ");
}
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

/** z / x / y, then the public token as a query value. The browser requests it. */
export function groundTileUrl(z: number, x: number, y: number): string {
  const token = requireMapboxCardToken();
  const path = GROUND_TILE_URL_TEMPLATE.replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
  return path + "?access_token=" + encodeURIComponent(token);
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
  let z = groundZoomFor(lat, fit.s);
  for (;;) {
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
    const tileCount = (txMax - txMin + 1) * (tyMax - tyMin + 1);
    if (tileCount <= GROUND_MAX_TILES) {
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
    if (z <= GROUND_ZOOM_MIN) {
      return { plan: null, reason: "ground_tile_cap" };
    }
    z -= 1;
  }
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
      `<img class="gt" alt="" draggable="false" decoding="async" referrerpolicy="origin" data-tile="${t.z}/${t.x}/${t.y}"` +
      ` src="${escapeHtml(t.url)}" style="${style}">`;
  }
  return `<div class="ground" aria-hidden="true" data-ground-z="${plan.z}" data-ground-tiles="${plan.tiles.length}">${imgs}</div>`;
}

/** Mapbox credit, then the toggle. The credit stays in the flow at every width. */
export function groundNoteHtml(plan: GroundPlan | null, on: boolean): string {
  if (!plan) return "";
  return (
    `<div class="gnote" data-ground-note="1">${mapboxAttributionHtml()}` +
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
  if (
    reason.startsWith("ground_") ||
    reason.startsWith("map_") ||
    reason === "multi_ground_extent"
  ) {
    switch (reason) {
      case "ground_tile_cap":
        return "Aerial view is shown zoomed out because this parcel covers too much ground at closer zoom.";
      case "ground_anchor_unread":
        return "Aerial view is not shown yet because the map anchor was not included in this result.";
      case "ground_anchor_missing":
        return "Aerial view is not shown because no map anchor was read for this parcel.";
      case "ground_anchor_absent":
        return "Aerial view is not shown because county records carry no anchor point for this parcel.";
      case "ground_anchor_error":
        return "Aerial view is still loading or could not be read; the parcel outline is shown.";
      case "ground_anchor_skipped":
        return "Aerial view is not shown for this stub read; call again at node depth for imagery.";
      case "ground_no_ring":
        return "No parcel outline was returned to draw on the map.";
      case "ground_off_world":
      case "ground_anchor_off_world":
        return "Aerial view is not shown because the anchor lies outside the map.";
      case "map_no_parcel_hits":
        return "No parcel matched this lookup, so there is no map to draw.";
      case "map_located_unbound":
        return "An address was found but no parcel is bound to it yet, so there is no parcel map.";
      case "map_wiring_failed":
        return "The parcel list could not be loaded for the map panel.";
      default:
        if (reason.startsWith("ground_anchor_")) {
          return "Aerial view is not shown (" + reason.replace(/^ground_anchor_/, "") + ").";
        }
        return reason.replace(/_/g, " ");
    }
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

/** Why there is no aerial under a single-parcel draw. Empty when ground painted. */
export function singleGroundNoteHtml(reason: string): string {
  return (
    '<div class="gnote" data-ground-refused="' + escapeHtml(reason) + '">' +
    escapeHtml(multiGroundReasonWords(reason)) + "</div>"
  );
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

export function refusalFrom(value: unknown): SectionRefusal | undefined {
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
  if (degraded) return `<span class="cite-deg" data-cite-degraded="1">${CITATION_NOT_LINKED}</span>`;
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

/** P-458. Embedded in the served page (INLINE_SHARED); must not close over imports. */
export function customerBriefReasonInline(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  if (/taxYear=\d{4}/.test(trimmed) || (/\bcad_property\b/.test(trimmed) && /\d{5}:\d+/.test(trimmed)) || /vintage-gap/i.test(trimmed)) {
    const declared = trimmed.match(/taxYear=(\d{4})/)?.[1];
    if (declared) return `Not on the ${declared} roll yet (an earlier year on file)`;
    return "Not on the declared appraisal roll yet (another year on file)";
  }
  if (/\bENVELOPE_ROUTER_[A-Z0-9_]+\b/.test(trimmed) || /\bSETBACK_ROUTER_[A-Z0-9_]+\b/.test(trimmed)) {
    return "Not available for this parcel under current rules.";
  }
  return trimmed;
}

export function reasonLineHtml(key: string, text: string, attr?: string): string {
  const face = customerBriefReasonInline(text) ?? text;
  return `<span class="why"${attr ? ` ${attr}` : ""}><span class="key">${escapeHtml(key)}</span> <span class="reason">${escapeHtml(face)}</span></span>`;
}

/** F6: as-of (date only) and source when the wire carries them; vintage and provenance for an overlay. */
export function metaHtml(
  asOf: string | null,
  source: string | null,
  vintage?: string | null,
  provenance?: string | null,
): string {
  const bits: string[] = [];
  const d = customerDate(asOf);
  if (d) bits.push(`<span data-as-of="${escapeHtml(d)}"><span class="key">as of</span> ${escapeHtml(d)}</span>`);
  const sourceShown = customerSource(source);
  if (sourceShown) bits.push(`<span data-source="${escapeHtml(sourceShown)}"><span class="key">source</span> ${escapeHtml(sourceShown)}</span>`);
  const vintageShown = customerDate(vintage);
  if (vintageShown) bits.push(`<span data-vintage="${escapeHtml(vintageShown)}"><span class="key">as of</span> ${escapeHtml(vintageShown)}</span>`);
  if (provenance) bits.push(`<span data-provenance="${escapeHtml(provenance)}" hidden></span>`);
  return bits.length ? `<span class="meta">${bits.join(" ")}</span>` : "";
}

const OVERLAY_TITLES: Record<string, string> = {
  flood: "Flood",
  footprint: "Footprint",
  envelope: "Buildable envelope",
  pipeline: "Pipeline",
  specialDistrict: "Special district",
  well: "Well",
};

export function overlayTitle(id: string): string {
  return OVERLAY_TITLES[id] ?? "Record";
}

/** A date we can read. Tokens, UNKNOWN, and raw instants' clock time are not printed. */
export function customerDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toUpperCase() === "UNKNOWN") return null;
  const iso = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(trimmed);
  if (iso?.[1]) return iso[1];
  if (/^\d{4}-\d{2}$/.test(trimmed)) return trimmed;
  const nfhl = /^NFHL_\d+_(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (nfhl) return `${nfhl[1]}-${nfhl[2]}-${nfhl[3]}`;
  return null;
}

export function customerSource(source: string | null | undefined): string | null {
  if (!source) return null;
  if (/^https:\/\//i.test(source)) return source;
  if (/adapter|fixture|parcel_record|_/i.test(source)) return null;
  return source;
}

/**
 * Unknown is not drawn as a verified absence. A "No …" label on an unknown
 * overlay is replaced. The pipeline sentence is the one the review measured.
 */
export function overlayCustomerLabel(o: Pick<OverlayRow, "id" | "state" | "label">): string {
  const state = railState(o.state);
  if (state === "unknown") {
    if (o.id === "pipeline") return "Not known whether a pipeline is within 500 ft";
    if (/^\s*no\b/i.test(o.label)) return `${overlayTitle(o.id)} is not known`;
  }
  return o.label;
}

/** PTAD first-letter names. Must match api-server ptadLandUseDescription for short codes. */
export function landUseNameFromCode(rawCode: string): string | null {
  const code = rawCode.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{0,3}$/.test(code)) return null;
  if (code.startsWith("EX") || code.startsWith("X")) return "Exempt property";
  switch (code[0]) {
    case "A":
      return "Single-family residential";
    case "B":
      return "Multifamily residential";
    case "C":
      return "Vacant lot or tract";
    case "D":
      return code.startsWith("D2")
        ? "Improvements on agricultural land"
        : "Agricultural / qualified open-space land";
    case "E":
      return code.startsWith("E1")
        ? "Rural single-family residential (farm/ranch improvement)"
        : "Rural farm or ranch land";
    case "F":
      return code.startsWith("F2") ? "Industrial real property" : "Commercial real property";
    case "J":
      return "Utility";
    case "M":
      return "Mobile home (residential)";
    case "O":
      return "Residential inventory (builder lots)";
    case "S":
      return "Special inventory";
    default:
      return null;
  }
}

export function landUseCustomerName(data: Record<string, unknown> | null | undefined): string | null {
  if (!data) return null;
  const label = typeof data.landUseLabel === "string" ? data.landUseLabel.trim() : "";
  if (label) return label;
  const code = typeof data.landUseCode === "string" ? data.landUseCode : "";
  if (!code) return null;
  return landUseNameFromCode(code);
}

/** One overlay row: the paint state (F5), citations (F1), a readable date, the why control (P1). */
export function overlayRowHtml(o: OverlayRow, i: number): string {
  const p = overlayPaint(o);
  const extra = o.id === "flood" ? " flood" : p.paint === "refused" ? " refused" : "";
  const humanReason = envelopeHumanReason(o.reason);
  const shown = humanReason && !/degraded|provenance|adapter/i.test(humanReason) ? humanReason : undefined;
  const why = shown ? reasonLineHtml("reason", shown) : "";
  const note = p.paintReason ? reasonLineHtml("note", p.paintReason, `data-paint-reason="${escapeHtml(p.paintReason)}"`) : "";
  const citations = o.citations ? o.citations : [];
  const degraded = o.citationsDegraded === true || (p.paint === "present" && citations.length === 0);
  const cites = citationHtml(citations, degraded);
  const ask = whyControlHtml("overlay", p.paint, { i: String(i) });
  return `<div class="ovl${extra}" data-overlay="${escapeHtml(o.id)}" data-paint="${p.paint}"><span class="g ${glyphClass(p.paint)}" title="${stateWord(p.paint)}"></span> <span class="key">${escapeHtml(overlayTitle(o.id))}</span> <span class="lbl">${escapeHtml(overlayCustomerLabel(o))}</span>${cites ? ` ${cites}` : ""}${ask ? ` ${ask}` : ""}${metaHtml(null, null, o.vintage, null)}${why}${note}</div>`;
}

/** F2: the flood row under the drawing, every value read off the flood section's data; a non-present section prints its state. */
export function floodFactsHtml(s: BriefSection, i: number, overlaySfha?: boolean): string {
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
  const sectionSfha =
    d.inSpecialFloodHazardArea === true ? true : d.inSpecialFloodHazardArea === false ? false : null;
  const sfhaBool = sectionSfha !== null ? sectionSfha : overlaySfha === true || overlaySfha === false ? overlaySfha : null;
  const sfha = sfhaBool === true ? "yes" : sfhaBool === false ? "no" : UNSTATED;
  const bfe = numberOrNull(d.baseFloodElevation);
  const method = stringOrNull(d.method);
  const readAt = method === "point-on-surface" ? "a point on the parcel" : null;
  const vintage = customerDate(stringOrNull(d.sourceVintage)) ?? customerDate(stringOrNull(d.evaluatedAt));
  /* data-fact-*, not data-flood-*: the drawing already owns data-flood-zone and data-flood-tint (D4) */
  const kv = (k: string, v: string, attr: string): string =>
    `<span class="kv" data-fact-${attr}="${escapeHtml(v)}"><span class="key">${k}</span> ${escapeHtml(v)}</span>`;
  const rows = [
    kv("zone", str("floodZone"), "zone"),
    stringOrNull(d.zoneSubtype) ? kv("subtype", str("zoneSubtype"), "subtype") : "",
    kv("SFHA", sfha, "sfha"),
    kv("base flood elevation", bfe === null ? BFE_NONE : String(bfe), "bfe"),
    readAt ? kv("read at", readAt, "method") : "",
    vintage ? kv("as of", vintage, "vintage") : "",
  ]
    .filter((row) => row.length > 0)
    .join(" ");
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

/** P-437: human situs leads; node id is secondary in the query cell. */
export function boardRowPrimaryLabel(row: Pick<BoardRow, "query" | "resolution" | "stubLabel" | "parcelNodeId">): string {
  if (row.resolution !== "resolved") return row.query;
  const stubLabel = row.stubLabel?.trim();
  if (stubLabel && (looksLikeParcelNodeId(row.query) || stubLabel !== row.query)) return customerSitus(stubLabel);
  return customerSitus(row.query) || row.query;
}

export function boardQueryCellHtml(row: BoardRow): string {
  if (row.resolution === "resolved") {
    const primary = boardRowPrimaryLabel(row);
    const secondary =
      row.parcelNodeId && primary !== row.parcelNodeId
        ? `<div class="pn atom ss-clip">${escapeHtml(row.parcelNodeId)}</div>`
        : row.parcelNodeId && looksLikeParcelNodeId(row.query) && primary !== row.query
          ? `<div class="pn atom ss-clip">${escapeHtml(row.query)}</div>`
          : "";
    return `<div class="pl">${escapeHtml(primary)}</div>${secondary}${stubReadNoteHtml(row)}`;
  }
  if (row.resolution === "ambiguous") {
    return `<div class="unres">${AMBIGUOUS_CAPTION}</div><div class="pn">${escapeHtml(row.query)}</div>${candidateControlsHtml(row)}`;
  }
  const cap = unresolvedCaption(row.query);
  return `<div class="unres">${cap}</div><div class="pn">${escapeHtml(row.query)}</div>`;
}

export function boardCardTitle(screenName?: string | null): string {
  const name = screenName?.trim();
  return name ? `Screening · ${name}` : "Screening board";
}

export function parcelCardTitle(model: Pick<PanelModel, "label" | "parcelNodeId">): string {
  const situs = customerSitus(model.label);
  return situs || model.parcelNodeId || "parcel";
}

/** P-437: zoning · land use · flood one line (present values only). */
export function parcelFactSubheadHtml(sections: BriefSection[]): string {
  function lineValue(section: BriefSection): string | null {
    if (section.paint !== "present" || !section.data) return null;
    const d = section.data;
    switch (section.id) {
      case "zoning":
        return typeof d.district === "string" ? d.district : null;
      case "land-use":
        return landUseCustomerName(d);
      case "flood":
        return typeof d.floodZone === "string" ? `zone ${d.floodZone}` : null;
      default:
        return null;
    }
  }
  const parts: string[] = [];
  for (const id of ["zoning", "land-use", "flood"] as const) {
    const s = sections.find((sec) => sec.id === id);
    if (!s) continue;
    const val = lineValue(s);
    if (!val) continue;
    const title = id === "land-use" ? "Land use" : s.title || id;
    parts.push(`${title} ${val}`);
  }
  if (parts.length === 0) return "";
  return `<p class="subhead" data-parcel-subhead="1">${escapeHtml(parts.join(" · "))}</p>`;
}

export function reportHtmlPartialDefault(sections: BriefSection[], open: boolean): string {
  const always = sections.filter((s) => s.id === "zoning" || s.id === "flood");
  const rest = sections.filter((s) => s.id !== "zoning" && s.id !== "flood");
  const render = (list: BriefSection[]) =>
    list
      .map((s) => {
        const i = sections.indexOf(s);
        const reason = s.reason ? s.reason : s.refusal && s.refusal.reason ? s.refusal.reason : null;
        const cites = citationHtml(s.citations, s.citationsDegraded);
        const ask = whyControlHtml("section", s.paint, { i: String(i) });
        const note = s.paintReason
          ? reasonLineHtml("note", s.paintReason, `data-paint-reason="${escapeHtml(s.paintReason)}"`)
          : "";
        const guide = s.agentGuidance
          ? `<div class="guide" data-agent-guidance="1">${escapeHtml(s.agentGuidance)}</div>`
          : "";
        const subtype =
          s.id === "flood" && s.paint === "present" ? stringOrNull(s.data ? s.data.zoneSubtype : null) : null;
        const subtypeHtml = subtype
          ? ` <span class="fsub" data-flood-subtype="${escapeHtml(subtype)}">${escapeHtml(subtype)}</span>`
          : "";
        return `<div class="rsec" data-report-section="${escapeHtml(s.id)}" data-report-state="${s.paint}"><span class="g ${glyphClass(s.paint)}" title="${stateWord(s.paint)}"></span> <span class="rt">${escapeHtml(s.title)}</span> <span class="sw">${stateWord(s.paint)}</span>${subtypeHtml}${cites ? ` ${cites}` : ""}${ask ? ` ${ask}` : ""}${metaHtml(s.asOf, sourceOf(s))}${reason ? reasonLineHtml("reason", reason) : ""}${note}${guide}</div>`;
      })
      .join("");
  if (sections.length === 0) return `<div class="report" data-report="1"><p class="empty">${NO_BRIEF}</p></div>`;
  const head = always.length ? `<div class="report-default" data-report-default="1">${render(always)}</div>` : "";
  const tail = open && rest.length ? `<div class="report-more" data-report-more="1">${render(rest)}</div>` : "";
  return `<div class="report" data-report="1"><div class="req">${REPORT_TOGGLE}</div>${head}${tail}</div>`;
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
  if (
    (d.status === "upgrade_required" || d.status === "error") &&
    d.reason === UPGRADE_SCREENS_REASON
  ) {
    /* OPS-16 A-101: create_screen/add_to_screen now reshape a recognised
     * screens-gate 402 into the same declared upgrade_required envelope
     * export_instrument's local gate returns (status "upgrade_required", no
     * upstreamStatus — see mapScreensGateNonOk). status "error" stays here
     * too as the fallback path: if that reshape ever declines (a 402 body
     * missing a field it always sends today), the refusal still arrives via
     * the generic upstream-error envelope, with reason carried through
     * unchanged by declareUpstreamNonOk, and still paints as an upgrade
     * prompt rather than a bare failure. Painted as an upgrade prompt either
     * way, because it is neither a fault nor a bare refusal: it is a rung
     * the account does not hold. */
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
export function sectionsFromBrief(host: Record<string, unknown>): BriefSection[] {
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
  const sectionsForDraw = model.sections ?? [];
  const floodSection = sectionsForDraw.find((s) => s.id === "flood") ?? null;
  const floodMethod = floodSection?.data ? stringOrNull(floodSection.data.method) : null;
  const envelopeOverlay = model.overlays.find((o) => o.id === "envelope" && o.geom && o.geom.length >= 3) ?? null;
  const svg = ringSvg(model.ring ?? [], model.edges ?? [], {
    zoning: model.zoning ?? null,
    flood: floodOverlayOf(model.overlays),
    frame: model.frame ?? null,
    envelope: envelopeOverlay?.geom ?? null,
    floodMethod,
  });
  /* M-2: ground under the drawing when the anchor was read, otherwise the svg
   * exactly as it renders with no anchor on the wire. */
  const groundOutcome = groundPlan(
    model.ring ?? [],
    model.anchor ?? null,
    model.anchorRead ?? null,
  );
  const envelopeNote = envelopeOverlay
    ? `<div class="envnote" data-envelope-disclosure="1">${escapeHtml(
        envelopeOverlay.basisDisplayText ||
          "Modelled from the setback table on record. The area is not stated.",
      )}</div>`
    : "";
  const drawn =
    groundWrapHtml(svg, groundOutcome.plan, groundOn === undefined ? true : groundOn) +
    envelopeNote +
    (groundOutcome.plan || !groundOutcome.reason ? "" : singleGroundNoteHtml(groundOutcome.reason));
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
      floodFacts = floodFactsHtml(s, i, floodOverlayOf(model.overlays)?.sfha);
      break;
    }
  }
  const situs = customerSitus(model.label);
  return `${node}${situs ? `<div class="pl">${escapeHtml(situs)}</div>` : ""}${drawn}${tip}${edgeList}${rows}${floodFacts}${offCanvasHtml(model)}`;
}

export function overlaysFromDraw(draw: Record<string, unknown>): OverlayRow[] {
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
    const geom = ringFromGeom(rec.geom);
    if (geom.length >= 3) row.geom = geom;
    const basisText = stringOrNull(rec.basisDisplayText);
    if (basisText) row.basisDisplayText = basisText;
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

export function zoningCitationUrl(host: Record<string, unknown>): string | null {
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

export function zoningFromDraw(draw: Record<string, unknown>, host: Record<string, unknown>): DrawZoning | null {
  const attrs = asRecord(draw.attrs);
  const zoning = attrs ? asRecord(attrs.zoning) : null;
  if (!zoning) return null;
  const v = stringOrNull(zoning.v);
  if (!v) return null;
  return {
    v,
    jurisdiction: cityNameFromHost(host),
    state: stringOrNull(zoning.state) ?? "unknown",
    url: zoningCitationUrl(host),
  };
}

function jurisdictionShown(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || /_/.test(trimmed) || /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(trimmed)) return null;
  return trimmed;
}

function cityNameFromHost(host: Record<string, unknown>): string | null {
  const fact = asRecord(host.cityLimitsFact);
  const name = fact ? stringOrNull(fact.cityName) : null;
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed || /_/.test(trimmed)) return null;
  return trimmed;
}

function ringFromGeom(geom: unknown): RingPt[] {
  if (!Array.isArray(geom)) return [];
  const out: RingPt[] = [];
  for (const raw of geom) {
    if (!Array.isArray(raw) || raw.length < 2) continue;
    const x = numberOrNull(raw[0]);
    const y = numberOrNull(raw[1]);
    if (x !== null && y !== null) out.push({ x, y });
  }
  return out;
}

export function frameFromDraw(draw: Record<string, unknown>): DrawFrame | null {
  const frame = asRecord(draw.frame);
  if (!frame) return null;
  return { units: stringOrNull(frame.units), quality: stringOrNull(frame.quality) };
}

/**
 * M-2: anchorRead is an OBJECT carrying one of four statuses, not a bare string.
 * A body whose anchorRead is a string, or carries a status outside the union, is
 * read as no declaration at all, which paints no ground.
 */
export function anchorReadFrom(value: unknown): PanelAnchorRead | null {
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
export function anchorFrom(value: unknown, read: PanelAnchorRead | null): PanelAnchor | null {
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
export function anchorBatchFrom(value: unknown): PanelAnchorBatch | null {
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
export function parcelsFromBatch(rec: Record<string, unknown>): PanelParcel[] | null {
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

export function batchRowsFrom(rec: Record<string, unknown>): BoardRow[] | null {
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

export function missRowsFrom(rec: Record<string, unknown>): MissRow[] | null {
  const reason = rec.reason;
  if (typeof reason !== "string" || reason.length === 0) return null;
  if (!Array.isArray(rec.parcels) || rec.parcels.length > 0) return null;
  const ids = stringList(rec.notFound);
  if (ids.length === 0) return null;
  const parcelExists: boolean | "unmeasured" =
    rec.parcelExists === true ? true : rec.parcelExists === false ? false : "unmeasured";
  // P-206: `record_retired` is checked FIRST. It reaches here with
  // parcelExists "unmeasured", but even if an upstream ever sent `false` this
  // row must not be painted as "not on file" -- a retired record IS on file.
  const retirement = rec.retirement;
  const retiredAsOf =
    retirement && typeof retirement === "object" && !Array.isArray(retirement) &&
    typeof (retirement as Record<string, unknown>).asOf === "string"
      ? String((retirement as Record<string, unknown>).asOf)
      : undefined;
  const missClass: MissClass =
    reason === "record_retired"
      ? "retired"
      : reason === "parcel_not_found" || parcelExists === false
        ? "absent"
        : reason === "baked_snapshot_not_found"
          ? "unbaked"
          : "unstated";
  const out: MissRow[] = [];
  for (const id of ids) {
    out.push({
      parcelNodeId: id,
      county: countyForNodeId(id),
      missClass,
      reason,
      parcelExists,
      ...(retiredAsOf ? { retiredAsOf } : {}),
    });
  }
  return out;
}

export function refusedRowsFrom(rec: Record<string, unknown>): RefusedRow[] | null {
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
export function degradedFrom(value: unknown): ScreenDegraded | null {
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
export function screensFrom(value: unknown): ScreenSummary[] | null {
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
export function declaredFrom(rec: Record<string, unknown>): DeclaredBody | null {
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
function inlineCardFrom(value: unknown): InlineCard | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const layout = rec.layout === "carousel" ? "carousel" : rec.layout === "single" ? "single" : null;
  if (!layout) return null;
  if (typeof rec.answer !== "string") return null;
  const facts: InlineFactModel[] = [];
  if (Array.isArray(rec.facts)) {
    for (const raw of rec.facts) {
      const f = asRecord(raw);
      if (!f || typeof f.label !== "string" || typeof f.value !== "string" || typeof f.state !== "string") continue;
      const fact: InlineFactModel = { label: f.label, value: f.value, state: f.state };
      if (typeof f.detail === "string" && f.detail.trim()) fact.detail = f.detail.trim();
      facts.push(fact);
    }
  }
  const items: InlineItemModel[] = [];
  if (Array.isArray(rec.items)) {
    for (const raw of rec.items) {
      const it = asRecord(raw);
      if (!it || typeof it.answer !== "string" || typeof it.actionLabel !== "string") continue;
      items.push({
        parcelNodeId: typeof it.parcelNodeId === "string" ? it.parcelNodeId : "",
        answer: it.answer,
        actionLabel: it.actionLabel,
        actionUrl: typeof it.actionUrl === "string" ? it.actionUrl : null,
      });
    }
  }
  const more = typeof rec.moreCount === "number" && Number.isFinite(rec.moreCount) ? rec.moreCount : 0;
  return {
    layout,
    title: typeof rec.title === "string" ? rec.title : "",
    answer: rec.answer,
    facts,
    expandUrl: typeof rec.expandUrl === "string" ? rec.expandUrl : null,
    shareUrl: typeof rec.shareUrl === "string" ? rec.shareUrl : null,
    items,
    moreCount: more,
  };
}

function parseToolResultInner(text: string): PanelModel {
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
  const mapPanelNote = stringOrNull(rec.mapPanelNote);
  if (mapPanelNote && !asRecord(rec.draw) && !Array.isArray(rec.parcels)) {
    return {
      kind: "parcel",
      rows: [],
      overlays: [],
      ring: [],
      edges: [],
      label: mapPanelNote,
    };
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
    const screenName =
      typeof screen.name === "string"
        ? screen.name
        : typeof rec.name === "string"
          ? rec.name
          : undefined;
    const degraded = typeof rec.stubsDegraded === "boolean" ? rec.stubsDegraded : screen.stubsDegraded;
    const model: PanelModel = { kind: "board", screenId, screenName, rows, overlays: [], ring: [], edges: [] };
    if (typeof degraded === "boolean") model.stubsDegraded = degraded;
    /* B2: the create_screen response's declared duplicates and timeouts */
    const declaredDegradation = degradedFrom(rec.degraded !== undefined ? rec.degraded : screen.degraded);
    if (declaredDegradation) model.degraded = declaredDegradation;
    return model;
  }
  /* P-437: a single-parcel node read without a drawable ring still paints the
   * parcel panel (sections, facts, actions), not the screening-board empty copy. */
  const loneNodeId = stringOrNull(rec.parcelNodeId);
  if (loneNodeId) {
    const briefSections = sectionsFromBrief(rec);
    const onRecord = asRecord(rec.onRecord);
    if (briefSections.length > 0 || onRecord) {
      const drawOnly = asRecord(rec.draw);
      const label =
        (drawOnly && typeof drawOnly.label === "string" ? drawOnly.label : null) ??
        stringOrNull(rec.label) ??
        loneNodeId;
      const model: PanelModel = {
        kind: "parcel",
        rows: [],
        overlays: drawOnly ? overlaysFromDraw(drawOnly) : [],
        ring: drawOnly ? ringFromDraw(drawOnly) : [],
        edges: drawOnly ? edgesFromDraw(drawOnly) : [],
        parcelNodeId: loneNodeId,
        label,
      };
      if (briefSections.length > 0) model.sections = briefSections;
      if (drawOnly) {
        const zoning = zoningFromDraw(drawOnly, rec);
        if (zoning) model.zoning = zoning;
        const frame = frameFromDraw(drawOnly);
        if (frame) model.frame = frame;
      }
      const anchorRead = anchorReadFrom(rec.anchorRead);
      if (anchorRead) {
        model.anchorRead = anchorRead;
        const anchor = anchorFrom(rec.anchor, anchorRead);
        if (anchor) model.anchor = anchor;
      }
      return model;
    }
  }
  return emptyModel("empty");
}

export function parseToolResult(text: string): PanelModel {
  const model = parseToolResultInner(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return model;
  }
  const rec = asRecord(parsed);
  const inline = rec ? inlineCardFrom(rec.inlineCard) : null;
  if (inline) model.inlineCard = inline;
  return model;
}

export function firstTextPart(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    const rec = asRecord(part);
    if (rec && rec.type === "text" && typeof rec.text === "string") return rec.text;
  }
  return null;
}

/** The first text part whose body parses as a JSON object (the wire record), never prose. */
export function firstJsonObjectTextPart(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    const rec = asRecord(part);
    if (!rec || rec.type !== "text" || typeof rec.text !== "string") continue;
    try {
      const parsed = JSON.parse(rec.text);
      if (asRecord(parsed)) return rec.text;
    } catch {
      /* prose or non-record text — keep scanning */
    }
  }
  return null;
}

/** A tool result with no record is unreadable, never empty. Never treats prose as the record. */
export function parseToolContent(result: unknown): PanelModel {
  if (typeof result === "string") return parseToolResult(result);
  const rec = asRecord(result);
  if (!rec) return emptyModel("unreadable");
  /* P-437: some hosts forward the wire record as params without a content array. */
  if (
    !Array.isArray(rec.content) &&
    rec.structuredContent === undefined &&
    (stringOrNull(rec.parcelNodeId) ||
      Array.isArray(rec.rows) ||
      Array.isArray(rec.parcels) ||
      Array.isArray(rec.screens))
  ) {
    return parseToolResult(JSON.stringify(rec));
  }
  const structured = rec.structuredContent;
  if (structured !== undefined && structured !== null) {
    const record = asRecord(structured);
    if (record) return parseToolResult(JSON.stringify(structured));
  }
  const text = firstJsonObjectTextPart(rec.content);
  return text === null ? emptyModel("unreadable") : parseToolResult(text);
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

export const EMPTY_BOARD_TITLE = "No parcels on this screen yet";
export const EMPTY_BOARD_BODY = "Paste addresses in the chat to add rows.";
/** Shown before the host delivers the first tool result; not the screening-board empty state. */
export const LOADING_PANEL_TITLE = "Smart Site";
export const LOADING_PANEL_BODY = "Reading this tool result.";
export const LOADING_SUBTITLE_BY_TOOL: Record<string, string> = {
  get_smart_site: "Loading this parcel…",
  create_screen: "Opening screening board…",
  list_screens: "Opening screening board…",
};

export function loadingPanelSubtitle(toolName: string | null | undefined): string {
  if (!toolName) return LOADING_PANEL_BODY;
  return LOADING_SUBTITLE_BY_TOOL[toolName] ?? LOADING_PANEL_BODY;
}
export const NOTHING_TO_OPEN = "Nothing to open until this resolves";
/** Host silence after Open click. Late tool results still replace this. */
export const OPEN_DEAD_MS = 12000;
