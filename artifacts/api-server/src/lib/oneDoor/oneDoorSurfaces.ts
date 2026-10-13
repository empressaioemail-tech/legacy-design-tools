/**
 * ONE DOOR (WP-L) for the two cortex fact surfaces:
 *
 *   - CFR, the node facets route (`routes/brokerageNodeFacets.ts`)
 *   - CB, the R1 brief (`routes/propertyExplorer.ts` research/brief), which
 *     the Smart Site MCP inline card and panel render
 *
 * Two jobs:
 *
 *  1. `on` mode composition. Every fact the surface shows is the reader's
 *     (`oneDoorReaderClient.ts`): a value rendered from `value`, or the
 *     reader's `words` verbatim. No baked base facts, no atom reads, no cortex
 *     store reads, no local absence wording, no LDT slate
 *     (`parcelRecordAllowlist.ts` is not consulted on this path at all — the
 *     reader owns the slate). The only non-reader input is PLACEMENT (the bake
 *     coordinate and boundary-edge geometry), which the spec keeps on the bake
 *     (§1 "the bake stays only for search, tiles and placement").
 *
 *  2. `shadow` comparison. Reduce what an OLD response body showed to
 *     per-rail answers on the reader's vocabulary and diff them against the
 *     reader, for `oneDoorShadowDiff.ts` to post.
 */

import {
  ONE_DOOR_GATED_RAILS,
  type OneDoorFact,
  type OneDoorRecord,
  type OneDoorState,
} from "./oneDoorReaderClient";
import type {
  OneDoorShadowDiffRow,
  OneDoorShownAnswer,
  OneDoorSurface,
} from "./oneDoorShadowDiff";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// ---------------------------------------------------------------------------
// `on` mode: the facets route body
// ---------------------------------------------------------------------------

export type OneDoorPlacement = {
  /** Bake coordinate (placement only, never a fact). */
  queryPoint: { longitude: number; latitude: number } | null;
};

/**
 * The CFR body in `on` mode. `facts` is the reader's map, verbatim (the reader
 * already projected it for this caller's entitlements). There is no
 * `source: "baked-snapshot"` label, no `facets`/`baseFacts`, and no typed
 * legacy fact keys: a consumer that still reads those is reading an old door.
 */
export function composeOneDoorFacetsBody(args: {
  parcelNodeId: string;
  record: OneDoorRecord;
  placement: OneDoorPlacement;
}): JsonRecord {
  return {
    parcelNodeId: args.parcelNodeId,
    oneDoorMode: "on",
    source: "parcel-record-reader",
    countyFips: args.record.countyFips,
    readAt: args.record.readAt,
    facts: args.record.facts,
    placement: { queryPoint: args.placement.queryPoint },
  };
}

// ---------------------------------------------------------------------------
// `on` mode: the brief body (what the MCP inline card + panel render)
// ---------------------------------------------------------------------------

/** The R1 section ids, mirroring `r1BriefCompose.ts`. */
export type OneDoorBriefSectionId =
  | "zoning"
  | "setbacks-envelope"
  | "flood"
  | "land-use"
  | "drainage";

/**
 * Each brief section is ONE primary rail (whose state and words the section
 * shows) plus companion rails whose values ride in `data` when on record.
 * A primary rail the reader did not return is a section the surface omits:
 * no local wording is invented for a fact the reader did not speak about.
 */
export const ONE_DOOR_BRIEF_SECTIONS: ReadonlyArray<{
  id: OneDoorBriefSectionId;
  title: string;
  primary: string;
  data: ReadonlyArray<{ rail: string; key: string }>;
}> = [
  {
    id: "zoning",
    title: "Zoning",
    primary: "zoningDistrict",
    data: [
      { rail: "zoningDistrict", key: "district" },
      { rail: "zoningJurisdictionKey", key: "jurisdictionKey" },
    ],
  },
  {
    id: "setbacks-envelope",
    title: "Setbacks and buildable envelope",
    primary: "setbackFrontFt",
    data: [
      { rail: "setbackFrontFt", key: "frontFt" },
      { rail: "setbackSideFt", key: "sideFt" },
      { rail: "setbackRearFt", key: "rearFt" },
      { rail: "setbackCornerFt", key: "cornerFt" },
    ],
  },
  { id: "flood", title: "Flood", primary: "flood", data: [{ rail: "flood", key: "*" }] },
  {
    id: "land-use",
    title: "Land use",
    primary: "landUseCode",
    data: [
      { rail: "landUseCode", key: "landUseCode" },
      { rail: "landUseDescription", key: "landUseDescription" },
    ],
  },
  // Live-only fact (§2): present only when the reader lists it.
  { id: "drainage", title: "Drainage", primary: "drainage", data: [{ rail: "drainage", key: "*" }] },
];

/**
 * Reader state -> the R1 section disposition the MCP already understands.
 * The disposition only picks the glyph; the TEXT is always the reader's words
 * (carried on `oneDoor.words` and `reason`).
 */
export function dispositionForOneDoorState(state: OneDoorState): string {
  switch (state) {
    case "value":
      return "present";
    case "not-on-record":
    case "not-applicable":
      return "absent-verified";
    case "not-loaded":
      return "unread";
    case "held":
    case "plan-gated":
      return "refused";
    case "failed":
      return "unknown";
  }
}

/**
 * A companion rail's value is an array of row payloads, in row order
 * (contract `one-door-v1`). The rows ride verbatim under `rows`. For flood,
 * row 0's fields are also named the way the MCP card already reads a flood
 * section (zone -> floodZone, subtype -> zoneSubtype, isSfha ->
 * inSpecialFloodHazardArea) and every row is listed under `zones`: a rename of
 * the reader's own fields, never a new value or a re-ranking.
 */
function companionSectionData(rail: string, value: unknown): JsonRecord {
  if (!Array.isArray(value)) {
    const obj = asRecord(value);
    return obj ? { ...obj } : { value };
  }
  const rows = value.map(asRecord).filter((r): r is JsonRecord => !!r);
  const out: JsonRecord = { rows: value };
  if (rail === "flood" && rows[0]) {
    const first = rows[0];
    if ("zone" in first) out.floodZone = first.zone;
    if ("subtype" in first) out.zoneSubtype = first.subtype;
    if ("isSfha" in first) out.inSpecialFloodHazardArea = first.isSfha;
    if ("baseFloodElevation" in first) out.baseFloodElevation = first.baseFloodElevation;
    out.zones = rows.map((r) => ({
      zone: r.zone ?? null,
      subtype: r.subtype ?? null,
      isSfha: r.isSfha ?? null,
      floodway: r.floodway ?? null,
      bfe: r.baseFloodElevation ?? null,
      areaShare: r.areaShare ?? null,
    }));
  }
  return out;
}

function sectionData(
  record: OneDoorRecord,
  spec: (typeof ONE_DOOR_BRIEF_SECTIONS)[number],
): JsonRecord | null {
  const data: JsonRecord = {};
  let any = false;
  for (const { rail, key } of spec.data) {
    const fact = record.facts[rail];
    if (!fact || fact.state !== "value") continue;
    any = true;
    if (key === "*") {
      Object.assign(data, companionSectionData(rail, fact.value));
    } else {
      data[key] = fact.value;
    }
  }
  return any ? data : null;
}

export type OneDoorBriefSection = {
  id: OneDoorBriefSectionId;
  title: string;
  data: JsonRecord | null;
  citations: string[];
  asOf: string | null;
  disposition: string;
  reason?: string;
  oneDoor: {
    rail: string;
    state: OneDoorState;
    words: string;
    source: OneDoorFact["source"];
  };
};

export function composeOneDoorBriefSections(record: OneDoorRecord): OneDoorBriefSection[] {
  const out: OneDoorBriefSection[] = [];
  for (const spec of ONE_DOOR_BRIEF_SECTIONS) {
    const fact = record.facts[spec.primary];
    if (!fact) continue;
    const citationUrl = str(fact.detail?.citationUrl);
    const section: OneDoorBriefSection = {
      id: spec.id,
      title: spec.title,
      data: fact.state === "value" ? sectionData(record, spec) : null,
      citations: citationUrl && /^https:\/\//i.test(citationUrl) ? [citationUrl] : [],
      asOf: fact.source.asOf ?? fact.source.vintage,
      disposition: dispositionForOneDoorState(fact.state),
      oneDoor: { rail: spec.primary, state: fact.state, words: fact.words, source: fact.source },
    };
    if (fact.state !== "value") section.reason = fact.words;
    out.push(section);
  }
  return out;
}

/**
 * The brief body in `on` mode. Same top-level slots the MCP already reads
 * (`brief.sections`, `draw`, `parcelNodeId`), plus the reader's full fact map
 * under `facts`. No `onRecord` (baked base facts), no typed legacy fact keys,
 * no `source: "baked-snapshot"`.
 */
export function composeOneDoorBriefBody(args: {
  /** The route's own R1 run id, so the existing run-id parsers keep working. */
  runId: string;
  parcelNodeId: string;
  record: OneDoorRecord;
  draw: JsonRecord | null;
}): JsonRecord {
  const sections = composeOneDoorBriefSections(args.record);
  const citations = [...new Set(sections.flatMap((s) => s.citations))];
  return {
    runId: args.runId,
    reportFamily: "R1",
    mode: "one-door-reader-v1",
    oneDoorMode: "on",
    source: "parcel-record-reader",
    parcelNodeId: args.parcelNodeId,
    countyFips: args.record.countyFips,
    readAt: args.record.readAt,
    facts: args.record.facts,
    brief: { sections, disclosure: [] },
    citations,
    ...(args.draw ? { draw: args.draw } : {}),
  };
}

/** The draw label in `on` mode: the reader's situs address value, else nothing. */
export function oneDoorSitusLabel(record: OneDoorRecord): string | null {
  const fact = record.facts.situsAddress;
  return fact && fact.state === "value" ? str(fact.value) : null;
}

/**
 * The rails the brief and facets surfaces show, used to build a `failed`
 * record when the reader is unreachable for an `on` county.
 */
export const ONE_DOOR_SURFACE_RAILS: readonly string[] = [
  "apn",
  "situsAddress",
  "situsCity",
  "situsState",
  "situsZip",
  "landUseCode",
  "acreageAcres",
  "cityLimits",
  "zoningDistrict",
  "flood",
  "setbackFrontFt",
  "setbackSideFt",
  "setbackRearFt",
  "setbackCornerFt",
  "parcelAreaSqFt",
  "maxHeightFt",
  "maxLotCoveragePct",
  "maxFootprintSqFt",
  "maxImperviousCoverPct",
  "owner",
  "marketValue",
  "assessedValue",
  "landValue",
  "improvementValue",
  "livingAreaSqft",
  "yearBuilt",
  "valueHistory",
  "agValuation",
  "schoolDistrict",
  "utilityService",
  "specialDistricts",
  "overlayDistricts",
  "wells",
  "pipelines",
  "buildingFootprint",
];

// ---------------------------------------------------------------------------
// `shadow` mode: what the OLD body showed, per rail
// ---------------------------------------------------------------------------

const OLD_MISSING: OneDoorShownAnswer = { state: "old:missing" };

/** Old typed-fact / refusal tokens onto the reader's states, where the meaning is the same. */
function stateFromOldToken(state: string, code: string | null, absenceKind: string | null): OneDoorShownAnswer["state"] {
  const token = `${code ?? ""} ${absenceKind ?? ""}`.toLowerCase();
  if (state === "present") return "value";
  if (/not-applicable/.test(token)) return "not-applicable";
  if (/join-hold|hold/.test(token)) return "held";
  if (/studio-gated|gated/.test(token)) return "plan-gated";
  if (/not-cut-over|not-slated/.test(token)) return "not-loaded";
  if (/timeout|unavailable|transient|aborted/.test(token)) return "failed";
  if (state === "absent") return "not-on-record";
  return `old:${state}${code ? `:${code}` : ""}`;
}

/** A typed FactRead (`{state: present|absent|refused, code?, absence?}`) or a bare scalar. */
export function shownFromOld(value: unknown, valueKey?: string): OneDoorShownAnswer {
  if (value === null || value === undefined) return OLD_MISSING;
  const rec = asRecord(value);
  if (!rec) return { state: "value", value };
  const stateRaw = str(rec.state);
  if (!stateRaw) {
    // A wire value object, e.g. `{ value, source }`, or a section `data` block.
    if ("value" in rec) return { state: "value", value: rec.value };
    if (valueKey && valueKey in rec) return { state: "value", value: rec[valueKey] };
    return { state: "value", value: rec };
  }
  const code = str(rec.code);
  const absenceKind = str(asRecord(rec.absence)?.kind) ?? str(rec.kind);
  const state = stateFromOldToken(stateRaw, code, absenceKind);
  const out: OneDoorShownAnswer = { state };
  if (state === "value") {
    out.value = valueKey ? rec[valueKey] : "value" in rec ? rec.value : undefined;
  } else {
    const words = str(rec.reason) ?? str(asRecord(rec.absence)?.reason);
    if (words) out.words = words;
  }
  return out;
}

/** A brief section (`disposition`, `data`, `refusal`, `reason`). */
function shownFromSection(section: JsonRecord | null, valueKey: string | null): OneDoorShownAnswer {
  if (!section) return OLD_MISSING;
  const disposition = str(section.disposition) ?? "unstated";
  const data = asRecord(section.data);
  const refusal = asRecord(section.refusal);
  const words = str(section.reason) ?? str(refusal?.reason);
  if (disposition === "present") {
    return { state: "value", value: valueKey && data ? data[valueKey] : data };
  }
  if (disposition === "unread") return { state: "not-loaded", ...(words ? { words } : {}) };
  if (disposition === "refused") {
    return { state: stateFromOldToken("refused", str(refusal?.code), null), ...(words ? { words } : {}) };
  }
  if (disposition === "absent" || disposition === "absent-verified") {
    return { state: "not-on-record", ...(words ? { words } : {}) };
  }
  return { state: `old:${disposition}`, ...(words ? { words } : {}) };
}

type OldExtractor = (body: JsonRecord) => OneDoorShownAnswer;

function at(body: JsonRecord, path: string[]): unknown {
  let cur: unknown = body;
  for (const key of path) {
    const rec = asRecord(cur);
    if (!rec) return undefined;
    cur = rec[key];
  }
  return cur;
}

function sectionOf(body: JsonRecord, id: string): JsonRecord | null {
  const sections = at(body, ["brief", "sections"]);
  if (!Array.isArray(sections)) return null;
  return (sections.map(asRecord).find((s) => s?.id === id) as JsonRecord | undefined) ?? null;
}

/** Facts both surfaces carry under the same top-level typed key. */
const SHARED_TYPED: Record<string, [string, string | undefined]> = {
  cityLimits: ["cityLimitsFact", undefined],
  flood: ["floodHazardFact", "floodZone"],
  setbackFrontFt: ["setbacksFact", "frontFt"],
  setbackSideFt: ["setbacksFact", "sideFt"],
  setbackRearFt: ["setbacksFact", "rearFt"],
  setbackCornerFt: ["setbacksFact", "cornerFt"],
  parcelAreaSqFt: ["parcelAreaSqFtFact", "sqFt"],
  maxHeightFt: ["maxHeightFtFact", "feet"],
  maxLotCoveragePct: ["maxLotCoveragePctFact", undefined],
  maxFootprintSqFt: ["maxFootprintSqFtFact", undefined],
  maxImperviousCoverPct: ["maxImperviousCoverPctFact", undefined],
  owner: ["ownerFact", undefined],
  valueHistory: ["valueHistoryFact", undefined],
  agValuation: ["agValuationFact", undefined],
  schoolDistrict: ["schoolDistrictFact", "districtName"],
  utilityService: ["utilityServiceFact", undefined],
  specialDistricts: ["specialDistrictFact", undefined],
  overlayDistricts: ["overlayDistrictsFact", undefined],
  wells: ["wellFact", undefined],
  pipelines: ["pipelineFact", undefined],
  buildingFootprint: ["buildingFootprintFact", undefined],
};

const CAD_ROLL_RAILS = [
  "marketValue",
  "assessedValue",
  "landValue",
  "improvementValue",
  "livingAreaSqft",
  "yearBuilt",
] as const;

function sharedExtractors(): Record<string, OldExtractor> {
  const out: Record<string, OldExtractor> = {};
  for (const [rail, [key, valueKey]] of Object.entries(SHARED_TYPED)) {
    out[rail] = (body) => shownFromOld(body[key], valueKey);
  }
  return out;
}

/** CFR: baked `facets.baseFacts` + the typed facts it fans out. */
export const CFR_SHOWN: Record<string, OldExtractor> = {
  ...sharedExtractors(),
  apn: (b) => shownFromOld(at(b, ["facets", "baseFacts", "apn"])),
  situsAddress: (b) => shownFromOld(at(b, ["facets", "baseFacts", "situsAddress"])),
  situsCity: (b) => shownFromOld(at(b, ["facets", "baseFacts", "situsCity"])),
  situsState: (b) => shownFromOld(at(b, ["facets", "baseFacts", "situsState"])),
  situsZip: (b) => shownFromOld(at(b, ["facets", "baseFacts", "situsZip"])),
  acreageAcres: (b) => shownFromOld(at(b, ["facets", "baseFacts", "acreage"]), "value"),
  landUseCode: (b) => shownFromOld(b.landUseFact, "landUseCode"),
  zoningDistrict: (b) => shownFromOld(at(b, ["facets", "zoning"]), "district"),
  ...Object.fromEntries(
    CAD_ROLL_RAILS.map((rail) => [
      rail,
      (b: JsonRecord) => shownFromOld(at(b, ["facets", "baseFacts", "cadRoll", rail]), "value"),
    ]),
  ),
};

/** CB: `onRecord`, the brief sections, and the typed facts. */
export const CB_SHOWN: Record<string, OldExtractor> = {
  ...sharedExtractors(),
  apn: (b) => shownFromOld(at(b, ["onRecord", "apn"])),
  acreageAcres: (b) => shownFromOld(at(b, ["onRecord", "acreage"]), "value"),
  situsAddress: (b) => shownFromOld(at(b, ["draw", "label"])),
  situsState: (b) => shownFromOld(at(b, ["onRecord", "situsState"])),
  landUseCode: (b) => shownFromSection(sectionOf(b, "land-use"), "code"),
  zoningDistrict: (b) => shownFromSection(sectionOf(b, "zoning"), "district"),
  flood: (b) => shownFromSection(sectionOf(b, "flood"), "floodZone"),
  setbackFrontFt: (b) => shownFromSection(sectionOf(b, "setbacks-envelope"), "frontFt"),
  setbackSideFt: (b) => shownFromSection(sectionOf(b, "setbacks-envelope"), "sideFt"),
  setbackRearFt: (b) => shownFromSection(sectionOf(b, "setbacks-envelope"), "rearFt"),
  setbackCornerFt: (b) => shownFromSection(sectionOf(b, "setbacks-envelope"), "cornerFt"),
  ...Object.fromEntries(
    CAD_ROLL_RAILS.map((rail) => [
      rail,
      (b: JsonRecord) => shownFromOld(at(b, ["onRecord", "cadRoll", rail]), "value"),
    ]),
  ),
};

/** The reader's value reduced to something comparable with an old scalar. */
function readerComparable(value: unknown, valueKey: string | undefined): unknown {
  // Companion rails: compare against row 0 (e.g. flood's zone).
  if (Array.isArray(value)) value = value.length === 1 ? value[0] : undefined;
  const rec = asRecord(value);
  if (!rec) return value;
  for (const key of [valueKey, "value", "district", "floodZone", "zone", "code", "sqFt", "feet"]) {
    if (key && key in rec) return rec[key];
  }
  return undefined;
}

function sameScalar(a: unknown, b: unknown): boolean | null {
  if (a === undefined || b === undefined) return null;
  if (asRecord(a) || asRecord(b) || Array.isArray(a) || Array.isArray(b)) return null;
  if (typeof a === "number" || typeof b === "number") {
    const x = Number(a);
    const y = Number(b);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return String(a) === String(b);
    return Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(x), Math.abs(y));
  }
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

const VALUE_KEY_HINT: Record<string, string> = {
  flood: "floodZone",
  zoningDistrict: "district",
  landUseCode: "code",
  schoolDistrict: "districtName",
  parcelAreaSqFt: "sqFt",
  maxHeightFt: "feet",
};

/**
 * Diff an OLD body against the reader, one row per rail the reader returned
 * and the surface shows, where state, value or words differ.
 */
export function oneDoorShadowDiffRows(args: {
  surface: OneDoorSurface;
  parcelNodeId: string;
  record: OneDoorRecord;
  oldBody: unknown;
  observedAt?: string;
}): OneDoorShadowDiffRow[] {
  const body = asRecord(args.oldBody) ?? {};
  const extractors = args.surface === "cortex-facets" ? CFR_SHOWN : CB_SHOWN;
  const observedAt = args.observedAt ?? new Date().toISOString();
  const rows: OneDoorShadowDiffRow[] = [];
  for (const [rail, extract] of Object.entries(extractors)) {
    const fact = args.record.facts[rail];
    if (!fact) continue;
    let shown: OneDoorShownAnswer;
    try {
      shown = extract(body);
    } catch {
      shown = OLD_MISSING;
    }
    const differs: OneDoorShadowDiffRow["oldShown"]["differs"] = [];
    if (shown.state !== fact.state) differs.push("state");
    if (shown.state === "value" && fact.state === "value") {
      const same = sameScalar(shown.value, readerComparable(fact.value, VALUE_KEY_HINT[rail]));
      if (same === false) differs.push("value");
    }
    if (
      fact.state !== "value" &&
      shown.state !== "value" &&
      typeof shown.words === "string" &&
      shown.words.trim() !== fact.words.trim()
    ) {
      differs.push("words");
    }
    if (!differs.length) continue;
    // Gated rails (owner, dollars) are compared here but never leave this
    // process with their values: the sink records only that they differed.
    const redact = (ONE_DOOR_GATED_RAILS as readonly string[]).includes(rail);
    if (redact) {
      const { value: _dropped, ...rest } = shown;
      shown = rest;
    }
    rows.push({
      countyFips: args.record.countyFips ?? args.parcelNodeId.split(":")[0]!,
      parcelNodeId: args.parcelNodeId,
      surface: args.surface,
      fact: rail,
      oldShown: { ...shown, differs },
      readerState: fact.state,
      readerValue: fact.state === "value" && !redact ? fact.value : null,
      readerWords: fact.words,
      mode: args.record.mode,
      observedAt,
    });
  }
  return rows;
}
