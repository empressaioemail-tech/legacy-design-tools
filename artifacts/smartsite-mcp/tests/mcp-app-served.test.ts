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
