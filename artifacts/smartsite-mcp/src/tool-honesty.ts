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

/** Summary row safe for third-party MCP assistants — no chat snapshots. */
export type ExternalSavedPropertySummary = {
  id: string;
  parcelNodeId: string;
  label: string;
  situs: "present" | "unknown";
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
    rows.push({
      id,
      parcelNodeId,
      label,
      situs: situsUnknown ? "unknown" : "present",
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

/**
 * Pass cortex `draw` through. Omit on unlabeled unknown hatch or seed float.
 * Fail closed: a bad stub is not a silent empty ring.
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
    }
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
