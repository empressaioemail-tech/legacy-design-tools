import { describe, expect, it } from "vitest";
import {
  buildValidSignedEventChain,
  verifyEventChain,
} from "@hauska/atom-contract/conformance";
import {
  accessPolicyForFamily,
  assembleAtomConformanceTarget,
  buildAssertedFallbackReadContract,
  normalizeAccessPolicy,
  validateFamilyConformance,
} from "../atomConformance";

describe("normalizeAccessPolicy", () => {
  it("maps legacy tenant-scoped to tenant-private", () => {
    expect(normalizeAccessPolicy("tenant-scoped", "platform-internal")).toBe(
      "tenant-private",
    );
  });

  it("falls back when value is unknown", () => {
    expect(normalizeAccessPolicy("", "tenant-private")).toBe("tenant-private");
    expect(normalizeAccessPolicy("legacy-value", "public-free")).toBe(
      "public-free",
    );
  });
});

describe("buildAssertedFallbackReadContract", () => {
  it("keeps calibrated at asserted fallback until earned", () => {
    const rc = buildAssertedFallbackReadContract({ estimate: 0.72, n: 0 });
    expect(rc.axes.calibratedConfidence.provenance).toBe("asserted");
    expect(rc.axes.assertedConfidence.provenance).toBe("asserted");
    expect(rc.axes.calibratedConfidence.estimate).toBe(0.72);
    expect(rc.axes.consequence.stratum).toBe("routine");
  });
});

describe("validateFamilyConformance", () => {
  it("passes encumbrances data-tier sample with signed history", () => {
    const events = buildValidSignedEventChain([
      {
        id: "01TESTENC001",
        entityType: "recorded-instrument",
        entityId: "did:hauska:instrument:test",
        eventType: "recorded-instrument.ingested",
        actor: { kind: "system", id: "encumbrance-extract" },
        payload: {},
        occurredAt: new Date("2026-06-21T00:00:00.000Z"),
        recordedAt: new Date("2026-06-21T00:00:00.000Z"),
      },
    ]);
    const verifyChain = verifyEventChain(events);
    const result = validateFamilyConformance({
      tier: "data",
      family: "encumbrances",
      readContract: buildAssertedFallbackReadContract({ estimate: 0.8, n: 1 }),
      accessPolicyRaw: "tenant-private",
      signedHistory: { events, verifyChain },
    });
    expect(result.ok, result.errors?.map((e) => e.message).join("; ")).toBe(true);
  });

  it("passes workspace app-tier sample without signed history", () => {
    const result = validateFamilyConformance({
      tier: "app",
      family: "workspace",
      readContract: buildAssertedFallbackReadContract(),
      accessPolicyRaw: "tenant-private",
    });
    expect(result.ok).toBe(true);
    expect(assembleAtomConformanceTarget({
      tier: "app",
      family: "workspace",
      readContract: buildAssertedFallbackReadContract(),
    }).accessPolicy).toBe("tenant-private");
  });
});
