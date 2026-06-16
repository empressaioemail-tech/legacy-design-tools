import { describe, expect, it } from "vitest";
import {
  isEngineEnvelopeShape,
  unwrapEngineEnvelope,
  wrapEngineEnvelope,
} from "../envelope";

/** Representative emit from hauska-engine PR #72 envelope schema. */
const E_SHAPED_ENVELOPE = {
  payload: {
    result: { findings: [{ atomId: "finding:sub:1" }], invalidCitations: [] },
    mode: "anthropic",
  },
  confidence: { value: 0.87, kind: "calibrated" as const },
  dataVintage: "2025-11-08",
  coverage: { degraded: true, reason: "web-grounded-on-demand" },
  source: {
    adapter: "hauska-engine/plan-review",
    citationIds: ["briefing-source:src-1", "code-section:atom-2"],
  },
};

describe("engine envelope", () => {
  it("unwraps cc-agent-E shaped envelope with populated honesty (not fallback)", () => {
    expect(isEngineEnvelopeShape(E_SHAPED_ENVELOPE)).toBe(true);
    const { payload, honesty } = unwrapEngineEnvelope<typeof E_SHAPED_ENVELOPE.payload>(
      E_SHAPED_ENVELOPE,
    );
    expect(payload.mode).toBe("anthropic");
    expect(honesty.confidence).toEqual({ value: 0.87, kind: "calibrated" });
    expect(honesty.dataVintage).toBe("2025-11-08");
    expect(honesty.coverage).toEqual({
      degraded: true,
      reason: "web-grounded-on-demand",
    });
    expect(honesty.source).toEqual({
      adapter: "hauska-engine/plan-review",
      citationIds: ["briefing-source:src-1", "code-section:atom-2"],
    });
    // Guard against silent fallback defaults.
    expect(honesty.confidence.kind).not.toBe("asserted");
    expect(honesty.dataVintage).not.toBeNull();
    expect(honesty.coverage.degraded).toBe(true);
    expect(honesty.source.adapter).not.toBe("engine-api");
  });

  it("unwraps legacy sibling honesty fields with object source", () => {
    const raw = {
      result: { findings: [] },
      mode: "anthropic",
      confidence: { value: 0.8, kind: "asserted" },
      dataVintage: null,
      coverage: { degraded: true, reason: "web-grounded" },
      source: { adapter: "engine-api/briefing" },
    };
    const { payload, honesty } = unwrapEngineEnvelope<{
      result: { findings: unknown[] };
      mode: string;
    }>(raw);
    expect(payload.result.findings).toEqual([]);
    expect(honesty.coverage).toEqual({
      degraded: true,
      reason: "web-grounded",
    });
    expect(honesty.source.adapter).toBe("engine-api/briefing");
  });

  it("synthesizes conservative honesty for bare legacy payloads", () => {
    const { honesty } = unwrapEngineEnvelope(
      { result: { findings: [] }, mode: "mock" },
      { legacyProducer: "mock" },
    );
    expect(honesty.coverage.degraded).toBe(true);
    expect(honesty.coverage.reason).toBe("mock_producer");
    expect(honesty.source.adapter).toBe("engine-api");
  });

  it("round-trips wrapEngineEnvelope", () => {
    const honesty = {
      confidence: { value: 1, kind: "deterministic" as const },
      dataVintage: "2026-06-01",
      coverage: { degraded: false },
      source: { adapter: "test-adapter", citationIds: ["a-1"] },
    };
    const env = wrapEngineEnvelope({ ok: true }, honesty);
    expect(env.payload).toEqual({ ok: true });
    expect(env.confidence.kind).toBe("deterministic");
    expect(env.source.citationIds).toEqual(["a-1"]);
  });
});
