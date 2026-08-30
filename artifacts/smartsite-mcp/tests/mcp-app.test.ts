import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { SERVER_NAME } from "../src/constants.js";
import {
  APP_HOST_TOOLS,
  APP_MIME,
  APP_RESOURCE_URI,
  LISTING_ACK_LABEL,
  LISTING_TURN_DESTINATION,
  LISTING_TURN_GUARD,
  LISTING_TURN_INSTRUCTION,
  LISTING_TURN_OPENER,
  EMPTY_BOARD_TITLE,
  NOTHING_TO_OPEN,
  NOT_ON_FILE_PREFIX,
  NO_BAKED_SNAPSHOT_PREFIX,
  OPEN_SENT,
  RESULT_NOT_READABLE,
  UPGRADE_TO_OPEN,
  COUNTY_BY_FIPS,
  OPEN_DEAD_MS,
  OPEN_DID_NOT_REACH_ME,
  OPEN_TURN_INSTRUCTION,
  OPEN_TURN_OPENER,
  buildAppHtml,
  countyForNodeId,
  escapeHtml,
  noBakedSnapshotSentence,
  notOnFileSentence,
  parseToolContent,
  edgeCaption,
  envelopeHuman,
  openParcelMessage,
  classifyListingOutcome,
  glyphClass,
  htmlContractViolations,
  listingHistoryClick,
  listingHistoryMessage,
  listingTurnIsGuarded,
  looksLikeParcelNodeId,
  parseToolResult,
  panelFingerprint,
  renderParcelDraw,
  ringSvg,
  unresolvedCaption,
} from "../src/mcp-app.js";
import { registerTools } from "../src/tools.js";

describe("mcp-app contracts", () => {
  it("labels a node-id miss as a node, not a situs", () => {
    expect(looksLikeParcelNodeId("48021:34137")).toBe(true);
    expect(looksLikeParcelNodeId("zzzz-not-a-situs-99999")).toBe(false);
    expect(unresolvedCaption("48021:34137")).toBe("node unresolved");
    expect(unresolvedCaption("zzzz-not-a-situs-99999")).toBe("situs unresolved");
  });

  it("ships Claude chrome and keeps listing history off the board template", () => {
    const html = buildAppHtml();
    expect(html).toContain('data-theme="claude"');
    expect(html).toContain("btn primary");
    expect(html).toContain("node unresolved");
    expect(html).not.toContain('data-act="listing" disabled');
    expect(html).not.toMatch(/#F3F5F1|#F5F5F0/);
    expect(html).toContain("--ss-ink:#323234");
    expect(html).toContain("--ss-blue:#86ADDF");
    expect(html).toContain("--ss-atom:#6FC1B8");
    expect(html).toContain("--bg:#1c1c1c");
    expect(html).toContain("--ss-fs-meta:12.5px");
    expect(html).toContain("--ss-fs-body:14.5px");
    expect(html).toContain("--ss-r-tip:12px");
    expect(html).toContain("--ss-ui:");
    expect(html).not.toMatch(/#8fde5d|#e8c36a|#b08ad4/);
    expect(html).not.toContain(".btn.primary{background:#fff");
    expect(html).not.toMatch(/font-size:\s*10px|font:\s*10px|font-size:\s*13px|font:\s*13px|font-size:\s*26px|font:\s*26px|font-size:\s*32px|font:\s*32px/);
    expect(html).not.toContain("border-radius:18");
    expect(html).not.toContain("fonts.googleapis");
    expect(html).toContain("position:sticky");
    expect(html).toContain('id="boot"');
    expect(html).toContain("script-ran");
    expect(html).toContain('document.body.addEventListener("click"');
    expect(html).toContain('data-act="open"');
    expect(html).toContain("window.__ss&&window.__ss.open(this)");
    expect(html).toContain("window.__ss&&window.__ss.listing(this)");
    expect(html).toContain("window.__ss&&window.__ss.save()");
    expect(html).toContain("host.sendMessage(text)");
    expect(html).toContain('id:id,method:"ui/message"');
    expect(html).toContain('content:[{type:"text",text:text}]');
    expect(html).not.toContain('params:{role:"user",content:{type:"text"');
    expect(html).not.toContain('{jsonrpc:"2.0",method:"ui/message"');
    expect(html).toContain('id:initId,method:"ui/initialize"');
    expect(html).toContain("function flushReady");
    expect(html).toContain("function paintBoot");
    expect(html).toContain("function summarizeCaps");
    expect(html).toContain("hostCapabilities");
    expect(html).toContain("pendingMsg");
    expect(html).toContain("handshake=");
    expect(html).toContain("message=none");
    expect(html).toContain("reply=");
    expect(html).toContain("String(d.id)===String(initId)");
    expect(html).toContain("pending.push");
    expect(html).not.toContain('id:rpcId++,method:"ui/initialize"');
    expect(APP_RESOURCE_URI).toBe("ui://smartsite/app-p555.html");
    expect(html).toContain("function fitHost");
    expect(html).toContain("ui/notifications/size-changed");
    expect(html).not.toMatch(/html,body\{[^}]*height:100%/);
    expect(html.indexOf(LISTING_ACK_LABEL)).toBeGreaterThan(0);
    expect(html.indexOf(LISTING_ACK_LABEL)).toBeLessThan(html.indexOf("host.sendMessage(text)"));
    expect(html).toContain(LISTING_TURN_INSTRUCTION);
    expect(html).toContain(OPEN_TURN_OPENER);
    expect(html).toContain(OPEN_TURN_INSTRUCTION);
    expect(html).not.toContain("atom_path_pending");
    expect(html).not.toMatch(/\bask_the_map\s*\(/);
  });

  it("unread and unknown do not share a glyph class", () => {
    expect(glyphClass("unread")).toBe("g-unread");
    expect(glyphClass("unknown")).toBe("g-unknown");
    expect(glyphClass("unread")).not.toBe(glyphClass("unknown"));
  });

  it("HTML fails when a private origin or invented percent is planted", () => {
    const clean = buildAppHtml();
    expect(htmlContractViolations(clean)).toEqual([]);
    expect(htmlContractViolations(clean + "https://fonts.googleapis.com")).toContain(
      "private_or_font_origin",
    );
    expect(htmlContractViolations(clean + " column total 12 coverage %")).toContain(
      "aggregate_or_invented_pct",
    );
    expect(htmlContractViolations(clean + "#F3F5F1")).toContain("cream_host_theme");
    expect(htmlContractViolations(clean + "ask_the_map({runId:1})")).toContain("ask_the_map_call");
    expect(
      htmlContractViolations(clean.replace(/Do not call ask_the_map/g, "Do not call the map tool")),
    ).toContain("listing_missing_ask_the_map_guard");
    expect(htmlContractViolations(clean.replace(/function flushReady/g, "function skipReady"))).toContain(
      "handshake_no_wait",
    );
    expect(
      htmlContractViolations(
        clean +
          'parent.postMessage({jsonrpc:"2.0",id:1,method:"ui/initialize",params:{}});parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/initialized"},"*");',
      ),
    ).toContain("handshake_fire_before_reply");
    expect(
      htmlContractViolations(
        clean.replace(
          'content:[{type:"text",text:text}]',
          'content:{type:"text",text:text}',
        ),
      ),
    ).toContain("ui_message_content_object");
    expect(htmlContractViolations(clean.replace(/function paintBoot/g, "function skipBoot"))).toContain(
      "handshake_not_visible",
    );
    expect(htmlContractViolations(clean.replace(/hostCapabilities/g, "hostInfo"))).toContain(
      "caps_unread",
    );
    expect(htmlContractViolations(clean.replace(/pendingMsg/g, "sentMsg"))).toContain(
      "message_reply_unread",
    );
    expect(
      htmlContractViolations(clean.replace(/html,body\{margin:0;padding:0/, "html,body{margin:0;padding:0;height:100%")),
    ).toContain("iframe_fills_host");
    expect(htmlContractViolations(clean.replace(/function fitHost/g, "function skipFit"))).toContain(
      "iframe_size_unreported",
    );
    expect(htmlContractViolations(clean + "save_to_screen")).toContain("ghost_catalog_tool");
    expect(htmlContractViolations(clean + "find_listing_history")).toContain("ghost_catalog_tool");
    expect(htmlContractViolations(clean + "Save to screen")).toContain("save_to_screen_label");
    expect(htmlContractViolations(clean + "Not read yet")).toContain("hatch_labeled_unread");
    expect(
      htmlContractViolations(clean.replace("if(ev.source!==window.parent)", "if(false)")),
    ).toContain("origin_unchecked");
    expect(
      htmlContractViolations(
        clean
          .replace("var d=ev.data;", "")
          .replace("if(ev.source!==window.parent)", "var d=ev.data;if(ev.source!==window.parent)"),
      ),
    ).toContain("origin_unchecked");
    for (const sentence of [
      OPEN_DID_NOT_REACH_ME,
      OPEN_SENT,
      NOT_ON_FILE_PREFIX,
      NO_BAKED_SNAPSHOT_PREFIX,
      UPGRADE_TO_OPEN,
      RESULT_NOT_READABLE,
      NOTHING_TO_OPEN,
    ]) {
      expect(htmlContractViolations(clean.split(sentence).join("")), sentence).toContain("miss_copy_unbound");
    }
  });

  it("does not treat list_my_properties as a board source", () => {
    const model = parseToolResult(
      JSON.stringify({
        savedProperties: [{ id: "x", parcelNodeId: "48021:34137", label: "gold" }],
      }),
    );
    expect(model.kind).toBe("empty");
    expect(model.rows).toEqual([]);
  });

  it("keeps unresolved query verbatim on a screen", () => {
    const model = parseToolResult(
      JSON.stringify({
        id: "screen-1",
        rows: [
          {
            query: "zzzz-not-a-situs-99999",
            parcelNodeId: null,
            resolution: "unresolved",
          },
          {
            query: "48021:34137",
            parcelNodeId: "48021:34137",
            resolution: "resolved",
            stub: { situs: "present", envelope: "refused" },
          },
        ],
      }),
    );
    expect(model.kind).toBe("board");
    expect(model.rows[0]?.query).toBe("zzzz-not-a-situs-99999");
    expect(model.rows[0]?.resolution).toBe("unresolved");
    expect(model.rows[1]?.rails.envelope).toBe("refused");
    expect(model.rows[1]?.rails.flood).toBe("unread");
  });

  it("parcel panel keeps envelope refused and listing history does not mutate the fingerprint", () => {
    const model = parseToolResult(
      JSON.stringify({
        parcelNodeId: "48021:33223",
        draw: {
          label: "927 MAIN ST , BASTROP, TX 78602",
          overlays: [
            {
              id: "envelope",
              state: "refused",
              reason: "atom_path_pending",
              label: "Buildable envelope not computed",
            },
          ],
        },
      }),
    );
    expect(model.kind).toBe("parcel");
    expect(model.overlays[0]?.state).toBe("refused");
    expect(model.overlays[0]?.reason).toBe("atom_path_pending");
    expect(JSON.stringify(model)).not.toMatch(/42\s*%/);
    const click = listingHistoryClick(model);
    expect(click.fingerprintAfter).toBe(click.fingerprintBefore);
    expect(click.fingerprintAfter).toBe(panelFingerprint(model));
    expect(click.message).toBe(listingHistoryMessage(model));
    expect(click.message).toBe(
      `${LISTING_TURN_OPENER} 927 MAIN ST , BASTROP, TX 78602. ${LISTING_TURN_DESTINATION} ${LISTING_TURN_GUARD}`,
    );
    expect(listingTurnIsGuarded(click.message)).toBe(true);
    expect(click.message).toMatch(/transcript/);
    expect(click.message).toContain("Do not call ask_the_map");
    expect(click.message).toMatch(/public web/);
    expect(click.message).not.toMatch(/42/);
  });

  it("distinguishes handler_unbound, host_drop, guard_failed, and working", () => {
    const turn = listingHistoryMessage({
      kind: "parcel",
      rows: [],
      overlays: [],
      label: "908 PINE , BASTROP, TX 78602",
      parcelNodeId: "48021:34137",
    });
    expect(classifyListingOutcome({
      turnText: null,
      localAck: false,
      toolsCalled: ["ask_the_map"],
      answeredInTranscript: false,
    })).toBe("handler_unbound");
    expect(classifyListingOutcome({
      turnText: null,
      localAck: true,
      toolsCalled: [],
      answeredInTranscript: false,
    })).toBe("host_drop");
    expect(classifyListingOutcome({
      turnText: turn,
      localAck: true,
      toolsCalled: ["ask_the_map"],
      answeredInTranscript: false,
    })).toBe("guard_failed");
    expect(classifyListingOutcome({
      turnText: "Find listing history for this parcel. Search the public web.",
      localAck: true,
      toolsCalled: [],
      answeredInTranscript: true,
    })).toBe("guard_failed");
    expect(classifyListingOutcome({
      turnText: turn,
      localAck: true,
      toolsCalled: [],
      answeredInTranscript: true,
    })).toBe("working");
    expect(() =>
      classifyListingOutcome({
        turnText: turn,
        localAck: true,
        toolsCalled: [],
        answeredInTranscript: false,
      }),
    ).toThrow(/listing_outcome_unclassified/);
  });
});

const GOLD_RING = [
  [48.6, 83.94],
  [-50.37, 83.7],
  [-49.07, -84.28],
  [50.84, -83.36],
] as const;

const GOLD_EDGES = [
  { i: 0, role: "rear", ft: 98.98, bearing: "S 89°52' W", adjacency: "alley", roadNode: "48021:road:925036023" },
  { i: 1, role: "side", ft: 167.99, neighbor: "48021:34169" },
  { i: 2, role: "front", ft: 99.92, adjacency: "ROW", roadNode: "48021:road:15113284" },
  { i: 3, role: "side_corner", ft: 167.32, adjacency: "ROW", roadNode: "48021:road:129017865" },
];

describe("Wave I look up", () => {
  it("Open is a unique turn that calls get_smart_site and does not save", () => {
    const text = openParcelMessage("48021:34137");
    expect(text.startsWith(OPEN_TURN_OPENER)).toBe(true);
    expect(text).toContain("48021:34137");
    expect(text).toContain("get_smart_site");
    expect(text).toMatch(/depth node/);
    expect(text).toContain("Do not call save_property");
    expect(text).toContain("Do not search the web");
    expect(text).not.toContain("save_to_screen");
    expect(text).not.toContain("find_listing_history");
    expect(text).not.toMatch(/Do not save it/);
    expect(text).not.toBe(
      "Open parcel 48021:34137 with get_smart_site depth node. Do not save it.",
    );
    const html = buildAppHtml();
    expect(html).toContain("openParcelMessage(node)");
    expect(html).not.toContain("Open parcel \"+node+\" with get_smart_site");
  });

  it("keeps ring vertices from the tool result and does not invent three PINE sides", () => {
    const ringOnly = parseToolResult(
      JSON.stringify({
        parcelNodeId: "48021:34137",
        draw: {
          label: "908 PINE , BASTROP, TX 78602",
          ring: GOLD_RING,
          overlays: [
            { id: "flood", state: "present", label: "Zone X" },
            { id: "envelope", state: "refused", reason: "atom_path_pending", label: "Buildable envelope not computed" },
          ],
        },
      }),
    );
    expect(ringOnly.kind).toBe("parcel");
    expect(ringOnly.ring).toEqual([
      { x: 48.6, y: 83.94 },
      { x: -50.37, y: 83.7 },
      { x: -49.07, y: -84.28 },
      { x: 50.84, y: -83.36 },
    ]);
    expect(ringOnly.edges).toEqual([]);
    const ringOnlyHtml = renderParcelDraw(ringOnly);
    expect(ringOnlyHtml).toContain("<polygon");
    expect(ringOnlyHtml).not.toContain("alley");
    expect(ringOnlyHtml).not.toContain("34169");
    const pineInEdges = (ringOnly.edges ?? [])
      .map(edgeCaption)
      .filter((c) => /PINE/i.test(c));
    expect(pineInEdges).toEqual([]);

    const withEdges = parseToolResult(
      JSON.stringify({
        parcelNodeId: "48021:34137",
        draw: {
          label: "908 PINE , BASTROP, TX 78602",
          ring: GOLD_RING,
          edges: GOLD_EDGES,
          overlays: [
            { id: "flood", state: "present", label: "Zone X" },
            { id: "envelope", state: "refused", reason: "atom_path_pending", label: "Buildable envelope not computed" },
          ],
        },
      }),
    );
    const caps = (withEdges.edges ?? []).map(edgeCaption);
    expect(caps.filter((c) => /PINE/i.test(c))).toEqual([]);
    expect(caps.some((c) => c.includes("alley"))).toBe(true);
    expect(caps.some((c) => c.includes("48021:34169"))).toBe(true);
    expect(caps.some((c) => c.includes("48021:road:15113284"))).toBe(true);
    expect(caps.some((c) => c.includes("48021:road:129017865"))).toBe(true);
    expect(caps.some((c) => c.includes("48021:road:925036023"))).toBe(true);
    const drawn = renderParcelDraw(withEdges);
    expect(drawn).toContain("stroke-dasharray");
    expect(drawn).toContain("Withheld, setbacks unruled");
    expect(drawn).not.toContain("atom_path_pending");
    expect(drawn).not.toMatch(/42\s*%/);
    expect(drawn).toContain("pn atom");
    expect(ringSvg(withEdges.ring ?? [], withEdges.edges ?? [])).toContain("parcel ring");
    const threePine = ["PINE", "PINE", "PINE"].every((word, i) =>
      (GOLD_EDGES[i] ? edgeCaption(GOLD_EDGES[i]) : "").includes(word),
    );
    expect(threePine).toBe(false);
  });

  it("maps the envelope machine reason to human copy", () => {
    expect(envelopeHuman("atom_path_pending")).toBe("Withheld, setbacks unruled");
    expect(envelopeHuman("other")).toBe("other");
  });
});

describe("Wave J honesty", () => {
  it("binds legend words and refuses a hatch labeled unread", () => {
    const html = buildAppHtml();
    expect(html).toContain(" present</span>");
    expect(html).toContain(" absent, verified</span>");
    expect(html).toContain(" unknown</span>");
    expect(html).toContain(" refused</span>");
    expect(html).toContain(" unread</span>");
    expect(html).not.toContain("Not read yet");
    expect(htmlContractViolations(html)).toEqual([]);
    expect(htmlContractViolations(html + "Not read yet")).toContain("hatch_labeled_unread");
  });

  it("binds empty, zzzz slot, and the plan 4.4 state sentences as distinct copy", () => {
    const html = buildAppHtml();
    expect(html).toContain(EMPTY_BOARD_TITLE);
    expect(html).toContain("Paste addresses in the chat. This panel does not search.");
    expect(html).toContain(NOTHING_TO_OPEN);
    expect(html).toContain(OPEN_DID_NOT_REACH_ME);
    expect(html).toContain(OPEN_SENT);
    expect(html).toContain(NOT_ON_FILE_PREFIX);
    expect(html).toContain(NO_BAKED_SNAPSHOT_PREFIX);
    expect(html).toContain(UPGRADE_TO_OPEN);
    expect(html).toContain(RESULT_NOT_READABLE);
    expect(html).not.toContain("Waiting for a screen or a parcel.");
    expect(html).not.toContain("Not on file in Bastrop");
    const sentences = [
      OPEN_DID_NOT_REACH_ME,
      OPEN_SENT,
      NOT_ON_FILE_PREFIX,
      NO_BAKED_SNAPSHOT_PREFIX,
      UPGRADE_TO_OPEN,
      RESULT_NOT_READABLE,
      NOTHING_TO_OPEN,
    ];
    expect(new Set(sentences).size).toBe(sentences.length);
    expect(html).toContain("if(ev.source!==window.parent)");
    expect(html).toContain("foreign=");
    expect(html).toContain("Object.create(null)");
    const afterToolResultAccept = html.split("accept(d.params);")[1] ?? "";
    expect(afterToolResultAccept.trimStart().startsWith("});")).toBe(true);
    expect(html).toContain("openWait");
    expect(html).toContain("openSent");
    expect(html).toContain("clearOpenTimer");
    expect(html).toContain(String(OPEN_DEAD_MS));
    expect(OPEN_DEAD_MS).toBe(12000);
  });

  it("treats a tool isError as a result, not host silence", () => {
    const html = buildAppHtml();
    const isErrorBlock = html.split("reply=isError")[1]?.split("reply=ok")[0] ?? "";
    expect(isErrorBlock.length).toBeGreaterThan(0);
    expect(isErrorBlock).toContain("accept(");
    expect(isErrorBlock).not.toContain(OPEN_DID_NOT_REACH_ME);
  });

  it("accepts an ok tool payload on the ui/message reply", () => {
    const html = buildAppHtml();
    const okBlock = html.split("reply=ok")[1]?.split("reply=empty")[0] ?? "";
    expect(okBlock).toContain("accept(");
    expect(okBlock).toContain("d.result.content");
  });

  it("keeps listing as the Wave D web turn on the drawn panel", () => {
    const html = buildAppHtml();
    expect(html).toContain("Find listing history");
    expect(html).toContain("Save property");
    expect(html).not.toContain("Save to screen");
    expect(html).not.toContain("save_to_screen");
    expect(html).not.toContain("find_listing_history");
    const click = listingHistoryClick({
      kind: "parcel",
      rows: [],
      overlays: [],
      label: "908 PINE , BASTROP, TX 78602",
      parcelNodeId: "48021:34137",
      ring: [
        { x: 48.6, y: 83.94 },
        { x: -50.37, y: 83.7 },
        { x: -49.07, y: -84.28 },
        { x: 50.84, y: -83.36 },
      ],
    });
    expect(click.fingerprintAfter).toBe(click.fingerprintBefore);
    expect(listingTurnIsGuarded(click.message)).toBe(true);
    expect(click.message).toContain(LISTING_TURN_OPENER);
    expect(openParcelMessage("48021:34137")).toContain("Do not call save_property");
    expect(openParcelMessage("48021:34137")).not.toContain("save_to_screen");
  });

  it("county copy follows the id prefix and never names a county the id does not map to", () => {
    expect(countyForNodeId("48021:900099")).toBe("Bastrop");
    expect(countyForNodeId("48453:1")).toBe("Travis");
    expect(countyForNodeId("48491:7")).toBe("Williamson");
    expect(countyForNodeId("99999:1")).toBe("this county");
    expect(countyForNodeId("not-an-id")).toBe("this county");
    expect(countyForNodeId(null)).toBe("this county");
    expect(notOnFileSentence("48453:1")).toBe("Not on file in Travis");
    expect(notOnFileSentence("48453:1")).not.toContain("Bastrop");
    expect(noBakedSnapshotSentence("48021:900099")).toBe("No baked snapshot yet for 48021:900099");
    expect(Object.keys(COUNTY_BY_FIPS).sort()).toEqual(["48021", "48055", "48209", "48453", "48491"]);
  });

  it("parses miss, refused, unreadable, and batch stub as their own kinds", () => {
    const absent = parseToolResult(
      JSON.stringify({ parcels: [], notFound: ["48021:900099"], reason: "parcel_not_found", parcelExists: false }),
    );
    expect(absent.kind).toBe("miss");
    expect(absent.misses).toEqual([
      { parcelNodeId: "48021:900099", county: "Bastrop", missClass: "absent", reason: "parcel_not_found", parcelExists: false },
    ]);
    const unbaked = parseToolResult(
      JSON.stringify({ parcels: [], notFound: ["48021:900099"], reason: "baked_snapshot_not_found", parcelExists: true }),
    );
    expect(unbaked.kind).toBe("miss");
    expect(unbaked.misses?.[0]?.missClass).toBe("unbaked");
    const unmeasured = parseToolResult(
      JSON.stringify({ parcels: [], notFound: ["48021:900099"], reason: "baked_snapshot_not_found", parcelExists: "unmeasured" }),
    );
    expect(unmeasured.misses?.[0]?.missClass).toBe("unbaked");
    expect(unmeasured.misses?.[0]?.parcelExists).toBe("unmeasured");
    const fieldMissing = parseToolResult(
      JSON.stringify({ parcels: [], notFound: ["48021:900099"], reason: "baked_snapshot_not_found" }),
    );
    expect(fieldMissing.misses?.[0]?.parcelExists).toBe("unmeasured");
    const contradiction = parseToolResult(
      JSON.stringify({ parcels: [], notFound: ["48021:900099"], reason: "baked_snapshot_not_found", parcelExists: false }),
    );
    expect(contradiction.misses?.[0]?.missClass).toBe("absent");
    const unstated = parseToolResult(JSON.stringify({ parcels: [], notFound: ["48021:1"], reason: "something_else" }));
    expect(unstated.kind).toBe("miss");
    expect(unstated.misses?.[0]?.missClass).toBe("unstated");
    const legacy = parseToolResult(JSON.stringify({ parcels: [], notFound: ["48021:900099"] }));
    expect(legacy.kind).toBe("board");
    expect(legacy.rows[0]).toMatchObject({ query: "48021:900099", parcelNodeId: null, resolution: "unresolved" });
    const refused = parseToolResult(
      JSON.stringify({ parcels: [], notFound: [], refused: [{ parcelNodeId: "48021:34137", reason: "upgrade_required" }] }),
    );
    expect(refused.kind).toBe("refused");
    expect(refused.refused).toEqual([{ parcelNodeId: "48021:34137", reason: "upgrade_required" }]);
    expect(refused.rows).toEqual([]);
    expect(parseToolResult("not json").kind).toBe("unreadable");
    expect(parseToolResult("[1,2]").kind).toBe("unreadable");
    expect(parseToolResult("null").kind).toBe("unreadable");
    expect(parseToolContent({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }).kind).toBe("unreadable");
    expect(parseToolContent({ content: [] }).kind).toBe("unreadable");
    expect(parseToolContent(undefined).kind).toBe("unreadable");
    expect(
      parseToolContent({
        content: [
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "text", text: JSON.stringify({ parcels: [], refused: [{ parcelNodeId: "48021:1", reason: "upgrade_required" }] }) },
        ],
      }).kind,
    ).toBe("refused");
    const batch = parseToolResult(
      JSON.stringify({
        parcels: [
          {
            parcelNodeId: "48021:34137",
            label: "908 PINE , BASTROP, TX 78602",
            url: "https://smartsite.cloud/p/48021:34137",
            stub: { situs: "present", zoning: "absent", landUse: "unknown", flood: "refused", drainage: "pending", envelope: 7 },
          },
        ],
        notFound: ["48021:900099"],
      }),
    );
    expect(batch.kind).toBe("board");
    expect(batch.rows).toHaveLength(2);
    expect(batch.rows[0]).toMatchObject({
      query: "908 PINE , BASTROP, TX 78602",
      parcelNodeId: "48021:34137",
      resolution: "resolved",
      rails: { situs: "present", zoning: "absent-verified", landUse: "unknown", flood: "refused", drainage: "unread", envelope: "unread" },
    });
    expect(batch.rows[1]).toMatchObject({ query: "48021:900099", parcelNodeId: null, resolution: "unresolved" });
    const degraded = parseToolResult(
      JSON.stringify({
        id: "s",
        stubsDegraded: true,
        rows: [
          { query: "q", parcelNodeId: "48021:1", resolution: "resolved", stub: { situs: "present" }, stubRead: "ok" },
          { query: "r", parcelNodeId: "48021:2", resolution: "resolved", stubRead: "skipped" },
        ],
      }),
    );
    expect(degraded.kind).toBe("board");
    expect(degraded.stubsDegraded).toBe(true);
    expect(degraded.rows[0]?.rails.situs).toBe("present");
    expect(degraded.rows[1]?.rails.situs).toBe("unread");
    const undeclared = parseToolResult(JSON.stringify({ id: "s", rows: [{ query: "q", parcelNodeId: "48021:1" }] }));
    expect(undeclared.stubsDegraded).toBeUndefined();
  });

  it("escapes quotes in attributes and whitelists glyph states on the exported renderer", () => {
    expect(escapeHtml("a\"b'c<d>&")).toBe("a&quot;b&#39;c&lt;d&gt;&amp;");
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    const drawn = renderParcelDraw({
      parcelNodeId: '48021:x" onmouseover="alert(1)',
      label: "<b>x</b>",
      overlays: [{ id: "flood", state: 'present" data-pwn="1', label: "Zone X" }],
      ring: [],
      edges: [],
    });
    expect(drawn).not.toContain('onmouseover="alert(1)"');
    expect(drawn).not.toContain("<b>x</b>");
    expect(drawn).not.toContain('data-pwn="1"');
    expect(drawn).toContain("g-unread");
  });
});

describe("mcp-app registration", () => {
  it("tools/list stays 13 and only the three host tools carry the ui resource", async () => {
    const server = new McpServer({ name: SERVER_NAME, version: "0.0.1" });
    registerTools(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(13);
    for (const tool of tools) {
      const meta = (tool as { _meta?: { ui?: { resourceUri?: string } } })._meta;
      if ((APP_HOST_TOOLS as readonly string[]).includes(tool.name)) {
        expect(meta?.ui?.resourceUri, `${tool.name} missing _meta.ui.resourceUri`).toBe(
          APP_RESOURCE_URI,
        );
      } else {
        expect(meta?.ui?.resourceUri).toBeUndefined();
      }
    }
    const resources = await client.listResources();
    const uris = resources.resources.map((r) => r.uri);
    expect(uris).toContain(APP_RESOURCE_URI);
    const read = await client.readResource({ uri: APP_RESOURCE_URI });
    const body = read.contents[0];
    expect(body?.mimeType).toBe(APP_MIME);
    if (body && "text" in body && typeof body.text === "string") {
      expect(htmlContractViolations(body.text)).toEqual([]);
      expect(body.text).toContain("g-unread");
      expect(body.text).toContain("g-unknown");
      expect(body.text).not.toContain("list_my_properties");
    } else {
      throw new Error("resource text missing");
    }
    await client.close();
    await server.close();
  });
});
