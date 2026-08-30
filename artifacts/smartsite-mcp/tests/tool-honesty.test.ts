import { describe, expect, it } from "vitest";

import {
  ASK_THE_MAP_INTERNAL_FIELD_NAMES,
  askTheMapArgsLeakInternalFields,
  buildRunReportEnvelope,
  buildRunReportErrorBody,
  mapGetSmartSiteNonOk,
  normalizeR1BodyForExternal,
  sanitizeAskTheMapErrorBody,
  stripSavedPropertiesForExternal,
} from "../src/tool-honesty.js";

const GOLD_DRAW_A3 = {
  node: "48021:34137",
  kind: "parcel",
  label: "908 PINE, BASTROP, TX 78602",
  url: "https://smartsite.cloud/p/48021:34137",
  asOf: "2026-08-04",
  frame: {
    units: "ft",
    origin: "centroid",
    yAxis: "true-north",
    convertedFrom: "local-enu-m",
    factor: "us-survey-foot",
    quality: "gis-approximate",
  },
  ring: [
    [48.6, 83.94],
    [-50.37, 83.7],
    [-49.07, -84.28],
    [50.84, -83.36],
  ],
  ringOrder: "ccw",
  attrs: { zoning: { v: "SF-1", state: "present" } },
  overlays: [
    {
      id: "flood",
      label: "Zone X shaded, 0.2% annual chance",
      draw: "tint-ring",
      state: "present",
      citations: [],
      citationsDegraded: true,
    },
  ],
  confidence: "seed",
};

describe("buildRunReportErrorBody (stamp only on res.ok)", () => {
  it("keeps the upstream JSON body under its own keys and status error wins", () => {
    const body = buildRunReportErrorBody(
      JSON.stringify({
        error: "upgrade_required",
        message: "Unlock this property or go Pro to run this report",
        tier: "free",
      }),
    );
    expect(body).toEqual({
      status: "error",
      error: "upgrade_required",
      message: "Unlock this property or go Pro to run this report",
      tier: "free",
    });
    expect(body).not.toHaveProperty("reportKind");
    expect(body).not.toHaveProperty("reportReadMode");
    expect(body).not.toHaveProperty("async");
  });

  it("an upstream status field cannot overwrite the error marker", () => {
    const body = buildRunReportErrorBody(
      JSON.stringify({ status: "queued", error: "rate_limited" }),
    );
    expect(body.status).toBe("error");
    expect(body.upstreamStatus).toBe("queued");
    expect(body.error).toBe("rate_limited");
  });

  it("non-JSON and non-object bodies land under brief", () => {
    expect(buildRunReportErrorBody("upstream unavailable")).toEqual({
      status: "error",
      brief: "upstream unavailable",
    });
    expect(buildRunReportErrorBody("[1,2]")).toEqual({
      status: "error",
      brief: "[1,2]",
    });
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
        situs: "present",
        stub: {
          situs: "unread",
          zoning: "unread",
          landUse: "unread",
          flood: "unread",
          drainage: "unread",
          envelope: "unread",
        },
        status: null,
        note: null,
        updatedAt: "2026-08-27T12:00:00.000Z",
      },
    ]);
    expect(rows[0]).not.toHaveProperty("snapshot");
  });

  it("rewrites a punctuation-only label to the node id with situs unknown", () => {
    const rows = stripSavedPropertiesForExternal([
      {
        id: "row-junk",
        parcelNodeId: "48021:25420",
        label: ", ,",
        updatedAt: "2026-08-27T12:00:00.000Z",
      },
    ]);
    expect(rows).toEqual([
      {
        id: "row-junk",
        parcelNodeId: "48021:25420",
        label: "48021:25420",
        situs: "unknown",
        stub: {
          situs: "unread",
          zoning: "unread",
          landUse: "unread",
          flood: "unread",
          drainage: "unread",
          envelope: "unread",
        },
        status: null,
        note: null,
        updatedAt: "2026-08-27T12:00:00.000Z",
      },
    ]);
    expect(rows[0]?.label).not.toMatch(/^[\s,.\-;:'"`]+$/);
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

  it("passes a valid draw stub through", () => {
    const body = normalizeR1BodyForExternal({
      brief: { sections: [{ id: "zoning", data: { district: "SF-1" } }] },
      draw: {
        node: "48021:34137",
        url: "https://smartsite.cloud/p/48021:34137",
        confidence: "seed",
        overlays: [
          {
            id: "footprint",
            label: "Structure of record (1910), footprint unmeasured",
            draw: "hatch-interior",
            state: "unknown",
          },
        ],
      },
    });
    expect(body.draw).toMatchObject({
      node: "48021:34137",
      url: "https://smartsite.cloud/p/48021:34137",
    });
  });

  it("A3: gold draw is byte-identical after honesty normalize", () => {
    const body = normalizeR1BodyForExternal({
      brief: { sections: [{ id: "zoning", data: { district: "SF-1" } }] },
      draw: GOLD_DRAW_A3,
    });
    expect(JSON.stringify(body.draw)).toBe(JSON.stringify(GOLD_DRAW_A3));
  });
});

describe("sanitizeAskTheMapErrorBody (P-91 item 10)", () => {
  const cortex400 = {
    error: "invalid_request",
    message: "Invalid research chat body",
    details: {
      formErrors: [],
      fieldErrors: {
        runId: [
          "Provide runId, address, workspaceDid, or areaContext (scope=area or visibleParcels)",
        ],
      },
    },
    accepted: {
      required: ["message"],
      runSelector:
        "runId (uuid) OR address OR workspaceDid OR areaContext (scope=area or visibleParcels)",
      optional: [
        "history",
        "presentationMode",
        "starterPromptId",
        "personaBucket",
        "mls_id",
        "areaContext",
        "purpose",
      ],
    },
  };

  const mcpZodError = {
    code: "invalid_arguments",
    message:
      "Unrecognized keys: workspaceDid, personaBucket, starterPromptId, mls_id, presentationMode",
  };

  it("fixture still contains the leak tokens (falsifier)", () => {
    const raw = JSON.stringify(cortex400);
    for (const token of ASK_THE_MAP_INTERNAL_FIELD_NAMES) {
      expect(raw).toContain(token);
    }
    expect(JSON.stringify(mcpZodError)).toContain("workspaceDid");
  });

  it("strips cortex validation 400 and MCP zod text", () => {
    const cortex = sanitizeAskTheMapErrorBody(JSON.stringify(cortex400));
    const mcp = sanitizeAskTheMapErrorBody(JSON.stringify(mcpZodError));
    for (const token of ASK_THE_MAP_INTERNAL_FIELD_NAMES) {
      expect(cortex).not.toContain(token);
      expect(mcp).not.toContain(token);
    }
    const parsed = JSON.parse(cortex);
    expect(parsed.accepted.optional).toEqual([
      "history",
      "areaContext",
      "purpose",
    ]);
    expect(parsed.details.fieldErrors.runId).toEqual([
      "Provide runId, address, or areaContext (scope=area or visibleParcels)",
    ]);
    expect(parsed.accepted.runSelector).toBe(
      "runId (uuid) OR address OR areaContext (scope=area or visibleParcels)",
    );
  });

  it("detects leak fields on raw ask_the_map args", () => {
    expect(
      askTheMapArgsLeakInternalFields({
        parcelNodeId: "48021:34137",
        message: "flood?",
        workspaceDid: "did:leak",
      }),
    ).toBe(true);
    expect(
      askTheMapArgsLeakInternalFields({
        parcelNodeId: "48021:34137",
        message: "flood?",
      }),
    ).toBe(false);
  });
});

describe("normalizeR1BodyForExternal remainder", () => {
  it("omits unlabeled unknown hatch rather than leaking a bad stub", () => {
    const body = normalizeR1BodyForExternal({
      brief: { sections: [{ id: "zoning", data: { district: "SF-1" } }] },
      draw: {
        overlays: [{ id: "x", label: "", draw: "hatch-interior", state: "unknown" }],
      },
    });
    expect(body).not.toHaveProperty("draw");
  });

  it("P-91 item 9: omits draw when present flood has empty citations and no citationsDegraded", () => {
    const body = normalizeR1BodyForExternal({
      brief: { sections: [{ id: "flood", data: { floodZone: "X" } }] },
      draw: {
        node: "48021:34137",
        overlays: [
          {
            id: "flood",
            label: "Zone X 0.2 PCT ANNUAL CHANCE FLOOD HAZARD",
            draw: "tint-ring",
            state: "present",
          },
        ],
      },
    });
    expect(body).not.toHaveProperty("draw");
  });

  it("P-91 item 9: omits draw when present landUse has empty citations and no citationsDegraded", () => {
    const body = normalizeR1BodyForExternal({
      brief: { sections: [{ id: "land-use", data: { code: "A1" } }] },
      draw: {
        node: "48021:34137",
        attrs: { landUse: { v: "A1", state: "present" } },
        overlays: [],
      },
    });
    expect(body).not.toHaveProperty("draw");
  });

  it("P-91 item 9: passes draw when present flood is labelled citationsDegraded", () => {
    const draw = {
      node: "48021:34137",
      overlays: [
        {
          id: "flood",
          label: "Zone X 0.2 PCT ANNUAL CHANCE FLOOD HAZARD",
          draw: "tint-ring",
          state: "present",
          citations: [],
          citationsDegraded: true,
        },
      ],
    };
    const body = normalizeR1BodyForExternal({
      brief: { sections: [{ id: "flood", data: { floodZone: "X" } }] },
      draw,
    });
    expect(body.draw).toEqual(draw);
  });
});

describe("mapGetSmartSiteNonOk (P-91 build plan 4.1)", () => {
  const ID = "48021:900099";
  const unbaked = {
    error: "baked_snapshot_not_found",
    message: "No baked facet snapshot exists for this parcel node.",
    parcelNodeId: ID,
  };

  it("404 parcel_not_found is a declared absence with parcelExists false", () => {
    const text = mapGetSmartSiteNonOk(
      404,
      JSON.stringify({ error: "parcel_not_found", parcelNodeId: ID, parcelExists: false }),
      [ID],
    );
    expect(text).not.toBeNull();
    expect(JSON.parse(text!)).toEqual({
      parcels: [],
      notFound: [ID],
      reason: "parcel_not_found",
      parcelExists: false,
    });
  });

  it("404 baked_snapshot_not_found carries a boolean parcelExists", () => {
    const text = mapGetSmartSiteNonOk(
      404,
      JSON.stringify({ ...unbaked, parcelExists: true }),
      [ID],
    );
    expect(JSON.parse(text!)).toEqual({
      parcels: [],
      notFound: [ID],
      reason: "baked_snapshot_not_found",
      parcelExists: true,
    });
  });

  it("404 baked_snapshot_not_found without parcelExists is unmeasured, and a non-boolean is not a boolean", () => {
    expect(JSON.parse(mapGetSmartSiteNonOk(404, JSON.stringify(unbaked), [ID])!)).toEqual({
      parcels: [],
      notFound: [ID],
      reason: "baked_snapshot_not_found",
      parcelExists: "unmeasured",
    });
    expect(
      JSON.parse(
        mapGetSmartSiteNonOk(404, JSON.stringify({ ...unbaked, parcelExists: "yes" }), [ID])!,
      ).parcelExists,
    ).toBe("unmeasured");
  });

  it("402 upgrade_required refuses every requested id and drops the upstream copy", () => {
    const body = JSON.stringify({
      error: "upgrade_required",
      message: "Unlock this property or go Pro to run this report",
      tier: "free",
    });
    expect(JSON.parse(mapGetSmartSiteNonOk(402, body, [ID])!)).toEqual({
      parcels: [],
      notFound: [],
      refused: [{ parcelNodeId: ID, reason: "upgrade_required" }],
    });
    const many = mapGetSmartSiteNonOk(402, body, ["a:1", "a:2"])!;
    expect(JSON.parse(many).refused).toEqual([
      { parcelNodeId: "a:1", reason: "upgrade_required" },
      { parcelNodeId: "a:2", reason: "upgrade_required" },
    ]);
    expect(many).not.toContain("go Pro");
  });

  it("returns null (pass through as error) for everything else", () => {
    expect(mapGetSmartSiteNonOk(404, JSON.stringify(unbaked), ["a:1", "a:2"])).toBeNull();
    expect(mapGetSmartSiteNonOk(500, JSON.stringify(unbaked), [ID])).toBeNull();
    expect(mapGetSmartSiteNonOk(404, JSON.stringify({ error: "invalid_parcel_node_id" }), [ID])).toBeNull();
    expect(mapGetSmartSiteNonOk(402, JSON.stringify({ error: "authentication_required" }), [ID])).toBeNull();
    expect(mapGetSmartSiteNonOk(401, JSON.stringify({ error: "authentication_required" }), [ID])).toBeNull();
    expect(mapGetSmartSiteNonOk(404, "not-json", [ID])).toBeNull();
    expect(mapGetSmartSiteNonOk(404, "[]", [ID])).toBeNull();
    expect(mapGetSmartSiteNonOk(404, JSON.stringify(unbaked), [])).toBeNull();
  });

  it("falsifier: every mapped miss carries reason; a copy without it is not the same shape", () => {
    const mapped = JSON.parse(mapGetSmartSiteNonOk(404, JSON.stringify(unbaked), [ID])!);
    expect(mapped.reason).toBe("baked_snapshot_not_found");
    const { reason, ...stripped } = mapped;
    void reason;
    expect(stripped).not.toHaveProperty("reason");
    expect(stripped).not.toEqual(mapped);
  });
});
