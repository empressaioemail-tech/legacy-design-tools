/**
 * Honest refusal for the R1 setbacks/envelope section when the baked Tier-1
 * envelope is not served (anti-zombie strip) or was never derived.
 */

export type EnvelopeBriefRefusal =
  | {
      state: "refused";
      code: "not-in-bake";
      reason: string;
    }
  | {
      state: "refused";
      code: "declined-in-bake";
      declineReason: string | null;
      reason: string;
    }
  | {
      state: "refused";
      code: "baked-envelope-not-served";
      bakeStatus: string | null;
      reason: string;
    };

function asBriefRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Read envelope disposition from the RAW Tier-1 bake payload before the
 * anti-zombie strip. Used by R1 brief so a null wire envelope carries a typed
 * refusal rather than a silent empty section.
 */
export function extractEnvelopeBriefRefusal(
  rawFacets: unknown,
): EnvelopeBriefRefusal {
  const root = asBriefRecord(rawFacets);
  if (!root) {
    return {
      state: "refused",
      code: "not-in-bake",
      reason: "No Tier-1 facet payload exists for this node.",
    };
  }
  const envelope = asBriefRecord(root.envelope);
  if (!envelope) {
    const coverage = asBriefRecord(root.facetCoverage);
    if (coverage?.envelope === false) {
      return {
        state: "refused",
        code: "not-in-bake",
        reason:
          "The bake marks envelope as not derived (facetCoverage.envelope false).",
      };
    }
    return {
      state: "refused",
      code: "not-in-bake",
      reason: "No envelope facet in the baked snapshot.",
    };
  }
  if (envelope.status === "declined") {
    const declineReason =
      typeof envelope.declineReason === "string" && envelope.declineReason.trim()
        ? envelope.declineReason.trim()
        : null;
    return {
      state: "refused",
      code: "declined-in-bake",
      declineReason,
      reason: declineReason
        ? `Buildable envelope was declined in bake: ${declineReason}.`
        : "Buildable envelope was declined in bake with no declineReason.",
    };
  }
  const bakeStatus =
    typeof envelope.status === "string" ? envelope.status : null;
  return {
    state: "refused",
    code: "baked-envelope-not-served",
    bakeStatus,
    reason:
      "A baked envelope exists but is not served on this read path; use the atom buildable-envelope route.",
  };
}
