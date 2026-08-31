/**
 * P-91: the SERVED iframe script under test.
 *
 * Extracts the <script> from buildAppHtml(), runs it under node:vm with a fake
 * DOM, fake timers, and a captured parent.postMessage, then drives it with
 * recorded host messages. Every sentence in the build plan's 4.4 table is
 * asserted on the painted root.innerHTML. Promoted from the two deep-dive
 * harnesses in doc_repo _inbox (2026-08-29_p91_iframe_instrument.mjs and
 * 2026-08-29_p91_iframe_harness.mts). The exported twin is never rendered here.
 *
 * v2 (P-91 D1 D2 D3 D4 D7): the fake DOM grew a flat tag parser so elements
 * painted into root.innerHTML can be found (querySelectorAll on [attr], tag,
 * #id, .class), listened to (addEventListener), and driven (dispatch(type),
 * bubbling for click and pointerdown, none for pointerenter/leave). A child's
 * setAttribute and innerHTML write back into root.innerHTML, so every
 * assertion below still reads the painted html, never a side channel.
 */
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import * as app from "../src/mcp-app.js";

/*
 * Plan 4.4 sentences, literal on purpose. Two derivations: the plan text here,
 * the module constants there. A constant edited to other words fails here.
 */
const COPY = {
  dead: "Open did not reach me",
  sent: "Sent to chat. Press Send to open.",
  absent: (county: string) => `Not on file in ${county}`,
  absentPrefix: "Not on file in",
  unbaked: (id: string) => `No baked snapshot yet for ${id}`,
  unbakedPrefix: "No baked snapshot yet for",
  refused: "Upgrade to open this parcel",
  unreadable: "Result not readable",
  empty: "No screen yet",
  nothingToOpen: "Nothing to open until this resolves",
  nodeUnresolved: "node unresolved",
  railsPartlyUnread: "Some rails on this screen were not read",
  acrossRow: "across the right of way",
  tipHint: "Point at a property line to read it. Click a line to keep it.",
  unitRef: "unit reference",
};
const OPEN_DEAD_MS = 12000;
const ALL_SENTENCES = [
  COPY.dead,
  COPY.sent,
  COPY.absentPrefix,
  COPY.unbakedPrefix,
  COPY.refused,
  COPY.unreadable,
  COPY.empty,
];

const GOLD = {
  parcelNodeId: "48021:34137",
  draw: {
    label: "908 PINE , BASTROP, TX 78602",
    ring: [
      [48.6, 83.94],
      [-50.37, 83.7],
      [-49.07, -84.28],
      [50.84, -83.36],
    ],
    edges: [{ i: 1, role: "side", ft: 167.99, neighbor: "48021:34169" }],
    overlays: [
      { id: "flood", state: "present", label: "Zone X" },
      { id: "envelope", state: "refused", reason: "atom_path_pending", label: "Buildable envelope not computed" },
    ],
  },
};

/*
 * P-91 v2 node-depth fixtures in the p557/p542 wire shape (api-server
 * parcelDrawStub.ts: frame, ring, edges with seg/ft/bearing/adjacency/
 * roadNode/roadClass/neighbor, attrs.zoning, overlays with sfha and draw;
 * brief.sections[] with citations). Ids, districts, jurisdictions, flood zones
 * and SFHA flags are the fixture doc's (2026-08-30_p91_fixture_set_bastrop.md).
 * Gold's ring, ft and road nodes are the recorded v1 fixture. Every other
 * coordinate, bearing and roadClass is a SYNTHETIC test input, never a parcel
 * fact: the tests assert that what is painted equals what is in the fixture
 * (I7), not that any number is true of Bastrop.
 */
const ZONING_URL = "https://gis.example.test/bastrop/zoning/layer/0";
const ZONING_SECTION = {
  id: "zoning",
  disposition: "present",
  data: { district: "SF-1" },
  citations: ["http://plain.example.test/first", ZONING_URL, "https://gis.example.test/second"],
};
const FLOOD_SECTION = { id: "flood", disposition: "present", data: {}, citations: [], citationsDegraded: true };
const ENVELOPE = {
  id: "envelope",
  label: "Buildable envelope not computed",
  geom: "none",
  draw: "suppress-setback-line",
  state: "refused",
  reason: "atom_path_pending",
};
const FRAME = { units: "ft", origin: "centroid", yAxis: "true-north", convertedFrom: "local-enu-m", factor: "us-survey-foot", quality: "gis-approximate" };
const GOLD_NODE = {
  parcelNodeId: "48021:34137",
  brief: { sections: [ZONING_SECTION, FLOOD_SECTION] },
  draw: {
    label: "908 PINE , BASTROP, TX 78602",
    frame: FRAME,
    ring: [
      [48.6, 83.94],
      [-50.37, 83.7],
      [-49.07, -84.28],
      [50.84, -83.36],
    ],
    edges: [
      { id: "e0", role: "rear", seg: [0, 1], ft: 98.98, bearing: "S 89°52' W", adjacency: "alley", roadNode: "48021:road:925036023", roadClass: "alley", state: "present" },
      { id: "e1", role: "side", seg: [1, 2], ft: 167.99, bearing: "S 0°27' W", adjacency: "neighbor-parcel", roadNode: null, neighbor: "48021:34169", state: "present" },
      { id: "e2", role: "front", seg: [2, 3], ft: 99.92, bearing: "N 89°28' E", adjacency: "ROW", roadNode: "48021:road:15113284", roadClass: "local", neighbor: "48021:34121", state: "present" },
      { id: "e3", role: "side_corner", seg: [3, 0], ft: 167.32, bearing: "N 0°45' W", adjacency: "ROW", roadNode: "48021:road:129017865", roadClass: "local", state: "present" },
    ],
    attrs: { zoning: { v: "SF-1", jurisdiction: "bastrop_city_tx", state: "present" } },
    overlays: [
      { id: "flood", label: "Zone X 0.2 PCT ANNUAL CHANCE FLOOD HAZARD", sfha: false, scope: "parcel-wide", geom: "none", draw: "tint-ring", state: "present", citations: [], citationsDegraded: true },
      { id: "footprint", label: "Structure of record (1910), footprint unmeasured", geom: "none", draw: "hatch-interior", state: "unknown" },
      ENVELOPE,
    ],
  },
};
/* 907 Chestnut: eight edges, GC. Ring synthetic (octagon, about 140 ft across). */
const NODE_34121 = {
  parcelNodeId: "48021:34121",
  brief: { sections: [{ ...ZONING_SECTION, data: { district: "GC" }, citations: [ZONING_URL] }, FLOOD_SECTION] },
  draw: {
    label: "907 CHESTNUT ST , BASTROP, TX 78602",
    frame: FRAME,
    ring: [[70, 30], [30, 70], [-30, 70], [-70, 30], [-70, -30], [-30, -70], [30, -70], [70, -30]],
    edges: [
      { id: "c0", role: "front", seg: [0, 1], ft: 56.57, bearing: "N 45°00' W", adjacency: "ROW", roadNode: "48021:road:15113284", roadClass: "local", state: "present" },
      { id: "c1", role: "side", seg: [1, 2], ft: 60, bearing: "S 90°00' W", adjacency: "neighbor-parcel", roadNode: null, neighbor: "48021:34137", state: "present" },
      { id: "c2", role: "side", seg: [2, 3], ft: 56.57, bearing: "S 45°00' W", adjacency: "neighbor-parcel", roadNode: null, neighbor: "48021:34169", state: "present" },
      { id: "c3", role: "side", seg: [3, 4], ft: 60, bearing: "S 0°00' E", adjacency: "unmapped", roadNode: null, state: "present" },
      { id: "c4", role: "rear", seg: [4, 5], ft: 56.57, bearing: "S 45°00' E", adjacency: "alley", roadNode: "48021:road:925036023", roadClass: "alley", state: "present" },
      { id: "c5", role: "rear", seg: [5, 6], ft: 60, bearing: "N 90°00' E", adjacency: "neighbor-parcel", roadNode: null, neighbor: "48021:34153", state: "present" },
      { id: "c6", role: "side", seg: [6, 7], ft: 56.57, bearing: "N 45°00' E", adjacency: "neighbor-parcel", roadNode: null, neighbor: "48021:34161", state: "present" },
      { id: "c7", role: "side_corner", seg: [7, 0], ft: 60, bearing: "N 0°00' W", adjacency: "ROW", roadNode: "48021:road:129017865", roadClass: "minor collector", neighbor: "48021:35105", state: "present" },
    ],
    attrs: { zoning: { v: "GC", jurisdiction: "bastrop_city_tx", state: "present" } },
    overlays: [
      { id: "flood", label: "Zone X 0.2 PCT ANNUAL CHANCE FLOOD HAZARD", sfha: false, scope: "parcel-wide", geom: "none", draw: "tint-ring", state: "present", citations: [], citationsDegraded: true },
      ENVELOPE,
    ],
  },
};
/* 1207 Fayette: Zone A inside the SFHA. Ring synthetic. */
const NODE_32243 = {
  parcelNodeId: "48021:32243",
  brief: { sections: [{ ...ZONING_SECTION, citations: [ZONING_URL] }, FLOOD_SECTION] },
  draw: {
    label: "1207 FAYETTE ST , BASTROP, TX 78602",
    frame: FRAME,
    ring: [[40, 60], [-40, 60], [-40, -60], [40, -60]],
    edges: [
      { id: "f0", role: "rear", seg: [0, 1], ft: 80, bearing: "S 90°00' W", adjacency: "unmapped", roadNode: null, state: "present" },
      { id: "f1", role: "side", seg: [1, 2], ft: 120, bearing: "S 0°00' E", adjacency: "unmapped", roadNode: null, state: "present" },
      { id: "f2", role: "front", seg: [2, 3], ft: 80, bearing: "N 90°00' E", adjacency: "ROW", roadNode: "48021:road:900000001", roadClass: "local", state: "present" },
      { id: "f3", role: "side", seg: [3, 0], ft: 120, bearing: "N 0°00' W", adjacency: "unmapped", roadNode: null, state: "present" },
    ],
    attrs: { zoning: { v: "SF-1", jurisdiction: "bastrop_city_tx", state: "present" } },
    overlays: [
      { id: "flood", label: "Zone A", sfha: true, scope: "parcel-wide", geom: "none", draw: "tint-ring", state: "present", citations: [], citationsDegraded: true },
      ENVELOPE,
    ],
  },
};
/* 145 Hasler Shores: AE floodway, eleven vertices. Ring synthetic (about 250 ft across). */
const NODE_49295 = {
  parcelNodeId: "48021:49295",
  brief: { sections: [{ ...ZONING_SECTION, citations: [ZONING_URL] }, FLOOD_SECTION] },
  draw: {
    label: "145 HASLER SHORES DR , BASTROP, TX 78602",
    frame: FRAME,
    ring: [[125, 20], [90, 60], [40, 80], [-20, 85], [-80, 70], [-125, 30], [-120, -30], [-70, -70], [0, -85], [70, -75], [120, -35]],
    edges: Array.from({ length: 11 }, (_, i) => ({
      id: `h${i}`,
      role: i === 0 ? "front" : "side",
      seg: [i, (i + 1) % 11],
      ft: 50 + i,
      bearing: `N ${i}°00' E`,
      adjacency: i === 0 ? "ROW" : i < 5 ? "neighbor-parcel" : "unmapped",
      roadNode: i === 0 ? "48021:road:900000002" : null,
      ...(i === 0 ? { roadClass: "local" } : {}),
      ...(i > 0 && i < 5 ? { neighbor: `48021:4929${i}` } : {}),
      state: "present",
    })),
    attrs: { zoning: { v: "SF-1", jurisdiction: "bastrop_city_tx", state: "present" } },
    overlays: [
      { id: "flood", label: "Zone AE FLOODWAY", sfha: true, scope: "parcel-wide", geom: "none", draw: "tint-ring", state: "present", citations: [], citationsDegraded: true },
      ENVELOPE,
    ],
  },
};
/* 927 Main: X minimal, GC, 28 ft frontage. Ring synthetic. */
const NODE_33223 = {
  parcelNodeId: "48021:33223",
  brief: { sections: [{ ...ZONING_SECTION, data: { district: "GC" }, citations: [ZONING_URL] }, FLOOD_SECTION] },
  draw: {
    label: "927 MAIN ST , BASTROP, TX 78602",
    frame: FRAME,
    ring: [[14, 60], [-14, 60], [-14, -60], [14, -60]],
    edges: [
      { id: "m0", role: "rear", seg: [0, 1], ft: 28, bearing: "S 90°00' W", adjacency: "alley", roadNode: "48021:road:900000003", roadClass: "alley", state: "present" },
      { id: "m1", role: "side", seg: [1, 2], ft: 120, bearing: "S 0°00' E", adjacency: "unmapped", roadNode: null, state: "present" },
      { id: "m2", role: "front", seg: [2, 3], ft: 28, bearing: "N 90°00' E", adjacency: "ROW", roadNode: "48021:road:900000004", roadClass: "minor collector", state: "present" },
      { id: "m3", role: "side", seg: [3, 0], ft: 120, bearing: "N 0°00' W", adjacency: "unmapped", roadNode: null, state: "present" },
    ],
    attrs: { zoning: { v: "GC", jurisdiction: "bastrop_city_tx", state: "present" } },
    overlays: [
      { id: "flood", label: "Zone X AREA OF MINIMAL FLOOD HAZARD", sfha: false, scope: "parcel-wide", geom: "none", draw: "tint-ring", state: "present", citations: [], citationsDegraded: true },
      ENVELOPE,
    ],
  },
};

type Json = Record<string, unknown>;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function goldWith(mutate: (draw: Json, body: Json) => void): Json {
  const body = clone(GOLD_NODE) as unknown as Json;
  mutate(body.draw as Json, body);
  return body;
}
const GOLD_NO_FT = goldWith((d) => {
  delete (d.edges as Json[])[1]!.ft;
});
const GOLD_NO_ZONING = goldWith((d) => {
  d.attrs = {};
});
const GOLD_ZONING_UNKNOWN = goldWith((d) => {
  d.attrs = { zoning: { v: "SF-1", jurisdiction: "bastrop_city_tx", state: "unknown" } };
});
const GOLD_HTTP_ONLY = goldWith((_d, b) => {
  b.brief = { sections: [{ ...ZONING_SECTION, citations: ["http://plain.example.test/only"] }] };
});
const GOLD_NO_BRIEF = goldWith((_d, b) => {
  delete b.brief;
});
const GOLD_NO_UNITS = goldWith((d) => {
  d.frame = { origin: "centroid", yAxis: "true-north", quality: "gis-approximate" };
});
const GOLD_NO_FRAME = goldWith((d) => {
  delete d.frame;
});
const GOLD_MU = goldWith((d) => {
  d.attrs = { zoning: { v: "MU", jurisdiction: "bastrop_city_tx", state: "present" } };
});
const GOLD_PDD = goldWith((d) => {
  d.attrs = { zoning: { v: "PDD", jurisdiction: "bastrop_city_tx", state: "present" } };
});

/*
 * P-91 v2 facts and actions (S7). Brief sections in the p543/p558 wire shape
 * (r1BriefCompose: id, title, data, citations, asOf, disposition, reason,
 * refusal, citationsDegraded, zoneExposureSummary, agentGuidance; the MCP
 * normalizer keeps an explicit disposition) and overlays carrying the F5
 * provenance/vintage pair. Ids, districts, flood zones, SFHA flags, the
 * NFHL vintage label and the refusal codes are the fixture doc's and the
 * producers' own enums. Every asOf instant, adapter name, elevation,
 * citation URL and neighbor id below is a SYNTHETIC test input, never a
 * parcel fact: the tests assert that what is painted equals what is on the
 * wire, and that nothing is painted that is not.
 */
const ZONING_URL_2 = "https://gis.example.test/second";
const FLOOD_URL = "https://msc.example.test/nfhl/48021";
const PIPE_URL = "https://rrc.example.test/pipelines/48021";
const AS_OF = "2026-08-29T10:00:00.000Z";
const ENVELOPE_REFUSAL = {
  state: "refused",
  code: "declined-in-bake",
  producer: "baked-envelope-facet",
  supersededBy: "buildable-envelope",
  declineReason: "no-zoning-stamp",
  reason: "Buildable envelope was declined in bake: no-zoning-stamp.",
};
const ENVELOPE_GUIDANCE = "Setbacks and buildable envelope are refused on this read path. Do not invent distances or polygons.";
const DRAINAGE_REASON = "drainage facet not produced for this parcel";
const FLOOD_DATA_GOLD = {
  state: "present",
  inSpecialFloodHazardArea: false,
  floodZone: "X",
  zoneSubtype: "0.2 PCT ANNUAL CHANCE FLOOD HAZARD",
  baseFloodElevation: null,
  sourceAdapter: "adapter:flood-test",
  sourceVintage: "NFHL_48_20260101",
  evaluatedAt: AS_OF,
};
const FLOOD_DATA_49295 = { ...FLOOD_DATA_GOLD, inSpecialFloodHazardArea: true, floodZone: "AE", zoneSubtype: "FLOODWAY", baseFloodElevation: 372.5 };
const FLOOD_SUMMARY = "Zone X shaded: outside the SFHA; 0.2 percent annual chance.";
const SECTION_ZONING = {
  id: "zoning",
  title: "Zoning",
  disposition: "present",
  data: { district: "SF-1", sourceAdapter: "adapter:zoning-test" },
  citations: ["http://plain.example.test/first", ZONING_URL, ZONING_URL_2],
  asOf: AS_OF,
};
const SECTION_ENVELOPE = {
  id: "setbacks-envelope",
  title: "Setbacks and buildable envelope",
  disposition: "refused",
  data: null,
  refusal: ENVELOPE_REFUSAL,
  citations: [],
  asOf: AS_OF,
  agentGuidance: ENVELOPE_GUIDANCE,
};
const SECTION_FLOOD = { id: "flood", title: "Flood hazard", disposition: "present", data: FLOOD_DATA_GOLD, citations: [], asOf: AS_OF, citationsDegraded: true, zoneExposureSummary: null };
const SECTION_LAND_USE = {
  id: "land-use",
  title: "Land use",
  disposition: "absent",
  data: { state: "absent", sourceAdapter: "adapter:landuse-test", sourceVintage: "2026-07" },
  citations: [],
  asOf: AS_OF,
};
const SECTION_DRAINAGE = { id: "drainage", title: "Drainage", disposition: "unread", data: null, citations: [], asOf: AS_OF, reason: DRAINAGE_REASON };
const FACTS_SECTIONS = [SECTION_ZONING, SECTION_ENVELOPE, SECTION_FLOOD, SECTION_LAND_USE, SECTION_DRAINAGE];
const OVERLAY_PIPELINE = { id: "pipeline", label: "No pipeline within 500 ft", geom: "none", draw: "legend-only", state: "absent-verified", provenance: "present", vintage: "2026-06", citations: [PIPE_URL] };
/* a stray claim: absent-verified with neither provenance nor vintage; the panel refuses to trust it (F5) */
const OVERLAY_SPECIAL_DISTRICT = { id: "special-district", label: "No special district of record", geom: "none", draw: "legend-only", state: "absent-verified" };
/* the writer already downgraded this one and said why */
const OVERLAY_WELL = { id: "well", label: "Well record not verified", geom: "none", draw: "legend-only", state: "unknown", reason: "provenance unknown; vintage unknown" };
const FACTS_OVERLAYS = [...GOLD_NODE.draw.overlays, OVERLAY_PIPELINE, OVERLAY_SPECIAL_DISTRICT, OVERLAY_WELL];
function factsWith(mutate: (draw: Json, body: Json) => void): Json {
  return goldWith((d, b) => {
    b.brief = { sections: clone(FACTS_SECTIONS) };
    d.overlays = clone(FACTS_OVERLAYS);
    mutate(d, b);
  });
}
const GOLD_FACTS = factsWith(() => {});
const GOLD_FACTS_NO_ASOF = factsWith((_d, b) => {
  delete ((b.brief as Json).sections as Json[])[0]!.asOf;
});
const GOLD_FACTS_VINTAGE_ONLY = factsWith((d) => {
  (d.overlays as Json[])[4] = { ...OVERLAY_SPECIAL_DISTRICT, vintage: "2026-05" };
});
const GOLD_FACTS_DEGRADED = factsWith((d) => {
  (d.overlays as Json[])[4] = { ...OVERLAY_SPECIAL_DISTRICT, provenance: "degraded", vintage: "UNKNOWN", reason: "provenance degraded; vintage unknown" };
});
const GOLD_FACTS_FLOOD_SUMMARY = factsWith((_d, b) => {
  ((b.brief as Json).sections as Json[])[2] = { ...SECTION_FLOOD, citations: [FLOOD_URL], citationsDegraded: false, zoneExposureSummary: FLOOD_SUMMARY };
});
const GOLD_FACTS_FLOOD_UNREAD = factsWith((_d, b) => {
  ((b.brief as Json).sections as Json[])[2] = { id: "flood", title: "Flood hazard", disposition: "unread", data: null, citations: [], asOf: AS_OF, reason: "flood facet not read" };
});
const GOLD_FACTS_FLOOD_ABSENT = factsWith((_d, b) => {
  ((b.brief as Json).sections as Json[])[2] = { id: "flood", title: "Flood hazard", disposition: "absent", data: { state: "absent", sourceAdapter: "adapter:flood-test", sourceVintage: "NFHL_48_20260101" }, citations: [], asOf: AS_OF };
});
const GOLD_FACTS_FLOOD_ABSENT_NO_VINTAGE = factsWith((_d, b) => {
  ((b.brief as Json).sections as Json[])[2] = { id: "flood", title: "Flood hazard", disposition: "absent", data: { state: "absent", sourceAdapter: "adapter:flood-test" }, citations: [], asOf: AS_OF };
});
const NODE_49295_FACTS = {
  ...NODE_49295,
  brief: { sections: [{ ...SECTION_ZONING, citations: [ZONING_URL] }, SECTION_ENVELOPE, { ...SECTION_FLOOD, data: FLOOD_DATA_49295 }, SECTION_LAND_USE, SECTION_DRAINAGE] },
};
const SAVE_STATUSES = ["New", "Watching", "Chasing", "Passed"];

const STUB_SIX = {
  situs: "present",
  zoning: "present",
  landUse: "absent",
  flood: "present",
  drainage: "unknown",
  envelope: "refused",
};
const STUB_SIX_GLYPHS = ["present", "present", "absent-verified", "present", "unknown", "refused"];
const ALL_UNREAD = ["unread", "unread", "unread", "unread", "unread", "unread"];
const BOARD = {
  id: "screen-1",
  stubsDegraded: true,
  rows: [
    { query: "908 Pine, Bastrop TX", parcelNodeId: "48021:34137", resolution: "resolved", stub: STUB_SIX, stubRead: "ok" },
    { query: "111 Rainmaker Cv, Bastrop TX", parcelNodeId: "48021:34169", resolution: "resolved", stubRead: "skipped" },
    { query: "zzzz-not-a-situs-99999", parcelNodeId: null, resolution: "unresolved" },
  ],
};
const MISS_ABSENT = { parcels: [], notFound: ["48021:900099"], reason: "parcel_not_found", parcelExists: false };
const MISS_UNBAKED = { parcels: [], notFound: ["48021:900099"], reason: "baked_snapshot_not_found", parcelExists: true };
const REFUSED = { parcels: [], notFound: [], refused: [{ parcelNodeId: "48021:34137", reason: "upgrade_required" }] };
const BATCH = {
  parcels: [
    {
      parcelNodeId: "48021:34137",
      label: "908 PINE , BASTROP, TX 78602",
      url: "https://smartsite.cloud/p/48021:34137",
      stub: STUB_SIX,
    },
  ],
  notFound: ["48021:900099"],
};
/*
 * Verbatim get_smart_site batch result from production p555/p542, 2026-08-30.
 * The six rails are FLAT on each parcel record; there is no stub key on the wire.
 * Kept as the exact string so the served script parses what production sends.
 */
const LIVE_BATCH =
  '{"parcels":[{"parcelNodeId":"48021:34137","label":"908 PINE , BASTROP, TX 78602","url":"https://smartsite.cloud/p/48021:34137","situs":"present","zoning":"present","landUse":"unknown","flood":"present","drainage":"unread","envelope":"refused"},{"parcelNodeId":"48021:8720522","label":"111 RAINMAKER CV, BASTROP, TX 78602","url":"https://smartsite.cloud/p/48021:8720522","situs":"present","zoning":"present","landUse":"unknown","flood":"present","drainage":"unread","envelope":"refused"}],"notFound":["48021:900099"]}';
const LIVE_GLYPHS = ["present", "present", "unknown", "present", "unread", "refused"];

/* The ten divergence fixtures from the deep-dive harness plus the new kinds. */
const PARITY: Record<string, unknown> = {
  liveBatch: LIVE_BATCH,
  legacyMiss: { parcels: [], notFound: ["48021:900099"] },
  idFallback: { rows: [{ query: "a", id: "48021:1" }] },
  absentState: { rows: [{ query: "a", parcelNodeId: "48021:1", stub: { situs: "absent" } }] },
  emptyRow: { rows: [{}] },
  capsResolution: { rows: [{ query: "q", parcelNodeId: "48021:1", resolution: "Resolved" }] },
  junkState: { rows: [{ query: "q", parcelNodeId: "48021:1", stub: { situs: "pending" } }] },
  stringStub: { rows: [{ query: "q", parcelNodeId: "48021:1", stub: "present" }] },
  nanRing: { parcelNodeId: "48021:1", draw: { ring: [[1, 2], [NaN, 3], [4, 5]], overlays: [] } },
  numericId: { id: 7, rows: [{ query: "q", parcelNodeId: "48021:1" }] },
  overlayNoLabel: { parcelNodeId: "48021:1", draw: { overlays: [{ id: 5, state: 3 }] } },
  gold: GOLD,
  board: BOARD,
  missAbsent: MISS_ABSENT,
  missUnbaked: MISS_UNBAKED,
  missUnmeasured: { ...MISS_UNBAKED, parcelExists: "unmeasured" },
  missUnstated: { parcels: [], notFound: ["48021:1"], reason: "something_else" },
  refused: REFUSED,
  refusedOther: { parcels: [], refused: [{ parcelNodeId: "48021:1", reason: "quota" }, { nope: 1 }] },
  batch: BATCH,
  garbage: "not json",
  jsonArray: "[1,2]",
  jsonNull: "null",
  rowsNotArray: { rows: "abc" },
  overlaysNotArray: { parcelNodeId: "48021:1", draw: { ring: [[0, 0], [1, 0], [1, 1]], overlays: "x" } },
  savedOnly: { savedProperties: [{ id: "x", parcelNodeId: "48021:34137", label: "gold" }] },
  screensOnly: { screens: [{ id: "s1" }] },
  emptyBatch: { parcels: [], notFound: [] },
  screenWrapped: { screen: { id: "s2", stubsDegraded: false, rows: [{ query: "q", parcelNodeId: "48021:2", resolution: "ambiguous" }] } },
  /* v2 node-depth shapes */
  goldNode: GOLD_NODE,
  node34121: NODE_34121,
  node32243: NODE_32243,
  node49295: NODE_49295,
  node33223: NODE_33223,
  goldNoFt: GOLD_NO_FT,
  goldNoZoning: GOLD_NO_ZONING,
  goldZoningUnknown: GOLD_ZONING_UNKNOWN,
  goldHttpOnly: GOLD_HTTP_ONLY,
  goldNoBrief: GOLD_NO_BRIEF,
  goldNoUnits: GOLD_NO_UNITS,
  goldNoFrame: GOLD_NO_FRAME,
  batchNode: { parcels: [{ parcelNodeId: "48021:34137", brief: GOLD_NODE.brief, draw: GOLD_NODE.draw }] },
  briefNotObject: { ...GOLD_NODE, brief: "x" },
  sectionsNotArray: { ...GOLD_NODE, brief: { sections: {} } },
  citationsNotStrings: { ...GOLD_NODE, brief: { sections: [{ id: "zoning", citations: [7, null, { url: "https://x" }] }] } },
  attrsNotObject: { parcelNodeId: "48021:1", draw: { ...GOLD_NODE.draw, attrs: "zoned" } },
  zoningNotObject: { parcelNodeId: "48021:1", draw: { ...GOLD_NODE.draw, attrs: { zoning: "SF-1" } } },
  frameNotObject: { parcelNodeId: "48021:1", draw: { ...GOLD_NODE.draw, frame: "ft" } },
  sfhaString: { parcelNodeId: "48021:1", draw: { ...GOLD_NODE.draw, overlays: [{ id: "flood", state: "present", label: "Zone A", sfha: "true", draw: "tint-ring" }] } },
  drawNumber: { parcelNodeId: "48021:1", draw: { ...GOLD_NODE.draw, overlays: [{ id: "flood", state: "present", label: "Zone A", sfha: true, draw: 4 }] } },
  /* v2 facts and actions shapes (S7) */
  goldFacts: GOLD_FACTS,
  goldFactsNoAsOf: GOLD_FACTS_NO_ASOF,
  goldFactsVintageOnly: GOLD_FACTS_VINTAGE_ONLY,
  goldFactsDegraded: GOLD_FACTS_DEGRADED,
  goldFactsFloodSummary: GOLD_FACTS_FLOOD_SUMMARY,
  goldFactsFloodUnread: GOLD_FACTS_FLOOD_UNREAD,
  goldFactsFloodAbsent: GOLD_FACTS_FLOOD_ABSENT,
  goldFactsFloodAbsentNoVintage: GOLD_FACTS_FLOOD_ABSENT_NO_VINTAGE,
  node49295Facts: NODE_49295_FACTS,
  sectionNoId: { ...GOLD_NODE, brief: { sections: [{ disposition: "present", data: {}, asOf: AS_OF }] } },
  sectionNotObject: { ...GOLD_NODE, brief: { sections: ["zoning", 4, null] } },
  refusalNotObject: { ...GOLD_NODE, brief: { sections: [{ ...SECTION_ENVELOPE, refusal: "nope" }] } },
  dataNotObject: { ...GOLD_NODE, brief: { sections: [{ ...SECTION_FLOOD, data: "x" }] } },
  asOfNumber: { ...GOLD_NODE, brief: { sections: [{ ...SECTION_ZONING, asOf: 5 }] } },
  dispositionJunk: { ...GOLD_NODE, brief: { sections: [{ ...SECTION_ZONING, disposition: "Present" }] } },
  provenanceNumber: { parcelNodeId: "48021:1", draw: { ...GOLD_NODE.draw, overlays: [{ ...OVERLAY_PIPELINE, provenance: 1, vintage: 2026, citations: "x" }] } },
  citationsDegradedString: { parcelNodeId: "48021:1", draw: { ...GOLD_NODE.draw, overlays: [{ ...OVERLAY_PIPELINE, citationsDegraded: "true" }] } },
};

type FakeEvent = { type: string; target: FakeEl; currentTarget: FakeEl; preventDefault(): void };
type Listener = (ev: FakeEvent) => void;
type FakeEl = {
  tag: string;
  attrs: Record<string, string>;
  style: Record<string, string>;
  innerHTML: string;
  textContent: string;
  className: string;
  scrollHeight: number;
  disabled: boolean;
  parentNode: FakeEl | null;
  listeners: Record<string, Listener[]>;
  setAttribute(k: string, v: unknown): void;
  getAttribute(k: string): string | null;
  querySelector(sel: string): FakeEl | null;
  querySelectorAll(sel: string): FakeEl[];
  addEventListener(type: string, fn: Listener): void;
  dispatch(type: string): void;
  appendChild(): void;
  closest(sel: string): FakeEl | null;
};

const BUBBLES = new Set(["click", "pointerdown", "pointerup", "pointerover", "pointerout"]);
const SEL_RE = /^([a-zA-Z][\w-]*)?(?:#([\w-]+))?(?:\.([\w-]+))?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/;
const TAG_RE = /<([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*(\/?)>/g;

function unescapeAttr(v: string): string {
  return v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#39;");
}
function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) out[m[1] ?? ""] = unescapeAttr(m[2] ?? "");
  return out;
}
function matches(node: FakeEl, sel: string): boolean {
  const m = SEL_RE.exec(sel);
  if (!m || !sel) throw new Error(`fake DOM: unsupported selector ${sel}`);
  const [, tag, id, cls, attr, val] = m;
  if (tag && node.tag !== tag) return false;
  if (id && node.attrs.id !== id) return false;
  if (cls && !(node.attrs.class ?? "").split(/\s+/).includes(cls)) return false;
  if (attr !== undefined) {
    if (!(attr in node.attrs)) return false;
    if (val !== undefined && node.attrs[attr] !== val) return false;
  }
  return true;
}
function fire(node: FakeEl, ev: FakeEvent): void {
  for (const fn of node.listeners[ev.type] ?? []) fn(ev);
  if (BUBBLES.has(ev.type) && node.parentNode) fire(node.parentNode, ev);
}

/** A container: root, body, boot. Its innerHTML is the source of truth for every child parsed out of it. */
function el(tag = "div"): FakeEl {
  let html = "";
  let cache: FakeEl[] | null = null;
  const node = {
    tag,
    attrs: {} as Record<string, string>,
    style: {} as Record<string, string>,
    textContent: "",
    className: "",
    scrollHeight: 500,
    disabled: false,
    parentNode: null as FakeEl | null,
    listeners: {} as Record<string, Listener[]>,
    setAttribute(k: string, v: unknown) {
      node.attrs[k] = String(v);
    },
    getAttribute(k: string) {
      return k in node.attrs ? (node.attrs[k] as string) : null;
    },
    querySelectorAll(sel: string) {
      if (!cache) cache = [...html.matchAll(TAG_RE)].map((m) => child(node, m[1] ?? "", m[0], parseAttrs(m[2] ?? ""), m[3] === "/"));
      return cache.filter((c) => matches(c, sel));
    },
    querySelector(sel: string) {
      return node.querySelectorAll(sel)[0] ?? null;
    },
    addEventListener(type: string, fn: Listener) {
      (node.listeners[type] ??= []).push(fn);
    },
    dispatch(type: string) {
      fire(node, { type, target: node, currentTarget: node, preventDefault() {} });
    },
    appendChild() {},
    closest(sel: string) {
      return matches(node, sel) ? node : node.parentNode ? node.parentNode.closest(sel) : null;
    },
    /* test-only: a child patches the container's html in place */
    patch(from: string, to: string) {
      const at = html.indexOf(from);
      if (at < 0) throw new Error("fake DOM: child tag no longer in its container");
      html = html.slice(0, at) + to + html.slice(at + from.length);
    },
  };
  Object.defineProperty(node, "innerHTML", {
    get: () => html,
    set: (v: string) => {
      html = v;
      cache = null;
    },
  });
  return node as unknown as FakeEl;
}

/** An element parsed out of a container's html. Attribute writes and innerHTML writes go back into that html. */
function child(root: FakeEl & { patch?(from: string, to: string): void }, tag: string, rawTag: string, attrs: Record<string, string>, selfClose: boolean): FakeEl {
  let raw = rawTag;
  const patch = (from: string, to: string) => {
    if (typeof root.patch !== "function") throw new Error("fake DOM: container cannot patch");
    root.patch(from, to);
  };
  const rebuild = () => {
    const next = `<${tag}${Object.entries(attrs)
      .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
      .join("")}${selfClose ? "/" : ""}>`;
    patch(raw, next);
    raw = next;
  };
  const inner = () => {
    const all = root.innerHTML;
    const at = all.indexOf(raw);
    if (at < 0) throw new Error("fake DOM: child tag no longer in its container");
    const start = at + raw.length;
    const end = all.indexOf(`</${tag}>`, start);
    return { start, end: end < 0 ? start : end };
  };
  const node = {
    tag,
    attrs,
    style: {} as Record<string, string>,
    textContent: "",
    className: attrs.class ?? "",
    scrollHeight: 0,
    disabled: false,
    parentNode: root as FakeEl,
    listeners: {} as Record<string, Listener[]>,
    setAttribute(k: string, v: unknown) {
      attrs[k] = String(v);
      rebuild();
    },
    getAttribute(k: string) {
      return k in attrs ? (attrs[k] as string) : null;
    },
    querySelectorAll(): FakeEl[] {
      throw new Error("fake DOM: nested querySelectorAll is not modelled; query the container");
    },
    querySelector(): FakeEl | null {
      throw new Error("fake DOM: nested querySelector is not modelled; query the container");
    },
    addEventListener(type: string, fn: Listener) {
      (node.listeners[type] ??= []).push(fn);
    },
    dispatch(type: string) {
      fire(node as unknown as FakeEl, { type, target: node as unknown as FakeEl, currentTarget: node as unknown as FakeEl, preventDefault() {} });
    },
    appendChild() {},
    closest(sel: string) {
      return matches(node as unknown as FakeEl, sel) ? (node as unknown as FakeEl) : root.closest(sel);
    },
  };
  Object.defineProperty(node, "innerHTML", {
    get: () => {
      const { start, end } = inner();
      return root.innerHTML.slice(start, end);
    },
    set: (v: string) => {
      const { start, end } = inner();
      const all = root.innerHTML;
      patch(all.slice(start, end), v);
    },
  });
  return node as unknown as FakeEl;
}

export function extractServedScript(html: string): string {
  const start = html.indexOf("<script>");
  const end = html.indexOf("</script>");
  if (start < 0 || end < 0 || end < start) throw new Error("served html has no script block");
  return html.slice(start + "<script>".length, end);
}

type Posted = Record<string, unknown> & { method?: string; id?: unknown; params?: Record<string, unknown> };
type MsgListener = (ev: { data: unknown; source: unknown }) => void;

function fresh() {
  const script = extractServedScript(app.buildAppHtml());
  const boot = el();
  const root = el();
  const body = el("body");
  const docEl = el("html");
  root.parentNode = body;
  let listener: MsgListener | null = null;
  const posted: Posted[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let tid = 0;
  const sandbox: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => (id === "boot" ? boot : id === "root" ? root : null),
      body,
      documentElement: docEl,
      createElement: () => el(),
    },
    parent: {
      postMessage: (m: Posted) => {
        posted.push(m);
      },
    },
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++tid;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    requestAnimationFrame: (fn: () => void) => {
      fn();
      return 0;
    },
    addEventListener: (type: string, fn: MsgListener) => {
      if (type === "message") listener = fn;
    },
    console,
  };
  /* window === the sandbox global, so window.parent is the capture above. */
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  const host = sandbox.parent;
  const deliver = (data: unknown, source: unknown = host) => {
    if (!listener) throw new Error("no message listener bound");
    listener({ data, source });
  };
  const fireMs = (ms: number) => {
    let n = 0;
    for (const [id, t] of [...timers]) {
      if (t.ms === ms) {
        timers.delete(id);
        t.fn();
        n += 1;
      }
    }
    return n;
  };
  const armed = (ms: number) => [...timers.values()].filter((t) => t.ms === ms).length;
  /* what a reader sees: tags gone, the five escapeHtml entities decoded */
  const strip = (html: string) =>
    html
      .replace(/<[^>]+>/g, " ")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
  const text = () => strip(root.innerHTML);
  const init = () =>
    deliver({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2026-01-26", hostCapabilities: { message: {}, serverTools: {} } },
    });
  const toolResult = (payload: unknown, content?: unknown[]) =>
    deliver({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: {
        content: content ?? [
          { type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) },
        ],
      },
    });
  const open = (node: string): Posted | undefined => {
    const ss = sandbox.__ss as { open: (btn: unknown) => void };
    ss.open({ getAttribute: (k: string) => (k === "data-node" ? node : null) });
    return posted.filter((m) => m.method === "ui/message").pop();
  };
  const openButtons = () => (root.innerHTML.match(/data-act="open"/g) ?? []).length;
  /* v2 drawing handles: every one reads or drives elements painted into root.innerHTML */
  const edges = () => root.querySelectorAll("[data-edge]");
  const edge = (i: number) => {
    const n = edges().find((e) => e.getAttribute("data-edge") === String(i));
    if (!n) throw new Error(`no edge ${i} in the drawing`);
    return n;
  };
  const tip = () => {
    const t = root.querySelector("[data-tip]");
    if (!t) throw new Error("no tip element in the drawing");
    return t;
  };
  const tipText = () => strip(tip().innerHTML);
  const hover = (i: number) => edge(i).dispatch("pointerenter");
  const leave = (i: number) => edge(i).dispatch("pointerleave");
  const down = (i: number) => edge(i).dispatch("pointerdown");
  const district = () => root.querySelector("[data-zoning]");
  const openLinks = () => posted.filter((m) => m.method === "ui/open-link");
  /* v2 facts and actions handles (S7): every control is invoked through window.__ss with a painted element or a forged one */
  const ss = () => sandbox.__ss as Record<string, (b?: unknown) => void>;
  const btn = (attrs: Record<string, string>) => ({ getAttribute: (k: string) => (k in attrs ? (attrs[k] as string) : null) });
  const messages = () => posted.filter((m) => m.method === "ui/message");
  const lastText = () => {
    const m = messages().pop();
    const c = m?.params?.content as Array<{ text?: string }> | undefined;
    return c?.[0]?.text ?? null;
  };
  const all = (sel: string) => root.querySelectorAll(sel);
  /* the painted html between two markers; the fake DOM is flat, so a row's contents are read by slicing */
  const segment = (from: string, to: string) => {
    const html = root.innerHTML;
    const a = html.indexOf(from);
    if (a < 0) throw new Error(`no segment start ${from}`);
    const b = html.indexOf(to, a + from.length);
    return html.slice(a, b < 0 ? html.length : b);
  };
  return { boot, root, posted, deliver, fire: fireMs, armed, text, init, toolResult, open, openButtons, sandbox, edges, edge, tip, tipText, hover, leave, down, district, openLinks, ss, btn, messages, lastText, all, segment, strip };
}

function rowGlyphs(html: string, needle: string): string[] {
  const row = html
    .split("<tr")
    .map((seg) => seg.split("</tr>")[0] ?? "")
    .find((seg) => seg.includes(needle));
  if (!row) throw new Error(`no table row containing ${needle}`);
  return [...row.matchAll(/class="g g-([a-z-]+)"/g)].map((m) => m[1] ?? "");
}

describe("served iframe script", () => {
  it("positive control: gold paints the ring, the human envelope reason, and script-ran in the header", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD);
    expect(f.root.innerHTML).toContain('aria-label="parcel ring"');
    expect(f.text()).toContain("48021:34137");
    expect(f.text()).toContain("908 PINE");
    expect(f.text()).toContain("Withheld, setbacks unruled");
    expect(f.root.innerHTML).not.toContain("atom_path_pending");
    expect(f.root.innerHTML).toContain('<span data-script="ran">script-ran</span>');
    expect(f.boot.textContent).toContain("script-ran");
    expect(f.boot.textContent).toContain("handshake=ready");
    expect(f.boot.textContent).toContain("caps=serverTools");
    expect(f.boot.textContent).toContain("message=yes");
    expect(f.boot.textContent).toContain("reply=none");
    expect(f.boot.textContent).toContain("foreign=0");
    for (const s of ALL_SENTENCES) expect(f.text(), s).not.toContain(s);
  });

  it("not vacuous: garbage text paints Result not readable, none of the other sentences, and no ring", () => {
    const f = fresh();
    f.init();
    f.toolResult("not json");
    expect(f.text()).toContain(COPY.unreadable);
    for (const s of ALL_SENTENCES.filter((x) => x !== COPY.unreadable)) {
      expect(f.text(), s).not.toContain(s);
    }
    expect(f.root.innerHTML).not.toContain("parcel ring");
    expect(f.openButtons()).toBe(0);
  });

  it("miss absent: Not on file in the id's county, never a county the prefix does not map to", () => {
    const f = fresh();
    f.init();
    f.toolResult(MISS_ABSENT);
    expect(f.text()).toContain(COPY.absent("Bastrop"));
    expect(f.text()).toContain("48021:900099");
    expect(f.text()).not.toContain(COPY.dead);
    expect(f.text()).not.toContain(COPY.empty);
    expect(f.openButtons()).toBe(0);

    const t = fresh();
    t.init();
    t.toolResult({ ...MISS_ABSENT, notFound: ["48453:1"] });
    expect(t.text()).toContain(COPY.absent("Travis"));
    expect(t.text()).not.toContain("Bastrop");

    const u = fresh();
    u.init();
    u.toolResult({ ...MISS_ABSENT, notFound: ["99999:1"] });
    expect(u.text()).toContain(COPY.absent("this county"));
    expect(u.text()).not.toMatch(/Bastrop|Caldwell|Hays|Travis|Williamson/);
  });

  it("miss unbaked: No baked snapshot yet for the id when it exists or existence is unmeasured; parcelExists false wins as absent", () => {
    for (const exists of [true, "unmeasured"]) {
      const f = fresh();
      f.init();
      f.toolResult({ ...MISS_UNBAKED, parcelExists: exists });
      expect(f.text(), String(exists)).toContain(COPY.unbaked("48021:900099"));
      expect(f.text(), String(exists)).not.toContain(COPY.absentPrefix);
      expect(f.text(), String(exists)).not.toContain(COPY.dead);
      expect(f.text(), String(exists)).not.toContain(COPY.empty);
    }
    const g = fresh();
    g.init();
    g.toolResult({ ...MISS_UNBAKED, parcelExists: false });
    expect(g.text()).toContain(COPY.absent("Bastrop"));
    expect(g.text()).not.toContain(COPY.unbakedPrefix);
  });

  it("refused: Upgrade to open this parcel plus the node id, no Open control", () => {
    const f = fresh();
    f.init();
    f.toolResult(REFUSED);
    expect(f.text()).toContain(COPY.refused);
    expect(f.text()).toContain("48021:34137");
    expect(f.openButtons()).toBe(0);
    expect(f.text()).not.toContain(COPY.absentPrefix);
    expect(f.text()).not.toContain(COPY.dead);
    expect(f.text()).not.toContain(COPY.empty);
  });

  it("unreadable: a missing text part paints Result not readable; a later text part is found by scanning", () => {
    const f = fresh();
    f.init();
    f.toolResult(BOARD);
    f.toolResult(null, [{ type: "image", data: "AAAA", mimeType: "image/png" }]);
    expect(f.text()).toContain(COPY.unreadable);
    expect(f.text()).not.toContain(COPY.empty);
    expect(f.openButtons()).toBe(0);

    const g = fresh();
    g.init();
    g.toolResult(null, [
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "text", text: JSON.stringify(GOLD) },
    ]);
    expect(g.root.innerHTML).toContain('aria-label="parcel ring"');

    const h = fresh();
    h.init();
    h.toolResult(null, []);
    expect(h.text()).toContain(COPY.unreadable);
  });

  it("batch stub: a board with one resolved row per parcel (query = label, rails from stub) and one unresolved row per notFound id", () => {
    const f = fresh();
    f.init();
    f.toolResult(BATCH);
    expect(f.openButtons()).toBe(1);
    expect(f.text()).toContain("908 PINE , BASTROP, TX 78602");
    expect(f.text()).toContain(COPY.nodeUnresolved);
    expect(f.text()).toContain("48021:900099");
    expect(f.text()).toContain(COPY.nothingToOpen);
    expect(rowGlyphs(f.root.innerHTML, 'data-node="48021:34137"')).toEqual(STUB_SIX_GLYPHS);
    expect(rowGlyphs(f.root.innerHTML, "48021:900099")).toEqual(ALL_UNREAD);
    expect(f.text()).not.toContain(COPY.empty);
    expect(f.text()).not.toContain(COPY.absentPrefix);
    expect(f.root.innerHTML).not.toContain("smartsite.cloud");
  });

  it("p556 live batch: flat rails on each parcel paint as glyphs (never six unread), one Open per parcel, node unresolved for the notFound id", () => {
    const f = fresh();
    f.init();
    f.toolResult(LIVE_BATCH);
    expect(f.openButtons()).toBe(2);
    expect(rowGlyphs(f.root.innerHTML, 'data-node="48021:34137"')).toEqual(LIVE_GLYPHS);
    expect(rowGlyphs(f.root.innerHTML, 'data-node="48021:8720522"')).toEqual(LIVE_GLYPHS);
    expect(rowGlyphs(f.root.innerHTML, "48021:900099")).toEqual(ALL_UNREAD);
    expect(f.text()).toContain("908 PINE , BASTROP, TX 78602");
    expect(f.text()).toContain("111 RAINMAKER CV, BASTROP, TX 78602");
    expect(f.text()).toContain(COPY.nodeUnresolved);
    expect(f.text()).toContain(COPY.nothingToOpen);
    expect(f.text()).not.toContain(COPY.empty);
    expect(f.text()).not.toContain(COPY.railsPartlyUnread);
    expect(f.root.innerHTML).not.toContain("smartsite.cloud");
  });

  it("screen: resolved rows carry rails from stub at first paint; a skipped read stays unread; stubsDegraded is declared", () => {
    const f = fresh();
    f.init();
    f.toolResult(BOARD);
    expect(f.openButtons()).toBe(2);
    expect(rowGlyphs(f.root.innerHTML, 'data-node="48021:34137"')).toEqual(STUB_SIX_GLYPHS);
    expect(rowGlyphs(f.root.innerHTML, 'data-node="48021:34169"')).toEqual(ALL_UNREAD);
    expect(f.text()).toContain("situs unresolved");
    expect(f.text()).toContain(COPY.railsPartlyUnread);
    const g = fresh();
    g.init();
    g.toolResult({ ...BOARD, stubsDegraded: false });
    expect(g.text()).not.toContain(COPY.railsPartlyUnread);
  });

  it("board: a {} reply to ui/message paints Sent, clears the 12s timer, keeps the rows; a later result clears the line", () => {
    const f = fresh();
    f.init();
    f.toolResult(BOARD);
    const msg = f.open("48021:34137");
    expect(msg?.method).toBe("ui/message");
    expect(f.armed(OPEN_DEAD_MS)).toBe(1);
    f.deliver({ jsonrpc: "2.0", id: msg?.id, result: {} });
    expect(f.boot.textContent).toContain("reply=ok");
    expect(f.text()).toContain(COPY.sent);
    expect(f.text()).not.toContain(COPY.dead);
    expect(f.openButtons()).toBe(2);
    expect(f.armed(OPEN_DEAD_MS)).toBe(0);
    expect(f.fire(OPEN_DEAD_MS)).toBe(0);
    expect(f.text()).not.toContain(COPY.dead);
    f.toolResult(BOARD);
    expect(f.text()).not.toContain(COPY.sent);
    expect(f.openButtons()).toBe(2);
  });

  it("board: dead only when the host never replies within 12s or replies with a JSON-RPC error", () => {
    const f = fresh();
    f.init();
    f.toolResult(BOARD);
    f.open("48021:34137");
    expect(f.text()).not.toContain(COPY.dead);
    expect(f.fire(OPEN_DEAD_MS)).toBe(1);
    expect(f.text()).toContain(COPY.dead);
    expect(f.text()).not.toContain(COPY.sent);
    expect(f.openButtons()).toBe(2);

    const g = fresh();
    g.init();
    g.toolResult(BOARD);
    const m2 = g.open("48021:34137");
    g.deliver({ jsonrpc: "2.0", id: m2?.id, error: { code: -32600, message: "nope" } });
    expect(g.text()).toContain(COPY.dead);
    expect(g.text()).not.toContain(COPY.sent);
    expect(g.armed(OPEN_DEAD_MS)).toBe(0);
    expect(g.boot.textContent).toContain("reply=-32600");
  });

  it("listener: a foreign source is refused and counted; a bare result.content from the parent is ignored; a prototype key is not a reply", () => {
    const f = fresh();
    f.init();
    f.toolResult(BOARD);
    const before = f.root.innerHTML;
    f.deliver(
      { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: JSON.stringify(GOLD) }] } },
      {},
    );
    expect(f.root.innerHTML).toBe(before);
    expect(f.boot.textContent).toContain("foreign=1");
    f.deliver({ result: { content: [{ type: "text", text: JSON.stringify(GOLD) }] } });
    expect(f.root.innerHTML).toBe(before);
    f.deliver({ jsonrpc: "2.0", id: "constructor", result: { content: [{ type: "text", text: JSON.stringify(GOLD) }] } });
    expect(f.root.innerHTML).toBe(before);
    expect(f.boot.textContent).not.toContain("reply=ok");
    f.toolResult(GOLD);
    expect(f.root.innerHTML).toContain("parcel ring");
    expect(f.boot.textContent).toContain("foreign=1");
  });

  it("sticky: a delivered result never ends as dead-Open, even when rows or overlays are not arrays; a later result clears a dead line", () => {
    const f = fresh();
    f.init();
    f.toolResult(BOARD);
    f.open("48021:34137");
    expect(() => f.toolResult({ rows: "abc" })).not.toThrow();
    expect(f.armed(OPEN_DEAD_MS)).toBe(0);
    expect(f.fire(OPEN_DEAD_MS)).toBe(0);
    expect(f.text()).not.toContain(COPY.dead);

    const g = fresh();
    g.init();
    g.toolResult(BOARD);
    g.open("48021:34137");
    expect(() =>
      g.toolResult({ parcelNodeId: "48021:34137", draw: { ring: [[0, 0], [1, 0], [1, 1]], overlays: "x" } }),
    ).not.toThrow();
    expect(g.armed(OPEN_DEAD_MS)).toBe(0);
    expect(g.root.innerHTML).toContain("parcel ring");

    const h = fresh();
    h.init();
    h.toolResult(BOARD);
    h.open("48021:34137");
    h.fire(OPEN_DEAD_MS);
    expect(h.text()).toContain(COPY.dead);
    h.toolResult(BOARD);
    expect(h.text()).not.toContain(COPY.dead);
    expect(h.text()).not.toContain(COPY.absentPrefix);
  });

  it("escaping: quotes in ids and rail states cannot leave their attribute; unknown states fall to unread", () => {
    const f = fresh();
    f.init();
    f.toolResult({
      id: "s",
      rows: [
        {
          query: "q",
          parcelNodeId: '48021:x" data-pwn="1',
          resolution: "resolved",
          stub: { situs: 'present" onmouseover="alert(1)', zoning: "pending", flood: 7 },
        },
      ],
    });
    expect(f.root.innerHTML).not.toContain('data-pwn="1"');
    expect(f.root.innerHTML).not.toContain('onmouseover="alert(1)"');
    expect(f.root.innerHTML).toContain('data-node="48021:x&quot; data-pwn=&quot;1"');
    expect(f.root.innerHTML).not.toContain("g-pending");
    expect(f.root.innerHTML).not.toContain("g-7");
    expect(rowGlyphs(f.root.innerHTML, "48021:x")).toEqual(ALL_UNREAD);
  });

  it("one parser: the served parse agrees with the exported parseToolResult on every fixture, exported semantics as authority", () => {
    const f = fresh();
    const ss = f.sandbox.__ss as { parse?: (t: string) => unknown } | undefined;
    const served = ss?.parse;
    expect(typeof served).toBe("function");
    const diffs: string[] = [];
    for (const [name, fx] of Object.entries(PARITY)) {
      const text = typeof fx === "string" ? fx : JSON.stringify(fx);
      const a = JSON.stringify(served!(text));
      const b = JSON.stringify(app.parseToolResult(text));
      if (a !== b) diffs.push(`${name}\n  served:   ${a}\n  exported: ${b}`);
    }
    expect(diffs).toEqual([]);
    const junk = app.parseToolResult(JSON.stringify(PARITY.junkState));
    expect(junk.rows[0]?.rails.situs).toBe("unread");
    const absent = app.parseToolResult(JSON.stringify(PARITY.absentState));
    expect(absent.rows[0]?.rails.situs).toBe("absent-verified");
    const caps = app.parseToolResult(JSON.stringify(PARITY.capsResolution));
    expect(caps.rows[0]?.resolution).toBe("resolved");
    const numericId = app.parseToolResult(JSON.stringify(PARITY.numericId));
    expect(numericId.screenId).toBeUndefined();
    const idFallback = app.parseToolResult(JSON.stringify(PARITY.idFallback));
    expect(idFallback.rows[0]?.parcelNodeId).toBe("48021:1");
    const stringStub = app.parseToolResult(JSON.stringify(PARITY.stringStub));
    expect(stringStub.rows[0]?.rails.situs).toBe("unread");
    const goldNode = app.parseToolResult(JSON.stringify(PARITY.goldNode));
    expect(goldNode.zoning?.url).toBe(ZONING_URL);
    expect(goldNode.frame?.units).toBe("ft");
    expect(app.parseToolResult(JSON.stringify(PARITY.sfhaString)).overlays[0]?.sfha).toBeUndefined();
    expect(app.parseToolResult(JSON.stringify(PARITY.drawNumber)).overlays[0]?.draw).toBeUndefined();
    expect(app.parseToolResult(JSON.stringify(PARITY.citationsNotStrings)).zoning?.url).toBeNull();
  });

  it("htmlContractViolations: origin_unchecked and miss_copy_unbound fire on violated copies of the served html", () => {
    const clean = app.buildAppHtml();
    expect(app.htmlContractViolations(clean)).toEqual([]);
    expect(app.htmlContractViolations(clean.replace("if(ev.source!==window.parent)", "if(false)"))).toContain(
      "origin_unchecked",
    );
    for (const s of [COPY.dead, COPY.sent, COPY.absentPrefix, COPY.unbakedPrefix, COPY.refused, COPY.unreadable]) {
      expect(app.htmlContractViolations(clean.split(s).join("")), s).toContain("miss_copy_unbound");
    }
    expect(app.htmlContractViolations(clean.replace('addEventListener("pointerenter"', 'addEventListener("pointerenterx"'))).toContain(
      "edge_hover_unbound",
    );
    expect(app.htmlContractViolations(clean.replace(/adjacency\s*===\s*"ROW"/g, 'adjacency === "NOPE"'))).toContain(
      "row_door_unguarded",
    );
    expect(app.htmlContractViolations(clean.replace('method:"ui/open-link"', 'method:"ui/open-url"'))).toContain(
      "open_link_unbound",
    );
  });
});

describe("P-91 v2 drawing (served)", () => {
  it("D1 hover: each ring edge is its own element; pointerenter highlights it and paints the edge object's words, ft, bearing and neighbor or road; nothing posts", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_NODE);
    const edges = GOLD_NODE.draw.edges;
    expect(f.edges().map((n) => n.getAttribute("data-edge"))).toEqual(["0", "1", "2", "3"]);
    expect(f.edges().every((n) => n.tag === "polyline")).toBe(true);
    expect(f.tipText()).toBe(COPY.tipHint);
    const before = f.posted.length;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i]!;
      f.hover(i);
      expect(f.edge(i).getAttribute("class"), `edge ${i} hot`).toBe("edge hot");
      expect(f.root.innerHTML.match(/class="edge hot"/g)?.length, "exactly one hot edge").toBe(1);
      expect(f.tipText(), `edge ${i} ft`).toContain(`${e.ft} ft`);
      expect(f.tipText(), `edge ${i} bearing`).toContain(e.bearing);
      expect(f.tip().getAttribute("data-edge-shown")).toBe(String(i));
    }
    f.hover(0);
    expect(f.tipText()).toContain("rear");
    expect(f.tipText()).toContain("alley");
    expect(f.tipText()).toContain("48021:road:925036023");
    f.hover(3);
    expect(f.tipText()).toContain("corner side");
    expect(f.tipText()).toContain("right of way");
    expect(f.tipText()).toContain("48021:road:129017865");
    expect(f.tipText()).toContain("local");
    expect(f.tipText()).not.toContain(COPY.acrossRow);
    f.hover(1);
    expect(f.tipText()).toContain("side");
    expect(f.tipText()).toContain("neighbor");
    expect(f.tipText()).toContain("48021:34169");
    expect(f.tipText()).not.toContain("48021:road:");
    expect(f.edge(3).getAttribute("class")).toBe("edge");
    f.leave(1);
    expect(f.tipText()).toBe(COPY.tipHint);
    expect(f.edge(1).getAttribute("class")).toBe("edge");
    expect(f.tip().getAttribute("data-edge-shown")).toBe("none");
    expect(f.posted.length, "hover is local: nothing posts, not even size-changed").toBe(before);
  });

  it("D1 honesty: an edge without ft shows no length; the panel never measures the ring", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_NO_FT);
    f.hover(1);
    expect(f.tipText()).toContain("48021:34169");
    expect(f.tipText()).not.toMatch(/\d ft/);
    f.hover(0);
    expect(f.tipText()).toContain("98.98 ft");
  });

  it("D1 touch: pointerdown pins the edge so leave keeps it and another edge's leave returns to it; a second pointerdown clears it", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_NODE);
    const before = f.posted.length;
    f.hover(1);
    f.down(1);
    f.leave(1);
    expect(f.tipText()).toContain("48021:34169");
    expect(f.edge(1).getAttribute("class")).toBe("edge hot");
    f.hover(2);
    expect(f.tipText()).toContain("48021:34121");
    expect(f.edge(2).getAttribute("class")).toBe("edge hot");
    expect(f.edge(1).getAttribute("class")).toBe("edge");
    f.leave(2);
    expect(f.tipText()).toContain("48021:34169");
    expect(f.edge(1).getAttribute("class")).toBe("edge hot");
    expect(f.edge(2).getAttribute("class")).toBe("edge");
    f.hover(1);
    f.down(1);
    expect(f.tipText()).toBe(COPY.tipHint);
    expect(f.edge(1).getAttribute("class")).toBe("edge");
    f.leave(1);
    expect(f.tipText()).toBe(COPY.tipHint);
    expect(f.posted.length).toBe(before);
  });

  it("D2 door: a shared line with a neighbor offers Open on the board's own path: the Open turn, the 12s dead timer, the Sent line painted in this panel", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_NODE);
    expect(f.openButtons()).toBe(0);
    f.hover(1);
    const tipHtml = f.tip().innerHTML;
    expect(tipHtml).toContain('data-act="open"');
    expect(tipHtml).toContain('data-node="48021:34169"');
    expect(tipHtml).toContain('onclick="window.__ss&&window.__ss.open(this)"');
    expect(f.openButtons()).toBe(1);
    const posted = f.open("48021:34169");
    expect(posted?.method).toBe("ui/message");
    const content = posted?.params?.content as Array<{ text: string }>;
    expect(content[0]?.text).toBe(app.openParcelMessage("48021:34169"));
    expect(f.armed(OPEN_DEAD_MS)).toBe(1);
    f.deliver({ jsonrpc: "2.0", id: posted?.id, result: {} });
    expect(f.text()).toContain(COPY.sent);
    expect(f.root.innerHTML).toContain('aria-label="parcel ring"');
    expect(f.armed(OPEN_DEAD_MS)).toBe(0);
    expect(f.text()).not.toContain(COPY.dead);

    const g = fresh();
    g.init();
    g.toolResult(GOLD_NODE);
    g.hover(1);
    g.open("48021:34169");
    expect(g.fire(OPEN_DEAD_MS)).toBe(1);
    expect(g.text()).toContain(COPY.dead);
    expect(g.root.innerHTML).toContain('aria-label="parcel ring"');
    g.toolResult(GOLD_NODE);
    expect(g.text()).not.toContain(COPY.dead);
  });

  it("D2 / O3: a ROW edge names the neighbor across the right of way and offers no Open, even with neighbor set", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_NODE);
    f.hover(2);
    const t = f.tipText();
    expect(t).toContain("48021:34121");
    expect(t).toContain(COPY.acrossRow);
    expect(t).toContain("48021:road:15113284");
    expect(t).toContain("front");
    expect(t).toContain("right of way");
    expect(f.tip().innerHTML).not.toContain('data-act="open"');
    expect(f.openButtons()).toBe(0);
    f.hover(1);
    expect(f.openButtons()).toBe(1);
    expect(f.tip().innerHTML).not.toContain(COPY.acrossRow);
    const g = fresh();
    g.init();
    g.toolResult(NODE_34121);
    g.hover(7);
    expect(g.tipText()).toContain("48021:35105");
    expect(g.tipText()).toContain(COPY.acrossRow);
    expect(g.tipText()).toContain("minor collector");
    expect(g.openButtons()).toBe(0);
    g.hover(5);
    expect(g.tipText()).toContain("48021:34153");
    expect(g.openButtons()).toBe(1);
  });

  it("D3 zoning: the district prints inside the ring with the jurisdiction beneath, the stroke takes the family tint, and clicking the district posts ui/open-link with the first https citation", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_NODE);
    const html = f.root.innerHTML;
    expect(html).toContain('data-zoning="SF-1"');
    expect(html).toContain(">SF-1</text>");
    expect(html).toContain(">bastrop_city_tx</text>");
    expect(html).toContain('stroke="var(--ss-t3)" stroke-width="2" data-zone-family="residential"');
    const district = f.district();
    expect(district?.getAttribute("class")).toBe("zn link");
    expect(district?.getAttribute("data-zoning-url")).toBe(ZONING_URL);
    const before = f.posted.length;
    district!.dispatch("click");
    const links = f.openLinks();
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({ jsonrpc: "2.0", id: expect.any(Number), method: "ui/open-link", params: { url: ZONING_URL } });
    expect(f.posted.length).toBe(before + 1);
    expect(f.posted.filter((m) => m.method === "ui/message")).toHaveLength(0);

    const g = fresh();
    g.init();
    g.toolResult(NODE_34121);
    expect(g.root.innerHTML).toContain('data-zoning="GC"');
    expect(g.root.innerHTML).toContain('stroke="var(--ss-blue)" stroke-width="2" data-zone-family="commercial"');
    const mu = fresh();
    mu.init();
    mu.toolResult(GOLD_MU);
    expect(mu.root.innerHTML).toContain('stroke="var(--ss-atom)" stroke-width="2" data-zone-family="mixed"');
    const pdd = fresh();
    pdd.init();
    pdd.toolResult(GOLD_PDD);
    expect(pdd.root.innerHTML).toContain('data-zoning="PDD"');
    expect(pdd.root.innerHTML).not.toContain("data-zone-family");
    expect(pdd.root.innerHTML).toContain('stroke="var(--ss-t3)" stroke-width="2"/>');
  });

  it("D3 honesty: no zoning prints nothing and tints nothing; a present district without an https citation prints without a link and a click opens nothing", () => {
    for (const [name, fx] of [
      ["no attrs", GOLD_NO_ZONING],
      ["state unknown", GOLD_ZONING_UNKNOWN],
    ] as const) {
      const f = fresh();
      f.init();
      f.toolResult(fx);
      expect(f.root.innerHTML, name).not.toContain("data-zoning");
      expect(f.root.innerHTML, name).not.toContain("data-zone-family");
      expect(f.root.innerHTML, name).not.toContain("SF-1");
      expect(f.district(), name).toBeNull();
    }
    for (const [name, fx] of [
      ["http only", GOLD_HTTP_ONLY],
      ["no brief", GOLD_NO_BRIEF],
    ] as const) {
      const f = fresh();
      f.init();
      f.toolResult(fx);
      const district = f.district();
      expect(district, name).not.toBeNull();
      expect(district?.getAttribute("data-zoning"), name).toBe("SF-1");
      expect(district?.getAttribute("class"), name).toBe("zn");
      expect(district?.getAttribute("data-zoning-url"), name).toBeNull();
      const before = f.posted.length;
      district!.dispatch("click");
      expect(f.openLinks(), name).toHaveLength(0);
      expect(f.posted.length, name).toBe(before);
    }
  });

  it("D4 flood: tint-ring tints light for shaded X, heavy for A and for AE floodway, none for AREA OF MINIMAL; the zone prints at the top edge with only --ss-blue", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_NODE);
    expect(f.root.innerHTML).toContain('data-flood-tint="light"');
    expect(f.root.innerHTML).toContain('fill="var(--ss-blue)" fill-opacity=".14"');
    expect(f.root.innerHTML).toContain('data-flood-zone="Zone X"');
    expect(f.text()).toContain("Zone X 0.2 PCT ANNUAL CHANCE FLOOD HAZARD");
    const a = fresh();
    a.init();
    a.toolResult(NODE_32243);
    expect(a.root.innerHTML).toContain('data-flood-tint="heavy"');
    expect(a.root.innerHTML).toContain('fill="var(--ss-blue)" fill-opacity=".32"');
    expect(a.root.innerHTML).toContain('data-flood-zone="Zone A"');
    const ae = fresh();
    ae.init();
    ae.toolResult(NODE_49295);
    expect(ae.edges()).toHaveLength(11);
    expect(ae.root.innerHTML).toContain('data-flood-tint="heavy"');
    expect(ae.root.innerHTML).toContain('data-flood-zone="Zone AE floodway"');
    expect(ae.root.innerHTML).toContain(">Zone AE floodway</text>");
    const x = fresh();
    x.init();
    x.toolResult(NODE_33223);
    expect(x.root.innerHTML).not.toContain("data-flood-tint");
    expect(x.root.innerHTML).not.toContain("data-flood-zone");
    expect(x.text()).toContain("Zone X AREA OF MINIMAL FLOOD HAZARD");
    for (const h of [f, a, ae, x]) {
      const tints = h.root.innerHTML.match(/<polygon class="flood-tint"[^>]*>/g) ?? [];
      for (const t of tints) expect(t).toContain('fill="var(--ss-blue)"');
    }
  });

  it("D7 frame cues: north arrow, a round scale bar at the ring's pixel scale labelled as a unit reference, and frame.quality as a note; no units means no bar", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_NODE);
    const html = f.root.innerHTML;
    expect(html).toContain('data-north="up"');
    expect(html).toContain('data-scale-ft="50"');
    expect(f.text()).toContain("50 ft");
    expect(f.text()).toContain(COPY.unitRef);
    expect(html).toContain('data-frame-quality="gis-approximate"');
    expect(f.text()).toContain("gis-approximate");
    const poly = /<polygon class="ring-fill" points="([^"]+)"/.exec(html)?.[1] ?? "";
    const xs = poly.split(" ").map((p) => Number(p.split(",")[0]));
    const ringPx = Math.max(...xs) - Math.min(...xs);
    const bar = /<g class="scale" data-scale-ft="50"><line x1="([\d.]+)" y1="\d+" x2="([\d.]+)"/.exec(html);
    expect(bar).not.toBeNull();
    const barPx = Number(bar![2]) - Number(bar![1]);
    /* two derivations: the fixture's feet (50.84 - -50.37 = 101.21) against the painted pixels */
    expect(Math.abs(barPx / ringPx - 50 / 101.21)).toBeLessThan(0.005);
    const wide = fresh();
    wide.init();
    wide.toolResult(NODE_49295);
    expect(wide.root.innerHTML).toContain('data-scale-ft="100"');
    const narrow = fresh();
    narrow.init();
    narrow.toolResult(NODE_33223);
    expect(narrow.root.innerHTML).toContain('data-scale-ft="10"');
    const noUnits = fresh();
    noUnits.init();
    noUnits.toolResult(GOLD_NO_UNITS);
    expect(noUnits.root.innerHTML).toContain('data-north="up"');
    expect(noUnits.root.innerHTML).not.toContain("data-scale-ft");
    expect(noUnits.text()).not.toContain(COPY.unitRef);
    expect(noUnits.root.innerHTML).toContain('data-frame-quality="gis-approximate"');
    const noFrame = fresh();
    noFrame.init();
    noFrame.toolResult(GOLD_NO_FRAME);
    expect(noFrame.root.innerHTML).not.toContain("data-north");
    expect(noFrame.root.innerHTML).not.toContain("data-scale-ft");
    expect(noFrame.root.innerHTML).not.toContain("data-frame-quality");
    expect(noFrame.root.innerHTML).toContain('aria-label="parcel ring"');
  });
});

/*
 * Plan sentences for S7, literal on purpose (two derivations: the plan text
 * here, the module constants there).
 */
const COPY2 = {
  citationDegraded: "citation degraded",
  asOfMissing: "as-of missing",
  absenceUnverified: "absence unverified; no provenance on the wire",
  bfeNone: "none on record",
  addToScreen: "Add to screen",
  report: "Report",
  whyOpener: "Why is",
  whyInstruction: "Answer from the record and the atom path; do not invent a value.",
  noReason: "no reason on the wire",
  unstated: "unstated",
};
const GOLD_LABEL = "908 PINE , BASTROP, TX 78602";

describe("P-91 v2 facts and actions (served)", () => {
  it("F1 citations: every https section or overlay citation is a control that posts ui/open-link with that URL; an http string never links; citationsDegraded paints the degraded text and opens nothing", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_FACTS);
    /* overlay citation before the report is open */
    const pipe = f.segment('data-overlay="pipeline"', "</div>");
    expect(pipe).toContain(`data-act="cite" data-url="${PIPE_URL}"`);
    /* the flood facts row is degraded: the text, never a link */
    const floodRow = f.segment('<div class="facts flood"', "</div></div>");
    expect(floodRow).toContain('data-cite-degraded="1"');
    expect(floodRow).toContain(COPY2.citationDegraded);
    expect(floodRow).not.toContain('data-act="cite"');
    f.ss().report();
    const zoning = f.segment('data-report-section="zoning"', 'data-report-section="setbacks-envelope"');
    expect(zoning).toContain(`data-act="cite" data-url="${ZONING_URL}"`);
    expect(zoning).toContain(`data-act="cite" data-url="${ZONING_URL_2}"`);
    expect(zoning).toContain(">citation 1</button>");
    expect(zoning).toContain(">citation 2</button>");
    expect(zoning).not.toContain(COPY2.citationDegraded);
    expect(f.root.innerHTML).not.toContain("plain.example.test");
    const urls = f.all('[data-act="cite"]').map((c) => c.getAttribute("data-url") ?? "");
    expect(urls.every((u) => /^https:\/\//.test(u))).toBe(true);
    expect(urls).toEqual(expect.arrayContaining([ZONING_URL, ZONING_URL_2, PIPE_URL]));
    const before = f.posted.length;
    const zoningCite = f.all('[data-act="cite"]').find((c) => c.getAttribute("data-url") === ZONING_URL);
    expect(zoningCite).toBeDefined();
    f.ss().cite(zoningCite);
    expect(f.openLinks()).toHaveLength(1);
    expect(f.openLinks()[0]).toEqual({ jsonrpc: "2.0", id: expect.any(Number), method: "ui/open-link", params: { url: ZONING_URL } });
    expect(f.posted.length).toBe(before + 1);
    expect(f.messages()).toHaveLength(0);
    /* a forged control carrying an http url opens nothing */
    f.ss().cite(f.btn({ "data-url": "http://plain.example.test/first" }));
    f.ss().cite(f.btn({ "data-url": "javascript:alert(1)" }));
    expect(f.openLinks()).toHaveLength(1);
    /* a present section whose only citation is http is degraded, not linked */
    const g = fresh();
    g.init();
    g.toolResult(factsWith((_d, b) => {
      ((b.brief as Json).sections as Json[])[0] = { ...SECTION_ZONING, citations: ["http://plain.example.test/only"] };
    }));
    g.ss().report();
    const gz = g.segment('data-report-section="zoning"', 'data-report-section="setbacks-envelope"');
    expect(gz).toContain(COPY2.citationDegraded);
    expect(gz).not.toContain('data-act="cite"');
    expect(g.root.innerHTML).not.toContain("plain.example.test");
  });

  it("F2 flood facts: zone, subtype, SFHA, base flood elevation or none on record, adapter, vintage and evaluated-at are each read from the section data; the summary prints only when on the wire; unread and absent print their state", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_FACTS);
    const row = f.segment('<div class="facts flood"', "</div></div>");
    expect(row).toContain('data-flood-state="present"');
    expect(row).toContain('data-fact-zone="X"');
    expect(row).toContain('data-fact-subtype="0.2 PCT ANNUAL CHANCE FLOOD HAZARD"');
    expect(row).toContain('data-fact-sfha="no"');
    expect(row).toContain(`data-fact-bfe="${COPY2.bfeNone}"`);
    expect(row).toContain('data-fact-adapter="adapter:flood-test"');
    expect(row).toContain('data-fact-vintage="NFHL_48_20260101"');
    expect(row).toContain('data-fact-evaluated="2026-08-29"');
    expect(row).not.toContain("T10:00");
    expect(row).not.toContain("data-zone-exposure");
    expect(f.text()).not.toContain(FLOOD_SUMMARY);
    expect(f.strip(row)).toContain("as of 2026-08-29");
    expect(f.strip(row)).toContain("source adapter:flood-test");
    const ae = fresh();
    ae.init();
    ae.toolResult(NODE_49295_FACTS);
    const aeRow = ae.segment('<div class="facts flood"', "</div></div>");
    expect(aeRow).toContain('data-fact-zone="AE"');
    expect(aeRow).toContain('data-fact-subtype="FLOODWAY"');
    expect(aeRow).toContain('data-fact-sfha="yes"');
    expect(aeRow).toContain('data-fact-bfe="372.5"');
    expect(aeRow).toContain('data-fact-vintage="NFHL_48_20260101"');
    expect(aeRow).not.toContain("data-zone-exposure");
    expect(aeRow).toContain(COPY2.citationDegraded);
    const s = fresh();
    s.init();
    s.toolResult(GOLD_FACTS_FLOOD_SUMMARY);
    const sRow = s.segment('<div class="facts flood"', "</div></div>");
    expect(sRow).toContain('data-zone-exposure="1"');
    expect(s.strip(sRow)).toContain(FLOOD_SUMMARY);
    expect(sRow).toContain(`data-act="cite" data-url="${FLOOD_URL}"`);
    expect(sRow).not.toContain(COPY2.citationDegraded);
    const u = fresh();
    u.init();
    u.toolResult(GOLD_FACTS_FLOOD_UNREAD);
    const uRow = u.segment('<div class="facts flood"', "</div>");
    expect(uRow).toContain('data-flood-state="unread"');
    expect(uRow).toContain("g-unread");
    expect(u.strip(uRow)).toContain("unread");
    expect(u.strip(uRow)).toContain("flood facet not read");
    expect(uRow).not.toContain("data-fact-zone");
    expect(uRow).not.toContain(COPY2.bfeNone);
    const a = fresh();
    a.init();
    a.toolResult(GOLD_FACTS_FLOOD_ABSENT);
    const aRow = a.segment('<div class="facts flood"', "</div>");
    expect(aRow).toContain('data-flood-state="absent-verified"');
    expect(aRow).toContain("g-absent-verified");
    expect(a.strip(aRow)).toContain("absent, verified");
    expect(aRow).not.toContain("data-fact-zone");
    const n = fresh();
    n.init();
    n.toolResult(GOLD_FACTS_FLOOD_ABSENT_NO_VINTAGE);
    const nRow = n.segment('<div class="facts flood"', "</div>");
    expect(nRow).toContain('data-flood-state="unknown"');
    expect(n.strip(nRow)).toContain(COPY2.absenceUnverified);
    /* S6's gold carries a flood section claiming present with no asOf and empty data: F6 fails it closed, and no value is invented */
    const gold = fresh();
    gold.init();
    gold.toolResult(GOLD_NODE);
    const goldRow = gold.segment('<div class="facts flood"', "</div>");
    expect(goldRow).toContain('data-flood-state="unknown"');
    expect(gold.strip(goldRow)).toContain(COPY2.asOfMissing);
    expect(goldRow).not.toContain("data-fact-zone");
    expect(goldRow).not.toContain(COPY2.bfeNone);
    /* no brief: no facts row, and nothing invented for it */
    const none = fresh();
    none.init();
    none.toolResult(GOLD_NO_BRIEF);
    expect(none.root.innerHTML).not.toContain('<div class="facts flood"');
    expect(none.root.innerHTML).not.toContain("data-fact-zone");
  });

  it("F5 verified means verified: an absent-verified overlay paints verified only with provenance present or a known vintage; otherwise unknown with the wire's reason, or the panel's note when the wire has none", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_FACTS);
    const pipe = f.segment('data-overlay="pipeline"', "</div>");
    expect(pipe).toContain('data-paint="absent-verified"');
    expect(pipe).toContain("g-absent-verified");
    expect(pipe).toContain('data-vintage="2026-06"');
    expect(pipe).toContain('data-provenance="present"');
    expect(pipe).not.toContain('data-act="why"');
    const sd = f.segment('data-overlay="special-district"', "</div>");
    expect(sd).toContain('data-paint="unknown"');
    expect(sd).toContain("g-unknown");
    expect(sd).not.toContain("g-absent-verified");
    expect(sd).toContain(`data-paint-reason="${COPY2.absenceUnverified}"`);
    expect(f.strip(sd)).toContain(COPY2.absenceUnverified);
    expect(sd).toContain('data-act="why"');
    const well = f.segment('data-overlay="well"', "</div>");
    expect(well).toContain('data-paint="unknown"');
    expect(f.strip(well)).toContain("provenance unknown; vintage unknown");
    expect(well).not.toContain("data-paint-reason");
    const v = fresh();
    v.init();
    v.toolResult(GOLD_FACTS_VINTAGE_ONLY);
    const vsd = v.segment('data-overlay="special-district"', "</div>");
    expect(vsd).toContain('data-paint="absent-verified"');
    expect(vsd).toContain('data-vintage="2026-05"');
    expect(vsd).not.toContain("data-paint-reason");
    const d = fresh();
    d.init();
    d.toolResult(GOLD_FACTS_DEGRADED);
    const dsd = d.segment('data-overlay="special-district"', "</div>");
    expect(dsd).toContain('data-paint="unknown"');
    expect(d.strip(dsd)).toContain("provenance degraded; vintage unknown");
    expect(dsd).not.toContain("data-paint-reason");
    expect(dsd).toContain('data-provenance="degraded"');
  });

  it("F6 as-of and source: a present section without asOf paints unknown with as-of missing; with asOf the row shows the date only and the source", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_FACTS_NO_ASOF);
    f.ss().report();
    const z = f.segment('data-report-section="zoning"', 'data-report-section="setbacks-envelope"');
    expect(z).toContain('data-report-state="unknown"');
    expect(z).toContain("g-unknown");
    expect(z).toContain(`data-paint-reason="${COPY2.asOfMissing}"`);
    expect(f.strip(z)).toContain(COPY2.asOfMissing);
    expect(z).not.toContain("data-as-of");
    expect(z).toContain('data-act="why"');
    const g = fresh();
    g.init();
    g.toolResult(GOLD_FACTS);
    g.ss().report();
    const gz = g.segment('data-report-section="zoning"', 'data-report-section="setbacks-envelope"');
    expect(gz).toContain('data-report-state="present"');
    expect(gz).toContain('data-as-of="2026-08-29"');
    expect(gz).not.toContain("T10:00");
    expect(gz).toContain('data-source="adapter:zoning-test"');
    expect(gz).not.toContain(COPY2.asOfMissing);
    expect(gz).not.toContain('data-act="why"');
    const env = g.segment('data-report-section="setbacks-envelope"', 'data-report-section="flood"');
    expect(env).toContain('data-source="baked-envelope-facet"');
    expect(env).toContain('data-as-of="2026-08-29"');
  });

  it("P1 board: an unknown, refused or unread rail cell is a control that drafts the why turn from the row; present and absent-verified cells are not; an unresolved row has none; no timer", () => {
    const f = fresh();
    f.init();
    f.toolResult(BOARD);
    const cells = f.all('[data-why-kind="rail"]');
    /* 34137: drainage unknown + envelope refused; 34169: six unread; the unresolved row: none */
    expect(cells).toHaveLength(8);
    const at = (node: string, rail: string) => cells.find((c) => c.getAttribute("data-why-node") === node && c.getAttribute("data-why-rail") === rail);
    expect(at("48021:34137", "situs")).toBeUndefined();
    expect(at("48021:34137", "landUse")).toBeUndefined();
    expect(at("48021:34137", "drainage")).toBeDefined();
    expect(at("48021:34137", "envelope")).toBeDefined();
    for (const rail of ["situs", "zoning", "landUse", "flood", "drainage", "envelope"]) expect(at("48021:34169", rail), rail).toBeDefined();
    expect(cells.some((c) => c.getAttribute("data-why-node") === null || c.getAttribute("data-why-node") === "")).toBe(false);
    expect(rowGlyphs(f.root.innerHTML, 'data-node="48021:34137"')).toEqual(STUB_SIX_GLYPHS);
    f.ss().why(at("48021:34137", "drainage"));
    expect(f.messages()).toHaveLength(1);
    expect(f.lastText()).toBe(
      `${COPY2.whyOpener} drainage unknown for 48021:34137 (908 Pine, Bastrop TX)? The record says: ${COPY2.noReason}; producer ${COPY2.unstated}; code ${COPY2.unstated}. ${COPY2.whyInstruction}`,
    );
    expect(f.armed(OPEN_DEAD_MS)).toBe(0);
    f.ss().why(at("48021:34137", "envelope"));
    expect(f.lastText()).toContain(`${COPY2.whyOpener} envelope refused for 48021:34137`);
    f.ss().why(at("48021:34169", "situs"));
    expect(f.lastText()).toContain(`${COPY2.whyOpener} situs unread for 48021:34169 (111 Rainmaker Cv, Bastrop TX)?`);
    /* forged controls for a present cell, an unknown rail, and an unknown node draft nothing */
    f.ss().why(f.btn({ "data-why-kind": "rail", "data-why-rail": "situs", "data-why-node": "48021:34137" }));
    f.ss().why(f.btn({ "data-why-kind": "rail", "data-why-rail": "owner", "data-why-node": "48021:34137" }));
    f.ss().why(f.btn({ "data-why-kind": "rail", "data-why-rail": "situs", "data-why-node": "48021:999" }));
    expect(f.messages()).toHaveLength(3);
    expect(f.text()).not.toContain(COPY.sent);
  });

  it("P1 parcel: an overlay or section that is unknown, refused or unread drafts a why turn quoting the record; present and verified cells are not controls; every slot is a wire field or the literal fallback", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_FACTS);
    expect(f.root.innerHTML).not.toContain("atom_path_pending");
    const overlayWhy = (id: string) => {
      const seg = f.segment(`data-overlay="${id}"`, "</div>");
      const m = /data-why-kind="overlay" data-why-i="(\d+)"/.exec(seg);
      return m ? f.btn({ "data-why-kind": "overlay", "data-why-i": m[1] as string }) : null;
    };
    expect(overlayWhy("flood")).toBeNull();
    expect(overlayWhy("pipeline")).toBeNull();
    expect(overlayWhy("envelope")).not.toBeNull();
    expect(overlayWhy("footprint")).not.toBeNull();
    expect(overlayWhy("special-district")).not.toBeNull();
    f.ss().why(overlayWhy("envelope"));
    expect(f.lastText()).toBe(
      `${COPY2.whyOpener} envelope refused for 48021:34137 (${GOLD_LABEL})? The record says: atom_path_pending; producer baked-envelope-facet; code declined-in-bake. ${COPY2.whyInstruction}`,
    );
    f.ss().why(overlayWhy("special-district"));
    expect(f.lastText()).toBe(
      `${COPY2.whyOpener} special-district unknown for 48021:34137 (${GOLD_LABEL})? The record says: ${COPY2.noReason}; producer ${COPY2.unstated}; code ${COPY2.unstated}. ${COPY2.whyInstruction}`,
    );
    f.ss().why(overlayWhy("footprint"));
    expect(f.lastText()).toContain(`${COPY2.whyOpener} footprint unknown for 48021:34137`);
    expect(f.armed(OPEN_DEAD_MS)).toBe(0);
    expect(f.messages()).toHaveLength(3);
    /* a forged control on a present overlay (flood is overlays[0]) drafts nothing */
    f.ss().why(f.btn({ "data-why-kind": "overlay", "data-why-i": "0" }));
    f.ss().why(f.btn({ "data-why-kind": "overlay", "data-why-i": "99" }));
    expect(f.messages()).toHaveLength(3);
    f.ss().report();
    const sectionWhy = (id: string, next: string) => {
      const seg = f.segment(`data-report-section="${id}"`, next);
      const m = /data-why-kind="section" data-why-i="(\d+)"/.exec(seg);
      return m ? f.btn({ "data-why-kind": "section", "data-why-i": m[1] as string }) : null;
    };
    expect(sectionWhy("zoning", 'data-report-section="setbacks-envelope"')).toBeNull();
    expect(sectionWhy("land-use", 'data-report-section="drainage"')).toBeNull();
    f.ss().why(sectionWhy("drainage", '<div class="acts">'));
    expect(f.lastText()).toBe(
      `${COPY2.whyOpener} drainage unread for 48021:34137 (${GOLD_LABEL})? The record says: ${DRAINAGE_REASON}; producer ${COPY2.unstated}; code ${COPY2.unstated}. ${COPY2.whyInstruction}`,
    );
    f.ss().why(sectionWhy("setbacks-envelope", 'data-report-section="flood"'));
    expect(f.lastText()).toBe(
      `${COPY2.whyOpener} setbacks-envelope refused for 48021:34137 (${GOLD_LABEL})? The record says: ${ENVELOPE_REFUSAL.reason}; producer baked-envelope-facet; code declined-in-bake. ${COPY2.whyInstruction}`,
    );
    const g = fresh();
    g.init();
    g.toolResult(GOLD_FACTS_NO_ASOF);
    g.ss().report();
    const seg = g.segment('data-report-section="zoning"', 'data-report-section="setbacks-envelope"');
    const m = /data-why-kind="section" data-why-i="(\d+)"/.exec(seg);
    expect(m).not.toBeNull();
    g.ss().why(g.btn({ "data-why-kind": "section", "data-why-i": m![1] as string }));
    expect(g.lastText()).toBe(
      `${COPY2.whyOpener} zoning unknown for 48021:34137 (${GOLD_LABEL})? The record says: ${COPY2.noReason}; producer ${COPY2.unstated}; code ${COPY2.unstated}. ${COPY2.whyInstruction}`,
    );
    /* the envelope overlay on the v1 gold (no brief) quotes only what it has */
    const h = fresh();
    h.init();
    h.toolResult(GOLD);
    const hm = /data-why-kind="overlay" data-why-i="(\d+)"/.exec(h.segment('data-overlay="envelope"', "</div>"));
    h.ss().why(h.btn({ "data-why-kind": "overlay", "data-why-i": hm![1] as string }));
    expect(h.lastText()).toBe(
      `${COPY2.whyOpener} envelope refused for 48021:34137 (${GOLD_LABEL})? The record says: atom_path_pending; producer ${COPY2.unstated}; code ${COPY2.unstated}. ${COPY2.whyInstruction}`,
    );
  });

  it("C1 save with a status: the Save property control is a chooser of New, Watching, Chasing, Passed; each choice drafts the save turn with that status; a second choice is another draft; an unknown status drafts nothing; no state is read", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_FACTS);
    const saves = f.all('[data-act="save"]');
    expect(saves.map((b) => b.getAttribute("data-status"))).toEqual(SAVE_STATUSES);
    expect(f.text()).toContain("Save property");
    const before = f.root.innerHTML;
    f.ss().save(saves.find((b) => b.getAttribute("data-status") === "Watching"));
    expect(f.lastText()).toBe("Save property 48021:34137 with save_property, status Watching. Do not change any screen.");
    f.ss().save(saves.find((b) => b.getAttribute("data-status") === "Passed"));
    expect(f.lastText()).toBe("Save property 48021:34137 with save_property, status Passed. Do not change any screen.");
    expect(f.messages()).toHaveLength(2);
    expect(f.root.innerHTML).toBe(before);
    expect(f.armed(OPEN_DEAD_MS)).toBe(0);
    f.ss().save(f.btn({ "data-status": "Sold" }));
    f.ss().save(f.btn({}));
    f.ss().save();
    expect(f.messages()).toHaveLength(2);
    const b = fresh();
    b.init();
    b.toolResult(BOARD);
    expect(b.all('[data-act="save"]')).toHaveLength(0);
  });

  it("C2 add neighbor: the door tooltip offers Add to screen beside Open; it drafts the add_to_screen turn naming the neighbor and no screen id; a ROW edge and a road edge offer neither", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_NODE);
    f.hover(1);
    const tip = f.tip().innerHTML;
    expect(tip).toContain('data-act="open" data-node="48021:34169"');
    expect(tip).toContain('data-act="addscreen" data-node="48021:34169"');
    expect(tip).toContain(COPY2.addToScreen);
    expect(tip.indexOf('data-act="open"')).toBeLessThan(tip.indexOf('data-act="addscreen"'));
    const before = f.posted.length;
    f.ss().addToScreen(f.btn({ "data-node": "48021:34169" }));
    expect(f.lastText()).toBe("Add 48021:34169 to the screen this parcel was opened from with add_to_screen, source walk. Do not save it.");
    expect(f.lastText()).not.toMatch(/screen-\d|screenId/);
    expect(f.posted.length).toBe(before + 1);
    expect(f.armed(OPEN_DEAD_MS)).toBe(0);
    expect(f.text()).not.toContain(COPY.sent);
    f.hover(2);
    expect(f.tip().innerHTML).not.toContain('data-act="addscreen"');
    expect(f.tip().innerHTML).not.toContain(COPY2.addToScreen);
    f.hover(0);
    expect(f.tip().innerHTML).not.toContain('data-act="addscreen"');
    f.ss().addToScreen(f.btn({}));
    expect(f.messages()).toHaveLength(1);
  });

  it("R1 report view: a local toggle lists every section in order with title, glyph and word, as-of date, source, citation control and agentGuidance; it posts no turn and no link; a second toggle removes it", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_FACTS);
    expect(f.root.innerHTML).not.toContain('data-report="1"');
    const toggle = f.root.querySelector('[data-act="report"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("data-report-open")).toBe("0");
    expect(f.strip(f.segment('<div class="acts">', "</div>"))).toContain(COPY2.report);
    const msgsBefore = f.messages().length;
    f.ss().report();
    expect(f.root.querySelector('[data-act="report"]')?.getAttribute("data-report-open")).toBe("1");
    const report = f.segment('<div class="report"', '<div class="acts">');
    const ids = [...report.matchAll(/data-report-section="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["zoning", "setbacks-envelope", "flood", "land-use", "drainage"]);
    const states = [...report.matchAll(/data-report-state="([^"]+)"/g)].map((m) => m[1]);
    expect(states).toEqual(["present", "refused", "present", "absent-verified", "unread"]);
    const text = f.strip(report);
    for (const t of ["Zoning", "Setbacks and buildable envelope", "Flood hazard", "Land use", "Drainage"]) expect(text).toContain(t);
    for (const w of ["present", "refused", "absent, verified", "unread"]) expect(text).toContain(w);
    expect(text).toContain("as of 2026-08-29");
    expect(text).not.toContain("T10:00");
    expect(report).toContain('data-source="adapter:zoning-test"');
    expect(report).toContain('data-source="baked-envelope-facet"');
    expect(report).toContain('data-source="adapter:flood-test"');
    expect(report).toContain('data-source="adapter:landuse-test"');
    expect(report).toContain(`data-act="cite" data-url="${ZONING_URL}"`);
    expect(report).toContain('data-agent-guidance="1"');
    expect(text).toContain(ENVELOPE_GUIDANCE);
    expect(text).toContain(DRAINAGE_REASON);
    /* nothing composed and no data value: the district and the elevation stay off the report */
    expect(report).not.toContain("SF-1");
    expect(report).not.toContain("372.5");
    expect(report).not.toContain("data-fact-zone");
    expect(f.messages()).toHaveLength(msgsBefore);
    expect(f.openLinks()).toHaveLength(0);
    expect(f.root.innerHTML).toContain('aria-label="parcel ring"');
    f.ss().report();
    expect(f.root.innerHTML).not.toContain('data-report="1"');
    expect(f.root.querySelector('[data-act="report"]')?.getAttribute("data-report-open")).toBe("0");
    expect(f.messages()).toHaveLength(msgsBefore);
    /* a later result closes the view; a parcel with no brief says so */
    f.ss().report();
    f.toolResult(GOLD);
    expect(f.root.innerHTML).not.toContain('data-report="1"');
    f.ss().report();
    expect(f.strip(f.segment('<div class="report"', '<div class="acts">'))).toContain("No brief sections on this result");
    expect(f.root.innerHTML).not.toContain("data-report-section");
    const b = fresh();
    b.init();
    b.toolResult(BOARD);
    expect(b.all('[data-act="report"]')).toHaveLength(0);
  });

  it("htmlContractViolations: the S7 checks fire on violated copies of the served html", () => {
    const clean = app.buildAppHtml();
    expect(app.htmlContractViolations(clean)).toEqual([]);
    expect(app.htmlContractViolations(clean.replace(/function sendCite/g, "function sendSite"))).toContain("citation_link_unbound");
    expect(app.htmlContractViolations(clean.split(COPY2.citationDegraded).join("citation missing"))).toContain("citation_link_unbound");
    expect(app.htmlContractViolations(clean.replace(/function sendWhy/g, "function sendHow"))).toContain("why_turn_unbound");
    expect(app.htmlContractViolations(clean.split(COPY2.whyOpener).join("Tell me about"))).toContain("why_turn_unbound");
    expect(app.htmlContractViolations(clean.replace('"Chasing"', '"Pursuing"'))).toContain("save_statuses_unbound");
    expect(app.htmlContractViolations(clean.replace(/function toggleReport/g, "function toggleView"))).toContain("report_toggle_unbound");
    expect(app.htmlContractViolations(clean.replace(/function sendAddToScreen/g, "function sendAdd"))).toContain("add_to_screen_unbound");
  });
});

/*
 * P-91 v2 board (S8), served. Screen rows in the p543 wire shape
 * (peScreenSave.ts ScreenRow: candidates on an ambiguous row, stubRead,
 * degraded.duplicates and degraded.timedOut), the bare list_screens summary
 * (ScreenSummary), and every declared body the p558 server emits (tools.ts,
 * tool-honesty.ts, export-instrument.ts, entitlement.ts). The ids and labels
 * for 908 Pine, 111 Rainmaker Cv and 927 Main are the fixture doc's; every
 * other id, label, date, count and status number is a SYNTHETIC test input.
 * Sentences are literal on purpose (two derivations: the brief's text here,
 * the module constants there).
 */
const COPY3 = {
  useThis: "Use this",
  lookUp: "Look this up",
  ambiguous: "ambiguous",
  noScreens: "No screens yet. Paste addresses in the chat to make one.",
  unresolvedGroup: "Unresolved",
  railsNotRead: "rails not read",
  notReturned: "Not returned",
  refused: "Refused",
  notImplemented: "Not implemented",
  notReady: "is not ready",
  byCompleteness: "by completeness",
  useDraft: (node: string, q: string) => `Add ${node} to this screen with add_to_screen, source pasted. It is the parcel for "${q}". Do not save it.`,
  lookupDraft: (q: string) => `Run find_parcel for "${q}". Do not add anything to a screen yet.`,
  reopenDraft: (id: string) => `Reopen screen ${id} with list_screens. Do not create a new screen.`,
  dup: (q: string, kept: string, node: string) => `"${q}" is the same parcel as "${kept}" (${node}); not added twice.`,
  timedOut: (q: string) => `"${q}" did not resolve in time; unresolved for now.`,
};
const SCREEN_S8 = {
  screen: {
    id: "scr-s8",
    name: "Higgins block",
    createdAt: "2026-08-30T09:00:00.000Z",
    updatedAt: "2026-08-30T09:05:00.000Z",
    rows: [
      { id: "r1", ordinal: 0, query: "908 Pine, Bastrop TX", parcelNodeId: "48021:34137", resolution: "resolved", source: "pasted", stub: STUB_SIX, stubRead: "ok" },
      /* a contradictory wire: a stub claiming present under an errored read; the panel refuses the claim */
      { id: "r2", ordinal: 1, query: "111 Rainmaker Cv, Bastrop TX", parcelNodeId: "48021:8720522", resolution: "resolved", source: "pasted", stub: STUB_SIX, stubRead: "error" },
      { id: "r3", ordinal: 2, query: "100 Main St", parcelNodeId: null, resolution: "ambiguous", source: "pasted", candidates: [{ parcelNodeId: "48021:33223", label: "927 MAIN ST , BASTROP, TX 78602" }, { parcelNodeId: "48209:700001", label: "100 MAIN ST , KYLE, TX 78640", countyFips: "48209" }] },
      { id: "r4", ordinal: 3, query: "zzzz-not-a-situs-99999", parcelNodeId: null, resolution: "unresolved", source: "pasted" },
      { id: "r5", ordinal: 4, query: "48021:900001", parcelNodeId: null, resolution: "unresolved", source: "pasted" },
      { id: "r6", ordinal: 5, query: "500 Slow Ln", parcelNodeId: null, resolution: "unresolved", source: "pasted", resolveTimedOut: true },
    ],
    stubsDegraded: true,
    degraded: {
      timedOut: ["500 Slow Ln"],
      duplicates: [{ query: "111 Rainmaker Cove, Bastrop TX", parcelNodeId: "48021:8720522", keptQuery: "111 Rainmaker Cv, Bastrop TX" }],
    },
  },
};
const SCREENS_S8 = {
  screens: [
    { id: "scr-a", name: "Older", rowCount: 3, createdAt: "2026-08-28T09:00:00.000Z", updatedAt: "2026-08-28T09:00:00.000Z" },
    { id: "scr-c", name: "Newest", rowCount: 1, createdAt: "2026-08-30T09:00:00.000Z", updatedAt: "2026-08-30T09:05:00.000Z" },
    { id: "scr-b", name: "Uncounted", createdAt: "2026-08-29T09:00:00.000Z", updatedAt: "2026-08-29T09:00:00.000Z" },
    { id: "scr-d", name: "Undated" },
  ],
};
const BOARD_CROSS = {
  id: "cross",
  rows: [
    { query: "908 Pine, Bastrop TX", parcelNodeId: "48021:34137", resolution: "resolved", stub: STUB_SIX },
    { query: "100 Main St, Kyle TX", parcelNodeId: "48209:1", resolution: "resolved", stub: { situs: "present" } },
    { query: "zzzz-not-a-situs-99999", parcelNodeId: null, resolution: "unresolved" },
    { query: "elsewhere", parcelNodeId: "99999:1", resolution: "resolved" },
    { query: "927 Main St, Bastrop TX", parcelNodeId: "48021:33223", resolution: "resolved", stub: { flood: "present" } },
  ],
};
const BOARD_MIXED = {
  id: "mixed",
  rows: [
    { query: "c", parcelNodeId: "48021:3", resolution: "resolved", stub: { situs: "present", zoning: "present", landUse: "present", flood: "present" } },
    { query: "a", parcelNodeId: "48021:1", resolution: "resolved", stub: { situs: "present" } },
    { query: "e", parcelNodeId: "48021:5", resolution: "resolved", stub: STUB_SIX },
    { query: "d", parcelNodeId: null, resolution: "unresolved" },
    { query: "b", parcelNodeId: "48021:2", resolution: "resolved", stub: { flood: "present", zoning: "absent" } },
  ],
};
const DECLARED_S8 = {
  errorJson: { status: "error", reason: "not_found", upstreamStatus: 404, error: "not_found", upstreamBodyStatus: "gone" },
  errorUnmeasured: { status: "error", reason: "export_failed", upstreamStatus: "unmeasured", message: "The export proxy did not answer." },
  nonJson: { status: "error", reason: "upstream_non_json", upstreamStatus: 502, brief: "<html>502 Bad Gateway</html>" },
  cap: { status: "refused", reason: "parcel_batch_cap", cap: 25, received: 30, depth: "node" },
  screenId: { status: "refused", reason: "screen_id_not_accepted", error: "screen_id_not_accepted" },
  hop1: { status: "not_implemented", reason: "depth_not_implemented", depth: "hop1" },
  cortex: { status: "degraded", reason: "cortex_not_configured", message: "Smart Site MCP cannot reach the workbench backend." },
  exportDown: { status: "degraded", tool: "export_instrument", reason: "hauska_mcp_unavailable", dependency: "hauska-mcp", message: "Export is temporarily unavailable because Hauska MCP is unreachable.", hauska: { state: "down" } },
  notReady: { status: "not_ready", tool: "export_instrument", reason: "P-87 export honesty", message: "export_instrument is not available on Smart Site MCP yet." },
  upgrade: { status: "upgrade_required", reason: "deep_report", tier: "free", subscriptionTier: null, message: "Deep report needs Solo or above." },
};
const PARITY_S8: Record<string, unknown> = {
  screenS8: SCREEN_S8,
  screensList: SCREENS_S8,
  screensEmpty: { screens: [] },
  screensJunk: { screens: [{ id: 7 }, "x", null, { id: "ok", rowCount: "3" }, { id: "z", rowCount: 0 }] },
  screensNotArray: { screens: "x" },
  boardCross: BOARD_CROSS,
  boardMixed: BOARD_MIXED,
  candidatesJunk: { screen: { id: "j", rows: [{ query: "q", resolution: "ambiguous", candidates: [{ parcelNodeId: 7 }, { label: "x" }, "y", { parcelNodeId: "48021:1" }] }] } },
  stubReadJunk: { rows: [{ query: "q", parcelNodeId: "48021:1", stubRead: "maybe", stub: { situs: "present" } }, { query: "r", parcelNodeId: "48021:2", stubRead: "skipped", stub: { situs: "present" } }] },
  degradedJunk: { screen: { id: "s", rows: [{ query: "q", parcelNodeId: "48021:1" }], degraded: { timedOut: "x", duplicates: [{ query: "a" }, { query: "a", parcelNodeId: "48021:1", keptQuery: "b" }] } } },
  ...DECLARED_S8,
  statusWeird: { status: "weird", reason: "x" },
  statusBare: { status: "error" },
  statusJunkFields: { status: "error", reason: "x", brief: "y", cap: "25", upstreamStatus: "502", tool: 4 },
  statusOkBoard: { status: "ok", rows: [{ query: "q", parcelNodeId: "48021:1" }] },
  rowIdNotNode: { rows: [{ query: "q", id: "r9" }] },
  rowNullWithNodeId: { rows: [{ query: "q", parcelNodeId: null, id: "48021:1" }] },
};

/** the <tr ...>...</tr> segment containing a needle, on the flat painted html */
function rowHtml(html: string, needle: string): string {
  const row = html
    .split("<tr")
    .map((seg) => seg.split("</tr>")[0] ?? "")
    .find((seg) => seg.includes(needle));
  if (!row) throw new Error(`no table row containing ${needle}`);
  return row;
}
/** the painted query of every board row, in paint order */
function rowQueries(html: string): string[] {
  return html
    .split('<tr class="row"')
    .slice(1)
    .map((seg) => {
      const m = /<div class="pl">([^<]*)<\/div>|<div class="pn">([^<]*)<\/div>/.exec(seg);
      return (m?.[1] ?? m?.[2] ?? "").trim();
    });
}

describe("P-91 v2 board (served)", () => {
  it("B1 candidates: an ambiguous row paints each candidate with Use this, keeps the typed query with no Open, and drafts the add turn for the chosen id only; an unresolved situs offers Look this up; a node id that is not on file offers only the slot", () => {
    const f = fresh();
    f.init();
    f.toolResult(SCREEN_S8);
    expect(f.openButtons()).toBe(2);
    const amb = rowHtml(f.root.innerHTML, 'data-candidates="100 Main St"');
    expect(amb).toContain('data-candidate="48021:33223"');
    expect(amb).toContain('data-candidate="48209:700001"');
    expect((amb.match(/data-act="usecand"/g) ?? []).length).toBe(2);
    expect(amb).not.toContain('data-act="open"');
    expect(amb).not.toContain('data-act="lookup"');
    expect(f.strip(amb)).toContain(COPY3.ambiguous);
    expect(f.strip(amb)).toContain("100 Main St");
    expect(f.strip(amb)).toContain("927 MAIN ST , BASTROP, TX 78602");
    expect(f.strip(amb)).toContain("100 MAIN ST , KYLE, TX 78640");
    expect(f.strip(amb)).toContain(COPY3.useThis);
    expect(f.strip(amb)).toContain(COPY.nothingToOpen);
    expect(amb).toContain('data-candidate-county="48209"');
    expect(f.strip(amb)).toContain("Hays");
    expect(amb.slice(0, amb.indexOf('data-candidate="48209:700001"'))).not.toContain("data-candidate-county");
    const before = f.root.innerHTML;
    const fp = () => (f.sandbox.__ss as { fp: () => string }).fp();
    const fp0 = fp();
    const use = f.all('[data-act="usecand"]');
    expect(use.map((b) => b.getAttribute("data-node"))).toEqual(["48021:33223", "48209:700001"]);
    f.ss().useCandidate(use[0]);
    expect(f.lastText()).toBe(COPY3.useDraft("48021:33223", "100 Main St"));
    f.ss().useCandidate(use[1]);
    expect(f.lastText()).toBe(COPY3.useDraft("48209:700001", "100 Main St"));
    expect(f.messages()).toHaveLength(2);
    expect(f.armed(OPEN_DEAD_MS)).toBe(0);
    expect(f.text()).not.toContain(COPY.sent);
    expect(f.root.innerHTML).toBe(before);
    expect(fp()).toBe(fp0);
    /* forged: a resolved node is not a candidate; a candidate under another query is not; a missing slot is not */
    f.ss().useCandidate(f.btn({ "data-node": "48021:34137", "data-query": "100 Main St" }));
    f.ss().useCandidate(f.btn({ "data-node": "48021:33223", "data-query": "908 Pine, Bastrop TX" }));
    f.ss().useCandidate(f.btn({ "data-node": "48021:33223" }));
    f.ss().useCandidate(f.btn({}));
    expect(f.messages()).toHaveLength(2);
    /* the unresolved situs offers Look this up beside the slot; the node id that is not on file offers only the slot */
    const situs = rowHtml(f.root.innerHTML, "zzzz-not-a-situs-99999");
    expect(situs).toContain('data-act="lookup" data-query="zzzz-not-a-situs-99999"');
    expect(f.strip(situs)).toContain(COPY3.lookUp);
    expect(f.strip(situs)).toContain(COPY.nothingToOpen);
    expect(f.strip(situs)).toContain("situs unresolved");
    const node = rowHtml(f.root.innerHTML, "48021:900001");
    expect(node).not.toContain('data-act="lookup"');
    expect(f.strip(node)).toContain(COPY.nodeUnresolved);
    expect(f.strip(node)).toContain(COPY.nothingToOpen);
    const look = f.all('[data-act="lookup"]');
    expect(look.map((b) => b.getAttribute("data-query")).sort()).toEqual(["500 Slow Ln", "zzzz-not-a-situs-99999"]);
    f.ss().lookup(look.find((b) => b.getAttribute("data-query") === "zzzz-not-a-situs-99999"));
    expect(f.lastText()).toBe(COPY3.lookupDraft("zzzz-not-a-situs-99999"));
    f.ss().lookup(f.btn({ "data-query": "100 Main St" }));
    f.ss().lookup(f.btn({ "data-query": "908 Pine, Bastrop TX" }));
    f.ss().lookup(f.btn({ "data-query": "48021:900001" }));
    f.ss().lookup(f.btn({}));
    expect(f.messages()).toHaveLength(3);
    expect(f.armed(OPEN_DEAD_MS)).toBe(0);
    expect(f.text()).not.toContain(COPY.empty);
    expect(f.root.innerHTML).toBe(before);
  });

  it("B2 declared degradation: one note per duplicate and per timed-out query beneath the board; an errored or skipped read paints every rail unread and names the read state on the row; stubsDegraded stays one line, above the legend", () => {
    const f = fresh();
    f.init();
    f.toolResult(SCREEN_S8);
    const html = f.root.innerHTML;
    expect(f.text()).toContain(COPY3.dup("111 Rainmaker Cove, Bastrop TX", "111 Rainmaker Cv, Bastrop TX", "48021:8720522"));
    expect(f.text()).toContain(COPY3.timedOut("500 Slow Ln"));
    expect(html).toContain('data-duplicate="48021:8720522"');
    expect(html).toContain('data-timed-out="500 Slow Ln"');
    expect(html.indexOf("data-duplicate=")).toBeGreaterThan(html.indexOf("</table>"));
    expect(html.indexOf("data-duplicate=")).toBeLessThan(html.indexOf('<div class="legend"'));
    expect(html.indexOf("data-timed-out=")).toBeGreaterThan(html.indexOf("</table>"));
    /* the errored read: every rail unread despite the stub's claim, and the read state named on the row */
    expect(rowGlyphs(html, 'data-node="48021:8720522"')).toEqual(ALL_UNREAD);
    expect(rowGlyphs(html, 'data-node="48021:34137"')).toEqual(STUB_SIX_GLYPHS);
    const err = rowHtml(html, 'data-node="48021:8720522"');
    expect(err).toContain('data-stub-read="error"');
    expect(f.strip(err)).toContain(`${COPY3.railsNotRead} error`);
    expect(rowHtml(html, 'data-node="48021:34137"')).not.toContain("data-stub-read");
    /* stubsDegraded: the carried sentence, one line, above the legend */
    expect(f.text()).toContain(COPY.railsPartlyUnread);
    expect((f.text().match(/Some rails/g) ?? []).length).toBe(1);
    expect(html.indexOf(COPY.railsPartlyUnread)).toBeGreaterThan(html.indexOf("</table>"));
    expect(html.indexOf(COPY.railsPartlyUnread)).toBeLessThan(html.indexOf('<div class="legend"'));
    expect(f.text()).not.toContain(COPY.empty);
    expect(f.openButtons()).toBe(2);
    /* a skipped read names skipped; a screen with no degraded block paints no note */
    const g = fresh();
    g.init();
    g.toolResult({ id: "s", rows: [{ query: "q", parcelNodeId: "48021:1", resolution: "resolved", stubRead: "skipped", stub: { situs: "present" } }] });
    expect(g.root.innerHTML).toContain('data-stub-read="skipped"');
    expect(g.strip(rowHtml(g.root.innerHTML, 'data-node="48021:1"'))).toContain(`${COPY3.railsNotRead} skipped`);
    expect(rowGlyphs(g.root.innerHTML, 'data-node="48021:1"')).toEqual(ALL_UNREAD);
    expect(g.root.innerHTML).not.toContain("data-duplicate=");
    expect(g.root.innerHTML).not.toContain("data-timed-out=");
    expect(g.text()).not.toContain(COPY.railsPartlyUnread);
    expect(g.text()).not.toContain("not added twice");
  });

  it("B3 reopen picker: a bare list_screens paints the screens newest first with name, row count when carried and updated date; Open drafts the reopen turn on the board's own path with the 12 s timer and the Sent line; an empty list paints its own sentence, never the empty board copy", () => {
    const f = fresh();
    f.init();
    f.toolResult(SCREENS_S8);
    expect(f.openButtons()).toBe(0);
    const reopen = f.all('[data-act="reopen"]');
    expect(reopen.map((b) => b.getAttribute("data-screen"))).toEqual(["scr-c", "scr-b", "scr-a", "scr-d"]);
    expect(f.text()).toContain("Newest");
    expect(f.text()).toContain("Uncounted");
    expect(f.text()).toContain("Undated");
    expect(f.root.innerHTML).toContain('data-row-count="1">1 row</span>');
    expect(f.root.innerHTML).toContain('data-row-count="3">3 rows</span>');
    expect((f.root.innerHTML.match(/data-row-count=/g) ?? []).length).toBe(2);
    expect(f.root.innerHTML).toContain('data-updated="2026-08-30"');
    expect(f.text()).toContain("updated 2026-08-30");
    expect(f.text()).not.toContain("T09:05");
    expect(f.text()).not.toContain(COPY3.noScreens);
    for (const s of ALL_SENTENCES) expect(f.text(), s).not.toContain(s);
    const before = f.posted.length;
    f.ss().reopen(reopen[0]);
    const msg = f.messages().pop();
    expect(msg?.method).toBe("ui/message");
    expect(f.lastText()).toBe(COPY3.reopenDraft("scr-c"));
    expect(f.posted.length).toBe(before + 1);
    expect(f.armed(OPEN_DEAD_MS)).toBe(1);
    f.deliver({ jsonrpc: "2.0", id: msg?.id, result: {} });
    expect(f.boot.textContent).toContain("reply=ok");
    expect(f.text()).toContain(COPY.sent);
    expect(f.text()).not.toContain(COPY.dead);
    expect(f.armed(OPEN_DEAD_MS)).toBe(0);
    expect(f.all('[data-act="reopen"]')).toHaveLength(4);
    /* the reopened screen replaces the list and clears the line */
    f.toolResult(BOARD);
    expect(f.text()).not.toContain(COPY.sent);
    expect(f.all('[data-act="reopen"]')).toHaveLength(0);
    expect(f.openButtons()).toBe(2);
    /* dead: no reply in 12 s; the list stays */
    const g = fresh();
    g.init();
    g.toolResult(SCREENS_S8);
    g.ss().reopen(g.all('[data-act="reopen"]')[1]);
    expect(g.lastText()).toBe(COPY3.reopenDraft("scr-b"));
    expect(g.fire(OPEN_DEAD_MS)).toBe(1);
    expect(g.text()).toContain(COPY.dead);
    expect(g.all('[data-act="reopen"]')).toHaveLength(4);
    /* a forged control naming a screen the panel did not paint drafts nothing and arms nothing */
    g.ss().reopen(g.btn({ "data-screen": "scr-z" }));
    g.ss().reopen(g.btn({}));
    expect(g.messages()).toHaveLength(1);
    expect(g.armed(OPEN_DEAD_MS)).toBe(0);
    /* empty: its own sentence */
    const e = fresh();
    e.init();
    e.toolResult({ screens: [] });
    expect(e.text()).toContain(COPY3.noScreens);
    expect(e.text()).not.toContain(COPY.empty);
    expect(e.all('[data-act="reopen"]')).toHaveLength(0);
    expect(e.openButtons()).toBe(0);
  });

  it("B4 cross-county grouping: more than one county prefix paints one group per county named from the map (else the fips) and an Unresolved group last; rails and the slot stay per parcel; no group carries a count; a single-county board paints no group at all", () => {
    const f = fresh();
    f.init();
    f.toolResult(BOARD_CROSS);
    const html = f.root.innerHTML;
    expect(f.all("[data-county-group]").map((g) => g.getAttribute("data-county-group"))).toEqual(["48021", "48209", "99999", "unresolved"]);
    const titles = [...html.matchAll(/data-county-group="[^"]+"><th colspan="9">([^<]+)<\/th>/g)].map((m) => m[1]);
    expect(titles).toEqual(["Bastrop", "Hays", "99999", COPY3.unresolvedGroup]);
    const bastrop = f.segment('data-county-group="48021"', 'data-county-group="48209"');
    expect(bastrop).toContain('data-node="48021:34137"');
    expect(bastrop).toContain('data-node="48021:33223"');
    expect(bastrop).not.toContain('data-node="48209:1"');
    expect(f.segment('data-county-group="48209"', 'data-county-group="99999"')).toContain('data-node="48209:1"');
    expect(f.segment('data-county-group="99999"', 'data-county-group="unresolved"')).toContain('data-node="99999:1"');
    const loose = f.segment('data-county-group="unresolved"', "</tbody>");
    expect(loose).toContain("zzzz-not-a-situs-99999");
    expect(loose).not.toContain("data-node=");
    expect(f.strip(loose)).toContain(COPY.nothingToOpen);
    expect(rowGlyphs(html, 'data-node="48021:34137"')).toEqual(STUB_SIX_GLYPHS);
    expect(rowGlyphs(html, 'data-node="48209:1"')).toEqual(["present", "unread", "unread", "unread", "unread", "unread"]);
    expect(rowGlyphs(html, 'data-node="99999:1"')).toEqual(ALL_UNREAD);
    expect(f.openButtons()).toBe(4);
    for (const t of titles) expect(t).not.toMatch(/\d\s*(present|of|\/)/);
    expect(f.text()).not.toMatch(/\d+ of \d+|\d+\/6/);
    expect(f.text()).not.toContain(COPY.empty);
    const g = fresh();
    g.init();
    g.toolResult(BOARD);
    expect(g.root.innerHTML).not.toContain("data-county-group");
    expect(g.text()).not.toContain(COPY3.unresolvedGroup);
    const h = fresh();
    h.init();
    h.toolResult(LIVE_BATCH);
    expect(h.root.innerHTML).not.toContain("data-county-group");
    expect(h.openButtons()).toBe(2);
    /* two counties is the boundary: grouped, and no Unresolved group when every row resolved */
    const two = fresh();
    two.init();
    two.toolResult({ id: "two", rows: [BOARD_CROSS.rows[0], BOARD_CROSS.rows[1]] });
    expect(two.all("[data-county-group]").map((g) => g.getAttribute("data-county-group"))).toEqual(["48021", "48209"]);
    expect(two.text()).toContain("Bastrop");
    expect(two.text()).toContain("Hays");
    expect(two.text()).not.toContain(COPY3.unresolvedGroup);
  });

  it("B5 default sort by completeness: the board opens fewest-present first, ties by query; the header sorts still work and the completeness control returns; every sort is local and paints no count", () => {
    const f = fresh();
    f.init();
    f.toolResult(BOARD_MIXED);
    expect(rowQueries(f.root.innerHTML)).toEqual(["d", "a", "b", "e", "c"]);
    expect(f.root.querySelector("table")?.getAttribute("data-sort")).toBe("completeness");
    expect(f.root.querySelector("table")?.getAttribute("data-dir")).toBe("1");
    expect(f.text()).toContain(COPY3.byCompleteness);
    const fp = () => (f.sandbox.__ss as { fp: () => string }).fp();
    const fp0 = fp();
    const turns = () => f.posted.filter((m) => m.method === "ui/message" || m.method === "ui/open-link").length;
    const t0 = turns();
    f.root.querySelector('[data-k="completeness"]')!.dispatch("click");
    expect(rowQueries(f.root.innerHTML)).toEqual(["c", "e", "a", "b", "d"]);
    expect(f.root.querySelector("table")?.getAttribute("data-dir")).toBe("-1");
    f.root.querySelector('[data-k="query"]')!.dispatch("click");
    expect(rowQueries(f.root.innerHTML)).toEqual(["a", "b", "c", "d", "e"]);
    expect(f.root.querySelector("table")?.getAttribute("data-sort")).toBe("query");
    f.root.querySelector('[data-k="query"]')!.dispatch("click");
    expect(rowQueries(f.root.innerHTML)).toEqual(["e", "d", "c", "b", "a"]);
    f.root.querySelector('[data-k="id"]')!.dispatch("click");
    expect(rowQueries(f.root.innerHTML)).toEqual(["d", "a", "b", "c", "e"]);
    expect(f.root.querySelector("table")?.getAttribute("data-sort")).toBe("id");
    f.root.querySelector('[data-k="completeness"]')!.dispatch("click");
    expect(rowQueries(f.root.innerHTML)).toEqual(["c", "e", "a", "b", "d"]);
    expect(fp()).toBe(fp0);
    expect(turns()).toBe(t0);
    expect(f.armed(OPEN_DEAD_MS)).toBe(0);
    expect(f.text()).not.toMatch(/\d+\s*(present|known|of 6|\/6)/);
    expect(f.root.innerHTML).not.toMatch(/data-(rank|present-count|known)=/);
    /* a later result opens on the default order again */
    f.toolResult(BOARD_MIXED);
    expect(rowQueries(f.root.innerHTML)).toEqual(["d", "a", "b", "e", "c"]);
    expect(f.root.querySelector("table")?.getAttribute("data-sort")).toBe("completeness");
    expect(rowGlyphs(f.root.innerHTML, 'data-node="48021:5"')).toEqual(STUB_SIX_GLYPHS);
  });

  it("H1 every body has a sentence: each declared body paints its own line, never the empty copy; the brief is verbatim and escaped; upstream prints only when numeric; an isError reply to Open is a result; a status off the enum is not declared; the v1 refused shape still paints per parcel", () => {
    const cases: Array<[string, Record<string, unknown>, string[]]> = [
      ["errorJson", DECLARED_S8.errorJson, [`${COPY3.notReturned}: not_found`, "upstream 404"]],
      ["errorUnmeasured", DECLARED_S8.errorUnmeasured, [`${COPY3.notReturned}: export_failed`, "The export proxy did not answer."]],
      ["nonJson", DECLARED_S8.nonJson, [`${COPY3.notReturned}: upstream_non_json`, "upstream 502", "<html>502 Bad Gateway</html>"]],
      ["cap", DECLARED_S8.cap, [`${COPY3.refused}: parcel_batch_cap`, "cap 25", "received 30", "depth node"]],
      ["screenId", DECLARED_S8.screenId, [`${COPY3.refused}: screen_id_not_accepted`]],
      ["hop1", DECLARED_S8.hop1, [`${COPY3.notImplemented}: hop1`]],
      ["cortex", DECLARED_S8.cortex, [`${COPY3.notReturned}: cortex_not_configured`, "Smart Site MCP cannot reach the workbench backend."]],
      ["exportDown", DECLARED_S8.exportDown, [`${COPY3.notReturned}: hauska_mcp_unavailable`, "tool export_instrument", "Export is temporarily unavailable because Hauska MCP is unreachable."]],
      ["notReady", DECLARED_S8.notReady, [`export_instrument ${COPY3.notReady}: P-87 export honesty`, "export_instrument is not available on Smart Site MCP yet."]],
      ["upgrade", DECLARED_S8.upgrade, [COPY.refused, "reason deep_report", "tier free", "Deep report needs Solo or above."]],
    ];
    for (const [name, body, sentences] of cases) {
      const f = fresh();
      f.init();
      f.toolResult(body);
      for (const s of sentences) expect(f.text(), `${name}: ${s}`).toContain(s);
      expect(f.text(), name).not.toContain(COPY.empty);
      expect(f.openButtons(), name).toBe(0);
      expect(f.root.innerHTML, name).toContain(`data-declared="${String(body.status)}"`);
      const allowed = name === "upgrade" ? [COPY.refused] : [];
      for (const s of ALL_SENTENCES) if (!allowed.includes(s)) expect(f.text(), `${name}: ${s}`).not.toContain(s);
    }
    const nj = fresh();
    nj.init();
    nj.toolResult(DECLARED_S8.nonJson);
    expect(nj.root.innerHTML).toContain('<pre class="brief" data-brief="1">&lt;html&gt;502 Bad Gateway&lt;/html&gt;</pre>');
    expect(nj.root.innerHTML).not.toContain("<html>502");
    const um = fresh();
    um.init();
    um.toolResult(DECLARED_S8.errorUnmeasured);
    expect(um.root.innerHTML).not.toContain("data-upstream-status");
    expect(um.text()).not.toContain("upstream");
    /* an isError reply to the Open turn is a result: the declared line replaces the board, the timer clears, nothing is dead or sent */
    const f = fresh();
    f.init();
    f.toolResult(BOARD);
    const msg = f.open("48021:34137");
    expect(f.armed(OPEN_DEAD_MS)).toBe(1);
    f.deliver({ jsonrpc: "2.0", id: msg?.id, result: { isError: true, content: [{ type: "text", text: JSON.stringify(DECLARED_S8.cap) }] } });
    expect(f.boot.textContent).toContain("reply=isError");
    expect(f.text()).toContain(`${COPY3.refused}: parcel_batch_cap`);
    expect(f.armed(OPEN_DEAD_MS)).toBe(0);
    expect(f.fire(OPEN_DEAD_MS)).toBe(0);
    expect(f.text()).not.toContain(COPY.dead);
    expect(f.text()).not.toContain(COPY.sent);
    expect(f.text()).not.toContain(COPY.empty);
    /* a status off the enum names no state the panel knows: it is not declared */
    const w = fresh();
    w.init();
    w.toolResult({ status: "weird", reason: "x" });
    expect(w.root.innerHTML).not.toContain("data-declared");
    expect(w.text()).toContain(COPY.empty);
    /* the v1 refused shape (parcels plus refused rows) still paints per parcel, not a declared line */
    const r = fresh();
    r.init();
    r.toolResult(REFUSED);
    expect(r.text()).toContain(COPY.refused);
    expect(r.text()).toContain("48021:34137");
    expect(r.root.innerHTML).not.toContain("data-declared");
  });

  it("one parser (S8): the served parse agrees with the exported parseToolResult on every board fixture", () => {
    const f = fresh();
    const served = (f.sandbox.__ss as { parse: (t: string) => unknown }).parse;
    const diffs: string[] = [];
    for (const [name, fx] of Object.entries(PARITY_S8)) {
      const text = JSON.stringify(fx);
      const a = JSON.stringify(served(text));
      const b = JSON.stringify(app.parseToolResult(text));
      if (a !== b) diffs.push(`${name}\n  served:   ${a}\n  exported: ${b}`);
    }
    expect(diffs).toEqual([]);
    expect(app.parseToolResult(JSON.stringify(PARITY_S8.screenS8)).rows[2]?.candidates).toHaveLength(2);
    expect(app.parseToolResult(JSON.stringify(PARITY_S8.screensList)).kind).toBe("screens");
    expect(app.parseToolResult(JSON.stringify(PARITY_S8.screensJunk)).screens).toHaveLength(2);
    expect(app.parseToolResult(JSON.stringify(PARITY_S8.cap)).kind).toBe("declared");
    expect(app.parseToolResult(JSON.stringify(PARITY_S8.statusWeird)).kind).toBe("empty");
    expect(app.parseToolResult(JSON.stringify(PARITY_S8.stubReadJunk)).rows.map((r) => r.rails.situs)).toEqual(["present", "unread"]);
  });

  it("htmlContractViolations: the S8 checks fire on violated copies of the served html", () => {
    const clean = app.buildAppHtml();
    expect(app.htmlContractViolations(clean)).toEqual([]);
    expect(app.htmlContractViolations(clean.replace(/data-act="usecand"/g, 'data-act="pick"'))).toContain("candidate_control_unbound");
    expect(app.htmlContractViolations(clean.split(COPY3.lookUp).join("Find it"))).toContain("candidate_control_unbound");
    expect(app.htmlContractViolations(clean.replace(/data-duplicate=/g, "data-dup="))).toContain("duplicate_note_unbound");
    expect(app.htmlContractViolations(clean.split("did not resolve in time; unresolved for now.").join("was slow"))).toContain("duplicate_note_unbound");
    expect(app.htmlContractViolations(clean.replace(/data-act="reopen"/g, 'data-act="again"'))).toContain("reopen_opener_unbound");
    expect(app.htmlContractViolations(clean.split("No screens yet.").join("Nothing here."))).toContain("reopen_opener_unbound");
    expect(app.htmlContractViolations(clean.replace(/data-county-group=/g, "data-group="))).toContain("county_group_unmarked");
    expect(app.htmlContractViolations(clean.split(`"${COPY3.unresolvedGroup}"`).join('"Loose"'))).toContain("county_group_unmarked");
    expect(app.htmlContractViolations(clean.replace(/function sortBoardRows/g, "function orderRows"))).toContain("completeness_sort_unbound");
    expect(app.htmlContractViolations(clean.replace('data-k="completeness"', 'data-k="known"'))).toContain("completeness_sort_unbound");
    expect(app.htmlContractViolations(clean.replace(/data-declared=/g, "data-state="))).toContain("declared_body_unbound");
    expect(app.htmlContractViolations(clean.split(`"${COPY3.refused}"`).join('"Declined"'))).toContain("declared_body_unbound");
  });
});

/*
 * P-91 v3 M-2: the aerial ground, in the SERVED panel. The exported twin's
 * arithmetic is proved in tests/mcp-app-ground.test.ts; what is proved here is
 * that the iframe composes it, resets it on every accepted result, and paints
 * nothing when the anchor was not read.
 */
const GROUND_ANCHOR = { lat: 30.10592, lon: -97.32528, precision: "1e-5-deg", source: "bake-latlng-index" };
const GOLD_ANCHORED = goldWith((_d, b) => {
  b.anchor = GROUND_ANCHOR;
  b.anchorRead = { status: "ok" };
});
const GOLD_ANCHOR_ABSENT = goldWith((_d, b) => {
  b.anchorRead = { status: "absent", reason: "city_limits_fact_absent" };
});
const GOLD_ANCHOR_ERROR = goldWith((_d, b) => {
  b.anchorRead = { status: "error", reason: "anchor_read_timeout" };
});
const GOLD_ANCHOR_SKIPPED = goldWith((_d, b) => {
  b.anchorRead = { status: "skipped", reason: "anchor_read_batch_cap" };
});

describe("P-91 v3 M-2 aerial ground (served)", () => {
  it("an ok anchor paints tiles under the drawing, with the drawing untouched on top", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_ANCHORED);
    const html = f.root.innerHTML;
    const plan = app.groundPlan(
      app.parseToolResult(JSON.stringify(GOLD_ANCHORED)).ring ?? [],
      GROUND_ANCHOR,
      { status: "ok", reason: null },
    ).plan;
    expect(plan).not.toBeNull();
    expect((html.match(/<img class="gt"/g) ?? []).length).toBe(plan?.tiles.length);
    expect(html).toContain('data-ground="on"');
    expect(html).toContain(app.GROUND_TILE_ORIGIN);
    /* the drawing is byte identical to the one the panel paints with no ground */
    const bare = fresh();
    bare.init();
    bare.toolResult(GOLD_ANCHOR_ABSENT);
    const svgOf = (h: string) => h.slice(h.indexOf("<svg"), h.indexOf("</svg>") + 6);
    expect(svgOf(html)).toBe(svgOf(bare.root.innerHTML));
    /* and it sits behind the drawing, not over it */
    expect(html.indexOf('<div class="ground"')).toBeLessThan(html.indexOf("<svg"));
  });

  it("every non ok read paints the void ground and puts no tile request in the html", () => {
    for (const payload of [GOLD_ANCHOR_ABSENT, GOLD_ANCHOR_ERROR, GOLD_ANCHOR_SKIPPED, GOLD_NODE]) {
      const f = fresh();
      f.init();
      f.toolResult(payload);
      const html = f.root.innerHTML;
      expect(html).not.toContain("<img");
      expect(html).not.toContain("arcgisonline");
      expect(html).not.toContain("gwrap");
      expect(html).not.toContain('data-act="ground"');
    }
  });

  it("a coordinate arriving under a non ok read is dropped, never placed", () => {
    const forged = goldWith((_d, b) => {
      b.anchor = GROUND_ANCHOR;
      b.anchorRead = { status: "error", reason: "anchor_read_timeout" };
    });
    const f = fresh();
    f.init();
    f.toolResult(forged);
    expect(f.root.innerHTML).not.toContain("arcgisonline");
  });

  it("the toggle is local view state: it repaints and sends nothing", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_ANCHORED);
    const before = f.messages().length;
    const fp = (f.sandbox.__ss as { fp: () => string }).fp();
    f.ss().ground();
    expect(f.root.innerHTML).not.toContain("<img");
    expect(f.root.innerHTML).toContain('data-ground="off"');
    expect(f.root.innerHTML).toContain('data-ground-on="0"');
    /* the way back is still there, and the drawing is still there */
    expect(f.root.innerHTML).toContain('data-act="ground"');
    expect(f.root.innerHTML).toContain("<svg");
    f.ss().ground();
    expect(f.root.innerHTML).toContain("<img");
    expect(f.root.innerHTML).toContain('data-ground="on"');
    expect(f.messages()).toHaveLength(before);
    expect((f.sandbox.__ss as { fp: () => string }).fp()).toBe(fp);
  });

  it("the toggle resets to on with every accepted result", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_ANCHORED);
    f.ss().ground();
    expect(f.root.innerHTML).toContain('data-ground="off"');
    f.toolResult(GOLD_ANCHORED);
    expect(f.root.innerHTML).toContain('data-ground="on"');
    expect(f.root.innerHTML).toContain("<img");
  });

  it("the ground does not disturb the drawing's own controls", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_ANCHORED);
    expect(f.edges().length).toBeGreaterThan(0);
    f.hover(1);
    expect(f.tipText()).toContain("167.99 ft");
    f.leave(1);
    expect(f.tipText()).toBe(COPY.tipHint);
    expect(f.root.innerHTML).toContain('data-north="up"');
    expect(f.root.innerHTML).toContain("data-scale-ft=");
    expect(f.root.innerHTML).toContain("data-flood-tint=");
    expect(f.all('[data-act="report"]')).toHaveLength(1);
  });

  it("the ground toggle is not offered on a board", () => {
    const f = fresh();
    f.init();
    f.toolResult({ id: "scr_1", rows: [{ query: "1 Main", parcelNodeId: "48021:34137", resolution: "resolved", situs: "present" }] });
    expect(f.all('[data-act="ground"]')).toHaveLength(0);
  });
});

/*
 * P-91 v3 M-4: the SET, in the served panel. The composition arithmetic is
 * proved in tests/mcp-app-multi.test.ts; what is proved here is that the iframe
 * composes it, paints both named lists, resets the ground on every accepted
 * result, and hands the click to the same Open handler a single parcel uses.
 *
 * 48021:34137 at 30.11021, -97.31631 is a live read (2026-08-30). The second
 * anchor is SYNTHETIC, one recorded lot width (98.97 ft) east of it, expressed
 * in degrees so this file does not borrow the module's own arithmetic.
 */
const SET_LAT = 30.11021;
const SET_LON = -97.31631;
const SET_LON_EAST = SET_LON + (98.97 * (1200 / 3937)) / (((Math.PI * 6378137) / 180) * Math.cos((SET_LAT * Math.PI) / 180));
function setRow(id: string, lat: number, lon: number, over: Json = {}): Json {
  const base = {
    parcelNodeId: id,
    brief: { sections: [] },
    draw: { label: id + " label", frame: FRAME, ring: GOLD_NODE.draw.ring, edges: [], overlays: [] },
    anchor: { lat: lat, lon: lon, precision: "1e-5-deg", source: "bake-latlng-index" },
    anchorRead: { status: "ok" },
  } as unknown as Json;
  return Object.assign(base, over) as Json;
}
const SET_BODY = {
  parcels: [setRow("48021:34137", SET_LAT, SET_LON), setRow("48021:34161", SET_LAT, SET_LON_EAST)],
  notFound: [],
} as unknown as Json;
const SET_WITH_MISSES = {
  parcels: [
    setRow("48021:34137", SET_LAT, SET_LON),
    setRow("48021:34161", SET_LAT, SET_LON_EAST),
    setRow("48021:34169", SET_LAT, SET_LON, {
      anchor: undefined,
      anchorRead: { status: "error", reason: "anchor_read_timeout" },
    }),
  ],
  notFound: ["48021:404404"],
  anchorBatch: { cap: 12, received: 20, attempted: 12, notAttempted: 8, reason: "anchor_read_batch_cap" },
} as unknown as Json;

describe("P-91 v3 M-4 parcel set (served)", () => {
  it("two anchored parcels paint one canvas with two rings over the aerial ground", () => {
    const f = fresh();
    f.init();
    f.toolResult(SET_BODY);
    const html = f.root.innerHTML;
    expect(html).toContain('data-parcels="2"');
    expect((html.match(/class="phit"/g) ?? []).length).toBe(2);
    expect(html).toContain('data-parcel="48021:34137"');
    expect(html).toContain('data-parcel="48021:34161"');
    expect(html).toContain('data-ground="on"');
    expect(html).toContain(app.GROUND_TILE_ORIGIN);
    /* one canvas, not two single-parcel drawings */
    expect((html.match(/<svg/g) ?? []).length).toBe(1);
  });

  it("the two rings are at DIFFERENT x, so they are placed and not stacked", () => {
    const f = fresh();
    f.init();
    f.toolResult(SET_BODY);
    const labels = f.root.querySelectorAll("[data-parcel]");
    expect(labels).toHaveLength(2);
    const polys = f.root.innerHTML.match(/class="ring-fill" points="([^"]+)"/g) ?? [];
    expect(polys).toHaveLength(2);
    expect(polys[0]).not.toBe(polys[1]);
  });

  it("a parcel that could not be drawn is named on the page with its reason", () => {
    const f = fresh();
    f.init();
    f.toolResult(SET_WITH_MISSES);
    const html = f.root.innerHTML;
    expect(html).toContain('data-undrawn="48021:34169"');
    expect(html).toContain('data-undrawn="48021:404404"');
    expect(html).toContain("anchor_read_timeout");
    expect(html).toContain('data-drawn="48021:34137"');
    expect(html).toContain('data-drawn="48021:34161"');
    expect(f.strip(html)).toContain(app.MULTI_UNDRAWN_TITLE);
  });

  it("the truncation is stated on the page when the batch capped", () => {
    const f = fresh();
    f.init();
    f.toolResult(SET_WITH_MISSES);
    expect(f.root.innerHTML).toContain('data-anchor-not-read="8"');
    expect(f.strip(f.root.innerHTML)).toContain(app.MULTI_ANCHORS_READ);
  });

  it("clicking a parcel on the canvas drafts the ordinary Open turn", () => {
    const f = fresh();
    f.init();
    f.toolResult(SET_BODY);
    const hit = f.root.querySelector('[data-act="open"]');
    expect(hit?.getAttribute("data-node")).toBe("48021:34137");
    expect(f.root.innerHTML).toContain('onclick="window.__ss&&window.__ss.open(this)"');
    const posted = f.open("48021:34161");
    const parts = posted?.params?.content as Array<{ text?: string }> | undefined;
    expect(parts?.[0]?.text).toContain("48021:34161");
    expect(parts?.[0]?.text).toContain(app.OPEN_TURN_OPENER);
  });

  it("the ground toggle works on a set and removes every tile from the html", () => {
    const f = fresh();
    f.init();
    f.toolResult(SET_BODY);
    expect(f.root.innerHTML).toContain(app.GROUND_TILE_ORIGIN);
    f.ss().ground();
    expect(f.root.innerHTML).not.toContain(app.GROUND_TILE_ORIGIN);
    expect(f.root.innerHTML).toContain('data-ground="off"');
    /* still a canvas, still both parcels */
    expect(f.root.innerHTML).toContain('data-parcels="2"');
  });

  it("the ground resets to on for the next accepted result", () => {
    const f = fresh();
    f.init();
    f.toolResult(SET_BODY);
    f.ss().ground();
    expect(f.root.innerHTML).toContain('data-ground="off"');
    f.toolResult(SET_BODY);
    expect(f.root.innerHTML).toContain('data-ground="on"');
  });

  it("a batch with one drawable parcel paints today's single parcel panel, not a canvas", () => {
    const one = {
      parcels: [
        setRow("48021:34137", SET_LAT, SET_LON),
        setRow("48021:34161", SET_LAT, SET_LON_EAST, {
          anchor: undefined,
          anchorRead: { status: "absent", reason: "city_limits_fact_absent" },
        }),
      ],
      notFound: [],
    } as unknown as Json;
    const f = fresh();
    f.init();
    f.toolResult(one);
    expect(f.root.innerHTML).not.toContain("data-parcels=");
    expect(f.root.innerHTML).toContain('data-act="listing"');
  });
});

/*
 * P-91 v3 M-5 (served).
 *
 * Item 1: what this panel did not draw is named whether or not there is a
 * canvas. Item 2: the paint only preview channel on a door tooltip, and its two
 * invariants. Item 3: the tools= token on the boot strip.
 *
 * Every id below is a SYNTHETIC test input. What is asserted is what the panel
 * paints given a recorded wire shape, never that a number is true of Bastrop.
 */
const OFF_UNDRAWABLE = { anchor: undefined, anchorRead: { status: "absent", reason: "no_latlng_for_parcel" } } as unknown as Json;
const OFF_SEVEN_IDS = ["48021:70001", "48021:70002", "48021:70003", "48021:70004", "48021:70005", "48021:70006", "48021:70007"];
function offBody(drawable: number): Json {
  const rows: Json[] = [];
  for (let i = 0; i < OFF_SEVEN_IDS.length; i++) {
    const id = OFF_SEVEN_IDS[i] as string;
    rows.push(i < drawable ? setRow(id, SET_LAT, SET_LON + i * 0.0004) : setRow(id, SET_LAT, SET_LON, OFF_UNDRAWABLE));
  }
  return { parcels: rows, notFound: [] } as unknown as Json;
}
function namedOff(html: string): string[] {
  return [...html.matchAll(/data-undrawn="([^"]+)"/g)].map((m) => m[1] ?? "");
}

describe("P-91 v3 M-5 item 1 (served): the fallback names what it did not draw", () => {
  it("seven parcels with ONE drawable: the single parcel panel, plus all six named with reasons", () => {
    const f = fresh();
    f.init();
    f.toolResult(offBody(1));
    const html = f.root.innerHTML;
    /* still the single parcel panel: no canvas */
    expect(html).not.toContain("data-parcels=");
    expect(html).toContain('data-act="listing"');
    expect(namedOff(html).sort()).toEqual(OFF_SEVEN_IDS.slice(1).sort());
    expect(f.strip(html)).toContain(app.MULTI_OFF_CANVAS_TITLE);
    expect(f.strip(html)).toContain(app.multiNoCanvasWords(1, 7));
    expect((html.match(/no_latlng_for_parcel/g) ?? []).length).toBe(6);
  });

  it("seven parcels with ZERO drawable: all seven are named, the painted one included", () => {
    const f = fresh();
    f.init();
    f.toolResult(offBody(0));
    const html = f.root.innerHTML;
    expect(namedOff(html).sort()).toEqual([...OFF_SEVEN_IDS].sort());
    expect(f.strip(html)).toContain(app.multiNoCanvasWords(0, 7));
  });

  it("seven parcels with TWO drawable: a canvas, and the five still named", () => {
    const f = fresh();
    f.init();
    f.toolResult(offBody(2));
    const html = f.root.innerHTML;
    expect(html).toContain('data-parcels="2"');
    expect(namedOff(html).sort()).toEqual(OFF_SEVEN_IDS.slice(2).sort());
    expect(f.strip(html)).toContain(app.MULTI_UNDRAWN_TITLE);
    expect(f.strip(html)).not.toContain(app.MULTI_OFF_CANVAS_TITLE);
  });

  it("a genuine single parcel result declares nothing", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_NODE);
    expect(f.root.innerHTML).not.toContain("data-undrawn=");
    expect(f.root.innerHTML).not.toContain("data-no-canvas=");
  });
});

/* The door on GOLD_NODE edge 1. NODE_34121 carries four doors, used for the
 * single flight bound below. */
const DOOR_NODE = "48021:34169";
const DOOR_EDGE = 1;
const PREVIEW_STUB = {
  parcels: [
    {
      parcelNodeId: DOOR_NODE,
      label: "111 RAINMAKER CV, BASTROP, TX 78602",
      situs: "present",
      zoning: "present",
      landUse: "unknown",
      flood: "present",
      drainage: "unread",
      envelope: "refused",
    },
  ],
  notFound: [],
};
const PREVIEW_GLYPHS = ["present", "present", "unknown", "present", "unread", "refused"];

/*
 * The preview sentences, literal on purpose. Same two derivation rule as COPY
 * at the top of this file: the words are here, the constants are in the module,
 * and the equality below is what makes the panel assertions non circular. A
 * fixture that reads app.PREVIEW_* and asserts the panel printed app.PREVIEW_*
 * passes on any edit to the constant, including one that deletes the promise.
 */
const PV_COPY = {
  notInChat: "Not sent to the chat. Claude cannot see this.",
  pending: "Reading stub rails.",
  unsupported: "No preview available: this host does not offer app tool calls.",
  timedOut: "No preview available: the tool call did not answer in time.",
  error: "No preview available: the tool call returned an error",
  declined: "No preview available: the tool declined this read.",
  empty: "No preview available: the result carried no rails for this parcel.",
  busy: "No preview available: another preview is still open.",
};

describe("P-91 v3 M-5: the preview sentences are what this card says they are", () => {
  it("every constant equals the sentence written here", () => {
    expect(app.PREVIEW_NOT_IN_CHAT).toBe(PV_COPY.notInChat);
    expect(app.PREVIEW_PENDING).toBe(PV_COPY.pending);
    expect(app.PREVIEW_UNSUPPORTED).toBe(PV_COPY.unsupported);
    expect(app.PREVIEW_TIMED_OUT).toBe(PV_COPY.timedOut);
    expect(app.PREVIEW_ERROR).toBe(PV_COPY.error);
    expect(app.PREVIEW_DECLINED).toBe(PV_COPY.declined);
    expect(app.PREVIEW_EMPTY).toBe(PV_COPY.empty);
    expect(app.PREVIEW_BUSY).toBe(PV_COPY.busy);
  });

  it("the not-in-conversation promise is on EVERY state the block can paint", () => {
    /* one derivation is the panel, the other is the sentence above */
    for (const st of ["ok", "pending", "unsupported", "timeout", "busy", "declined", "empty", "error", "nonsense"]) {
      const html = app.previewBlockHtml("48021:1", st, st === "ok" ? { rails: { situs: "present", zoning: "unread", landUse: "unread", flood: "unread", drainage: "unread", envelope: "unread" } } : null, null);
      expect(html, st).toContain(PV_COPY.notInChat);
    }
  });

  it("no state but ok paints a rail glyph, and an unknown state word still says something", () => {
    for (const st of ["pending", "unsupported", "timeout", "busy", "declined", "empty", "error", "nonsense"]) {
      const html = app.previewBlockHtml("48021:1", st, null, null);
      expect(html, st).not.toContain('class="g g-');
      expect(html.length, st).toBeGreaterThan(0);
    }
    expect(app.previewBlockHtml("48021:1", "nonsense", null, null)).toContain(app.PREVIEW_UNSTATED);
    /* a row handed in under a non-ok state is still not painted */
    const row = { rails: { situs: "present", zoning: "present", landUse: "present", flood: "present", drainage: "present", envelope: "present" } };
    expect(app.previewBlockHtml("48021:1", "timeout", row, null)).not.toContain('class="g g-');
    expect(app.previewBlockHtml("48021:1", "timeout", row, null)).toContain(PV_COPY.timedOut);
  });
});

type Harness = ReturnType<typeof fresh>;
const toolCalls = (f: Harness) => f.posted.filter((m) => m.method === "tools/call");
function replyTo(f: Harness, id: unknown, payload: unknown): void {
  f.deliver({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } });
}
/** The preview block sliced off the end of the tooltip. Throws when absent. */
function pvBlock(f: Harness): string {
  const h = f.tip().innerHTML;
  const at = h.indexOf('<span class="pv"');
  if (at < 0) throw new Error("no preview block in the tooltip");
  return h.slice(at);
}
function hasPv(f: Harness): boolean {
  return f.tip().innerHTML.indexOf('<span class="pv"') >= 0;
}
/** A host that answers the handshake WITHOUT serverTools. */
function initNoTools(f: Harness): void {
  f.deliver({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2026-01-26", hostCapabilities: { message: {} } } });
}

describe("P-91 v3 M-5 item 2 (served): the paint only preview channel", () => {
  it("pointer transit fires nothing: the call needs the dwell, and leaving cancels it", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_NODE);
    f.hover(DOOR_EDGE);
    expect(toolCalls(f)).toHaveLength(0);
    expect(hasPv(f)).toBe(false);
    expect(f.armed(app.PREVIEW_DWELL_MS)).toBe(1);
    f.leave(DOOR_EDGE);
    expect(f.armed(app.PREVIEW_DWELL_MS)).toBe(0);
    expect(f.fire(app.PREVIEW_DWELL_MS)).toBe(0);
    expect(toolCalls(f)).toHaveLength(0);
  });

  it("a held hover fires exactly one tools/call, naming the neighbour at stub depth", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_NODE);
    f.hover(DOOR_EDGE);
    expect(f.fire(app.PREVIEW_DWELL_MS)).toBe(1);
    const calls = toolCalls(f);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params?.name).toBe(app.PREVIEW_TOOL);
    expect(calls[0]?.params?.arguments).toEqual({ parcelNodeId: [DOOR_NODE], depth: app.PREVIEW_DEPTH });
    /* the tool is one the catalog already has; no fourteenth tool */
    expect(app.APP_HOST_TOOLS).toContain(app.PREVIEW_TOOL);
    expect(f.boot.textContent).toContain("tools=pending");
    expect(f.armed(app.PREVIEW_TIMEOUT_MS)).toBe(1);
    /* pending is stated, and no rail glyph is painted for it */
    expect(f.strip(pvBlock(f))).toContain(PV_COPY.pending);
    expect(pvBlock(f)).not.toContain('class="g g-');
  });

  it("the answer paints the neighbour's six rails and NEVER enters the conversation", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_NODE);
    const before = f.messages().length;
    f.hover(DOOR_EDGE);
    f.fire(app.PREVIEW_DWELL_MS);
    replyTo(f, toolCalls(f)[0]?.id, PREVIEW_STUB);
    const pv = pvBlock(f);
    expect(pv).toContain('data-preview="' + DOOR_NODE + '"');
    expect(pv).toContain('data-preview-state="ok"');
    expect([...pv.matchAll(/class="g g-([a-z-]+)"/g)].map((m) => m[1])).toEqual(PREVIEW_GLYPHS);
    /* invariant 1, in words */
    expect(f.strip(pv)).toContain(PV_COPY.notInChat);
    /* invariant 1, mechanically: nothing was drafted, sent, or queued */
    expect(f.messages()).toHaveLength(before);
    expect(f.boot.textContent).toContain("tools=ok");
    expect(f.armed(app.PREVIEW_TIMEOUT_MS)).toBe(0);
  });

  it("the preview is visually distinct: none of its parts wear the tool result fact classes", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_NODE);
    f.hover(DOOR_EDGE);
    f.fire(app.PREVIEW_DWELL_MS);
    replyTo(f, toolCalls(f)[0]?.id, PREVIEW_STUB);
    const pv = pvBlock(f);
    /* the tooltip's own facts use tn, tf, tb and tw; the preview uses none */
    for (const cls of ['class="tn"', 'class="tf"', 'class="tb"', 'class="tw"']) {
      expect(pv, cls).not.toContain(cls);
    }
    /* and the facts above it still do */
    const facts = f.tip().innerHTML.slice(0, f.tip().innerHTML.indexOf('<span class="pv"'));
    expect(facts).toContain('class="tn"');
    /* the block has a rule of its own in the page, not the tooltip's */
    expect(app.buildAppHtml()).toContain(".tip .pv{");
  });

  it("invariant 2: acting on the door still drafts the ordinary turn, unchanged by the preview", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_NODE);
    f.hover(DOOR_EDGE);
    f.fire(app.PREVIEW_DWELL_MS);
    replyTo(f, toolCalls(f)[0]?.id, PREVIEW_STUB);
    const posted = f.open(DOOR_NODE);
    const content = posted?.params?.content as Array<{ text: string }>;
    /* byte identical to the turn the same door drafts with no preview at all */
    expect(content[0]?.text).toBe(app.openParcelMessage(DOOR_NODE));
    expect(content[0]?.text).not.toContain(app.PREVIEW_TITLE);
    expect(content[0]?.text).not.toContain("present");
    /* and the add_to_screen door control is equally untouched */
    f.ss().addToScreen(f.btn({ "data-node": DOOR_NODE }));
    expect(f.lastText()).toBe(app.addToScreenMessage(DOOR_NODE));
  });

  it("invariant 2, a second way: the drafted turn is byte identical with and without a preview", () => {
    /* Independent of app.openParcelMessage. Two panels, the same door, the same
     * click; one of them saw a preview first. If a preview can reach a turn at
     * all, these two strings differ. */
    const withPreview = fresh();
    withPreview.init();
    withPreview.toolResult(GOLD_NODE);
    withPreview.hover(DOOR_EDGE);
    withPreview.fire(app.PREVIEW_DWELL_MS);
    replyTo(withPreview, toolCalls(withPreview)[0]?.id, PREVIEW_STUB);
    const a = (withPreview.open(DOOR_NODE)?.params?.content as Array<{ text: string }>)[0]?.text;

    const without = fresh();
    without.init();
    without.toolResult(GOLD_NODE);
    without.hover(DOOR_EDGE);
    const b = (without.open(DOOR_NODE)?.params?.content as Array<{ text: string }>)[0]?.text;
    expect(toolCalls(without)).toHaveLength(0);
    expect(a).toBe(b);
    expect((a ?? "").length).toBe((b ?? "").length);
  });

  it("invariant 2, a third way: a preview changes no panel state at all", () => {
    /* The I5 fingerprint is the panel's own model. A preview that entered it
     * would move this string, and a preview that can move the model is a
     * preview that can reach a turn through some other control later. */
    const f = fresh();
    f.init();
    f.toolResult(GOLD_NODE);
    const fp = (f.sandbox.__ss as { fp: () => string }).fp();
    f.hover(DOOR_EDGE);
    f.fire(app.PREVIEW_DWELL_MS);
    replyTo(f, toolCalls(f)[0]?.id, PREVIEW_STUB);
    expect(pvBlock(f)).toContain('data-preview-state="ok"');
    expect((f.sandbox.__ss as { fp: () => string }).fp()).toBe(fp);
  });

  it("one call per neighbour per panel instance; a new result resets the budget", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_NODE);
    f.hover(DOOR_EDGE);
    f.fire(app.PREVIEW_DWELL_MS);
    replyTo(f, toolCalls(f)[0]?.id, PREVIEW_STUB);
    f.leave(DOOR_EDGE);
    f.hover(DOOR_EDGE);
    /* the answer is still there, and a second dwell fires and buys nothing:
     * the bound is in firePreview, not in whether a timer was armed */
    expect(pvBlock(f)).toContain('data-preview-state="ok"');
    expect(f.armed(app.PREVIEW_DWELL_MS)).toBe(1);
    expect(f.fire(app.PREVIEW_DWELL_MS)).toBe(1);
    expect(toolCalls(f)).toHaveLength(1);
    expect(pvBlock(f)).toContain('data-preview-state="ok"');
    /* a new accepted result is a new panel instance */
    f.toolResult(GOLD_NODE);
    f.hover(DOOR_EDGE);
    expect(hasPv(f)).toBe(false);
    expect(f.fire(app.PREVIEW_DWELL_MS)).toBe(1);
    expect(toolCalls(f)).toHaveLength(2);
  });

  it("one in flight at a time: a second door states the wait rather than calling", () => {
    const f = fresh();
    f.init();
    f.toolResult(NODE_34121);
    f.hover(1);
    f.fire(app.PREVIEW_DWELL_MS);
    expect(toolCalls(f)).toHaveLength(1);
    f.hover(2);
    expect(f.fire(app.PREVIEW_DWELL_MS)).toBe(1);
    expect(toolCalls(f)).toHaveLength(1);
    expect(pvBlock(f)).toContain('data-preview-state="busy"');
    expect(f.strip(pvBlock(f))).toContain(PV_COPY.busy);
    expect(pvBlock(f)).not.toContain('class="g g-');
    /* when the first answers, the door still under the pointer gets its dwell back */
    replyTo(f, toolCalls(f)[0]?.id, { parcels: [], notFound: [] });
    expect(f.armed(app.PREVIEW_DWELL_MS)).toBe(1);
    expect(f.fire(app.PREVIEW_DWELL_MS)).toBe(1);
    expect(toolCalls(f)).toHaveLength(2);
  });

  it("a timeout states it and paints no rails", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_NODE);
    f.hover(DOOR_EDGE);
    f.fire(app.PREVIEW_DWELL_MS);
    expect(f.fire(app.PREVIEW_TIMEOUT_MS)).toBe(1);
    expect(pvBlock(f)).toContain('data-preview-state="timeout"');
    expect(f.strip(pvBlock(f))).toContain(PV_COPY.timedOut);
    expect(pvBlock(f)).not.toContain('class="g g-');
    expect(f.strip(pvBlock(f))).toContain(PV_COPY.notInChat);
    expect(f.boot.textContent).toContain("tools=timeout");
  });

  it("an error reply states the code, on the tooltip and on the strip", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_NODE);
    f.hover(DOOR_EDGE);
    f.fire(app.PREVIEW_DWELL_MS);
    f.deliver({ jsonrpc: "2.0", id: toolCalls(f)[0]?.id, error: { code: -32601, message: "no such method" } });
    expect(pvBlock(f)).toContain('data-preview-state="error"');
    expect(f.strip(pvBlock(f))).toContain(PV_COPY.error);
    expect(f.strip(pvBlock(f))).toContain("-32601");
    expect(pvBlock(f)).not.toContain('class="g g-');
    expect(f.boot.textContent).toContain("tools=err-32601");
  });

  it("a host with no serverTools never calls, says so on the tooltip, and says so on the strip", () => {
    const f = fresh();
    initNoTools(f);
    expect(f.boot.textContent).toContain("tools=unsupported");
    f.toolResult(GOLD_NODE);
    f.hover(DOOR_EDGE);
    expect(f.fire(app.PREVIEW_DWELL_MS)).toBe(1);
    expect(toolCalls(f)).toHaveLength(0);
    expect(pvBlock(f)).toContain('data-preview-state="unsupported"');
    expect(f.strip(pvBlock(f))).toContain(PV_COPY.unsupported);
    expect(pvBlock(f)).not.toContain('class="g g-');
  });

  it("a handshake that never answers leaves the token measured, not unread", () => {
    const f = fresh();
    expect(f.boot.textContent).toContain("tools=unread");
    expect(f.fire(2000)).toBe(1);
    expect(f.boot.textContent).toContain("handshake=timeout");
    expect(f.boot.textContent).toContain("tools=unsupported");
    f.toolResult(GOLD_NODE);
    f.hover(DOOR_EDGE);
    f.fire(app.PREVIEW_DWELL_MS);
    expect(toolCalls(f)).toHaveLength(0);
    expect(pvBlock(f)).toContain('data-preview-state="unsupported"');
  });

  it("a result carrying no row for the id asked is a stated absence, not an empty rail set", () => {
    const empty = fresh();
    empty.init();
    empty.toolResult(GOLD_NODE);
    empty.hover(DOOR_EDGE);
    empty.fire(app.PREVIEW_DWELL_MS);
    replyTo(empty, toolCalls(empty)[0]?.id, { parcels: [], notFound: [] });
    expect(pvBlock(empty)).toContain('data-preview-state="empty"');
    expect(empty.strip(pvBlock(empty))).toContain(PV_COPY.empty);
    expect(pvBlock(empty)).not.toContain('class="g g-');

    /* second derivation: a well formed board that answers about a DIFFERENT
     * parcel is equally not an answer about this one */
    const wrong = fresh();
    wrong.init();
    wrong.toolResult(GOLD_NODE);
    wrong.hover(DOOR_EDGE);
    wrong.fire(app.PREVIEW_DWELL_MS);
    replyTo(wrong, toolCalls(wrong)[0]?.id, {
      parcels: [{ ...PREVIEW_STUB.parcels[0], parcelNodeId: "48021:99999" }],
      notFound: [],
    });
    expect(pvBlock(wrong)).toContain('data-preview-state="empty"');
    expect(pvBlock(wrong)).not.toContain('class="g g-');
  });

  it("a declined tool call is a decline, and the channel still measured ok", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_NODE);
    f.hover(DOOR_EDGE);
    f.fire(app.PREVIEW_DWELL_MS);
    f.deliver({
      jsonrpc: "2.0",
      id: toolCalls(f)[0]?.id,
      result: { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "refused", reason: "tier" }) }] },
    });
    expect(pvBlock(f)).toContain('data-preview-state="declined"');
    expect(f.strip(pvBlock(f))).toContain(PV_COPY.declined);
    expect(pvBlock(f)).not.toContain('class="g g-');
    expect(f.boot.textContent).toContain("tools=ok");
  });

  it("a preview never repaints the panel and a late reply for a retired panel is dropped", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_NODE);
    f.hover(DOOR_EDGE);
    f.fire(app.PREVIEW_DWELL_MS);
    const staleId = toolCalls(f)[0]?.id;
    /* a new result retires the panel instance */
    f.toolResult(NODE_34121);
    const painted = f.root.innerHTML;
    replyTo(f, staleId, PREVIEW_STUB);
    expect(f.root.innerHTML).toBe(painted);
    expect(f.root.innerHTML).not.toContain("data-preview=");
  });

  it("no stale preview: a road edge and a cleared hover carry no block at all", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_NODE);
    f.hover(DOOR_EDGE);
    f.fire(app.PREVIEW_DWELL_MS);
    replyTo(f, toolCalls(f)[0]?.id, PREVIEW_STUB);
    expect(hasPv(f)).toBe(true);
    /* edge 0 is an alley with a road and no neighbor: not a door */
    f.hover(0);
    expect(hasPv(f)).toBe(false);
    expect(f.armed(app.PREVIEW_DWELL_MS)).toBe(0);
    f.leave(0);
    expect(f.tipText()).toBe(COPY.tipHint);
    expect(hasPv(f)).toBe(false);
  });

  it("a ROW edge is not a door, so it never previews", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD_NODE);
    /* edge 2 is a ROW that DOES name a neighbor; edgeDoor still refuses it */
    f.hover(2);
    expect(f.tip().innerHTML).toContain("48021:34121");
    expect(hasPv(f)).toBe(false);
    expect(f.fire(app.PREVIEW_DWELL_MS)).toBe(0);
    expect(toolCalls(f)).toHaveLength(0);
  });
});

describe("P-91 v3 M-5: verify by violation", () => {
  const clean = app.buildAppHtml();
  const mut = (from: string, to: string): string => {
    const out = clean.split(from).join(to);
    if (out === clean) throw new Error("mutation changed nothing: " + from);
    return out;
  };

  it("the clean page carries no violation, old or new", () => {
    expect(app.htmlContractViolations(clean)).toEqual([]);
  });

  it("invariant 1 mutations fire preview_not_marked", () => {
    expect(app.htmlContractViolations(mut(app.PREVIEW_NOT_IN_CHAT, "Fresh from the record."))).toContain("preview_not_marked");
    expect(app.htmlContractViolations(mut('class="pv"', 'class="tn"'))).toContain("preview_not_marked");
    expect(app.htmlContractViolations(mut(".tip .pv{", ".tip .zz{"))).toContain("preview_not_marked");
    expect(app.htmlContractViolations(mut("data-preview-state=", "data-pstate="))).toContain("preview_not_marked");
    expect(app.htmlContractViolations(mut("function previewBlockHtml", "function previewBox"))).toContain("preview_not_marked");
    /* the mutation the FIRST version of this rule passed on: the line is deleted
     * from the block, and the sentence is still in the page as a var. */
    const noNote = mut(`'<span class="pvnote">' + PREVIEW_NOT_IN_CHAT + "</span></span>"`, `"</span>"`);
    expect(noNote).toContain(app.PREVIEW_NOT_IN_CHAT);
    expect(app.htmlContractViolations(noNote)).toContain("preview_not_marked");
    expect(app.htmlContractViolations(mut("previewRailsHtml(row)", "railsOf(row)"))).toContain("preview_not_marked");
  });

  it("a lost absence sentence fires preview_absence_unstated", () => {
    expect(app.htmlContractViolations(mut(app.PREVIEW_TIMED_OUT, "No data."))).toContain("preview_absence_unstated");
    expect(app.htmlContractViolations(mut(app.PREVIEW_UNSUPPORTED, "No data."))).toContain("preview_absence_unstated");
    expect(app.htmlContractViolations(mut(app.PREVIEW_UNSTATED, "No data."))).toContain("preview_absence_unstated");
    expect(app.htmlContractViolations(mut("function previewLine", "function pLine"))).toContain("preview_absence_unstated");
    expect(app.htmlContractViolations(mut("function previewRowFrom", "function pRow"))).toContain("preview_absence_unstated");
    /* a state word that stops being reached, with its sentence still declared */
    const noFallback = mut("  return PREVIEW_UNSTATED;", '  return "";');
    expect(noFallback).toContain(app.PREVIEW_UNSTATED);
    expect(app.htmlContractViolations(noFallback)).toContain("preview_absence_unstated");
    const noBusy = mut('if (state === "busy") return PREVIEW_BUSY;', "");
    expect(noBusy).toContain(app.PREVIEW_BUSY);
    expect(app.htmlContractViolations(noBusy)).toContain("preview_absence_unstated");
  });

  it("dropping the dwell, the single flight or the token fires preview_unbounded", () => {
    expect(app.htmlContractViolations(mut("function armPreviewDwell", "function armNow"))).toContain("preview_unbounded");
    expect(app.htmlContractViolations(mut("armPreviewDwell(door)", "firePreview(door)"))).toContain("preview_unbounded");
    expect(
      app.htmlContractViolations(mut("var PREVIEW_DWELL_MS=" + app.PREVIEW_DWELL_MS, "var PREVIEW_DWELL_MS=0")),
    ).toContain("preview_unbounded");
    expect(
      app.htmlContractViolations(mut("var PREVIEW_TIMEOUT_MS=" + app.PREVIEW_TIMEOUT_MS, "var PREVIEW_TIMEOUT_MS=0")),
    ).toContain("preview_unbounded");
    expect(app.htmlContractViolations(mut("previewInFlight", "pFlight"))).toContain("preview_unbounded");
    expect(app.htmlContractViolations(mut('var toolsText="tools=unread"', 'var toolsText="tools=ok"'))).toContain("preview_unbounded");
    expect(app.htmlContractViolations(mut('"data-tools"', '"data-tls"'))).toContain("preview_unbounded");
  });

  it("a second, missing or misplaced tools/call site fires tools_call_unmarked", () => {
    /* a second call anywhere */
    expect(app.htmlContractViolations(mut("  function tipEl(){", '  function tipEl(){parent.postMessage({method:"tools/call"},"*");'))).toContain(
      "tools_call_unmarked",
    );
    /* the markers gone */
    expect(app.htmlContractViolations(mut("/*P561_TOOLS_BEGIN*/", ""))).toContain("tools_call_unmarked");
    expect(app.htmlContractViolations(mut("/*P561_TOOLS_END*/", ""))).toContain("tools_call_unmarked");
    /* the markers intact but no longer around the call */
    const outside = clean
      .replace("/*P561_TOOLS_BEGIN*/", "")
      .replace("/*P561_TOOLS_END*/", "")
      .replace("})();", "/*P561_TOOLS_BEGIN*/ /*P561_TOOLS_END*/\n})();");
    expect(outside).not.toBe(clean);
    expect(app.htmlContractViolations(outside)).toContain("tools_call_unmarked");
  });

  it("the P561 block is NOT exempt: a fetch inside it still fires direct_network", () => {
    const planted = mut("function sendToolsCall(pid,node){", 'function sendToolsCall(pid,node){fetch("https://x.example/");');
    const v = app.htmlContractViolations(planted);
    expect(v).toContain("direct_network");
    expect(v).not.toContain("tools_call_unmarked");
  });

  it("making the off canvas list conditional on the canvas fires off_canvas_list_unbound", () => {
    /* The mutation that caught a VACUOUS check on this file's own first pass.
     * The rule was a presence check on the text "offCanvasHtml(model)", which
     * the emitted declaration `function offCanvasHtml(model) {` satisfies, so a
     * page that defined the list and never painted it passed. The rule now
     * counts CALL sites, and the declaration does not count as one. */
    const dropped = mut("+offCanvasHtml(model)+", "+");
    expect(dropped).toContain("function offCanvasHtml(model)");
    expect(app.htmlContractViolations(dropped)).toContain("off_canvas_list_unbound");
    expect(app.htmlContractViolations(mut("function offCanvasParcels", "function otherParcels"))).toContain("off_canvas_list_unbound");
    expect(app.htmlContractViolations(mut("function offCanvasHtml", "function otherHtml"))).toContain("off_canvas_list_unbound");
    expect(app.htmlContractViolations(mut("data-no-canvas=", "data-nc="))).toContain("off_canvas_list_unbound");
    expect(app.htmlContractViolations(mut(app.MULTI_OFF_CANVAS_TITLE, "Other parcels"))).toContain("off_canvas_list_unbound");
    expect(app.htmlContractViolations(mut(app.MULTI_NO_CANVAS, "not drawn"))).toContain("off_canvas_list_unbound");
  });

  it("the M-4 canvas rule is untouched and the tool catalog is still 13", () => {
    expect(app.htmlContractViolations(mut(app.MULTI_UNDRAWN_TITLE, "Other parcels"))).toContain("multi_canvas_unbound");
    expect(clean).not.toContain("get_parcel_set");
    expect(clean).not.toContain("preview_parcel");
  });
});
