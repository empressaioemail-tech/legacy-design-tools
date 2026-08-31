import { envelopeHuman } from "./mcp-app.js";
import {
  DERIVED_FIGURES_POLICY,
  WIRE_DISPOSITION_DISPLAY_TEXT,
} from "./vocabulary.js";

const PUNCTUATION_ONLY_SITUS_RE = /^[\s,.\-;:'"`]+$/;

export function isPunctuationOnlySitusLabel(value: unknown): boolean {
  if (value == null) return true;
  const s = String(value).trim();
  return s === "" || PUNCTUATION_ONLY_SITUS_RE.test(s);
}

const CRM_STATUSES = ["New", "Watching", "Chasing", "Passed"] as const;
export type ExternalCrmStatus = (typeof CRM_STATUSES)[number];

const STUB_RAILS = [
  "situs",
  "zoning",
  "landUse",
  "flood",
  "drainage",
  "envelope",
] as const;

export type ExternalStubRails = {
  situs: string;
  zoning: string;
  landUse: string;
  flood: string;
  drainage: string;
  envelope: string;
};

function asCrmStatus(value: unknown): ExternalCrmStatus | null {
  return typeof value === "string" &&
    (CRM_STATUSES as readonly string[]).includes(value)
    ? (value as ExternalCrmStatus)
    : null;
}

function asStub(value: unknown): ExternalStubRails {
  const rec =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const rail = (key: (typeof STUB_RAILS)[number]) =>
    typeof rec[key] === "string" ? rec[key] : "unread";
  return {
    situs: rail("situs"),
    zoning: rail("zoning"),
    landUse: rail("landUse"),
    flood: rail("flood"),
    drainage: rail("drainage"),
    envelope: rail("envelope"),
  };
}

/** Summary row safe for third-party MCP assistants — no chat snapshots. */
export type ExternalSavedPropertySummary = {
  id: string;
  parcelNodeId: string;
  label: string;
  situs: "present" | "unknown";
  stub: ExternalStubRails;
  status: ExternalCrmStatus | null;
  note: string | null;
  updatedAt: string;
};

export function stripSavedPropertiesForExternal(
  raw: unknown,
): ExternalSavedPropertySummary[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const rows: ExternalSavedPropertySummary[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const parcelNodeId =
      typeof record.parcelNodeId === "string" ? record.parcelNodeId : "";
    if (!id || !parcelNodeId) continue;
    const storedLabel =
      typeof record.label === "string" ? record.label : null;
    const situsUnknown = isPunctuationOnlySitusLabel(storedLabel);
    const label = situsUnknown ? parcelNodeId : storedLabel!.trim();
    const updatedAt =
      typeof record.updatedAt === "string"
        ? record.updatedAt
        : record.updatedAt != null
          ? String(record.updatedAt)
          : "";
    const status = asCrmStatus(record.crmStatus ?? record.status);
    const note = typeof record.note === "string" ? record.note : null;
    rows.push({
      id,
      parcelNodeId,
      label,
      situs: situsUnknown ? "unknown" : "present",
      stub: asStub(record.stub),
      status,
      note,
      updatedAt,
    });
  }
  return rows;
}

export type RunReportHonestyFields = {
  reportKind: "R1-baked-snapshot";
  /** How the MCP server delivered the report (sync read). Distinct from cortex `mode`. */
  reportReadMode: "baked-snapshot-read";
  async: false;
  parcelNodeId: string;
};

/** Flattened cortex R1 body plus honesty fields — same `brief.sections` path as get_smart_site. */
export type RunReportEnvelope = RunReportHonestyFields &
  Record<string, unknown>;

export function buildRunReportEnvelope(
  parcelNodeId: string,
  cortexBodyText: string,
): RunReportEnvelope {
  const honesty: RunReportHonestyFields = {
    reportKind: "R1-baked-snapshot",
    reportReadMode: "baked-snapshot-read",
    async: false,
    parcelNodeId,
  };
  try {
    const parsed: unknown = JSON.parse(cortexBodyText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        ...honesty,
        ...normalizeR1BodyForExternal(parsed as Record<string, unknown>),
      };
    }
  } catch {
    // Non-JSON error bodies stay under `brief`.
  }
  return { ...honesty, brief: cortexBodyText };
}

/**
 * H1 wire half (P-91 v2, 2026-08-30). Every non-OK body this server emits
 * carries a machine-readable `status` and `reason` so the panel can paint a
 * declared line instead of the empty copy. `upstreamStatus` is the HTTP
 * status of the upstream response, or `"unmeasured"` where the boundary
 * that produced the text did not carry it (the export proxy).
 */
export type DeclaredUpstreamErrorBody = {
  status: "error";
  reason: string;
  upstreamStatus: number | "unmeasured";
} & Record<string, unknown>;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Wrap an upstream non-OK (cortex, or Hauska via the export proxy) as a
 * declared error. For run_report this also means no reportKind,
 * reportReadMode, or async: those describe a read that happened, and none
 * did. A JSON object body travels under its own keys; `status: "error"`
 * always wins, and an upstream `status` field moves to `upstreamBodyStatus`
 * (one key, one meaning: `upstreamStatus` is only ever the HTTP status).
 * `reason` is the upstream `reason` when it is a non-empty string, else the
 * upstream `error` code when that is, else `upstream_error`; a non-string
 * upstream `reason` is kept under `upstreamBodyReason`, never dropped.
 * Non-JSON and non-object bodies are `upstream_non_json` with the text
 * under `brief`.
 */
export function declareUpstreamNonOk(
  upstreamStatus: number | "unmeasured",
  bodyText: string,
): DeclaredUpstreamErrorBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const {
      status: upstreamBodyStatus,
      reason: upstreamReason,
      ...rest
    } = parsed as Record<string, unknown>;
    const reason = nonEmptyString(upstreamReason)
      ? upstreamReason
      : nonEmptyString(rest.error)
        ? rest.error
        : "upstream_error";
    return {
      ...rest,
      ...(upstreamBodyStatus !== undefined ? { upstreamBodyStatus } : {}),
      ...(upstreamReason !== undefined && !nonEmptyString(upstreamReason)
        ? { upstreamBodyReason: upstreamReason }
        : {}),
      status: "error",
      reason,
      upstreamStatus,
    };
  }
  return {
    status: "error",
    reason: "upstream_non_json",
    upstreamStatus,
    brief: bodyText,
  };
}

/**
 * P-91 v3 item 1. `present | refused | absent | unread` is what
 * artifacts/api-server's own R1BriefSectionDisposition type carries today
 * (r1BriefCompose.ts) and is the only shape `buildR1Brief` emits: no code
 * path there returns `unknown`, and WDLL item 5 names `absent-verified` as
 * explicitly withheld at section level pending a positive typed result no
 * section carries yet. `unknown` and `absent-verified` are added to THIS
 * union anyway, so that if a section ever DOES carry one of them -- today,
 * from a future cortex change, or from any other producer this MCP server
 * proxies -- `sectionDisposition` below preserves it instead of silently
 * strengthening it into `absent` (the defect this item closes: a claimed
 * state this union could not name was discarded and re-derived, and the
 * re-derivation is always a claim strength the wire never made). Widening
 * the union is a promise about what THIS SERVER can say, not a claim about
 * what cortex sends today.
 */
export type ExternalBriefSectionDisposition =
  | "present"
  | "refused"
  | "absent"
  | "unread"
  | "unknown"
  | "absent-verified";

const EXTERNAL_BRIEF_SECTION_DISPOSITIONS: readonly ExternalBriefSectionDisposition[] =
  ["present", "refused", "absent", "unread", "unknown", "absent-verified"];

function asExplicitDisposition(
  value: unknown,
): ExternalBriefSectionDisposition | null {
  return typeof value === "string" &&
    (EXTERNAL_BRIEF_SECTION_DISPOSITIONS as readonly string[]).includes(value)
    ? (value as ExternalBriefSectionDisposition)
    : null;
}

export type ExternalBriefSection = {
  id?: string;
  title?: string;
  data: unknown;
  refusal?: unknown;
  disposition: ExternalBriefSectionDisposition;
  /** V3 (P-91 v3). The exact string next to the machine code, so a caller never has to translate `disposition` itself. */
  dispositionDisplayText: string;
  agentGuidance?: string | null;
  [key: string]: unknown;
};

function derivedSectionDisposition(
  section: Record<string, unknown>,
): Exclude<ExternalBriefSectionDisposition, "unread"> {
  if (section.refusal != null) return "refused";
  if (section.data !== null && section.data !== undefined) return "present";
  return "absent";
}

/**
 * F7 (P-91 v2). A section that carries an explicit disposition keeps it,
 * with its `reason`: cortex emits drainage as `unread` until the facet
 * exists, and rewriting that to `absent` would turn "not read" into "read,
 * nothing there". The wire may weaken a claim, never strengthen one: the
 * one claim it rewrites is `present` without data, which the section does
 * not support, and that falls to the derived state (refused if a refusal
 * rides along, else absent). A missing or unrecognised disposition derives.
 *
 * P-91 v3 item 1. `claimed` now recognises `unknown` and `absent-verified`
 * (see the union's own comment above): neither is `present`, so both fall
 * straight through the one downgrade check below and are RETURNED AS
 * CLAIMED, never re-derived. That is the fix -- this function's body did
 * not otherwise need to change, because the strengthening lived entirely in
 * `asExplicitDisposition` rejecting a state it had no member for.
 */
function sectionDisposition(section: Record<string, unknown>): ExternalBriefSectionDisposition {
  const derived = derivedSectionDisposition(section);
  const claimed = asExplicitDisposition(section.disposition);
  if (claimed === null) return derived;
  if (claimed === "present" && derived !== "present") return derived;
  return claimed;
}

/**
 * P-91 v3 item 1 follow-up. The check the defect card asked for: the stub
 * rail and the node section disposition for one facet, on one parcel, are
 * two SEPARATE wire reads (get_smart_site depth "stub" and depth "node" are
 * two different tool calls; on cortex's own side, artifacts/api-server's
 * assembleStubBody and assembleNodeBriefBody each call
 * loadBakedNodeFacetSnapshot / loadFloodHazardFactAtom independently -- see
 * artifacts/api-server/src/routes/propertyExplorer.ts), so a race, a cache,
 * or a divergence introduced by a future change to either read path can
 * make them disagree even though the transform between them is shared code
 * today. That is what this function is checking: agreement across two
 * independently-fetched reads, not internal consistency within one payload
 * a single producer could fabricate both halves of.
 *
 * The expected relationship is NOT equality, and this is the correction to
 * the defect card's own framing: per api-server's
 * railStateFromSectionDisposition (src/lib/smartSiteStub.ts, read from the
 * write path, not inferred from output), a node section with no
 * determination (`absent`) is DESIGNED to read as `unknown` at stub depth.
 * That pairing -- confirmed for all five brief-backed facets: zoning,
 * land-use, flood, drainage and setbacks-envelope share the one
 * `railStateFromSectionDisposition` projection end to end -- is the
 * intended, shared derivation, not the strengthening bug item 1 fixes
 * above. A check that expected `unknown` at stub to equal `unknown` at node
 * would fail on every healthy parcel with an absent facet; that is not this
 * check. `unknown` and `absent-verified` are still listed on the node side
 * of the table below even though no section carries them today (same
 * forward posture as the union widening above): if a section ever DOES
 * claim one, the table states plainly what the stub rail is expected to
 * say next to it.
 *
 * `situs` is deliberately excluded: it is not one of api-server's five
 * R1BriefSectionId facets (composeSitusLabel is a label compose, not a
 * disposition), so it has no node-depth disposition to agree with.
 */
export const STUB_RAIL_FOR_NODE_DISPOSITION: Record<
  ExternalBriefSectionDisposition,
  string
> = {
  present: "present",
  refused: "refused",
  unread: "unread",
  absent: "unknown",
  unknown: "unknown",
  "absent-verified": "absent-verified",
};

/** Stub rail key -> node section id, for the five facets both depths carry. */
export const STUB_RAIL_TO_NODE_SECTION_ID: Record<
  "zoning" | "landUse" | "flood" | "drainage" | "envelope",
  string
> = {
  zoning: "zoning",
  landUse: "land-use",
  flood: "flood",
  drainage: "drainage",
  envelope: "setbacks-envelope",
};

/**
 * True when a stub rail's word is what api-server's own projection says it
 * should be, given the node section's disposition for the same facet. Two
 * independently-fetched inputs in, one boolean out; see the comment on
 * STUB_RAIL_FOR_NODE_DISPOSITION above for why the relationship is a
 * mapping and not equality.
 */
export function stubRailAgreesWithNodeDisposition(
  stubRailValue: string,
  nodeDisposition: ExternalBriefSectionDisposition,
): boolean {
  return STUB_RAIL_FOR_NODE_DISPOSITION[nodeDisposition] === stubRailValue;
}

/**
 * V4 (P-91 v3). What not to invent, per facet. Keyed by the real section
 * ids read out of the wire and this package's own tests (zoning, land-use,
 * flood, drainage, setbacks-envelope); an id outside this map still gets a
 * generic instruction rather than none, so the mechanism cannot go starved
 * just because a new facet id ships before this map is updated.
 */
const FACET_TOPIC: Record<string, string> = {
  zoning: "a zoning district, jurisdiction, or permitted-use table",
  "land-use": "a land-use code or description",
  flood: "a flood zone, SFHA status, or base flood elevation",
  drainage: "drainage infrastructure, capacity, or a compliance state",
  "setbacks-envelope": "a setback distance or a buildable-envelope polygon",
};
const GENERIC_FACET_TOPIC = "a value for this facet";

/**
 * V4 (P-91 v3). Facet-scoped agentGuidance on every non-present section.
 * Previously shipped on exactly one facet (setbacks-envelope, refused
 * only) as a hand-written sentence; this generalizes the same instruction
 * shape to every facet and every non-present disposition. The disposition
 * word in the sentence is read off WIRE_DISPOSITION_DISPLAY_TEXT, the same
 * table dispositionDisplayText is read from below, so the two can never
 * disagree about what state this section is in.
 */
function facetGuidance(
  id: string | undefined,
  disposition: ExternalBriefSectionDisposition,
): string {
  const topic = (id && FACET_TOPIC[id]) ?? GENERIC_FACET_TOPIC;
  const state = WIRE_DISPOSITION_DISPLAY_TEXT[disposition].toLowerCase();
  return `This facet is ${state} for this parcel on this call. Do not invent ${topic}.`;
}

function isHttpCitation(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function presentCitationDishonest(rail: Record<string, unknown>): boolean {
  if (rail.state !== "present") return false;
  const citations = Array.isArray(rail.citations)
    ? rail.citations.filter(isHttpCitation)
    : [];
  return citations.length === 0 && rail.citationsDegraded !== true;
}

/**
 * V3 (P-91 v3). `reasonDisplayText` next to an overlay's raw `reason`, read
 * through envelopeHuman — the exact function the panel itself calls — so
 * the text the model reads in the tool result and the text the panel paints
 * can never be two different sentences. This is the direct fix for the
 * live-session finding: `reason: "atom_path_pending"` traveled to the model
 * with no display string attached, because envelopeHuman was wired to the
 * panel only. The raw `reason` is left untouched (additive).
 *
 * V6 (P-91 v3). Where `state` is "unknown", `finding` is explicit `null`
 * (this file's own convention for SectionRefusal: a missing field is null,
 * never a default), never the overlay's `label`. A finding-shaped label
 * ("No pipeline within 500 ft") on an unknown-state overlay is a caption
 * about what was NOT checked, not a result; no consumer that reads
 * `finding` before treating a value as a result can mistake one for the
 * other. Scoped to "unknown" only, per the v3 build plan: every other state
 * already prints an unambiguous state word next to its label.
 */
function honestOverlay(overlay: Record<string, unknown>): Record<string, unknown> {
  const reason = typeof overlay.reason === "string" ? overlay.reason : undefined;
  const withReason: Record<string, unknown> =
    reason !== undefined
      ? { ...overlay, reasonDisplayText: envelopeHuman(reason) ?? reason }
      : overlay;
  if (withReason.state === "unknown") {
    return { ...withReason, finding: null };
  }
  return withReason;
}

/**
 * Pass cortex `draw` through. Omit on unlabeled unknown hatch, seed float,
 * or a present flood/landUse rail with empty citations and no
 * citationsDegraded (P-91 item 9). Fail closed: a bad stub is not a silent
 * empty ring, and present without a citation is not silently complete.
 */
export function sanitizeExternalDraw(raw: unknown): unknown | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const draw = raw as Record<string, unknown>;
  const overlays = draw.overlays;
  if (Array.isArray(overlays)) {
    for (const item of overlays) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const overlay = item as Record<string, unknown>;
      const label = typeof overlay.label === "string" ? overlay.label.trim() : "";
      if (
        overlay.state === "unknown" &&
        overlay.draw === "hatch-interior" &&
        !label
      ) {
        return undefined;
      }
      if (overlay.id === "flood" && presentCitationDishonest(overlay)) {
        return undefined;
      }
    }
  }
  const attrs =
    draw.attrs && typeof draw.attrs === "object" && !Array.isArray(draw.attrs)
      ? (draw.attrs as Record<string, unknown>)
      : null;
  const landUse =
    attrs?.landUse &&
    typeof attrs.landUse === "object" &&
    !Array.isArray(attrs.landUse)
      ? (attrs.landUse as Record<string, unknown>)
      : null;
  if (landUse && presentCitationDishonest(landUse)) {
    return undefined;
  }
  const blob = JSON.stringify(draw);
  if (
    blob.includes("calibratedConfidence") ||
    blob.includes('"estimate":0.7') ||
    blob.includes('"estimate":0.9')
  ) {
    return undefined;
  }
  // V3/V6: rebuild overlays (reasonDisplayText, unknown-state finding split)
  // only on the surviving path; every omission check above still reads the
  // raw, unmapped overlays. V5: the derived-figures deny travels on every
  // draw that reaches the wire, not as a convention but as a payload field.
  const honestOverlays = Array.isArray(overlays)
    ? overlays.map((item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? honestOverlay(item as Record<string, unknown>)
          : item,
      )
    : undefined;
  return {
    ...draw,
    ...(honestOverlays ? { overlays: honestOverlays } : {}),
    derivedFigures: DERIVED_FIGURES_POLICY,
  };
}

/**
 * Ensures MCP clients never see bare null section data without a disposition.
 * Mirrors flood SS-W16 honesty for setbacks-envelope refusals on the wire.
 * `draw` is optional; invalid stubs are omitted (fail closed).
 */
export function normalizeR1BodyForExternal(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const draw = sanitizeExternalDraw(body.draw);
  const withDraw: Record<string, unknown> = { ...body };
  delete withDraw.draw;
  if (draw) withDraw.draw = draw;
  const brief = withDraw.brief;
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) {
    return withDraw;
  }
  const briefRecord = brief as Record<string, unknown>;
  const sections = briefRecord.sections;
  if (!Array.isArray(sections)) {
    return withDraw;
  }
  const normalizedSections: ExternalBriefSection[] = sections.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        data: raw,
        disposition: "absent",
        dispositionDisplayText: WIRE_DISPOSITION_DISPLAY_TEXT.absent,
        agentGuidance: facetGuidance(undefined, "absent"),
      };
    }
    const section = raw as Record<string, unknown>;
    const disposition = sectionDisposition(section);
    const id = typeof section.id === "string" ? section.id : undefined;
    // V4: every non-present facet gets guidance, not only setbacks-envelope
    // refused. A wire-supplied agentGuidance always wins (never overwritten).
    const agentGuidance =
      typeof section.agentGuidance === "string"
        ? section.agentGuidance
        : disposition !== "present"
          ? facetGuidance(id, disposition)
          : undefined;
    return {
      ...section,
      data: section.data ?? null,
      disposition,
      // V3: the exact display string beside the machine code, additive.
      dispositionDisplayText: WIRE_DISPOSITION_DISPLAY_TEXT[disposition],
      ...(agentGuidance ? { agentGuidance } : {}),
    } as ExternalBriefSection;
  });
  return {
    ...withDraw,
    brief: {
      ...briefRecord,
      sections: normalizedSections,
    },
  };
}

export type GetSmartSiteMissReason =
  | "parcel_not_found"
  | "baked_snapshot_not_found";

export type GetSmartSiteRefusal = {
  parcelNodeId: string;
  reason: "upgrade_required";
};

/**
 * Result text for a cortex non-OK that the host forwards to the panel.
 * `reason` always travels on a miss; `parcelExists` is `"unmeasured"`
 * when cortex did not say, never a fabricated boolean.
 */
export type GetSmartSiteNonOkResult =
  | {
      parcels: [];
      notFound: [string];
      reason: GetSmartSiteMissReason;
      parcelExists: boolean | "unmeasured";
    }
  | { parcels: []; notFound: []; refused: GetSmartSiteRefusal[] };

/**
 * P-91 build plan, wire contract 4.1. A cortex non-OK on research/brief
 * becomes a declared result (the caller sets isError false and the host
 * forwards it to the panel) in exactly the named cases; anything else
 * returns null and the caller passes the body through with isError true.
 *
 * 404 rows apply to a single id only: cortex never 404s an array (per-id
 * notFound rides inside a 200), so a 404 on an array is unexpected and is
 * not turned into per-id absences. A 402 on an array refuses every id.
 * The upstream message copy is not carried; the state is the reason.
 */
export function mapGetSmartSiteNonOk(
  httpStatus: number,
  cortexBodyText: string,
  parcelNodeIds: readonly string[],
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cortexBodyText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const body = parsed as Record<string, unknown>;
  if (parcelNodeIds.length === 0) return null;

  if (httpStatus === 402 && body.error === "upgrade_required") {
    const refused: GetSmartSiteNonOkResult = {
      parcels: [],
      notFound: [],
      refused: parcelNodeIds.map((parcelNodeId) => ({
        parcelNodeId,
        reason: "upgrade_required",
      })),
    };
    return JSON.stringify(refused);
  }

  if (httpStatus !== 404 || parcelNodeIds.length !== 1) return null;
  const id = parcelNodeIds[0]!;

  if (body.error === "parcel_not_found") {
    const absent: GetSmartSiteNonOkResult = {
      parcels: [],
      notFound: [id],
      reason: "parcel_not_found",
      parcelExists: false,
    };
    return JSON.stringify(absent);
  }

  if (body.error === "baked_snapshot_not_found") {
    const unbaked: GetSmartSiteNonOkResult = {
      parcels: [],
      notFound: [id],
      reason: "baked_snapshot_not_found",
      parcelExists:
        typeof body.parcelExists === "boolean" ? body.parcelExists : "unmeasured",
    };
    return JSON.stringify(unbaked);
  }

  return null;
}

/** Batch node rows keep per-parcel brief honesty; stubs pass through. */
export function normalizeGetSmartSiteResponseText(
  cortexBodyText: string,
  mode: "single-node" | "stub-or-batch",
): string {
  if (mode === "single-node") return normalizeR1ResponseText(cortexBodyText);
  try {
    const parsed: unknown = JSON.parse(cortexBodyText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return cortexBodyText;
    }
    const record = parsed as Record<string, unknown>;
    if (!Array.isArray(record.parcels)) return cortexBodyText;
    return JSON.stringify({
      ...record,
      parcels: record.parcels.map((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) return row;
        const parcel = row as Record<string, unknown>;
        if (!parcel.brief) return parcel;
        return normalizeR1BodyForExternal(parcel);
      }),
    });
  } catch {
    return cortexBodyText;
  }
}

/** Brokerage-internal names that must never appear in ask_the_map error text. */
export const ASK_THE_MAP_INTERNAL_FIELD_NAMES = [
  "workspaceDid",
  "personaBucket",
  "starterPromptId",
  "mls_id",
  "presentationMode",
] as const;

const ASK_THE_MAP_INTERNAL_FIELD_SET = new Set<string>(
  ASK_THE_MAP_INTERNAL_FIELD_NAMES,
);

export function askTheMapArgsLeakInternalFields(
  args: Record<string, unknown>,
): boolean {
  return ASK_THE_MAP_INTERNAL_FIELD_NAMES.some((name) =>
    Object.prototype.hasOwnProperty.call(args, name),
  );
}

function stripInternalFieldTokens(value: string): string {
  let out = value;
  for (const token of ASK_THE_MAP_INTERNAL_FIELD_NAMES) {
    out = out.split(token).join("");
  }
  return out
    .replace(/\s+OR\s+OR\s+/g, " OR ")
    .replace(/\s+OR\s+,/g, ",")
    .replace(/,\s+OR\s+/g, ", ")
    .replace(/,\s*,+/g, ",")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/,\s*$/g, "")
    .replace(/^\s*,\s*/g, "")
    .trim();
}

function sanitizeAskTheMapJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return stripInternalFieldTokens(value);
  }
  if (Array.isArray(value)) {
    return value
      .filter(
        (item) =>
          typeof item !== "string" || !ASK_THE_MAP_INTERNAL_FIELD_SET.has(item),
      )
      .map((item) => sanitizeAskTheMapJsonValue(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (ASK_THE_MAP_INTERNAL_FIELD_SET.has(key)) continue;
      out[key] = sanitizeAskTheMapJsonValue(nested);
    }
    return out;
  }
  return value;
}

/**
 * P-91 item 10. Strip brokerage-internal field names from MCP and cortex
 * validation errors. Last line is a substring scrub so a nested string cannot
 * keep a token the walk missed.
 */
export function sanitizeAskTheMapErrorBody(body: string): string {
  let sanitized: string;
  try {
    sanitized = JSON.stringify(sanitizeAskTheMapJsonValue(JSON.parse(body)));
  } catch {
    sanitized = stripInternalFieldTokens(body);
  }
  if (ASK_THE_MAP_INTERNAL_FIELD_NAMES.some((token) => sanitized.includes(token))) {
    return stripInternalFieldTokens(sanitized);
  }
  return sanitized;
}

/** Parse cortex R1 JSON and normalize for get_smart_site / run_report. */
export function normalizeR1ResponseText(cortexBodyText: string): string {
  try {
    const parsed: unknown = JSON.parse(cortexBodyText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify(
        normalizeR1BodyForExternal(parsed as Record<string, unknown>),
      );
    }
  } catch {
    // pass through non-JSON errors
  }
  return cortexBodyText;
}
