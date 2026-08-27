import { describe, expect, it } from "vitest";

import {
  buildRunReportEnvelope,
  normalizeR1BodyForExternal,
  stripEntitlementForExternal,
  stripSavedPropertiesForExternal,
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
  it("flattens cortex R1 JSON so brief.sections matches get_smart_site", () => {
    const cortexBody = {
      runId: "r1-node-abc",
      reportFamily: "R1",
      mode: "baked-facet-intel-v1",
      parcelNodeId: "node-abc",
      brief: {
        sections: [{ id: "zoning", title: "Zoning", data: null, citations: [] }],
        disclosure: [],
      },
      source: "baked-snapshot",
    };
    const envelope = buildRunReportEnvelope(
      "node-abc",
      JSON.stringify(cortexBody),
    );
    expect(envelope.async).toBe(false);
    expect(envelope.reportKind).toBe("R1-baked-snapshot");
    expect(envelope.reportReadMode).toBe("baked-snapshot-read");
    expect(envelope.runId).toBe("r1-node-abc");
    expect(envelope.mode).toBe("baked-facet-intel-v1");
    expect(envelope.brief).toEqual({
      sections: [
        {
          id: "zoning",
          title: "Zoning",
          data: null,
          citations: [],
          disposition: "absent",
        },
      ],
      disclosure: [],
    });
    const brief = envelope.brief as { sections: unknown[] };
    expect(brief.sections).toHaveLength(1);
  });

  it("preserves non-JSON error bodies under brief", () => {
    const envelope = buildRunReportEnvelope("node-abc", "upstream unavailable");
    expect(envelope.async).toBe(false);
    expect(envelope.brief).toBe("upstream unavailable");
  });
});

describe("stripSavedPropertiesForExternal", () => {
  it("drops snapshot blobs and keeps list summary fields", () => {
    const rows = stripSavedPropertiesForExternal([
      {
        id: "row-1",
        parcelNodeId: "48021:34137",
        label: "908 PINE",
        updatedAt: "2026-08-27T12:00:00.000Z",
        snapshot: {
          chatThreads: [{ id: "secret", messages: ["private"] }],
          notes: "do not leak",
        },
      },
    ]);
    expect(rows).toEqual([
      {
        id: "row-1",
        parcelNodeId: "48021:34137",
        label: "908 PINE",
        updatedAt: "2026-08-27T12:00:00.000Z",
      },
    ]);
    expect(rows[0]).not.toHaveProperty("snapshot");
  });

  it("returns empty array for non-array input", () => {
    expect(stripSavedPropertiesForExternal(null)).toEqual([]);
  });
});

describe("normalizeR1BodyForExternal", () => {
  it("adds disposition refused when section carries refusal", () => {
    const body = normalizeR1BodyForExternal({
      brief: {
        sections: [
          {
            id: "setbacks-envelope",
            data: null,
            refusal: {
              state: "refused",
              code: "not-in-bake",
              reason: "No envelope facet",
            },
          },
        ],
      },
    });
    const sections = (body.brief as { sections: Array<{ disposition: string; agentGuidance?: string }> })
      .sections;
    expect(sections[0]?.disposition).toBe("refused");
    expect(sections[0]?.agentGuidance).toContain("Do not invent");
  });

  it("adds disposition present when section has data", () => {
    const body = normalizeR1BodyForExternal({
      brief: {
        sections: [{ id: "zoning", data: { district: "SF-3" } }],
      },
    });
    const sections = (body.brief as { sections: Array<{ disposition: string }> })
      .sections;
    expect(sections[0]?.disposition).toBe("present");
  });
});
