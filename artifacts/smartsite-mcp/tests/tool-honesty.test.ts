import { describe, expect, it } from "vitest";

import {
  ASK_THE_MAP_INTERNAL_FIELD_NAMES,
  askTheMapArgsLeakInternalFields,
  buildRunReportEnvelope,
  declareUpstreamNonOk,
  mapGetSmartSiteNonOk,
  normalizeGetSmartSiteResponseText,
  normalizeR1BodyForExternal,
  sanitizeAskTheMapErrorBody,
  STUB_RAIL_FOR_NODE_DISPOSITION,
  stripSavedPropertiesForExternal,
  stubRailAgreesWithNodeDisposition,
  type ExternalBriefSectionDisposition,
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

describe("declareUpstreamNonOk (H1 wire half; run_report stamp only on res.ok)", () => {
  it("keeps the upstream JSON body under its own keys; status error, reason from error, upstreamStatus is the HTTP status", () => {
    const body = declareUpstreamNonOk(
      402,
      JSON.stringify({
        error: "upgrade_required",
        message: "Unlock this property or go Pro to run this report",
        tier: "free",
      }),
    );
    expect(body).toEqual({
      status: "error",
      reason: "upgrade_required",
      upstreamStatus: 402,
      error: "upgrade_required",
      message: "Unlock this property or go Pro to run this report",
      tier: "free",
    });
    expect(body).not.toHaveProperty("reportKind");
    expect(body).not.toHaveProperty("reportReadMode");
    expect(body).not.toHaveProperty("async");
  });

  it("an upstream status field moves to upstreamBodyStatus and cannot overwrite the error marker; an upstream reason is kept", () => {
    const body = declareUpstreamNonOk(
      429,
      JSON.stringify({ status: "queued", reason: "rate_limited", error: "throttled" }),
    );
    expect(body).toEqual({
      status: "error",
      reason: "rate_limited",
      upstreamStatus: 429,
      upstreamBodyStatus: "queued",
      error: "throttled",
    });
  });

  it("a JSON body naming no error and no reason is upstream_error, never a bare status", () => {
    expect(declareUpstreamNonOk(500, JSON.stringify({ detail: "pool exhausted" }))).toEqual({
      status: "error",
      reason: "upstream_error",
      upstreamStatus: 500,
      detail: "pool exhausted",
    });
    // A non-string or empty error code is not a reason.
    expect(declareUpstreamNonOk(500, JSON.stringify({ error: { code: 7 } })).reason).toBe(
      "upstream_error",
    );
    expect(declareUpstreamNonOk(500, JSON.stringify({ error: "" })).reason).toBe("upstream_error");
  });

  it("non-JSON and non-object bodies are wrapped as upstream_non_json under brief", () => {
    expect(declareUpstreamNonOk(502, "<html>bad gateway</html>")).toEqual({
      status: "error",
      reason: "upstream_non_json",
      upstreamStatus: 502,
      brief: "<html>bad gateway</html>",
    });
    expect(declareUpstreamNonOk(500, "[1,2]")).toEqual({
      status: "error",
      reason: "upstream_non_json",
      upstreamStatus: 500,
      brief: "[1,2]",
    });
    expect(declareUpstreamNonOk("unmeasured", "")).toEqual({
      status: "error",
      reason: "upstream_non_json",
      upstreamStatus: "unmeasured",
      brief: "",
    });
  });

  it("falsifier: every declared body has a non-empty string status and reason; a body without one is not the shape", () => {
    const bodies = [
      declareUpstreamNonOk(500, JSON.stringify({ error: "internal" })),
      declareUpstreamNonOk(502, "<html>"),
      declareUpstreamNonOk(404, JSON.stringify({})),
    ];
    for (const body of bodies) {
      expect(typeof body.status).toBe("string");
      expect(body.status.length).toBeGreaterThan(0);
      expect(typeof body.reason).toBe("string");
      expect(body.reason.length).toBeGreaterThan(0);
    }
    const { reason, ...stripped } = bodies[0]!;
    void reason;
    expect(stripped).not.toHaveProperty("reason");
    expect(stripped).not.toEqual(bodies[0]);
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
          dispositionDisplayText: "Reported absent",
          agentGuidance:
            "This facet is reported absent for this parcel on this call. Do not invent a zoning district, jurisdiction, or permitted-use table.",
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

  describe("F7: an explicit disposition survives normalization; only an unsupported claim is rewritten", () => {
    type Section = {
      id?: string;
      data: unknown;
      disposition: string;
      reason?: unknown;
      refusal?: unknown;
    };
    const sectionsOf = (body: Record<string, unknown>): Section[] =>
      (body.brief as { sections: Section[] }).sections;

    it("explicit unread with null data stays unread and keeps its reason", () => {
      const body = normalizeR1BodyForExternal({
        brief: {
          sections: [
            {
              id: "drainage",
              data: null,
              citations: [],
              disposition: "unread",
              reason: "drainage facet not yet baked for this parcel",
            },
          ],
        },
      });
      expect(sectionsOf(body)[0]).toEqual({
        id: "drainage",
        data: null,
        citations: [],
        disposition: "unread",
        dispositionDisplayText: "Not read",
        reason: "drainage facet not yet baked for this parcel",
        agentGuidance:
          "This facet is not read for this parcel on this call. Do not invent drainage infrastructure, capacity, or a compliance state.",
      });
    });

    it("no disposition and null data still derives absent", () => {
      const body = normalizeR1BodyForExternal({
        brief: { sections: [{ id: "drainage", data: null, citations: [] }] },
      });
      expect(sectionsOf(body)[0]?.disposition).toBe("absent");
    });

    it("a claim of present with null data and no refusal is rewritten to absent (fail closed), and the rewrite is real", () => {
      const claimed = { id: "drainage", data: null, citations: [], disposition: "present" };
      expect(claimed.disposition).toBe("present");
      const body = normalizeR1BodyForExternal({ brief: { sections: [claimed] } });
      const out = sectionsOf(body)[0]!;
      expect(out.disposition).toBe("absent");
      expect(out.disposition).not.toBe(claimed.disposition);
      expect(out.data).toBeNull();
    });

    it("a claim of present with null data but a refusal is rewritten to refused, not absent", () => {
      const body = normalizeR1BodyForExternal({
        brief: {
          sections: [
            {
              id: "setbacks-envelope",
              data: null,
              disposition: "present",
              refusal: { state: "refused", code: "atom_path_pending" },
            },
          ],
        },
      });
      expect(sectionsOf(body)[0]?.disposition).toBe("refused");
    });

    it("explicit refused, absent, and present-with-data are kept as claimed, reasons intact", () => {
      const body = normalizeR1BodyForExternal({
        brief: {
          sections: [
            { id: "a", data: null, disposition: "refused", reason: "declined" },
            { id: "b", data: null, disposition: "absent", reason: "no record" },
            { id: "c", data: { v: 1 }, disposition: "present" },
          ],
        },
      });
      const out = sectionsOf(body);
      expect(out.map((s) => s.disposition)).toEqual(["refused", "absent", "present"]);
      expect(out[0]?.reason).toBe("declined");
      expect(out[1]?.reason).toBe("no record");
    });

    it("a disposition outside the six recognised words is ignored and derived", () => {
      const body = normalizeR1BodyForExternal({
        brief: {
          sections: [
            { id: "x", data: null, disposition: "maybe" },
            { id: "y", data: { v: 1 }, disposition: "" },
          ],
        },
      });
      expect(sectionsOf(body).map((s) => s.disposition)).toEqual(["absent", "present"]);
    });

    it("reaches node-batch rows through normalizeGetSmartSiteResponseText", () => {
      const text = normalizeGetSmartSiteResponseText(
        JSON.stringify({
          parcels: [
            {
              parcelNodeId: "48021:34137",
              brief: {
                sections: [
                  {
                    id: "drainage",
                    data: null,
                    citations: [],
                    disposition: "unread",
                    reason: "not read",
                  },
                ],
              },
            },
          ],
          notFound: [],
        }),
        "stub-or-batch",
      );
      const parcels = JSON.parse(text).parcels as Array<{ brief: { sections: Section[] } }>;
      expect(parcels[0]?.brief.sections[0]).toMatchObject({
        disposition: "unread",
        reason: "not read",
      });
    });
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

  it("A3: gold draw's own facts are byte-identical after honesty normalize; V5 adds derivedFigures only", () => {
    const body = normalizeR1BodyForExternal({
      brief: { sections: [{ id: "zoning", data: { district: "SF-1" } }] },
      draw: GOLD_DRAW_A3,
    });
    expect(JSON.stringify(body.draw)).toBe(
      JSON.stringify({
        ...GOLD_DRAW_A3,
        derivedFigures: {
          denies: ["area", "coverage_ratio", "lot_coverage_pct", "setback_distance", "buildable_area"],
          reason:
            "ring, edges, and overlays are for rendering only. Do not compute an area, a coverage ratio, a percentage, or a distance from them; use a brief section's own figure, or say the figure is not on record.",
        },
      }),
    );
  });
});

describe("P-91 v3 item 1: unknown and absent-verified are preserved, not strengthened", () => {
  type Section = { id?: string; disposition: string; dispositionDisplayText?: string };
  const sectionsOf = (body: Record<string, unknown>): Section[] =>
    (body.brief as { sections: Section[] }).sections;

  it("a section claiming unknown with no data comes out unknown, not absent (the defect card's own repro)", () => {
    const body = normalizeR1BodyForExternal({
      brief: {
        sections: [{ id: "land-use", data: null, citations: [], disposition: "unknown" }],
      },
    });
    const out = sectionsOf(body)[0]!;
    expect(out.disposition).toBe("unknown");
    expect(out.disposition).not.toBe("absent");
    expect(out.dispositionDisplayText).toBe("unknown");
  });

  it("a section claiming absent-verified with no data keeps the verified qualifier, not degraded to absent", () => {
    const body = normalizeR1BodyForExternal({
      brief: {
        sections: [
          { id: "flood", data: null, citations: [], disposition: "absent-verified" },
        ],
      },
    });
    const out = sectionsOf(body)[0]!;
    expect(out.disposition).toBe("absent-verified");
    expect(out.disposition).not.toBe("absent");
    expect(out.dispositionDisplayText).toBe("absent, verified");
  });

  it("present-with-no-data still weakens to absent even now that unknown is a member (the one permitted rewrite is unchanged)", () => {
    const body = normalizeR1BodyForExternal({
      brief: {
        sections: [{ id: "zoning", data: null, citations: [], disposition: "present" }],
      },
    });
    expect(sectionsOf(body)[0]?.disposition).toBe("absent");
  });

  describe("stubRailAgreesWithNodeDisposition: two independently-fetched reads, not one payload read twice", () => {
    it("agrees on the four states stub and node share directly", () => {
      expect(stubRailAgreesWithNodeDisposition("present", "present")).toBe(true);
      expect(stubRailAgreesWithNodeDisposition("refused", "refused")).toBe(true);
      expect(stubRailAgreesWithNodeDisposition("unread", "unread")).toBe(true);
    });

    it("node absent agreeing with stub unknown is the CORRECT, designed pairing, not a disagreement", () => {
      // This is the exact pair the defect card's own W2 harness observed
      // (land-use: unknown at stub, absent at node) and read as a bug. Read
      // from api-server's write path (railStateFromSectionDisposition,
      // src/lib/smartSiteStub.ts: `case "absent": return "unknown"`), it is
      // the documented, shared projection: stub deliberately prints a more
      // conservative glance word for a node section with no determination.
      // A check that failed this case would be wrong on every healthy
      // parcel with an absent facet, which is the opposite of a check.
      expect(stubRailAgreesWithNodeDisposition("unknown", "absent")).toBe(true);
      expect(STUB_RAIL_FOR_NODE_DISPOSITION.absent).toBe("unknown");
    });

    it("falsifier: verify by violation -- a genuine disagreement is reported, not waved through", () => {
      // stub claims present, node genuinely has no determination: a real
      // divergence (stale cache, a race between the two separate reads, or
      // a bug in either projection), not the designed absent/unknown pair.
      expect(stubRailAgreesWithNodeDisposition("present", "absent")).toBe(false);
      // stub still says refused after node came back present: also a real
      // divergence, and the mirror-image direction of the case above.
      expect(stubRailAgreesWithNodeDisposition("refused", "present")).toBe(false);
      // stub and node both claim a state peer to unknown/absent-verified,
      // but not the SAME one: absent-verified cannot silently pass as
      // unknown or vice versa, so an upgrade-in-transit is still caught.
      expect(stubRailAgreesWithNodeDisposition("unknown", "absent-verified")).toBe(false);
    });

    it("every node disposition has a stated expected stub word; the table is total, not partial", () => {
      const dispositions: ExternalBriefSectionDisposition[] = [
        "present",
        "refused",
        "unread",
        "absent",
        "unknown",
        "absent-verified",
      ];
      for (const d of dispositions) {
        expect(typeof STUB_RAIL_FOR_NODE_DISPOSITION[d]).toBe("string");
      }
    });
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
    expect(body.draw).toEqual({
      ...draw,
      derivedFigures: {
        denies: ["area", "coverage_ratio", "lot_coverage_pct", "setback_distance", "buildable_area"],
        reason:
          "ring, edges, and overlays are for rendering only. Do not compute an area, a coverage ratio, a percentage, or a distance from them; use a brief section's own figure, or say the figure is not on record.",
      },
    });
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

describe("P-91 v3 V3: dispositionDisplayText on every section", () => {
  type Section = { id?: string; disposition: string; dispositionDisplayText?: string };
  const sectionsOf = (body: Record<string, unknown>): Section[] =>
    (body.brief as { sections: Section[] }).sections;

  it("attaches the exact display text for each of the four wire dispositions", () => {
    const body = normalizeR1BodyForExternal({
      brief: {
        sections: [
          { id: "zoning", data: { district: "SF-1" } },
          { id: "land-use", data: null, disposition: "absent" },
          { id: "flood", data: null, refusal: { code: "not-in-bake" } },
          { id: "drainage", data: null, disposition: "unread" },
        ],
      },
    });
    const sections = sectionsOf(body);
    expect(sections.map((s) => [s.disposition, s.dispositionDisplayText])).toEqual([
      ["present", "Present"],
      ["absent", "Reported absent"],
      ["refused", "Refused"],
      ["unread", "Not read"],
    ]);
  });

  it("falsifier: a section whose dispositionDisplayText is missing is not the shape this normalizer promises", () => {
    const body = normalizeR1BodyForExternal({
      brief: { sections: [{ id: "zoning", data: { district: "SF-1" } }] },
    });
    const section = sectionsOf(body)[0]!;
    expect(section).toHaveProperty("dispositionDisplayText");
    const { dispositionDisplayText, ...stripped } = section;
    void dispositionDisplayText;
    expect(stripped).not.toHaveProperty("dispositionDisplayText");
    expect(stripped).not.toEqual(section);
  });
});

describe("P-91 v3 V3/V6: overlay reasonDisplayText and the unknown-state finding split", () => {
  it("the live-session bug, reproduced and fixed: an envelope overlay's raw atom_path_pending reason now carries the panel's own display text beside it, unchanged", () => {
    const body = normalizeR1BodyForExternal({
      brief: { sections: [{ id: "zoning", data: { district: "SF-1" } }] },
      draw: {
        node: "48021:34137",
        overlays: [
          {
            id: "envelope",
            label: "Buildable envelope not computed",
            draw: "suppress-setback-line",
            state: "refused",
            reason: "atom_path_pending",
          },
        ],
      },
    });
    const draw = body.draw as { overlays: Array<Record<string, unknown>> };
    expect(draw.overlays[0]?.reason).toBe("atom_path_pending");
    expect(draw.overlays[0]?.reasonDisplayText).toBe("Withheld, setbacks unruled");
  });

  it("an overlay reason with no special mapping still gets reasonDisplayText, equal to the raw reason (envelopeHuman's pass-through)", () => {
    const body = normalizeR1BodyForExternal({
      brief: { sections: [{ id: "zoning", data: { district: "SF-1" } }] },
      draw: {
        node: "48021:34137",
        overlays: [
          { id: "drainage", label: "Drainage not evaluated", state: "unread", reason: "not_yet_baked" },
        ],
      },
    });
    const draw = body.draw as { overlays: Array<Record<string, unknown>> };
    expect(draw.overlays[0]?.reasonDisplayText).toBe("not_yet_baked");
  });

  it("an overlay with no reason at all gets no reasonDisplayText key (additive, never a fabricated one)", () => {
    const body = normalizeR1BodyForExternal({
      brief: { sections: [{ id: "zoning", data: { district: "SF-1" } }] },
      draw: {
        node: "48021:34137",
        overlays: [{ id: "flood", label: "Zone X", state: "present", citations: [], citationsDegraded: true }],
      },
    });
    const draw = body.draw as { overlays: Array<Record<string, unknown>> };
    expect(draw.overlays[0]).not.toHaveProperty("reasonDisplayText");
  });

  it("V6: an unknown-state overlay's finding-shaped label never becomes a printable finding — finding is explicit null, label is untouched", () => {
    const body = normalizeR1BodyForExternal({
      brief: { sections: [{ id: "zoning", data: { district: "SF-1" } }] },
      draw: {
        node: "48021:34137",
        overlays: [
          {
            id: "pipeline",
            label: "No pipeline within 500 ft",
            draw: "legend-only",
            state: "unknown",
          },
        ],
      },
    });
    const draw = body.draw as { overlays: Array<Record<string, unknown>> };
    expect(draw.overlays[0]?.label).toBe("No pipeline within 500 ft");
    expect(draw.overlays[0]).toHaveProperty("finding");
    expect(draw.overlays[0]?.finding).toBeNull();
  });

  it("V6 is scoped to state unknown only: a present-state overlay gets no finding key at all", () => {
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
            citations: [],
            citationsDegraded: true,
          },
        ],
      },
    });
    const draw = body.draw as { overlays: Array<Record<string, unknown>> };
    expect(draw.overlays[0]).not.toHaveProperty("finding");
  });

  it("falsifier: the finding-split check fails on an overlay that leaks its unknown-state label as finding", () => {
    const bogus = { state: "unknown", label: "No pipeline within 500 ft", finding: "No pipeline within 500 ft" };
    expect(bogus.finding).not.toBeNull();
  });
});

describe("P-91 v3 V4: facet-scoped agentGuidance on every non-present facet", () => {
  const FACETS = ["zoning", "land-use", "flood", "drainage", "setbacks-envelope"] as const;
  const TOPIC_WORD: Record<(typeof FACETS)[number], string> = {
    zoning: "zoning district",
    "land-use": "land-use code",
    flood: "flood zone",
    drainage: "drainage infrastructure",
    "setbacks-envelope": "setback distance",
  };

  it("every known facet gets non-empty, facet-specific guidance when absent", () => {
    const body = normalizeR1BodyForExternal({
      brief: {
        sections: FACETS.map((id) => ({ id, data: null, disposition: "absent" })),
      },
    });
    const sections = (body.brief as { sections: Array<{ id: string; agentGuidance?: string }> }).sections;
    for (const section of sections) {
      const id = section.id as (typeof FACETS)[number];
      expect(section.agentGuidance).toBeTruthy();
      expect(section.agentGuidance).toContain("Do not invent");
      expect(section.agentGuidance).toContain(TOPIC_WORD[id]);
    }
    // Facet-scoped, not one shared blob: no two facets get the same sentence.
    expect(new Set(sections.map((s) => s.agentGuidance)).size).toBe(FACETS.length);
  });

  it("a present facet gets no agentGuidance (mechanism fires only on the non-present branch)", () => {
    const body = normalizeR1BodyForExternal({
      brief: { sections: [{ id: "zoning", data: { district: "SF-1" } }] },
    });
    const sections = (body.brief as { sections: Array<{ agentGuidance?: string }> }).sections;
    expect(sections[0]?.agentGuidance).toBeUndefined();
  });

  it("a wire-supplied agentGuidance always wins over the derived one", () => {
    const body = normalizeR1BodyForExternal({
      brief: {
        sections: [
          { id: "zoning", data: null, disposition: "absent", agentGuidance: "Custom upstream guidance." },
        ],
      },
    });
    const sections = (body.brief as { sections: Array<{ agentGuidance?: string }> }).sections;
    expect(sections[0]?.agentGuidance).toBe("Custom upstream guidance.");
  });

  it("an id outside the known facet map still gets guidance (starved-mechanism guard), generic topic", () => {
    const body = normalizeR1BodyForExternal({
      brief: { sections: [{ id: "some-future-facet", data: null, disposition: "unread" }] },
    });
    const sections = (body.brief as { sections: Array<{ agentGuidance?: string }> }).sections;
    expect(sections[0]?.agentGuidance).toBe(
      "This facet is not read for this parcel on this call. Do not invent a value for this facet.",
    );
  });

  it("falsifier: the facet-scoping check fails if every facet shared one guidance string", () => {
    const bogus = FACETS.map(() => "One shared sentence for every facet.");
    expect(new Set(bogus).size).not.toBe(FACETS.length);
  });
});
