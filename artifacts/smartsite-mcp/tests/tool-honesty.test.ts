import { describe, expect, it } from "vitest";

import {
  buildRunReportEnvelope,
  stripEntitlementForExternal,
} from "../src/tool-honesty.js";

describe("stripEntitlementForExternal", () => {
  it("returns minimal entitled shape and strips internal ids", () => {
    const summary = stripEntitlementForExternal({
      authenticated: true,
      tier: "paid",
      subscriptionTier: "studio",
      tenantId: "tenant-secret",
      userId: "user-secret",
      devRole: true,
      entitlementSource: "stripe",
      property: { parcelNodeId: "node-1", unlocked: true },
    });
    expect(summary).toEqual({ entitled: true, subscriptionTier: "studio" });
    expect(summary).not.toHaveProperty("userId");
    expect(summary).not.toHaveProperty("tenantId");
    expect(summary).not.toHaveProperty("entitlementSource");
  });

  it("returns entitled false for empty input", () => {
    expect(stripEntitlementForExternal(null)).toEqual({ entitled: false });
  });
});

describe("buildRunReportEnvelope", () => {
  it("wraps cortex brief JSON with synchronous honesty fields", () => {
    const brief = {
      runId: "r1-node-abc",
      reportFamily: "R1",
      mode: "baked-facet-intel-v1",
      parcelNodeId: "node-abc",
    };
    const envelope = buildRunReportEnvelope("node-abc", JSON.stringify(brief));
    expect(envelope).toEqual({
      reportKind: "R1-baked-snapshot",
      mode: "baked-snapshot-read",
      async: false,
      parcelNodeId: "node-abc",
      brief,
    });
  });

  it("preserves non-JSON error bodies under brief", () => {
    const envelope = buildRunReportEnvelope("node-abc", "upstream unavailable");
    expect(envelope.async).toBe(false);
    expect(envelope.brief).toBe("upstream unavailable");
  });
});
