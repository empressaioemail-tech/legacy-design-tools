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

/** Summary row safe for third-party MCP assistants — no chat snapshots. */
export type ExternalSavedPropertySummary = {
  id: string;
  parcelNodeId: string;
  label: string | null;
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
    const label =
      typeof record.label === "string"
        ? record.label
        : record.label === null
          ? null
          : null;
    const updatedAt =
      typeof record.updatedAt === "string"
        ? record.updatedAt
        : record.updatedAt != null
          ? String(record.updatedAt)
          : "";
    rows.push({ id, parcelNodeId, label, updatedAt });
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
      return { ...honesty, ...(parsed as Record<string, unknown>) };
    }
  } catch {
    // Non-JSON error bodies stay under `brief`.
  }
  return { ...honesty, brief: cortexBodyText };
}
