/**
 * Uniform engine-api reasoning envelope (cc-agent-E contract).
 *
 * Authoritative shape: hauska-engine `packages/engine-core/src/envelope/schema.ts`
 * (PR #72). cortex-api forwards honesty fields end-to-end without flattening.
 */

export type EngineConfidenceKind = "calibrated" | "asserted" | "deterministic";

export interface EngineEnvelopeConfidence {
  value: number;
  kind: EngineConfidenceKind;
}

export interface EngineEnvelopeCoverage {
  degraded: boolean;
  reason?: string;
}

/** Matches {@link envelopeSourceSchema} on engine-api. */
export interface EngineEnvelopeSource {
  adapter: string;
  citationIds?: string[];
}

/** Buyer-facing honesty slice — omits payload; safe on wire surfaces. */
export interface EngineHonesty {
  confidence: EngineEnvelopeConfidence;
  /** ISO-8601 acquisition date for underlying data, or null when unknown. */
  dataVintage: string | null;
  coverage: EngineEnvelopeCoverage;
  source: EngineEnvelopeSource;
}

export interface EngineEnvelope<TPayload = unknown> {
  payload: TPayload;
  confidence: EngineEnvelopeConfidence;
  dataVintage: string | null;
  coverage: EngineEnvelopeCoverage;
  source: EngineEnvelopeSource;
}

const CONFIDENCE_KINDS = new Set<EngineConfidenceKind>([
  "calibrated",
  "asserted",
  "deterministic",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseConfidence(raw: unknown): EngineEnvelopeConfidence | null {
  if (!isRecord(raw)) return null;
  const value = raw.value;
  const kind = raw.kind;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  if (typeof kind !== "string" || !CONFIDENCE_KINDS.has(kind as EngineConfidenceKind)) {
    return null;
  }
  return { value, kind: kind as EngineConfidenceKind };
}

function parseCoverage(raw: unknown): EngineEnvelopeCoverage | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.degraded !== "boolean") return null;
  const reason = raw.reason;
  return {
    degraded: raw.degraded,
    ...(typeof reason === "string" && reason.length > 0 ? { reason } : {}),
  };
}

function parseDataVintage(raw: unknown): string | null {
  if (raw === null) return null;
  if (raw === undefined) return null;
  if (typeof raw !== "string" || raw.length === 0) return null;
  return raw;
}

function parseSource(
  raw: unknown,
  fallbackAdapter: string,
): EngineEnvelopeSource | null {
  if (isRecord(raw) && typeof raw.adapter === "string" && raw.adapter.length > 0) {
    const citationIds = Array.isArray(raw.citationIds)
      ? raw.citationIds.filter((id): id is string => typeof id === "string")
      : undefined;
    return {
      adapter: raw.adapter,
      ...(citationIds && citationIds.length > 0 ? { citationIds } : {}),
    };
  }
  // Transitional: spine may still emit a bare adapter string during cutover.
  if (typeof raw === "string" && raw.length > 0) {
    return { adapter: raw };
  }
  if (fallbackAdapter.length > 0) {
    return { adapter: fallbackAdapter };
  }
  return null;
}

/**
 * True when `value` carries the engine-api envelope shape at the top level.
 */
export function isEngineEnvelopeShape(value: unknown): value is EngineEnvelope {
  if (!isRecord(value)) return false;
  if (!("payload" in value)) return false;
  return (
    parseConfidence(value.confidence) !== null &&
    parseCoverage(value.coverage) !== null &&
    parseSource(value.source, "") !== null
  );
}

/**
 * Parse an engine-api JSON body into payload + honesty. Supports:
 *   - full {@link EngineEnvelope} (`payload` + honesty fields per E schema)
 *   - legacy bodies with honesty siblings (`result` + `confidence`, …)
 *   - bare legacy payloads (synthesizes conservative honesty — last resort)
 */
export function unwrapEngineEnvelope<TPayload>(
  raw: unknown,
  args?: {
    fallbackSourceAdapter?: string;
    legacyProducer?: "mock" | "anthropic" | "grok" | string;
    legacyConfidence?: number;
  },
): { payload: TPayload; honesty: EngineHonesty } {
  const fallbackAdapter = args?.fallbackSourceAdapter ?? "engine-api";

  if (isEngineEnvelopeShape(raw)) {
    const confidence = parseConfidence(raw.confidence)!;
    const coverage = parseCoverage(raw.coverage)!;
    const source = parseSource(raw.source, fallbackAdapter)!;
    return {
      payload: raw.payload as TPayload,
      honesty: {
        confidence,
        dataVintage: parseDataVintage(raw.dataVintage),
        coverage,
        source,
      },
    };
  }

  if (isRecord(raw)) {
    const topConfidence = parseConfidence(raw.confidence);
    const topCoverage = parseCoverage(raw.coverage);
    const topSource = parseSource(raw.source, fallbackAdapter);
    if (topConfidence && topCoverage && topSource) {
      const {
        confidence: _c,
        coverage: _cov,
        dataVintage,
        source: _s,
        ...rest
      } = raw;
      return {
        payload: rest as TPayload,
        honesty: {
          confidence: topConfidence,
          dataVintage: parseDataVintage(dataVintage),
          coverage: topCoverage,
          source: topSource,
        },
      };
    }
  }

  const producer = args?.legacyProducer ?? "unknown";
  const isMock = producer === "mock";
  const confidenceValue =
    typeof args?.legacyConfidence === "number"
      ? args.legacyConfidence
      : isMock
        ? 0
        : 0.75;

  return {
    payload: raw as TPayload,
    honesty: {
      confidence: {
        value: confidenceValue,
        kind: isMock ? "asserted" : "asserted",
      },
      dataVintage: null,
      coverage: {
        degraded: isMock,
        ...(isMock ? { reason: "mock_producer" } : {}),
      },
      source: { adapter: fallbackAdapter },
    },
  };
}

export function engineHonestyFromEnvelope<T>(
  envelope: EngineEnvelope<T>,
): EngineHonesty {
  return {
    confidence: envelope.confidence,
    dataVintage: envelope.dataVintage,
    coverage: envelope.coverage,
    source: envelope.source,
  };
}

export function wrapEngineEnvelope<TPayload>(
  payload: TPayload,
  honesty: EngineHonesty,
): EngineEnvelope<TPayload> {
  return {
    payload,
    confidence: honesty.confidence,
    dataVintage: honesty.dataVintage,
    coverage: honesty.coverage,
    source: honesty.source,
  };
}
