/**
 * Wire helpers for engine-api honesty fields on cortex-api responses.
 */

import type { EngineHonesty, EngineEnvelopeSource } from "@workspace/engine-core";

export type { EngineHonesty };

function parseWireSource(raw: unknown): EngineEnvelopeSource | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if (typeof o.adapter === "string" && o.adapter.length > 0) {
      const citationIds = Array.isArray(o.citationIds)
        ? o.citationIds.filter((id): id is string => typeof id === "string")
        : undefined;
      return {
        adapter: o.adapter,
        ...(citationIds && citationIds.length > 0 ? { citationIds } : {}),
      };
    }
  }
  if (typeof raw === "string" && raw.length > 0) {
    return { adapter: raw };
  }
  return null;
}

export function wireEngineHonesty(raw: unknown): EngineHonesty | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const confidence = o.confidence;
  const coverage = o.coverage;
  if (
    !confidence ||
    typeof confidence !== "object" ||
    !coverage ||
    typeof coverage !== "object"
  ) {
    return null;
  }
  const c = confidence as Record<string, unknown>;
  const cov = coverage as Record<string, unknown>;
  if (
    typeof c.value !== "number" ||
    typeof c.kind !== "string" ||
    typeof cov.degraded !== "boolean"
  ) {
    return null;
  }
  const source = parseWireSource(o.source);
  if (!source) return null;
  return {
    confidence: {
      value: c.value,
      kind: c.kind as EngineHonesty["confidence"]["kind"],
    },
    dataVintage:
      typeof o.dataVintage === "string"
        ? o.dataVintage
        : o.dataVintage === null
          ? null
          : null,
    coverage: {
      degraded: cov.degraded,
      ...(typeof cov.reason === "string" ? { reason: cov.reason } : {}),
    },
    source,
  };
}

export function engineHonestyForWire(honesty: EngineHonesty): EngineHonesty {
  return {
    confidence: { ...honesty.confidence },
    dataVintage: honesty.dataVintage,
    coverage: { ...honesty.coverage },
    source: {
      adapter: honesty.source.adapter,
      ...(honesty.source.citationIds?.length
        ? { citationIds: [...honesty.source.citationIds] }
        : {}),
    },
  };
}

/** Merge cortex-side plan-set vision degradation into an engine honesty row. */
export function mergePlanSetVisionDegradation(
  honesty: EngineHonesty | null,
  reason: string,
): EngineHonesty {
  const base: EngineHonesty =
    honesty ??
    ({
      confidence: { value: 0.68, kind: "asserted" },
      dataVintage: null,
      coverage: { degraded: true, reason },
      source: { adapter: "cortex-api:plan-set-vision" },
    } satisfies EngineHonesty);

  const mergedReason = base.coverage.degraded
    ? [base.coverage.reason, reason].filter(Boolean).join("; ")
    : reason;

  return {
    ...base,
    coverage: { degraded: true, reason: mergedReason },
  };
}
