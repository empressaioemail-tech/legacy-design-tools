/** External-safe entitlement shape — never echo cortex userId/tenantId blobs. */
export type ExternalEntitlementSummary = {
  entitled: boolean;
  subscriptionTier?: string;
};

export function stripEntitlementForExternal(
  raw: unknown,
): ExternalEntitlementSummary {
  if (!raw || typeof raw !== "object") {
    return { entitled: false };
  }
  const record = raw as Record<string, unknown>;
  const subscriptionTier =
    typeof record.subscriptionTier === "string"
      ? record.subscriptionTier
      : undefined;
  const property =
    record.property && typeof record.property === "object"
      ? (record.property as Record<string, unknown>)
      : null;
  const unlocked = property?.unlocked === true;
  const tierEntitled =
    record.tier === "paid" ||
    record.authenticated === true ||
    subscriptionTier === "studio" ||
    subscriptionTier === "team" ||
    subscriptionTier === "pro";
  return {
    entitled: unlocked || tierEntitled,
    ...(subscriptionTier ? { subscriptionTier } : {}),
  };
}

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

export type ExternalBriefSectionDisposition =
  | "present"
  | "refused"
  | "absent";

export type ExternalBriefSection = {
  id?: string;
  title?: string;
  data: unknown;
  refusal?: unknown;
  disposition: ExternalBriefSectionDisposition;
  agentGuidance?: string | null;
  [key: string]: unknown;
};

function sectionDisposition(section: Record<string, unknown>): ExternalBriefSectionDisposition {
  if (section.refusal != null) return "refused";
  if (section.data !== null && section.data !== undefined) return "present";
  return "absent";
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
  return draw;
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
      };
    }
    const section = raw as Record<string, unknown>;
    const disposition = sectionDisposition(section);
    const agentGuidance =
      typeof section.agentGuidance === "string"
        ? section.agentGuidance
        : disposition === "refused" &&
            section.id === "setbacks-envelope" &&
            section.refusal &&
            typeof section.refusal === "object"
          ? "Setbacks and buildable envelope are refused on this read path. Do not invent distances or polygons."
          : undefined;
    return {
      ...section,
      data: section.data ?? null,
      disposition,
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
