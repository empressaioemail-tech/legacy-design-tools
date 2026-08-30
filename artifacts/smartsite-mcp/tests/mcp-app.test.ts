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
  ACROSS_ROW,
  EDGE_TIP_HINT,
  UNIT_REFERENCE,
  edgeDoor,
  edgeIsRow,
  edgeTipHtml,
  edgeWord,
  floodOverlayOf,
  floodTint,
  floodZoneLabel,
  frameNoteHtml,
  scaleBarFt,
  zoneFamily,
  ABSENCE_UNVERIFIED,
  AS_OF_MISSING,
  CITATION_DEGRADED,
  BFE_NONE,
  SAVE_STATUSES,
  WHY_TURN_OPENER,
  WHY_TURN_INSTRUCTION,
  addToScreenMessage,
  citationHtml,
  dateOnly,
  floodFactsHtml,
  httpsCitations,
  knownVintage,
  overlayPaint,
  overlayRowHtml,
  reportHtml,
  saveMessage,
  sectionPaint,
  sourceOf,
  whyMessage,
  whyQuestion,
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
    /* C1: the Save control is a status chooser; the click carries its button */
    expect(html).toContain("window.__ss&&window.__ss.save(this)");
    expect(html).not.toContain("window.__ss&&window.__ss.save()");
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
    expect(APP_RESOURCE_URI).toBe("ui://smartsite/app-p558.html");
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
    expect(
      htmlContractViolations(clean.replace('addEventListener("pointerenter"', 'addEventListener("pointerenterx"')),
    ).toContain("edge_hover_unbound");
    expect(htmlContractViolations(clean.replace(/adjacency\s*===\s*"ROW"/g, 'adjacency === "NOPE"'))).toContain(
      "row_door_unguarded",
    );
    expect(htmlContractViolations(clean.split(ACROSS_ROW).join(""))).toContain("row_door_unguarded");
    expect(htmlContractViolations(clean.replace('method:"ui/open-link"', 'method:"ui/open-url"'))).toContain(
      "open_link_unbound",
    );
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

  it("p556: the live batch stub result carries its rails flat on each parcel, and they paint as rails, not six unread", () => {
    /* Verbatim get_smart_site result from production p555/p542, 2026-08-30. No stub key on the wire. */
    const live =
      '{"parcels":[{"parcelNodeId":"48021:34137","label":"908 PINE , BASTROP, TX 78602","url":"https://smartsite.cloud/p/48021:34137","situs":"present","zoning":"present","landUse":"unknown","flood":"present","drainage":"unread","envelope":"refused"},{"parcelNodeId":"48021:8720522","label":"111 RAINMAKER CV, BASTROP, TX 78602","url":"https://smartsite.cloud/p/48021:8720522","situs":"present","zoning":"present","landUse":"unknown","flood":"present","drainage":"unread","envelope":"refused"}],"notFound":["48021:900099"]}';
    const liveRails = { situs: "present", zoning: "present", landUse: "unknown", flood: "present", drainage: "unread", envelope: "refused" };
    const allUnread = { situs: "unread", zoning: "unread", landUse: "unread", flood: "unread", drainage: "unread", envelope: "unread" };
    const model = parseToolResult(live);
    expect(model.kind).toBe("board");
    expect(model.rows).toHaveLength(3);
    expect(model.rows[0]).toEqual({
      query: "908 PINE , BASTROP, TX 78602",
      parcelNodeId: "48021:34137",
      resolution: "resolved",
      rails: liveRails,
    });
    expect(model.rows[1]).toEqual({
      query: "111 RAINMAKER CV, BASTROP, TX 78602",
      parcelNodeId: "48021:8720522",
      resolution: "resolved",
      rails: liveRails,
    });
    expect(model.rows[2]).toEqual({ query: "48021:900099", parcelNodeId: null, resolution: "unresolved", rails: allUnread });
    /* Precedence: a nested stub object still wins over flat keys; a non-object stub falls through to the flat keys. */
    const both = parseToolResult(
      JSON.stringify({ parcels: [{ parcelNodeId: "48021:1", stub: { situs: "absent" }, situs: "present" }], notFound: [] }),
    );
    expect(both.rows[0]?.rails.situs).toBe("absent-verified");
    const stringStub = parseToolResult(
      JSON.stringify({ parcels: [{ parcelNodeId: "48021:1", stub: "present", situs: "present", zoning: "pending" }], notFound: [] }),
    );
    expect(stringStub.rows[0]?.rails.situs).toBe("present");
    expect(stringStub.rows[0]?.rails.zoning).toBe("unread");
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

/*
 * P-91 v2 drawing, exported twins. Ids, districts, jurisdictions and flood
 * states are the fixture doc's (2026-08-30_p91_fixture_set_bastrop.md); the
 * gold ring, ft and road nodes are the recorded v1 fixture above. Every other
 * coordinate, bearing and roadClass is a synthetic test input, not a parcel fact.
 */
const GOLD_V2_EDGES = [
  { id: "e0", role: "rear", seg: [0, 1] as [number, number], ft: 98.98, bearing: "S 89°52' W", adjacency: "alley", roadNode: "48021:road:925036023", roadClass: "alley" },
  { id: "e1", role: "side", seg: [1, 2] as [number, number], ft: 167.99, bearing: "S 0°27' W", adjacency: "neighbor-parcel", roadNode: null, neighbor: "48021:34169" },
  { id: "e2", role: "front", seg: [2, 3] as [number, number], ft: 99.92, bearing: "N 89°28' E", adjacency: "ROW", roadNode: "48021:road:15113284", roadClass: "local", neighbor: "48021:34121" },
  { id: "e3", role: "side_corner", seg: [3, 0] as [number, number], ft: 167.32, bearing: "N 0°45' W", adjacency: "ROW", roadNode: "48021:road:129017865", roadClass: "local" },
];
const ZONING_URL = "https://gis.example.test/bastrop/zoning/layer/0";
const GOLD_V2 = {
  parcelNodeId: "48021:34137",
  brief: {
    sections: [
      { id: "zoning", disposition: "present", data: { district: "SF-1" }, citations: ["http://plain.example.test/first", ZONING_URL, "https://gis.example.test/second"] },
      { id: "flood", disposition: "present", data: {}, citations: [], citationsDegraded: true },
    ],
  },
  draw: {
    label: "908 PINE , BASTROP, TX 78602",
    frame: { units: "ft", origin: "centroid", yAxis: "true-north", quality: "gis-approximate" },
    ring: GOLD_RING,
    edges: GOLD_V2_EDGES,
    attrs: { zoning: { v: "SF-1", jurisdiction: "bastrop_city_tx", state: "present" } },
    overlays: [
      { id: "flood", label: "Zone X 0.2 PCT ANNUAL CHANCE FLOOD HAZARD", sfha: false, geom: "none", draw: "tint-ring", state: "present", citations: [], citationsDegraded: true },
      { id: "envelope", state: "refused", reason: "atom_path_pending", label: "Buildable envelope not computed", draw: "suppress-setback-line" },
    ],
  },
};

describe("P-91 v2 drawing (exported twins)", () => {
  it("D1: the tooltip carries the edge object's words, ft, bearing, and neighbor or road; ft is omitted when absent, never measured", () => {
    const e0 = edgeTipHtml(GOLD_V2_EDGES[0]!, 0);
    expect(e0).toContain("rear");
    expect(e0).toContain("alley");
    expect(e0).toContain("98.98 ft");
    expect(e0).toContain("S 89°52&#39; W");
    expect(e0).toContain("48021:road:925036023");
    expect(e0).toContain('data-edge-tip="0"');
    expect(e0).not.toContain('data-act="open"');
    const e3 = edgeTipHtml(GOLD_V2_EDGES[3]!, 3);
    expect(e3).toContain("corner side");
    expect(e3).toContain("right of way");
    expect(e3).toContain("48021:road:129017865");
    expect(e3).toContain("local");
    expect(e3).not.toContain(ACROSS_ROW);
    expect(edgeWord("side_corner")).toBe("corner side");
    expect(edgeWord("neighbor-parcel")).toBe("neighbor");
    expect(edgeWord("ROW")).toBe("right of way");
    expect(edgeWord("something-else")).toBe("something-else");
    expect(edgeWord(null)).toBeNull();
    const noFt = edgeTipHtml({ ...GOLD_V2_EDGES[1]!, ft: null }, 1);
    expect(noFt).not.toMatch(/\d ft/);
    expect(noFt).toContain("48021:34169");
    const unmapped = edgeTipHtml({ role: "side", adjacency: "unmapped", ft: 40.5 }, 5);
    expect(unmapped).toContain("unmapped");
    expect(unmapped).toContain("40.5 ft");
    expect(unmapped).not.toContain("48021:");
  });

  it("D2: a shared line is a door; a ROW line names the neighbor across the right of way and is never a door", () => {
    const door = edgeTipHtml(GOLD_V2_EDGES[1]!, 1);
    expect(door).toContain('data-act="open"');
    expect(door).toContain('data-node="48021:34169"');
    expect(door).toContain('onclick="window.__ss&&window.__ss.open(this)"');
    expect(door).toContain("neighbor");
    expect(door).not.toContain("48021:road:");
    expect(edgeDoor(GOLD_V2_EDGES[1]!)).toBe("48021:34169");
    const row = edgeTipHtml(GOLD_V2_EDGES[2]!, 2);
    expect(row).toContain("48021:34121");
    expect(row).toContain(ACROSS_ROW);
    expect(row).toContain("48021:road:15113284");
    expect(row).not.toContain('data-act="open"');
    expect(edgeIsRow(GOLD_V2_EDGES[2]!)).toBe(true);
    expect(edgeDoor(GOLD_V2_EDGES[2]!)).toBeNull();
    expect(edgeDoor({ neighbor: "48021:1", adjacency: "side" })).toBe("48021:1");
    expect(edgeDoor({ adjacency: "side" })).toBeNull();
  });

  it("D3: districts map to a family by prefix; the tint is an existing Stone token; unknown prefixes take none", () => {
    expect(zoneFamily("SF-1")).toBe("residential");
    expect(zoneFamily("R-2")).toBe("residential");
    expect(zoneFamily("GC")).toBe("commercial");
    expect(zoneFamily("C-1")).toBe("commercial");
    expect(zoneFamily("MU")).toBe("mixed");
    expect(zoneFamily("PI")).toBe("public");
    expect(zoneFamily("P/OS")).toBe("public");
    expect(zoneFamily("PDD")).toBeNull();
    expect(zoneFamily("")).toBeNull();
    expect(zoneFamily(null)).toBeNull();
    expect(zoneFamily("GCX")).toBeNull();
    const cues = (v: string) => ({ zoning: { v, jurisdiction: "bastrop_city_tx", state: "present", url: null } });
    const ring = GOLD_RING.map(([x, y]) => ({ x, y }));
    expect(ringSvg(ring, [], cues("SF-1"))).toContain('stroke="var(--ss-t3)" stroke-width="2" data-zone-family="residential"');
    expect(ringSvg(ring, [], cues("GC"))).toContain('stroke="var(--ss-blue)" stroke-width="2" data-zone-family="commercial"');
    expect(ringSvg(ring, [], cues("MU"))).toContain('stroke="var(--ss-atom)" stroke-width="2" data-zone-family="mixed"');
    expect(ringSvg(ring, [], cues("P/OS"))).toContain('stroke="var(--ss-t5)" stroke-width="2" data-zone-family="public"');
    const pdd = ringSvg(ring, [], cues("PDD"));
    expect(pdd).toContain('stroke="var(--ss-t3)" stroke-width="2"/>');
    expect(pdd).not.toContain("data-zone-family");
    expect(pdd).toContain('data-zoning="PDD"');
    expect(pdd).toContain(">bastrop_city_tx</text>");
    const notPresent = ringSvg(ring, [], { zoning: { v: "SF-1", jurisdiction: "x", state: "unknown", url: null } });
    expect(notPresent).not.toContain("data-zoning");
    expect(notPresent).not.toContain("data-zone-family");
    expect(notPresent).not.toContain("SF-1");
    const linked = ringSvg(ring, [], { zoning: { v: "SF-1", jurisdiction: "x", state: "present", url: ZONING_URL } });
    expect(linked).toContain(`data-zoning-url="${ZONING_URL}"`);
    expect(linked).toContain('class="zn link"');
    expect(ringSvg(ring, [], cues("SF-1"))).not.toContain("data-zoning-url");
  });

  it("D4: tint-ring tints light for sfha false, heavy for sfha true, none for MINIMAL or an unstated sfha; the zone prints from the label", () => {
    expect(floodTint({ id: "flood", state: "present", label: "Zone X 0.2 PCT ANNUAL CHANCE FLOOD HAZARD", sfha: false, draw: "tint-ring" })).toBe("light");
    expect(floodTint({ id: "flood", state: "present", label: "Zone A", sfha: true, draw: "tint-ring" })).toBe("heavy");
    expect(floodTint({ id: "flood", state: "present", label: "Zone AE FLOODWAY", sfha: true, draw: "tint-ring" })).toBe("heavy");
    expect(floodTint({ id: "flood", state: "present", label: "Zone X AREA OF MINIMAL FLOOD HAZARD", sfha: false, draw: "tint-ring" })).toBeNull();
    expect(floodTint({ id: "flood", state: "present", label: "Zone A", draw: "tint-ring" })).toBeNull();
    expect(floodTint({ id: "flood", state: "unknown", label: "Flood record not checked", draw: "legend-only" })).toBeNull();
    expect(floodTint(null)).toBeNull();
    expect(floodZoneLabel("Zone AE FLOODWAY")).toBe("Zone AE floodway");
    expect(floodZoneLabel("Zone X 0.2 PCT ANNUAL CHANCE FLOOD HAZARD")).toBe("Zone X");
    expect(floodZoneLabel("Zone A")).toBe("Zone A");
    expect(floodZoneLabel("Flood record not checked")).toBe("Flood record not checked");
    expect(floodOverlayOf([{ id: "envelope", state: "refused", label: "x" }, { id: "flood", state: "present", label: "Zone A" }])?.label).toBe("Zone A");
    expect(floodOverlayOf([])).toBeNull();
    const ring = GOLD_RING.map(([x, y]) => ({ x, y }));
    const heavy = ringSvg(ring, [], { flood: { id: "flood", state: "present", label: "Zone AE FLOODWAY", sfha: true, draw: "tint-ring" } });
    expect(heavy).toContain('data-flood-tint="heavy"');
    expect(heavy).toContain('fill="var(--ss-blue)" fill-opacity=".32"');
    expect(heavy).toContain('data-flood-zone="Zone AE floodway"');
    const light = ringSvg(ring, [], { flood: { id: "flood", state: "present", label: "Zone X 0.2 PCT ANNUAL CHANCE FLOOD HAZARD", sfha: false, draw: "tint-ring" } });
    expect(light).toContain('data-flood-tint="light"');
    expect(light).toContain('fill="var(--ss-blue)" fill-opacity=".14"');
    expect(light).toContain('data-flood-zone="Zone X"');
    const none = ringSvg(ring, [], { flood: { id: "flood", state: "present", label: "Zone X AREA OF MINIMAL FLOOD HAZARD", sfha: false, draw: "tint-ring" } });
    expect(none).not.toContain("data-flood-tint");
    expect(none).not.toContain("data-flood-zone");
  });

  it("D7: the scale bar is a round number from the ring extent, drawn at the ring's pixel scale and labelled as a unit reference; no units means no bar", () => {
    expect(scaleBarFt(101.21)).toBe(50);
    expect(scaleBarFt(300)).toBe(100);
    expect(scaleBarFt(28)).toBe(10);
    expect(scaleBarFt(500)).toBe(200);
    expect(scaleBarFt(50)).toBe(25);
    expect(scaleBarFt(19)).toBe(10);
    const ring = GOLD_RING.map(([x, y]) => ({ x, y }));
    const withFrame = ringSvg(ring, [], { frame: { units: "ft", quality: "gis-approximate" } });
    expect(withFrame).toContain('data-north="up"');
    expect(withFrame).toContain('data-scale-ft="50"');
    expect(withFrame).toContain(`50 ft <tspan class="sm">${UNIT_REFERENCE}</tspan>`);
    const poly = /<polygon class="ring-fill" points="([^"]+)"/.exec(withFrame)?.[1] ?? "";
    const xs = poly.split(" ").map((p) => Number(p.split(",")[0]));
    const ringPx = Math.max(...xs) - Math.min(...xs);
    const bar = /<g class="scale" data-scale-ft="50"><line x1="([\d.]+)" y1="\d+" x2="([\d.]+)"/.exec(withFrame);
    expect(bar).not.toBeNull();
    const barPx = Number(bar![2]) - Number(bar![1]);
    expect(Math.abs(barPx / ringPx - 50 / 101.21)).toBeLessThan(0.005);
    const noUnits = ringSvg(ring, [], { frame: { units: null, quality: "gis-approximate" } });
    expect(noUnits).toContain('data-north="up"');
    expect(noUnits).not.toContain("data-scale-ft");
    const noFrame = ringSvg(ring, []);
    expect(noFrame).not.toContain("data-north");
    expect(noFrame).not.toContain("data-scale-ft");
    expect(frameNoteHtml({ units: "ft", quality: "gis-approximate" })).toContain('data-frame-quality="gis-approximate"');
    expect(frameNoteHtml({ units: "ft", quality: null })).toBe("");
    expect(frameNoteHtml(null)).toBe("");
  });

  it("parses attrs.zoning, the zoning section's first https citation, frame, and the flood overlay's sfha and draw", () => {
    const model = parseToolResult(JSON.stringify(GOLD_V2));
    expect(model.kind).toBe("parcel");
    expect(model.zoning).toEqual({ v: "SF-1", jurisdiction: "bastrop_city_tx", state: "present", url: ZONING_URL });
    expect(model.frame).toEqual({ units: "ft", quality: "gis-approximate" });
    expect(model.overlays[0]).toMatchObject({ id: "flood", sfha: false, draw: "tint-ring" });
    expect(model.overlays[1]?.sfha).toBeUndefined();
    const httpOnly = parseToolResult(
      JSON.stringify({ ...GOLD_V2, brief: { sections: [{ id: "zoning", citations: ["http://plain.example.test/only"] }] } }),
    );
    expect(httpOnly.zoning?.url).toBeNull();
    const noBrief = parseToolResult(JSON.stringify({ parcelNodeId: GOLD_V2.parcelNodeId, draw: GOLD_V2.draw }));
    expect(noBrief.zoning?.url).toBeNull();
    expect(noBrief.zoning?.v).toBe("SF-1");
    const noAttrs = parseToolResult(JSON.stringify({ parcelNodeId: GOLD_V2.parcelNodeId, draw: { ...GOLD_V2.draw, attrs: {} } }));
    expect(noAttrs.zoning).toBeUndefined();
    const emptyDistrict = parseToolResult(
      JSON.stringify({ parcelNodeId: GOLD_V2.parcelNodeId, draw: { ...GOLD_V2.draw, attrs: { zoning: { v: "", state: "present" } } } }),
    );
    expect(emptyDistrict.zoning).toBeUndefined();
    const noFrame = parseToolResult(JSON.stringify({ parcelNodeId: GOLD_V2.parcelNodeId, draw: { ...GOLD_V2.draw, frame: undefined } }));
    expect(noFrame.frame).toBeUndefined();
    const batchNode = parseToolResult(JSON.stringify({ parcels: [{ parcelNodeId: GOLD_V2.parcelNodeId, brief: GOLD_V2.brief, draw: GOLD_V2.draw }] }));
    expect(batchNode.zoning?.url).toBe(ZONING_URL);
    const drawn = renderParcelDraw(model);
    expect(drawn).toContain(EDGE_TIP_HINT);
    expect(drawn).toContain('data-frame-quality="gis-approximate"');
    expect(drawn).toContain('data-edge="1"');
    expect(drawn).toContain('data-zoning="SF-1"');
    expect(drawn).toContain('data-flood-tint="light"');
    expect(drawn).not.toContain("atom_path_pending");
  });
});

/*
 * P-91 v2 facts and actions, exported twins (S7). Section and overlay
 * shapes as the p543/p558 wire carries them; every asOf, adapter, URL and
 * elevation is a synthetic test input, never a parcel fact.
 */
const AS_OF_V2 = "2026-08-29T10:00:00.000Z";
const ENVELOPE_REFUSAL_V2 = {
  state: "refused",
  code: "declined-in-bake",
  producer: "baked-envelope-facet",
  supersededBy: "buildable-envelope",
  declineReason: "no-zoning-stamp",
  reason: "Buildable envelope was declined in bake: no-zoning-stamp.",
};
const GOLD_FACTS_V2 = {
  parcelNodeId: "48021:34137",
  brief: {
    sections: [
      { id: "zoning", title: "Zoning", disposition: "present", data: { district: "SF-1", sourceAdapter: "adapter:zoning-test" }, citations: ["http://plain.example.test/first", ZONING_URL], asOf: AS_OF_V2 },
      { id: "setbacks-envelope", title: "Setbacks and buildable envelope", disposition: "refused", data: null, refusal: ENVELOPE_REFUSAL_V2, citations: [], asOf: AS_OF_V2, agentGuidance: "Do not invent distances or polygons." },
      {
        id: "flood",
        title: "Flood hazard",
        disposition: "present",
        data: { inSpecialFloodHazardArea: true, floodZone: "AE", zoneSubtype: "FLOODWAY", baseFloodElevation: 372.5, sourceAdapter: "adapter:flood-test", sourceVintage: "NFHL_48_20260101", evaluatedAt: AS_OF_V2 },
        citations: [],
        asOf: AS_OF_V2,
        citationsDegraded: true,
        zoneExposureSummary: null,
      },
      { id: "land-use", title: "Land use", disposition: "absent", data: { state: "absent", sourceAdapter: "adapter:landuse-test" }, citations: [], asOf: AS_OF_V2 },
      { id: "drainage", title: "Drainage", disposition: "unread", data: null, citations: [], asOf: AS_OF_V2, reason: "drainage facet not produced for this parcel" },
    ],
  },
  draw: {
    ...GOLD_V2.draw,
    overlays: [
      ...GOLD_V2.draw.overlays,
      { id: "pipeline", label: "No pipeline within 500 ft", geom: "none", draw: "legend-only", state: "absent-verified", provenance: "present", vintage: "2026-06", citations: ["https://rrc.example.test/p", "http://plain.example.test/p"] },
      { id: "special-district", label: "No special district of record", geom: "none", draw: "legend-only", state: "absent-verified" },
    ],
  },
};

describe("P-91 v2 facts and actions (exported twins)", () => {
  it("P1 C1 C2: the three drafts are literal, every slot a wire field or the fallback word", () => {
    expect(
      whyMessage({ field: "envelope", state: "refused", parcelNodeId: "48021:34137", label: "908 PINE , BASTROP, TX 78602", reason: "atom_path_pending", producer: "baked-envelope-facet", code: "declined-in-bake" }),
    ).toBe(
      "Why is envelope refused for 48021:34137 (908 PINE , BASTROP, TX 78602)? The record says: atom_path_pending; producer baked-envelope-facet; code declined-in-bake. Answer from the record and the atom path; do not invent a value.",
    );
    expect(whyMessage({ field: "drainage", state: "unread", parcelNodeId: "48021:1", label: null, reason: null, producer: null, code: null })).toBe(
      "Why is drainage unread for 48021:1? The record says: no reason on the wire; producer unstated; code unstated. Answer from the record and the atom path; do not invent a value.",
    );
    expect(WHY_TURN_OPENER).toBe("Why is");
    expect(WHY_TURN_INSTRUCTION).toBe("Answer from the record and the atom path; do not invent a value.");
    expect(saveMessage("48021:34137", "Watching")).toBe("Save property 48021:34137 with save_property, status Watching. Do not change any screen.");
    expect(SAVE_STATUSES).toEqual(["New", "Watching", "Chasing", "Passed"]);
    expect(addToScreenMessage("48021:34169")).toBe("Add 48021:34169 to the screen this parcel was opened from with add_to_screen, source walk. Do not save it.");
    expect(addToScreenMessage("48021:34169")).not.toMatch(/screenId|screen-/);
  });

  it("F5 F6: paint rules are earned, never asserted", () => {
    expect(knownVintage("2026-06")).toBe("2026-06");
    expect(knownVintage("UNKNOWN")).toBeNull();
    expect(knownVintage("unknown ")).toBeNull();
    expect(knownVintage("")).toBeNull();
    expect(knownVintage(7)).toBeNull();
    expect(overlayPaint({ state: "absent-verified", provenance: "present", vintage: "2026-06" })).toEqual({ paint: "absent-verified" });
    expect(overlayPaint({ state: "absent-verified", vintage: "2026-06" })).toEqual({ paint: "absent-verified" });
    expect(overlayPaint({ state: "absent-verified", provenance: "present" })).toEqual({ paint: "absent-verified" });
    expect(overlayPaint({ state: "absent-verified" })).toEqual({ paint: "unknown", paintReason: ABSENCE_UNVERIFIED });
    expect(overlayPaint({ state: "absent-verified", provenance: "degraded", vintage: "UNKNOWN", reason: "provenance degraded; vintage unknown" })).toEqual({ paint: "unknown" });
    expect(overlayPaint({ state: "absent", provenance: "nope" })).toEqual({ paint: "unknown", paintReason: ABSENCE_UNVERIFIED });
    expect(overlayPaint({ state: "present" })).toEqual({ paint: "present" });
    expect(overlayPaint({ state: "refused", reason: "x" })).toEqual({ paint: "refused" });
    expect(overlayPaint({ state: "pending" })).toEqual({ paint: "unread" });
    expect(sectionPaint("present", AS_OF_V2, {})).toEqual({ paint: "present" });
    expect(sectionPaint("present", null, { district: "SF-1" })).toEqual({ paint: "unknown", paintReason: AS_OF_MISSING });
    expect(sectionPaint("refused", null, null)).toEqual({ paint: "refused" });
    expect(sectionPaint("unread", AS_OF_V2, null)).toEqual({ paint: "unread" });
    expect(sectionPaint("absent", AS_OF_V2, { sourceVintage: "2026-07" })).toEqual({ paint: "absent-verified" });
    expect(sectionPaint("absent", AS_OF_V2, { sourceVintage: "UNKNOWN" })).toEqual({ paint: "unknown", paintReason: ABSENCE_UNVERIFIED });
    expect(sectionPaint("absent", AS_OF_V2, null)).toEqual({ paint: "unknown", paintReason: ABSENCE_UNVERIFIED });
    expect(sectionPaint("Present", AS_OF_V2, {}).paint).toBe("unread");
    expect(sectionPaint("unstated", AS_OF_V2, {}).paint).toBe("unread");
    expect(dateOnly(AS_OF_V2)).toBe("2026-08-29");
    expect(dateOnly("2026-08-29")).toBe("2026-08-29");
    expect(dateOnly("NFHL_48_20260101")).toBe("NFHL_48_20260101");
    expect(dateOnly(null)).toBeNull();
    expect(httpsCitations(["http://a.test/x", "https://b.test/y", 7, null, "", " https://c.test/z "])).toEqual(["https://b.test/y", "https://c.test/z"]);
    expect(httpsCitations("https://b.test/y")).toEqual([]);
  });

  it("parses brief sections with paint, https-only citations, refusal fields and source; overlays carry provenance, vintage and citations", () => {
    const model = parseToolResult(JSON.stringify(GOLD_FACTS_V2));
    expect(model.kind).toBe("parcel");
    const s = model.sections ?? [];
    expect(s.map((x) => x.id)).toEqual(["zoning", "setbacks-envelope", "flood", "land-use", "drainage"]);
    expect(s.map((x) => x.paint)).toEqual(["present", "refused", "present", "unknown", "unread"]);
    expect(s[0]?.citations).toEqual([ZONING_URL]);
    expect(s[0]?.citationsDegraded).toBe(false);
    expect(s[0]?.asOf).toBe(AS_OF_V2);
    expect(sourceOf(s[0]!)).toBe("adapter:zoning-test");
    expect(s[1]?.refusal).toEqual({ code: "declined-in-bake", producer: "baked-envelope-facet", declineReason: "no-zoning-stamp", reason: ENVELOPE_REFUSAL_V2.reason });
    expect(sourceOf(s[1]!)).toBe("baked-envelope-facet");
    expect(s[1]?.agentGuidance).toBe("Do not invent distances or polygons.");
    expect(s[2]?.citationsDegraded).toBe(true);
    expect(s[2]?.zoneExposureSummary).toBeUndefined();
    expect(s[3]?.paintReason).toBe(ABSENCE_UNVERIFIED);
    expect(s[4]?.reason).toBe("drainage facet not produced for this parcel");
    expect(sourceOf(s[4]!)).toBeNull();
    const pipeline = model.overlays.find((o) => o.id === "pipeline");
    expect(pipeline).toMatchObject({ provenance: "present", vintage: "2026-06", citations: ["https://rrc.example.test/p"], paint: "absent-verified" });
    const sd = model.overlays.find((o) => o.id === "special-district");
    expect(sd).toMatchObject({ paint: "unknown", paintReason: ABSENCE_UNVERIFIED });
    expect(sd?.provenance).toBeUndefined();
    const flood = model.overlays.find((o) => o.id === "flood");
    expect(flood).toMatchObject({ paint: "present", citationsDegraded: true });
    expect(parseToolResult(JSON.stringify({ parcelNodeId: "48021:1", draw: GOLD_V2.draw })).sections).toBeUndefined();
    const noId = parseToolResult(JSON.stringify({ ...GOLD_FACTS_V2, brief: { sections: [{ disposition: "present", data: {}, asOf: AS_OF_V2 }, "x", null] } }));
    expect(noId.sections).toBeUndefined();
    /* P1 lookups: present and verified cells are never questions; the overlay borrows its section's refusal */
    expect(whyQuestion(model, "overlay", { i: "0" })).toBeNull();
    expect(whyQuestion(model, "overlay", { i: "2" })).toBeNull();
    expect(whyQuestion(model, "section", { i: "0" })).toBeNull();
    expect(whyQuestion(model, "overlay", { i: "1" })).toEqual({
      field: "envelope",
      state: "refused",
      parcelNodeId: "48021:34137",
      label: "908 PINE , BASTROP, TX 78602",
      reason: "atom_path_pending",
      producer: "baked-envelope-facet",
      code: "declined-in-bake",
    });
    expect(whyQuestion(model, "overlay", { i: "3" })).toMatchObject({ field: "special-district", state: "unknown", reason: null, producer: null, code: null });
    expect(whyQuestion(model, "section", { i: "3" })).toMatchObject({ field: "land-use", state: "unknown", reason: null, producer: null, code: null });
    expect(whyQuestion(model, "section", { i: "4" })).toMatchObject({ field: "drainage", state: "unread", reason: "drainage facet not produced for this parcel" });
    expect(whyQuestion(model, "section", { i: "9" })).toBeNull();
    expect(whyQuestion(model, "rail", { rail: "situs", node: "48021:34137" })).toBeNull();
    const board = parseToolResult(JSON.stringify({ id: "s", rows: [{ query: "q", parcelNodeId: "48021:1", resolution: "resolved", stub: { situs: "present", zoning: "refused" } }] }));
    expect(whyQuestion(board, "rail", { rail: "situs", node: "48021:1" })).toBeNull();
    expect(whyQuestion(board, "rail", { rail: "zoning", node: "48021:1" })).toEqual({ field: "zoning", state: "refused", parcelNodeId: "48021:1", label: "q", reason: null, producer: null, code: null });
    expect(whyQuestion(board, "rail", { rail: "flood", node: "48021:1" })).toMatchObject({ state: "unread" });
    expect(whyQuestion(board, "rail", { rail: "owner", node: "48021:1" })).toBeNull();
    expect(whyQuestion(board, "rail", { rail: "zoning", node: "48021:2" })).toBeNull();
  });

  it("F1 F2 R1 C2 renderers: citations link only https, degraded prints the text, flood facts read the data, the report lists sections without values, the door carries Add to screen", () => {
    expect(citationHtml(["https://a.test/1"], false)).toBe('<button type="button" class="cite" data-act="cite" data-url="https://a.test/1" onclick="window.__ss&&window.__ss.cite(this)">citation</button>');
    expect(citationHtml(["https://a.test/1", "https://a.test/2"], false)).toContain(">citation 2</button>");
    expect(citationHtml(["http://a.test/1", 'https://a.test/"x'], false)).toBe('<button type="button" class="cite" data-act="cite" data-url="https://a.test/&quot;x" onclick="window.__ss&&window.__ss.cite(this)">citation</button>');
    expect(citationHtml(["https://a.test/1"], true)).toBe(`<span class="cite-deg" data-cite-degraded="1">${CITATION_DEGRADED}</span>`);
    expect(citationHtml([], false)).toBe("");
    const model = parseToolResult(JSON.stringify(GOLD_FACTS_V2));
    const flood = floodFactsHtml(model.sections![2]!, 2);
    expect(flood).toContain('data-flood-state="present"');
    expect(flood).toContain('data-fact-zone="AE"');
    expect(flood).toContain('data-fact-subtype="FLOODWAY"');
    expect(flood).toContain('data-fact-sfha="yes"');
    expect(flood).toContain('data-fact-bfe="372.5"');
    expect(flood).toContain('data-fact-adapter="adapter:flood-test"');
    expect(flood).toContain('data-fact-vintage="NFHL_48_20260101"');
    expect(flood).toContain('data-fact-evaluated="2026-08-29"');
    expect(flood).toContain(CITATION_DEGRADED);
    expect(flood).not.toContain("data-zone-exposure");
    expect(flood).not.toContain('data-act="why"');
    const noBfe = floodFactsHtml({ ...model.sections![2]!, data: { floodZone: "X" } }, 2);
    expect(noBfe).toContain(`data-fact-bfe="${BFE_NONE}"`);
    expect(noBfe).toContain('data-fact-sfha="unstated"');
    expect(noBfe).toContain('data-fact-subtype="unstated"');
    const unread = floodFactsHtml(model.sections![4]!, 4);
    expect(unread).toContain('data-flood-state="unread"');
    expect(unread).not.toContain("data-fact-zone");
    expect(unread).toContain('data-act="why" data-why-kind="section" data-why-i="4"');
    const report = reportHtml(model.sections!);
    expect([...report.matchAll(/data-report-section="([^"]+)"/g)].map((m) => m[1])).toEqual(["zoning", "setbacks-envelope", "flood", "land-use", "drainage"]);
    expect(report).toContain('data-agent-guidance="1"');
    expect(report).toContain('data-as-of="2026-08-29"');
    expect(report).toContain('data-source="baked-envelope-facet"');
    expect(report).not.toContain("SF-1");
    expect(report).not.toContain("372.5");
    expect(report).not.toContain("atom_path_pending");
    expect(reportHtml([])).toContain("No brief sections on this result");
    /* overlays: 0 flood, 1 envelope, 2 pipeline, 3 special-district */
    const pipe = overlayRowHtml(model.overlays[2]!, 2);
    expect(pipe).toContain('data-paint="absent-verified"');
    expect(pipe).toContain('data-url="https://rrc.example.test/p"');
    expect(pipe).not.toContain("plain.example.test");
    expect(pipe).not.toContain('data-act="why"');
    const sd = overlayRowHtml(model.overlays[3]!, 3);
    expect(sd).toContain('data-paint="unknown"');
    expect(sd).toContain(`data-paint-reason="${ABSENCE_UNVERIFIED}"`);
    expect(sd).toContain('data-act="why" data-why-kind="overlay" data-why-i="3"');
    const env = overlayRowHtml(model.overlays[1]!, 1);
    expect(env).toContain("Withheld, setbacks unruled");
    expect(env).not.toContain("atom_path_pending");
    expect(env).toContain('data-act="why"');
    const drawn = renderParcelDraw(model);
    expect(drawn).toContain('data-flood-state="present"');
    expect(drawn).toContain('data-overlay="pipeline"');
    expect(drawn).not.toContain('data-report="1"');
    const door = edgeTipHtml(GOLD_V2_EDGES[1]!, 1);
    expect(door).toContain('data-act="addscreen" data-node="48021:34169"');
    expect(door).toContain("Add to screen");
    expect(door.indexOf('data-act="open"')).toBeLessThan(door.indexOf('data-act="addscreen"'));
    expect(edgeTipHtml(GOLD_V2_EDGES[2]!, 2)).not.toContain("addscreen");
    expect(edgeTipHtml(GOLD_V2_EDGES[0]!, 0)).not.toContain("addscreen");
  });

  it("htmlContractViolations: the S7 checks fire on violated copies", () => {
    const clean = buildAppHtml();
    expect(htmlContractViolations(clean)).toEqual([]);
    expect(htmlContractViolations(clean.replace('data-act="cite"', 'data-act="site"'))).toContain("citation_link_unbound");
    expect(htmlContractViolations(clean.replace(WHY_TURN_INSTRUCTION, "Answer however you like."))).toContain("why_turn_unbound");
    expect(htmlContractViolations(clean.replace('"Watching"', '"Following"'))).toContain("save_statuses_unbound");
    expect(htmlContractViolations(clean.replace('data-act="report"', 'data-act="view"'))).toContain("report_toggle_unbound");
    expect(htmlContractViolations(clean.replace(/add_to_screen/g, "add_to_list"))).toContain("add_to_screen_unbound");
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
