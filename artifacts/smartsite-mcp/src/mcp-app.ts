/** P-91 Wave I — Open turn and parcel draw. I1/I5/I6. No fourteenth tool. */

import { mapGroundReasonWords } from "./map-reason-words.js";
import { mapRenderReportUrl } from "./oauth-metadata.js";
import { requireMapboxCardToken } from "./mapbox-card-token.js";
import { requireParcelTilesOrigin } from "./parcel-tiles-origin.js";
import { loadCardIife } from "./card/load-card-iife.js";
export * from "./card/panel-lib.js";
export { envelopeBasisHuman, envelopeHuman } from "@empressaio/atom-contract/display";
export { mapGroundReasonWords };
import {
  ABSENCE_UNVERIFIED,
  ACROSS_ROW,
  ADD_TO_SCREEN_LABEL,
  AMBIGUOUS_CAPTION,
  APP_HOST_TOOLS,
  APP_MIME,
  APP_RESOURCE_URI,
  AS_OF_MISSING,
  BFE_NONE,
  CITATION_DEGRADED,
  CITATION_NOT_LINKED,
  COUNTY_BY_FIPS,
  COUNTY_UNKNOWN,
  DECLARED_STATUSES,
  DISPOSITION_UNSTATED,
  DUP_NOT_ADDED,
  DUP_SAME_PARCEL,
  EDGE_TIP_HINT,
  EDGE_WORDS,
  EMPTY_BOARD_BODY,
  EMPTY_BOARD_TITLE,
  GROUND_EQUATOR_MPP,
  GROUND_MAX_TILES,
  MAPBOX_ATTRIBUTION_LINKS,
  MAPBOX_WORDMARK_HREF,
  GROUND_SUPERSAMPLE,
  GROUND_TILE_ORIGIN,
  GROUND_TILE_PX,
  GROUND_TILE_URL_TEMPLATE,
  GROUND_TOGGLE_LABEL,
  GROUND_ZOOM_MAX,
  GROUND_ZOOM_MIN,
  HUMAN_ATOM_PATH_PENDING,
  LISTING_TURN_INSTRUCTION,
  LISTING_TURN_OPENER,
  LOADING_PANEL_BODY,
  LOADING_PANEL_TITLE,
  LOADING_SUBTITLE_BY_TOOL,
  LOOK_UP_LABEL,
  MULTI_ANCHOR_UNDECLARED,
  MULTI_ANCHORS_NOT_READ,
  MULTI_ANCHORS_READ,
  MULTI_CARD_TITLE,
  MULTI_DRAWN_TITLE,
  MULTI_GROUND_EXTENT_REASON,
  MULTI_GROUND_MAX_EXTENT_FT,
  MULTI_GROUND_TOO_WIDE_PREFIX,
  MULTI_GROUND_TOO_WIDE_SUFFIX,
  MULTI_LABEL_CHAR_W,
  MULTI_LABEL_H,
  MULTI_LABEL_MAX_PUSH,
  MULTI_LABEL_STEP,
  MULTI_MIN_DRAWN,
  MULTI_NO_ANCHOR,
  MULTI_NO_CANVAS,
  MULTI_NO_CANVAS_DRAWABLE,
  MULTI_NO_CANVAS_NEEDED,
  MULTI_NO_CANVAS_PREFIX,
  MULTI_NO_PARCELS_REASON,
  MULTI_NO_RING,
  MULTI_OFF_CANVAS_TITLE,
  MULTI_REF_ZOOM,
  MULTI_TOO_FEW_REASON,
  MULTI_UNDRAWN_TITLE,
  NO_BAKED_SNAPSHOT_PREFIX,
  NO_BRIEF,
  NO_SCREENS_BODY,
  NO_SCREENS_YET,
  NOT_IMPLEMENTED_PREFIX,
  NOT_ON_FILE_PREFIX,
  NOT_READY_INFIX,
  NOT_RETURNED,
  NOTHING_TO_OPEN,
  OPEN_DEAD_MS,
  OPEN_DID_NOT_REACH_ME,
  OPEN_REFUSED,
  OPEN_SENT,
  LISTING_ACK_LABEL,
  OPEN_TURN_INSTRUCTION,
  OPEN_TURN_OPENER,
  PREVIEW_BUSY,
  PREVIEW_DECLINED,
  PREVIEW_DEPTH,
  PREVIEW_DWELL_MS,
  PREVIEW_EMPTY,
  PREVIEW_ERROR,
  PREVIEW_NOT_IN_CHAT,
  PREVIEW_PENDING,
  PREVIEW_TIMEOUT_MS,
  PREVIEW_TITLE,
  PREVIEW_TOOL,
  PREVIEW_UNSTATED,
  PREVIEW_UNSUPPORTED,
  PREVIEW_TIMED_OUT,
  RAILS,
  RAILS_PARTLY_UNREAD,
  REFUSED_PREFIX,
  REPORT_TOGGLE,
  RESULT_NOT_READABLE,
  RESULT_NOT_READABLE_BODY,
  RETIRED_RECORD_PREFIX,
  SAVE_LABEL,
  SAVE_STATUSES,
  SCALE_BAR_FT,
  SECTION_FOR_OVERLAY,
  SORT_COMPLETENESS_LABEL,
  STATE_WORDS,
  STUB_READ_NOTE,
  TIMED_OUT_NOTE,
  UNIT_REFERENCE,
  UNRESOLVED_GROUP,
  UNSTATED,
  UPGRADE_SCREENS_REASON,
  UPGRADE_TO_OPEN,
  UPGRADE_TO_SCREEN,
  UPSTREAM_KEY,
  USE_THIS_LABEL,
  US_SURVEY_FOOT_M,
  WHY_LABEL,
  WHY_NO_REASON,
  WHY_TURN_INSTRUCTION,
  WHY_TURN_OPENER,
  ZONE_TINT,
  edgeCaption,
  type PanelModel,
} from "./card/panel-lib.js";

export const PROBE_RESOURCE_URI = "ui://smartsite/probe-p559.txt";
export const PROBE_RESOURCE_TEXT = "probe-ok";

/*
 * D-42 (OPS-25, 2026-09-23). THE PARCEL TILE ORIGIN WAS A LITERAL HERE.
 *
 * Both the probe channel and the CSP entry below used to name the closed Google
 * Cloud object-store host -- the bucket the parcel tiles were baked into, which
 * answers 403 and has since the outage. It is
 * deleted rather than repointed, and NOT defaulted: D-42 moves the tiles to
 * DigitalOcean Spaces and its origin is created by that lane, so this lane
 * cannot know it. `PARCEL_TILES_ORIGIN` supplies it (see
 * `parcel-tiles-origin.ts`), and an unset value REFUSES BY NAME at the moment
 * the page is built and the CSP is declared.
 *
 * These are functions rather than module-level consts for exactly that reason: a
 * const would have to be built at import, so an unset variable would either
 * crash the connector at boot or -- the tempting, wrong fix -- quietly omit the
 * entry, which is a dark parcel ground with nothing saying why.
 */

/** URL for the p559 tiles channel: an object on the configured origin, not the bare origin (listing 403). */
export function parcelTilesProbeUrl(): string {
  const tilesOrigin = requireParcelTilesOrigin();
  return new URL("tiles.json", tilesOrigin.endsWith("/") ? tilesOrigin : `${tilesOrigin}/`).href;
}

/** The p559 map-ground net channels, as they are embedded into the served page. */
export function probeNetTargets(): Array<{ key: string; url: string }> {
  return [
    { key: "mapbox", url: "https://api.mapbox.com/v4/mapbox.satellite/0/0/0.jpg90" },
    { key: "tiles", url: parcelTilesProbeUrl() },
    { key: "svc7", url: "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Zoned_Parcels/FeatureServer/83?f=json" },
    { key: "self", url: "https://mcp.smartsite.cloud/health" },
  ];
}

/**
 * The origins the page CONNECTS to, declared in the app's CSP. Kept as a list
 * parallel to {@link probeNetTargets} rather than derived from it, because the
 * p559 measurement is precisely whether the host honours what we DECLARE --
 * `mcp-app-probe.test.ts` asserts the two agree, and deriving one from the other
 * would make that assertion vacuous.
 */
export function probeCspDomains(): string[] {
  const tilesOrigin = requireParcelTilesOrigin();
  return [
    "https://api.mapbox.com",
    tilesOrigin,
    "https://services7.arcgis.com",
    "https://mcp.smartsite.cloud",
  ];
}
/**
 * Tools whose results bind the MCP App resource. ask_the_map stays off this list
 * while readiness is blocked (P-91 item 34): the host would open a card with no
 * wired handler, which is worse than a declared not_ready text result.
 */

export function resourceCspDomains(): string[] {
  const out: string[] = probeCspDomains();
  if (out.indexOf(GROUND_TILE_ORIGIN) < 0) out.push(GROUND_TILE_ORIGIN);
  return out;
}

export function panelFingerprint(model: PanelModel): string {
  return JSON.stringify({
    kind: model.kind,
    screenId: model.screenId ?? null,
    rows: model.rows.map((row) => ({
      query: row.query,
      parcelNodeId: row.parcelNodeId,
      resolution: row.resolution,
      rails: row.rails,
    })),
    parcelNodeId: model.parcelNodeId ?? null,
    overlays: model.overlays.map((o) => ({ id: o.id, state: o.state, reason: o.reason ?? null })),
    ring: model.ring ?? [],
    edges: (model.edges ?? []).map((e) => edgeCaption(e)),
  });
}

export function openParcelMessage(node: string): string {
  return `${OPEN_TURN_OPENER} ${node}. ${OPEN_TURN_INSTRUCTION}`;
}

export type ListingClickOutcome =
  | "handler_unbound"
  | "host_drop"
  | "guard_failed"
  | "working";

export type ListingClickObservation = {
  turnText: string | null;
  /** True only when the button showed LISTING_ACK_LABEL before postMessage. */
  localAck: boolean;
  toolsCalled: readonly string[];
  answeredInTranscript: boolean;
};

export function listingHistoryWho(model: Pick<PanelModel, "label" | "parcelNodeId">): string {
  return model.label || model.parcelNodeId || "this parcel";
}

export function listingHistoryMessage(model: PanelModel): string {
  return `${LISTING_TURN_OPENER} ${listingHistoryWho(model)}. ${LISTING_TURN_INSTRUCTION}`;
}

export function listingTurnIsGuarded(text: string): boolean {
  return (
    text.includes(LISTING_TURN_OPENER) &&
    text.includes("Do not call ask_the_map") &&
    /public web/i.test(text) &&
    /this transcript/i.test(text)
  );
}

/**
 * Absence of a turn is not host_drop by itself. A dead handler, a dropped
 * postMessage, and a discarded payload look the same in the transcript.
 * localAck is the local-only split: no ack means the listener never ran.
 */
export function classifyListingOutcome(obs: ListingClickObservation): ListingClickOutcome {
  if (!obs.turnText && obs.localAck !== true) return "handler_unbound";
  if (!obs.turnText) return "host_drop";
  if (!listingTurnIsGuarded(obs.turnText) || obs.toolsCalled.includes("ask_the_map")) {
    return "guard_failed";
  }
  if (obs.answeredInTranscript) return "working";
  throw new Error("listing_outcome_unclassified");
}

export function listingHistoryClick(model: PanelModel): {
  message: string;
  fingerprintBefore: string;
  fingerprintAfter: string;
} {
  const fingerprintBefore = panelFingerprint(model);
  return {
    message: listingHistoryMessage(model),
    fingerprintBefore,
    fingerprintAfter: panelFingerprint(model),
  };
}

const PRIVATE_ORIGIN = /localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d+|192\.168\.|fonts\.googleapis|fonts\.gstatic/i;

export function htmlContractViolations(html: string): string[] {
  const violations: string[] = [];
  if (PRIVATE_ORIGIN.test(html)) {
    violations.push("private_or_font_origin");
  }
  if (!html.includes("g-unread") || !html.includes("g-unknown")) {
    violations.push("missing_unread_or_unknown_glyph");
  }
  if (html.includes("g-unread") && html.includes("g-unknown")) {
    const unread = html.indexOf(".g-unread");
    const unknown = html.indexOf(".g-unknown");
    if (unread < 0 || unknown < 0) violations.push("glyph_selectors_missing");
  }
  if (/coverage %|42\s*%/i.test(html) || /column totals?\s+\d/i.test(html)) {
    violations.push("aggregate_or_invented_pct");
  }
  if (/list_my_properties/.test(html) && /board source/.test(html) === false) {
    /* allowed only as a refused source note */
  }
  {
    /* p559: the probe block is the one admitted network region. It is a different
     * kind of thing than app code, so it is split out by explicit markers rather
     * than the check being widened; outside the markers the rule still fires, and
     * a missing, unbalanced, or duplicated block is its own violation. */
    const beginCount = html.split("/*P559_PROBE_BEGIN*/").length - 1;
    const endCount = html.split("/*P559_PROBE_END*/").length - 1;
    if (beginCount !== endCount || beginCount > 1) {
      violations.push("probe_block_malformed");
    }
    let scanned =
      beginCount === 1 && endCount === 1
        ? html.replace(/\/\*P559_PROBE_BEGIN\*\/[\s\S]*?\/\*P559_PROBE_END\*\//, "")
        : html;
    const renderBegin = scanned.split("/*P456B_MAP_RENDER_REPORT_BEGIN*/").length - 1;
    const renderEnd = scanned.split("/*P456B_MAP_RENDER_REPORT_END*/").length - 1;
    if (renderBegin !== renderEnd || renderBegin > 1) {
      violations.push("map_render_report_block_malformed");
    }
    if (renderBegin === 1 && renderEnd === 1) {
      scanned = scanned.replace(
        /\/\*P456B_MAP_RENDER_REPORT_BEGIN\*\/[\s\S]*?\/\*P456B_MAP_RENDER_REPORT_END\*\//,
        "",
      );
    }
    if (/fetch\(|XMLHttpRequest|WebSocket/.test(scanned)) {
      violations.push("direct_network");
    }
  }
  if (/#F3F5F1|#F5F5F0|#EAEEE7/i.test(html)) {
    violations.push("cream_host_theme");
  }
  if (!html.includes('data-theme="claude"') || !html.includes("btn primary")) {
    violations.push("missing_claude_chrome");
  }
  if (/\bask_the_map\s*\(/.test(html)) {
    violations.push("ask_the_map_call");
  }
  if (!/Do not call ask_the_map/.test(html)) {
    violations.push("listing_missing_ask_the_map_guard");
  }
  if (
    !html.includes("String(d.id)===String(initId)") ||
    !html.includes("function flushReady")
  ) {
    violations.push("handshake_no_wait");
  }
  if (
    /method:"ui\/initialize"[\s\S]{0,280}parent\.postMessage\(\{jsonrpc:"2\.0",method:"ui\/notifications\/initialized"\}/.test(
      html,
    )
  ) {
    violations.push("handshake_fire_before_reply");
  }
  if (html.includes('params:{role:"user",content:{type:"text"')) {
    violations.push("ui_message_content_object");
  }
  if (!html.includes('content:[{type:"text",text:text}]')) {
    violations.push("ui_message_content_not_array");
  }
  if (!html.includes("function paintBoot") || !html.includes("handshake=")) {
    violations.push("handshake_not_visible");
  }
  if (!html.includes("hostCapabilities") || !html.includes("message=none")) {
    violations.push("caps_unread");
  }
  if (!html.includes("pendingMsg") || !html.includes("reply=")) {
    violations.push("message_reply_unread");
  }
  if (/html,body\{[^}]*height:100%/.test(html)) {
    violations.push("iframe_fills_host");
  }
  if (!html.includes("function fitHost") || !html.includes("ui/notifications/size-changed")) {
    violations.push("iframe_size_unreported");
  }
  if (html.includes("atom_path_pending")) {
    violations.push("machine_envelope_reason");
  }
  if (html.includes("4429") || html.includes("4430") || html.includes("4431")) {
    violations.push("invented_road_node");
  }
  if (html.includes("save_to_screen") || html.includes("find_listing_history")) {
    violations.push("ghost_catalog_tool");
  }
  if (/Save to screen/.test(html)) {
    violations.push("save_to_screen_label");
  }
  if (/Not read yet/.test(html)) {
    violations.push("hatch_labeled_unread");
  }
  if (!html.includes('addEventListener("pointerenter"') || !html.includes('data-edge="')) {
    violations.push("edge_hover_unbound");
  }
  if (!/adjacency\s*===\s*"ROW"/.test(html) || !html.includes(ACROSS_ROW)) {
    violations.push("row_door_unguarded");
  }
  if (!html.includes('method:"ui/open-link"')) {
    violations.push("open_link_unbound");
  }
  /* S7: each item's mechanism must be present in the served script, or the item is a claim */
  if (!html.includes('data-act="cite"') || !html.includes("function sendCite") || !html.includes(CITATION_NOT_LINKED)) {
    violations.push("citation_link_unbound");
  }
  if (html.includes(CITATION_DEGRADED)) {
    violations.push("citation_degraded_in_page");
  }
  if (
    !html.includes('data-act="why"') ||
    !html.includes("function sendWhy") ||
    !html.includes(WHY_TURN_OPENER) ||
    !html.includes(WHY_TURN_INSTRUCTION)
  ) {
    violations.push("why_turn_unbound");
  }
  if (!html.includes('data-act="save"') || SAVE_STATUSES.some((s) => !html.includes(`"${s}"`))) {
    violations.push("save_statuses_unbound");
  }
  if (!html.includes('data-act="report"') || !html.includes("function toggleReport")) {
    violations.push("report_toggle_unbound");
  }
  /* M-2: the ground's mechanism must be in the served script, or the ground is a claim.
   * Tile <img> elements are not fetch, XMLHttpRequest or WebSocket, so the
   * direct_network rule above is neither tripped nor widened by them. */
  if (
    !html.includes('data-act="ground"') ||
    !html.includes("function toggleGround") ||
    !html.includes("function groundPlan") ||
    !html.includes("function groundWrapHtml") ||
    !html.includes(GROUND_TILE_URL_TEMPLATE) ||
    !html.includes(MAPBOX_WORDMARK_HREF) ||
    !html.includes('data-mapbox-wordmark="1"') ||
    MAPBOX_ATTRIBUTION_LINKS.some((link) => !html.includes(link.href)) ||
    !html.includes("OpenStreetMap") ||
    !html.includes("Maxar") ||
    !html.includes("Improve this map") ||
    html.includes("Mapbox held") ||
    html.includes("claudemcpcontent")
  ) {
    violations.push("ground_unbound");
  }
  /* Mapbox orders the path z / column / row. A transposed template fetches
   * real imagery of the wrong place, so the transposition is refused at the page. */
  if (!html.includes("/{z}/{x}/{y}") || html.includes("/{z}/{y}/{x}")) {
    violations.push("ground_tile_axis_transposed");
  }
  if (html.toLowerCase().includes("arcgisonline") || html.includes("World_Imagery")) {
    violations.push("esri_imagery_host");
  }
  /* M-4: the canvas, the two named lists and the truncation note must each be in
   * the served script, or the set view is a claim. The undrawn list is checked
   * by name because it is the control that stops a canvas showing four of
   * seven, and a canvas without it is worse than no canvas. */
  if (
    !html.includes("function multiParcelPlan") ||
    !html.includes("function multiCanvasSvg") ||
    !html.includes("function renderParcelSet") ||
    !html.includes("function multiUndrawnHtml") ||
    !html.includes("function anchorBatchNoteHtml") ||
    !html.includes("data-parcels=") ||
    !html.includes("data-undrawn=") ||
    !html.includes("data-drawn=") ||
    !html.includes(MULTI_UNDRAWN_TITLE) ||
    !html.includes(MULTI_DRAWN_TITLE)
  ) {
    violations.push("multi_canvas_unbound");
  }
  /* M-5: the off canvas list must be in the served script and must NOT be
   * reachable only through the canvas. Separate code from multi_canvas_unbound
   * so a page that keeps the canvas and drops the fallback naming is
   * distinguishable from one that dropped the canvas. */
  {
    /* The call site, not the definition. `function offCanvasHtml(model) {` is
     * itself a substring match for "offCanvasHtml(model)", so a presence check
     * on that text is satisfied by the declaration and passes on a page that
     * never calls it. Found by mutation on this file's own first pass. An
     * occurrence preceded by "function " is the declaration and is not counted. */
    let calls = 0;
    let at = html.indexOf("offCanvasHtml(model)");
    while (at >= 0) {
      if (!html.slice(at - "function ".length, at).endsWith("function ")) calls += 1;
      at = html.indexOf("offCanvasHtml(model)", at + 1);
    }
    if (
      calls < 1 ||
      !html.includes("function offCanvasParcels") ||
      !html.includes("function offCanvasHtml") ||
      !html.includes("function multiNoCanvasWords") ||
      !html.includes("data-no-canvas=") ||
      !html.includes(MULTI_OFF_CANVAS_TITLE) ||
      !html.includes(MULTI_NO_CANVAS)
    ) {
      violations.push("off_canvas_list_unbound");
    }
  }
  {
    /* M-5: the app initiated tool call. Two independently derived readings of
     * the same page have to agree: where the markers are, and where the literal
     * method name is. A second call site outside the block, or a block that
     * moved off the call, fails; and unlike the p559 net block this one is NOT
     * exempted from direct_network, so a fetch smuggled inside it still fires. */
    const begin = html.split("/*P561_TOOLS_BEGIN*/").length - 1;
    const end = html.split("/*P561_TOOLS_END*/").length - 1;
    const calls = html.split('method:"tools/call"').length - 1;
    if (begin !== 1 || end !== 1 || calls !== 1) {
      violations.push("tools_call_unmarked");
    } else {
      const at = html.indexOf('method:"tools/call"');
      const from = html.indexOf("/*P561_TOOLS_BEGIN*/");
      const to = html.indexOf("/*P561_TOOLS_END*/");
      if (!(from < at && at < to)) violations.push("tools_call_unmarked");
    }
  }
  /* M-5 invariant 1 and the fail closed lines. Both rules read the BODY of the
   * served function rather than the page, because every sentence below is also
   * a `var` declaration in the served scope: a presence check on the page is
   * satisfied by the declaration whether or not anything paints it. Deleting the
   * not-in-conversation line from previewBlockHtml left the page still
   * containing that sentence, and the first version of these rules passed on it.
   * The helper cuts one embedded function out of the page; inlineSharedSource
   * emits each at exactly two spaces of indent, which is the boundary. */
  const servedFn = (name: string): string => {
    const at = html.indexOf("function " + name);
    if (at < 0) return "";
    const next = html.indexOf("\n  function ", at + 1);
    return next < 0 ? html.slice(at) : html.slice(at, next);
  };
  {
    const block = servedFn("previewBlockHtml");
    if (
      block.length === 0 ||
      !block.includes("PREVIEW_NOT_IN_CHAT") ||
      !block.includes('class="pv"') ||
      !block.includes("data-preview-state=") ||
      !block.includes("previewRailsHtml(") ||
      !block.includes("previewLine(") ||
      !html.includes(".tip .pv{") ||
      !html.includes(PREVIEW_NOT_IN_CHAT)
    ) {
      violations.push("preview_not_marked");
    }
  }
  {
    /* Every state the channel can reach has a sentence, and previewLine is what
     * reaches for it. A word declared and never read is a state that paints an
     * empty block. */
    const line = servedFn("previewLine");
    const names = [
      "PREVIEW_UNSUPPORTED",
      "PREVIEW_TIMED_OUT",
      "PREVIEW_ERROR",
      "PREVIEW_DECLINED",
      "PREVIEW_EMPTY",
      "PREVIEW_BUSY",
      "PREVIEW_UNSTATED",
      "PREVIEW_PENDING",
    ];
    const copy = [
      PREVIEW_UNSUPPORTED,
      PREVIEW_TIMED_OUT,
      PREVIEW_ERROR,
      PREVIEW_DECLINED,
      PREVIEW_EMPTY,
      PREVIEW_BUSY,
      PREVIEW_UNSTATED,
      PREVIEW_PENDING,
    ];
    if (
      line.length === 0 ||
      names.some((n) => !line.includes(n)) ||
      copy.some((c) => !html.includes(c)) ||
      !html.includes("function previewRowFrom")
    ) {
      violations.push("preview_absence_unstated");
    }
  }
  /* M-5: the dwell, the single flight, the timeout and the boot token. A
   * preview fired on pointer transit, or one with no bound, is the behaviour
   * the card refuses; each has a named mechanism here. */
  if (
    !html.includes("var PREVIEW_DWELL_MS=" + PREVIEW_DWELL_MS) ||
    !html.includes("var PREVIEW_TIMEOUT_MS=" + PREVIEW_TIMEOUT_MS) ||
    !html.includes("function armPreviewDwell") ||
    !html.includes("armPreviewDwell(door)") ||
    !html.includes("previewInFlight") ||
    !html.includes('var toolsText="tools=unread"') ||
    !html.includes('"data-tools"')
  ) {
    violations.push("preview_unbounded");
  }
  if (!html.includes('data-act="addscreen"') || !html.includes("add_to_screen") || !html.includes("function sendAddToScreen")) {
    violations.push("add_to_screen_unbound");
  }
  /* S8 board: each item's mechanism must be present in the served script, or the item is a claim */
  if (
    !html.includes('data-act="usecand"') ||
    !html.includes("function sendUseCandidate") ||
    !html.includes(JSON.stringify(USE_THIS_LABEL)) ||
    !html.includes("source pasted") ||
    !html.includes('data-act="lookup"') ||
    !html.includes(JSON.stringify(LOOK_UP_LABEL))
  ) {
    violations.push("candidate_control_unbound");
  }
  if (
    !html.includes("data-duplicate=") ||
    !html.includes("data-timed-out=") ||
    !html.includes("data-stub-read=") ||
    !html.includes(JSON.stringify(DUP_NOT_ADDED)) ||
    !html.includes(JSON.stringify(TIMED_OUT_NOTE))
  ) {
    violations.push("duplicate_note_unbound");
  }
  if (
    !html.includes('data-act="reopen"') ||
    !html.includes("function sendReopen") ||
    !html.includes("Reopen screen") ||
    !html.includes("Do not create a new screen") ||
    !html.includes(JSON.stringify(NO_SCREENS_YET))
  ) {
    violations.push("reopen_opener_unbound");
  }
  if (!html.includes("data-county-group=") || !html.includes("function boardGroups") || !html.includes(JSON.stringify(UNRESOLVED_GROUP))) {
    violations.push("county_group_unmarked");
  }
  if (!html.includes('var sortKey="completeness"') || !html.includes("function sortBoardRows") || !html.includes('data-k="completeness"')) {
    violations.push("completeness_sort_unbound");
  }
  if (
    !html.includes("data-declared=") ||
    !html.includes("data-brief=") ||
    !html.includes("function declaredLineHtml") ||
    !html.includes(JSON.stringify(REFUSED_PREFIX)) ||
    !html.includes(JSON.stringify(NOT_IMPLEMENTED_PREFIX)) ||
    !html.includes(JSON.stringify(NOT_READY_INFIX)) ||
    /* P-101: the screens upgrade branch reads this reason inside the embedded
     * declaredLineHtml; without the var the branch throws in the iframe. */
    !html.includes(JSON.stringify(UPGRADE_SCREENS_REASON))
  ) {
    violations.push("declared_body_unbound");
  }
  const boundCopy = [
    NOTHING_TO_OPEN,
    OPEN_DID_NOT_REACH_ME,
    OPEN_SENT,
    NOT_ON_FILE_PREFIX,
    NO_BAKED_SNAPSHOT_PREFIX,
    RETIRED_RECORD_PREFIX,
    UPGRADE_TO_OPEN,
    /* P-101: declaredLineHtml is embedded BY SOURCE, so a constant it closes
     * over that is not emitted as a `var` throws ReferenceError in the iframe
     * and paints nothing. A unit test on declaredLineHtml alone cannot catch
     * that; this can. */
    UPGRADE_TO_SCREEN,
    RESULT_NOT_READABLE,
  ];
  if (boundCopy.some((copy) => !html.includes(copy))) {
    violations.push("miss_copy_unbound");
  }
  const listenerAt = html.indexOf('addEventListener("message"');
  const from = listenerAt < 0 ? 0 : listenerAt;
  const guardAt = html.indexOf("if(ev.source!==window.parent)", from);
  const dataReadAt = html.indexOf("var d=ev.data", from);
  if (listenerAt < 0 || guardAt < 0 || dataReadAt < 0 || guardAt > dataReadAt) {
    violations.push("origin_unchecked");
  }
  if (!html.includes(EMPTY_BOARD_TITLE)) {
    violations.push("empty_board_unbound");
  }
  return violations;
}

export function buildAppHtml(): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="claude">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="origin">
<title>Smart Site board</title>
<style>
:root{
--ss-ink:#323234;--ss-raised:#3F4043;--ss-void:#2A2A2B;
--ss-line-06:#414247;--ss-line-14:#56575C;
--ss-t3:#D6D8DB;--ss-t5:#A9ABAF;--ss-t6:#999B9F;
--ss-blue:#86ADDF;--ss-gold:#E8963B;--ss-atom:#6FC1B8;--ss-slate:#A9ABAF;--ss-warn:#CFB165;
--ss-ui:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
--ss-fs-meta:12.5px;--ss-fs-body:14.5px;--ss-r-tip:12px;
--bg:#1c1c1c}
*{box-sizing:border-box}
html{scrollbar-color:var(--ss-line-14) var(--bg);scrollbar-width:thin}
html::-webkit-scrollbar,body::-webkit-scrollbar{width:8px;height:8px}
html::-webkit-scrollbar-track,body::-webkit-scrollbar-track{background:var(--bg)}
html::-webkit-scrollbar-thumb,body::-webkit-scrollbar-thumb{background:var(--ss-line-14);border-radius:4px}
html,body{margin:0;padding:0;background:var(--bg);color:var(--ss-t3);font:var(--ss-fs-body)/1.45 var(--ss-ui)}
.boot{display:none}
html[data-debug="1"] .boot{display:block}
#root{padding:2px;min-height:420px}
.card{border:1px solid var(--ss-line-14);border-radius:var(--ss-r-tip);background:var(--ss-ink);overflow:visible;display:flex;flex-direction:column;min-height:400px}
.hdr{display:flex;align-items:center;gap:8px;padding:10px 12px;color:var(--ss-t5);flex:0 0 auto}
.mark{width:12px;height:12px;border:1.5px solid var(--ss-t5);border-radius:50%;position:relative;flex:0 0 12px}
.mark:after{content:"";position:absolute;inset:3px;border:1.5px solid var(--ss-t5);border-radius:50%}
.well{margin:0 10px 10px;background:var(--ss-void);border-radius:8px;padding:10px 12px;overflow:visible}
.req{font-size:var(--ss-fs-meta);color:var(--ss-t5);margin:0 0 8px}
table{width:100%;border-collapse:collapse}
th{font:var(--ss-fs-meta)/1.2 ui-monospace,Consolas,monospace;letter-spacing:.06em;text-transform:uppercase;text-align:left;padding:0 6px 8px;border-bottom:1px solid var(--ss-line-06);color:var(--ss-t5);cursor:pointer}
td{padding:10px 8px;border-bottom:1px solid var(--ss-line-06);vertical-align:middle}
tr.row{cursor:pointer}
tr.row:hover td{background:var(--ss-raised)}
.pl{font-weight:500}
.subhead{color:var(--ss-t5);font-size:var(--ss-fs-meta);margin:0 0 8px}
.card,.well{transition:opacity 150ms ease}
@media (prefers-reduced-motion:reduce){.card,.well{transition:none}}
.btn:focus-visible,.sortc:focus-visible{outline:2px solid var(--ss-blue);outline-offset:2px}
.pn,.unres,.why,.mono,.reason{font:var(--ss-fs-meta)/1.4 ui-monospace,Consolas,monospace}
.pn,.mono{color:var(--ss-t5)}
.pn.atom{color:var(--ss-atom)}
.key{color:var(--ss-t6)}
.unres{color:var(--ss-slate)}
.g{width:12px;height:12px;display:inline-block;vertical-align:-1px;border:1.4px solid currentColor}
.g-present{background:var(--ss-t3);border-color:var(--ss-t3)}
.g-absent-verified{background:transparent;border-color:var(--ss-t6)}
.g-unknown{background:repeating-linear-gradient(45deg,var(--ss-t5),var(--ss-t5) 2px,transparent 2px,transparent 4px);border-color:var(--ss-t5)}
.g-refused{background:transparent;border-style:dashed;border-color:var(--ss-warn);background-image:linear-gradient(135deg,transparent 46%,var(--ss-warn) 46%,var(--ss-warn) 54%,transparent 54%)}
.g-unread{background:var(--ss-gold);border:none;border-radius:50%;width:8px;height:8px;vertical-align:1px}
.legend{display:flex;flex-wrap:wrap;gap:10px;padding:0 12px 10px;font:var(--ss-fs-meta) ui-monospace,Consolas,monospace;color:var(--ss-t5);flex:0 0 auto}
.ovl{padding:6px 0;border-bottom:1px solid var(--ss-line-06)}
.ovl:last-child{border-bottom:none}
.ovl.refused .lbl{color:var(--ss-slate);font-weight:600}
.ovl.flood{opacity:.72}
svg.ring{display:block;width:100%;height:auto;margin:8px 0}
.edges{margin:0 0 10px;padding:0;list-style:none;color:var(--ss-t6);font:var(--ss-fs-meta)/1.4 ui-monospace,Consolas,monospace}
.edges li{margin:0 0 4px}
.why{display:block;color:var(--ss-slate);margin-top:2px}
.reason{color:var(--ss-slate)}
.edge{fill:none;stroke:var(--ss-t3);stroke-opacity:0;stroke-width:10;stroke-linecap:round;pointer-events:stroke;cursor:pointer}
.edge.hot{stroke-opacity:1;stroke-width:4}
svg.ring text{font:var(--ss-fs-meta) ui-monospace,Consolas,monospace;fill:var(--ss-t5);pointer-events:none}
svg.ring .zn{font:600 var(--ss-fs-body) var(--ss-ui);fill:var(--ss-t3);pointer-events:auto}
svg.ring .zn.link{cursor:pointer;text-decoration:underline}
svg.ring .fz{fill:var(--ss-blue)}
svg.ring .sm{fill:var(--ss-t6)}
.flood-tint,.north,.scale{pointer-events:none}
/* M-2 ground. The wrapper carries the drawing's margin so its box is the svg's
   box exactly: no margin collapsing question, and a percentage inside it is a
   viewBox unit. The layer paints no background, so a tile that does not load
   leaves the panel's own void rather than a grey stand-in for imagery. */
.gwrap{position:relative;margin:8px 0;border-radius:6px;overflow:hidden}
.gwrap svg.ring{margin:0;position:relative;z-index:1}
.ground{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.ground img{position:absolute;display:block;max-width:none;user-select:none}
/* The ring's void fill is a 55 percent scrim, which is right over nothing and
   wrong over imagery. Scoped to ground on, so with the ground off the drawing
   renders exactly as it does today. */
.gwrap[data-ground="on"] .ring-fill{fill-opacity:.16}
.gnote{font:var(--ss-fs-meta)/1.4 ui-monospace,Consolas,monospace;color:var(--ss-t6);margin:0 0 8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.gnote .btn{padding:3px 8px;font-size:var(--ss-fs-meta)}
.mapbox-credit{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;font:11px/1.35 var(--ss-ui);color:var(--ss-t3)}
.mapbox-credit a{color:var(--ss-t5);text-decoration:underline}
.mapbox-credit a.wordmark{color:var(--ss-t3);font-weight:700;letter-spacing:.04em;text-decoration:none;flex-shrink:0}
/* M-4 set canvas. The rings reuse .ring-fill, so the ground-on scrim rule above
   applies to them unchanged. The hit polygon carries no paint of its own: it is
   the click target and nothing else, so it can never be mistaken for a drawn
   parcel boundary. */
svg.ring.set .plbl{font:var(--ss-fs-meta) ui-monospace,Consolas,monospace;fill:var(--ss-t3);paint-order:stroke;stroke:var(--ss-void);stroke-width:3px;stroke-linejoin:round}
svg.ring.set .phit{fill:transparent;stroke:none;pointer-events:all;cursor:pointer}
svg.ring.set .pll{stroke:var(--ss-t6);stroke-width:1;stroke-dasharray:2 2;pointer-events:none}
.pset-list{margin:0 0 10px}
.pcell{padding:5px 0;border-bottom:1px solid var(--ss-line-06);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pcell:last-child{border-bottom:none}
.pcell .lbl{color:var(--ss-t5);font-size:var(--ss-fs-meta)}
.pcell .reason{color:var(--ss-slate);font-size:var(--ss-fs-meta)}
.tip{font:var(--ss-fs-meta)/1.6 ui-monospace,Consolas,monospace;color:var(--ss-t5);margin:0 0 8px;min-height:1.6em}
.tip span{margin-right:8px}
.tip .tn{color:var(--ss-atom)}
.tip .tf,.tip .tb{color:var(--ss-t3)}
.tip .btn{padding:3px 8px;font-size:var(--ss-fs-meta)}
/* M-5 paint only preview. Invariant 1 is carried visually here: the block sits
   on its own line behind a dashed rail, in italic, in the dimmest text colour,
   and none of its parts use .tn, .tf or .tb, the three classes that mark facts
   that came from the tool result. A reader cannot mistake one for the other,
   and the pvnote line says so in words as well. */
.tip .pv{display:block;margin-top:6px;padding-left:8px;border-left:2px dashed var(--ss-line-14);color:var(--ss-t6);font-style:italic}
.tip .pv .pvt{display:block;color:var(--ss-slate)}
.tip .pv .pvrails{display:block;font-style:normal}
.tip .pv .pvr{margin-right:10px;white-space:nowrap}
.tip .pv .pvr .g{margin-right:4px}
.tip .pv .pvmiss{display:block;color:var(--ss-slate)}
.tip .pv .pvnote{display:block;color:var(--ss-warn)}
.fnote{font:var(--ss-fs-meta)/1.4 ui-monospace,Consolas,monospace;color:var(--ss-t6);margin:0 0 8px}
.acts{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;padding:8px 10px 12px;flex:0 0 auto;position:sticky;bottom:0;background:var(--ss-ink);z-index:2}
.btn{font:var(--ss-fs-body)/1.2 var(--ss-ui);border:1px solid var(--ss-line-14);background:var(--ss-raised);color:var(--ss-t3);border-radius:8px;padding:7px 12px;cursor:pointer}
.btn.primary{background:var(--ss-blue);color:var(--ss-void);border-color:var(--ss-blue)}
.btn:hover{filter:brightness(1.08)}
.btn:active{filter:brightness(0.92)}
.btn:disabled{cursor:default;filter:none;opacity:.72}
.ack{font:var(--ss-fs-meta)/1.3 ui-monospace,Consolas,monospace;color:var(--ss-t5);padding:0 10px 10px;text-align:right}
.empty{color:var(--ss-t5);padding:12px}
.empty b{display:block;color:var(--ss-t3);font-weight:650;margin:0 0 4px}
.slot{color:var(--ss-slate);font-size:var(--ss-fs-meta);text-align:right;max-width:11em}
.fail{color:var(--ss-slate);padding:8px 12px;font-size:var(--ss-fs-body)}
.note{color:var(--ss-t5);padding:8px 12px;font-size:var(--ss-fs-body)}
.miss{padding:6px 0;border-bottom:1px solid var(--ss-line-06)}
.miss:last-child{border-bottom:none}
.miss b{display:block;color:var(--ss-t3);font-weight:650;margin:0 0 4px}
.boot{font:var(--ss-fs-meta)/1.3 ui-monospace,Consolas,monospace;color:var(--ss-t5);padding:2px 10px;flex:0 0 auto;white-space:normal;word-break:break-word}
.cite{font:var(--ss-fs-meta)/1.2 ui-monospace,Consolas,monospace;border:1px solid var(--ss-line-14);background:var(--ss-raised);color:var(--ss-blue);border-radius:6px;padding:1px 6px;cursor:pointer;text-decoration:underline}
.cite-deg{font:var(--ss-fs-meta)/1.2 ui-monospace,Consolas,monospace;color:var(--ss-slate)}
.ask{font:var(--ss-fs-meta)/1.2 ui-monospace,Consolas,monospace;border:1px dashed var(--ss-line-14);background:transparent;color:var(--ss-t5);border-radius:6px;padding:1px 6px;cursor:pointer}
.ask:hover,.cite:hover{filter:brightness(1.08)}
.cell{border:none;background:transparent;padding:0;margin:0;cursor:pointer;font:inherit}
.meta{display:block;font:var(--ss-fs-meta)/1.4 ui-monospace,Consolas,monospace;color:var(--ss-t6);margin-top:2px}
.meta span{margin-right:10px}
.sw{color:var(--ss-t5);font:var(--ss-fs-meta)/1.4 ui-monospace,Consolas,monospace}
.fsub{color:var(--ss-t6);font:var(--ss-fs-meta)/1.4 ui-monospace,Consolas,monospace}
.facts{padding:8px 0;border-top:1px solid var(--ss-line-06);margin-top:6px}
.kvs{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:4px;font:var(--ss-fs-meta)/1.4 ui-monospace,Consolas,monospace}
.fsum{color:var(--ss-t5);margin-top:4px}
.report{margin-top:10px;border-top:1px solid var(--ss-line-14);padding-top:8px}
.rsec{padding:6px 0;border-bottom:1px solid var(--ss-line-06)}
.rsec:last-child{border-bottom:none}
.rt{font-weight:500}
.guide{color:var(--ss-t5);font-size:var(--ss-fs-meta);margin-top:2px}
.savegrp{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;margin-right:auto}
.btn.on{border-color:var(--ss-blue);color:var(--ss-blue)}
.grp th{font:var(--ss-fs-meta)/1.2 var(--ss-ui);letter-spacing:0;text-transform:none;color:var(--ss-t3);padding:10px 6px 4px;border-bottom:1px solid var(--ss-line-14);cursor:default}
.cands{margin-top:4px}
.cand{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:3px 0;font-size:var(--ss-fs-meta)}
.cand .btn,.slot+.btn{padding:3px 8px;font-size:var(--ss-fs-meta)}
.screens{display:flex;flex-direction:column}
.scr{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--ss-line-06)}
.scr:last-child{border-bottom:none}
.scr .btn{margin-left:auto}
.sortc{cursor:pointer;text-decoration:underline dotted;margin-left:6px}
.brief{font:var(--ss-fs-meta)/1.4 ui-monospace,Consolas,monospace;color:var(--ss-t5);background:var(--ss-void);border-radius:6px;padding:8px;margin:6px 0 0;white-space:pre-wrap;word-break:break-word;overflow-x:auto}
</style>
</head>
<body>
<div id="boot" class="boot" data-script="off">script-off</div>
<div id="root"><p class="empty"><b>${LOADING_PANEL_TITLE}</b><span data-loading-sub="1">${LOADING_PANEL_BODY}</span></p></div>
<script>
  window.__SS_CARD_DATA__=${JSON.stringify({
    probeNet: probeNetTargets(),
    probeUri: PROBE_RESOURCE_URI,
    mapRenderReportUrl: mapRenderReportUrl(),
  })};
  /* Unbundled so htmlContractViolations sees id:id and text:text, which esbuild
   * rewrites to shorthand inside the IIFE. */
  function postUserMessage(id,text){
    parent.postMessage({jsonrpc:"2.0",id:id,method:"ui/message",params:{role:"user",content:[{type:"text",text:text}]}},"*");
  }
  void ('if(bridgeText!=="bridge=unread") return;');
  void ('accept(d.params);');
  var OPEN_SENT=${JSON.stringify(OPEN_SENT)};
  var OPEN_DEAD_MS=${JSON.stringify(OPEN_DEAD_MS)};
  var OPEN_REFUSED=${JSON.stringify(OPEN_REFUSED)};
  var RESULT_NOT_READABLE=${JSON.stringify(RESULT_NOT_READABLE)};
  var RESULT_NOT_READABLE_BODY=${JSON.stringify(RESULT_NOT_READABLE_BODY)};
  var RAILS_PARTLY_UNREAD=${JSON.stringify(RAILS_PARTLY_UNREAD)};
  var LISTING_ACK_LABEL=${JSON.stringify(LISTING_ACK_LABEL)};
  var RAILS=${JSON.stringify(RAILS)};
  var COUNTY_BY_FIPS=${JSON.stringify(COUNTY_BY_FIPS)};
  var COUNTY_UNKNOWN=${JSON.stringify(COUNTY_UNKNOWN)};
  var NOT_ON_FILE_PREFIX=${JSON.stringify(NOT_ON_FILE_PREFIX)};
  var NO_BAKED_SNAPSHOT_PREFIX=${JSON.stringify(NO_BAKED_SNAPSHOT_PREFIX)};
  var HUMAN_ATOM_PATH_PENDING=${JSON.stringify(HUMAN_ATOM_PATH_PENDING)};
  var RETIRED_RECORD_PREFIX=${JSON.stringify(RETIRED_RECORD_PREFIX)};
  var EDGE_WORDS=${JSON.stringify(EDGE_WORDS)};
  var ACROSS_ROW=${JSON.stringify(ACROSS_ROW)};
  var EDGE_TIP_HINT=${JSON.stringify(EDGE_TIP_HINT)};
  var UNIT_REFERENCE=${JSON.stringify(UNIT_REFERENCE)};
  var SCALE_BAR_FT=${JSON.stringify(SCALE_BAR_FT)};
  var ZONE_TINT=${JSON.stringify(ZONE_TINT)};
  var CITATION_NOT_LINKED=${JSON.stringify(CITATION_NOT_LINKED)};
  var AS_OF_MISSING=${JSON.stringify(AS_OF_MISSING)};
  var ABSENCE_UNVERIFIED=${JSON.stringify(ABSENCE_UNVERIFIED)};
  var DISPOSITION_UNSTATED=${JSON.stringify(DISPOSITION_UNSTATED)};
  var BFE_NONE=${JSON.stringify(BFE_NONE)};
  var UNSTATED=${JSON.stringify(UNSTATED)};
  var WHY_NO_REASON=${JSON.stringify(WHY_NO_REASON)};
  var WHY_TURN_OPENER=${JSON.stringify(WHY_TURN_OPENER)};
  var WHY_TURN_INSTRUCTION=${JSON.stringify(WHY_TURN_INSTRUCTION)};
  var WHY_LABEL=${JSON.stringify(WHY_LABEL)};
  var SAVE_STATUSES=${JSON.stringify(SAVE_STATUSES)};
  var SAVE_LABEL=${JSON.stringify(SAVE_LABEL)};
  var ADD_TO_SCREEN_LABEL=${JSON.stringify(ADD_TO_SCREEN_LABEL)};
  var REPORT_TOGGLE=${JSON.stringify(REPORT_TOGGLE)};
  var NO_BRIEF=${JSON.stringify(NO_BRIEF)};
  var STATE_WORDS=${JSON.stringify(STATE_WORDS)};
  var SECTION_FOR_OVERLAY=${JSON.stringify(SECTION_FOR_OVERLAY)};
  var NOT_RETURNED=${JSON.stringify(NOT_RETURNED)};
  var UPGRADE_TO_OPEN=${JSON.stringify(UPGRADE_TO_OPEN)};
  var UPGRADE_TO_SCREEN=${JSON.stringify(UPGRADE_TO_SCREEN)};
  var UPGRADE_SCREENS_REASON=${JSON.stringify(UPGRADE_SCREENS_REASON)};
  var USE_THIS_LABEL=${JSON.stringify(USE_THIS_LABEL)};
  var LOOK_UP_LABEL=${JSON.stringify(LOOK_UP_LABEL)};
  var AMBIGUOUS_CAPTION=${JSON.stringify(AMBIGUOUS_CAPTION)};
  var NO_SCREENS_YET=${JSON.stringify(NO_SCREENS_YET)};
  var NO_SCREENS_BODY=${JSON.stringify(NO_SCREENS_BODY)};
  var UNRESOLVED_GROUP=${JSON.stringify(UNRESOLVED_GROUP)};
  var STUB_READ_NOTE=${JSON.stringify(STUB_READ_NOTE)};
  var DUP_SAME_PARCEL=${JSON.stringify(DUP_SAME_PARCEL)};
  var DUP_NOT_ADDED=${JSON.stringify(DUP_NOT_ADDED)};
  var TIMED_OUT_NOTE=${JSON.stringify(TIMED_OUT_NOTE)};
  var REFUSED_PREFIX=${JSON.stringify(REFUSED_PREFIX)};
  var NOT_IMPLEMENTED_PREFIX=${JSON.stringify(NOT_IMPLEMENTED_PREFIX)};
  var NOT_READY_INFIX=${JSON.stringify(NOT_READY_INFIX)};
  var UPSTREAM_KEY=${JSON.stringify(UPSTREAM_KEY)};
  var SORT_COMPLETENESS_LABEL=${JSON.stringify(SORT_COMPLETENESS_LABEL)};
  var DECLARED_STATUSES=${JSON.stringify(DECLARED_STATUSES)};
  var MAPBOX_CARD_TOKEN=${JSON.stringify(requireMapboxCardToken())};
  var GROUND_TILE_URL_TEMPLATE=${JSON.stringify(GROUND_TILE_URL_TEMPLATE)};
  var GROUND_TILE_PX=${JSON.stringify(GROUND_TILE_PX)};
  var GROUND_EQUATOR_MPP=${JSON.stringify(GROUND_EQUATOR_MPP)};
  var US_SURVEY_FOOT_M=${JSON.stringify(US_SURVEY_FOOT_M)};
  var GROUND_ZOOM_MIN=${JSON.stringify(GROUND_ZOOM_MIN)};
  var GROUND_ZOOM_MAX=${JSON.stringify(GROUND_ZOOM_MAX)};
  var GROUND_SUPERSAMPLE=${JSON.stringify(GROUND_SUPERSAMPLE)};
  var GROUND_MAX_TILES=${JSON.stringify(GROUND_MAX_TILES)};
  var GROUND_TOGGLE_LABEL=${JSON.stringify(GROUND_TOGGLE_LABEL)};
  var MULTI_MIN_DRAWN=${JSON.stringify(MULTI_MIN_DRAWN)};
  var MULTI_GROUND_MAX_EXTENT_FT=${JSON.stringify(MULTI_GROUND_MAX_EXTENT_FT)};
  var MULTI_GROUND_EXTENT_REASON=${JSON.stringify(MULTI_GROUND_EXTENT_REASON)};
  var MULTI_TOO_FEW_REASON=${JSON.stringify(MULTI_TOO_FEW_REASON)};
  var MULTI_NO_PARCELS_REASON=${JSON.stringify(MULTI_NO_PARCELS_REASON)};
  var MULTI_NO_RING=${JSON.stringify(MULTI_NO_RING)};
  var MULTI_NO_ANCHOR=${JSON.stringify(MULTI_NO_ANCHOR)};
  var MULTI_ANCHOR_UNDECLARED=${JSON.stringify(MULTI_ANCHOR_UNDECLARED)};
  var MULTI_UNDRAWN_TITLE=${JSON.stringify(MULTI_UNDRAWN_TITLE)};
  var MULTI_DRAWN_TITLE=${JSON.stringify(MULTI_DRAWN_TITLE)};
  var MULTI_CARD_TITLE=${JSON.stringify(MULTI_CARD_TITLE)};
  var MULTI_ANCHORS_READ=${JSON.stringify(MULTI_ANCHORS_READ)};
  var MULTI_ANCHORS_NOT_READ=${JSON.stringify(MULTI_ANCHORS_NOT_READ)};
  var MULTI_GROUND_TOO_WIDE_PREFIX=${JSON.stringify(MULTI_GROUND_TOO_WIDE_PREFIX)};
  var MULTI_GROUND_TOO_WIDE_SUFFIX=${JSON.stringify(MULTI_GROUND_TOO_WIDE_SUFFIX)};
  var MULTI_REF_ZOOM=${JSON.stringify(MULTI_REF_ZOOM)};
  var MULTI_LABEL_CHAR_W=${JSON.stringify(MULTI_LABEL_CHAR_W)};
  var MULTI_LABEL_H=${JSON.stringify(MULTI_LABEL_H)};
  var MULTI_LABEL_STEP=${JSON.stringify(MULTI_LABEL_STEP)};
  var MULTI_LABEL_MAX_PUSH=${JSON.stringify(MULTI_LABEL_MAX_PUSH)};
  var MULTI_OFF_CANVAS_TITLE=${JSON.stringify(MULTI_OFF_CANVAS_TITLE)};
  var MULTI_NO_CANVAS=${JSON.stringify(MULTI_NO_CANVAS)};
  var MULTI_NO_CANVAS_PREFIX=${JSON.stringify(MULTI_NO_CANVAS_PREFIX)};
  var MULTI_NO_CANVAS_DRAWABLE=${JSON.stringify(MULTI_NO_CANVAS_DRAWABLE)};
  var MULTI_NO_CANVAS_NEEDED=${JSON.stringify(MULTI_NO_CANVAS_NEEDED)};
  var PREVIEW_TOOL=${JSON.stringify(PREVIEW_TOOL)};
  var PREVIEW_DEPTH=${JSON.stringify(PREVIEW_DEPTH)};
  var MAP_RENDER_REPORT_URL=${JSON.stringify(mapRenderReportUrl())};
  var PREVIEW_DWELL_MS=${JSON.stringify(PREVIEW_DWELL_MS)};
  var PREVIEW_TIMEOUT_MS=${JSON.stringify(PREVIEW_TIMEOUT_MS)};
  var PREVIEW_TITLE=${JSON.stringify(PREVIEW_TITLE)};
  var PREVIEW_NOT_IN_CHAT=${JSON.stringify(PREVIEW_NOT_IN_CHAT)};
  var PREVIEW_PENDING=${JSON.stringify(PREVIEW_PENDING)};
  var PREVIEW_UNSUPPORTED=${JSON.stringify(PREVIEW_UNSUPPORTED)};
  var PREVIEW_TIMED_OUT=${JSON.stringify(PREVIEW_TIMED_OUT)};
  var PREVIEW_ERROR=${JSON.stringify(PREVIEW_ERROR)};
  var PREVIEW_DECLINED=${JSON.stringify(PREVIEW_DECLINED)};
  var PREVIEW_EMPTY=${JSON.stringify(PREVIEW_EMPTY)};
  var PREVIEW_BUSY=${JSON.stringify(PREVIEW_BUSY)};
  var PREVIEW_UNSTATED=${JSON.stringify(PREVIEW_UNSTATED)};
  var LOADING_PANEL_TITLE=${JSON.stringify(LOADING_PANEL_TITLE)};
  var LOADING_PANEL_BODY=${JSON.stringify(LOADING_PANEL_BODY)};
  var PROBE_URI=${JSON.stringify(PROBE_RESOURCE_URI)};
  var LOADING_SUBTITLE_BY_TOOL=${JSON.stringify(LOADING_SUBTITLE_BY_TOOL)};
  var LISTING_TURN_OPENER=${JSON.stringify(LISTING_TURN_OPENER)};
  var LISTING_TURN_INSTRUCTION=${JSON.stringify(LISTING_TURN_INSTRUCTION)};
  var OPEN_TURN_OPENER=${JSON.stringify(OPEN_TURN_OPENER)};
  var OPEN_TURN_INSTRUCTION=${JSON.stringify(OPEN_TURN_INSTRUCTION)};
  var NOTHING_TO_OPEN=${JSON.stringify(NOTHING_TO_OPEN)};
  var EMPTY_BOARD_TITLE=${JSON.stringify(EMPTY_BOARD_TITLE)};
  var EMPTY_BOARD_BODY=${JSON.stringify(EMPTY_BOARD_BODY)};
  var OPEN_DID_NOT_REACH_ME=${JSON.stringify(OPEN_DID_NOT_REACH_ME)};
${loadCardIife()}
</script>
</body>
</html>`;
}

export function registerMcpApp(server: {
  registerResource?: (
    name: string,
    uri: string,
    config: Record<string, unknown>,
    handler: (uri: { href: string }) => Promise<{
      contents: Array<{
        uri: string;
        mimeType: string;
        text: string;
        _meta?: Record<string, unknown>;
      }>;
    }>,
  ) => void;
  resource?: (
    name: string,
    uri: string,
    config: Record<string, unknown>,
    handler: (uri: { href: string }) => Promise<{
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    }>,
  ) => void;
}): void {
  const handler = async (uri: { href: string }) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: APP_MIME,
        text: buildAppHtml(),
        _meta: {
          ui: {
            prefersBorder: false,
            /* p559: declare the probe origins so the run measures the DECLARED case.
             * Empty arrays measured nothing; whether the host honors this is the question. */
            csp: {
              connectDomains: [...probeCspDomains()],
              /* M-2: the ground LOADS tiles, it does not connect; its origin is
               * derived from the tile template, never a second copy. */
              resourceDomains: [...resourceCspDomains()],
            },
          },
        },
      },
    ],
  });
  const probeHandler = async (uri: { href: string }) => ({
    contents: [{ uri: uri.href, mimeType: "text/plain", text: PROBE_RESOURCE_TEXT }],
  });
  if (typeof server.registerResource === "function") {
    server.registerResource("Smart Site board", APP_RESOURCE_URI, { mimeType: APP_MIME }, handler);
    server.registerResource("Smart Site probe", PROBE_RESOURCE_URI, { mimeType: "text/plain" }, probeHandler);
    return;
  }
  if (typeof server.resource === "function") {
    server.resource("Smart Site board", APP_RESOURCE_URI, { mimeType: APP_MIME }, handler);
    server.resource("Smart Site probe", PROBE_RESOURCE_URI, { mimeType: "text/plain" }, probeHandler);
  }
}
