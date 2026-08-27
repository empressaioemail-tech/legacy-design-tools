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

export type RunReportEnvelope = {
  reportKind: "R1-baked-snapshot";
  mode: "baked-snapshot-read";
  async: false;
  parcelNodeId: string;
  brief: unknown;
};

export function buildRunReportEnvelope(
  parcelNodeId: string,
  cortexBodyText: string,
): RunReportEnvelope {
  let brief: unknown = cortexBodyText;
  try {
    brief = JSON.parse(cortexBodyText);
  } catch {
    // Non-JSON error bodies stay as raw text under `brief`.
  }
  return {
    reportKind: "R1-baked-snapshot",
    mode: "baked-snapshot-read",
    async: false,
    parcelNodeId,
    brief,
  };
}
