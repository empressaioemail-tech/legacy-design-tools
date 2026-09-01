/**
 * P-91 v3 V1/V2. The single vocabulary table for the machine tokens this
 * server puts on the wire: the disposition enum, the refusal codes, the two
 * Open failure sentences, citationsDegraded, confidence "seed", edge role
 * side_corner, and frame quality gis-approximate.
 *
 * Where a display string already exists as the panel's own copy (mcp-app.ts
 * STATE_WORDS, OPEN_DID_NOT_REACH_ME, NOT_ON_FILE_PREFIX,
 * NO_BAKED_SNAPSHOT_PREFIX, UPGRADE_TO_OPEN, NOT_IMPLEMENTED_PREFIX,
 * CITATION_DEGRADED, EDGE_WORDS, envelopeHuman), this table imports the
 * VALUE rather than retyping the string. A changed panel copy changes this
 * table with it; a renamed or removed export breaks the build instead of
 * silently diverging. That is the whole point: one table, owned in one
 * place, read by both the wire (tool-honesty.ts) and the panel (mcp-app.ts),
 * so drift between what the model reads and what the panel paints is
 * impossible rather than merely unlikely.
 *
 * mcp-app.ts may not import a VALUE from this module (half of it is
 * embedded into the served script by source, and this module would not
 * exist in that scope); the dependency runs one way, this module reading
 * mcp-app.ts's exported constants, never the reverse.
 */
import {
  CITATION_DEGRADED,
  EDGE_WORDS,
  envelopeHuman,
  NO_BAKED_SNAPSHOT_PREFIX,
  NOT_IMPLEMENTED_PREFIX,
  NOT_ON_FILE_PREFIX,
  OPEN_DID_NOT_REACH_ME,
  STATE_WORDS,
  UPGRADE_TO_OPEN,
} from "./mcp-app.js";

export type VocabularyEntry = {
  /** The exact machine token as it appears in code or on the wire. */
  token: string;
  /** The exact string a lay reader gets. Sourced from the panel's own copy where one exists. */
  displayText: string;
  /** One line: what the token means, and where it matters, what it does not claim. */
  meaning: string;
};

/**
 * Wire-level section disposition words (tool-honesty.ts sectionDisposition
 * / ExternalBriefSectionDisposition). Distinct from the panel's five-state
 * PAINT vocabulary (mcp-app.ts STATE_WORDS / CellState), though as of P-91
 * v3 item 1 the two now overlap: `unknown` and `absent-verified` are the
 * union's own display words, not the panel's earned-locally versions of
 * them (a section that CLAIMS one of those two is preserved as claimed, not
 * re-derived -- see tool-honesty.ts sectionDisposition). Cortex does not
 * emit either at section level today (confirmed against
 * artifacts/api-server's own R1BriefSectionDisposition type and the WDLL
 * item 5 ruling withholding absent-verified there), so in practice the wire
 * still only ever carries the original four; this table's other two rows
 * exist so the display text is correct the day a section does. Both rows
 * reuse STATE_WORDS' own strings rather than retype them, so the panel's
 * word and the wire's word for the same token cannot drift apart.
 */
export const WIRE_DISPOSITION_DISPLAY_TEXT: Record<
  "present" | "refused" | "absent" | "unread" | "unknown" | "absent-verified",
  string
> = {
  present: "Present",
  refused: "Refused",
  absent: "Reported absent",
  unread: "Not read",
  unknown: STATE_WORDS.unknown,
  "absent-verified": STATE_WORDS["absent-verified"],
};

/**
 * V5 (P-91 v3). Nothing in the wire shape prohibited computing an area or a
 * coverage ratio from draw.ring; a session did exactly that. This is the
 * stated policy, carried in the payload next to the geometry it governs
 * (see sanitizeExternalDraw), not left as a convention nobody reads.
 */
export const DERIVED_FIGURES_POLICY = {
  denies: [
    "area",
    "coverage_ratio",
    "lot_coverage_pct",
    "setback_distance",
    "buildable_area",
  ],
  reason:
    "ring, edges, and overlays are for rendering only. Do not compute an area, a coverage ratio, a percentage, or a distance from them; use a brief section's own figure, or say the figure is not on record.",
} as const;

function requireString(value: string | undefined, what: string): string {
  if (!value) {
    throw new Error(`vocabulary: ${what} produced no display string`);
  }
  return value;
}

/**
 * atom_path_pending's display text is read out of envelopeHuman, the same
 * function the panel calls, rather than retyped here. If that mapping is
 * ever removed, this throws at module load instead of silently shipping the
 * raw token as its own "display text".
 */
const ATOM_PATH_PENDING_DISPLAY_TEXT = requireString(
  envelopeHuman("atom_path_pending"),
  'envelopeHuman("atom_path_pending")',
);

/**
 * V1. 19 entries: the disposition enum, the panel-only paint additions
 * (absent-verified, unknown), the two Open failure sentences (kept
 * distinct, checked by tests/vocabulary.test.ts), citationsDegraded,
 * confidence "seed", frame quality gis-approximate, edge role side_corner,
 * and the refusal/reason codes read out of tool-honesty.ts, mcp-app.ts and
 * their tests (declined-in-bake, not-in-bake, atom_path_pending,
 * upgrade_required, parcel_not_found, baked_snapshot_not_found,
 * parcel_batch_cap, depth_not_implemented). Every token here is grepped out
 * of the source, not invented; see the P-91 v3 handback for the grep trail.
 */
export const VOCABULARY: readonly VocabularyEntry[] = [
  {
    token: "present",
    displayText: WIRE_DISPOSITION_DISPLAY_TEXT.present,
    meaning:
      "The section or rail carries confirmed on-record data for this parcel.",
  },
  {
    token: "absent",
    displayText: WIRE_DISPOSITION_DISPLAY_TEXT.absent,
    meaning:
      "The source claims no record exists, not yet verified by provenance or a known vintage. A claim, not yet a confirmed absence.",
  },
  {
    token: "absent-verified",
    displayText: STATE_WORDS["absent-verified"],
    meaning:
      "Confirmed absent: the absence claim carries provenance or a known source vintage. A panel-side paint state, earned from a wire 'absent' claim, never asserted directly on the wire.",
  },
  {
    token: "unknown",
    displayText: STATE_WORDS.unknown,
    meaning:
      "Not a finding either way. The record neither confirms present nor earns a verified absence.",
  },
  {
    token: "refused",
    displayText: WIRE_DISPOSITION_DISPLAY_TEXT.refused,
    meaning:
      "The producer declined to answer on this read path. See the refusal code and reason for why.",
  },
  {
    token: "unread",
    displayText: WIRE_DISPOSITION_DISPLAY_TEXT.unread,
    meaning:
      "Not read on this call. Distinct from absent: nothing was checked, so there is no claim to report either way.",
  },
  {
    token: "citationsDegraded",
    displayText: CITATION_DEGRADED,
    meaning:
      "A present claim carries no verifiable https citation; the source exists but could not be linked.",
  },
  {
    token: "gis-approximate",
    displayText: "GIS-approximate",
    meaning:
      "frame.quality: the boundary ring is derived from public GIS parcel geometry, not a field survey. Printed distances are approximate, not surveyed.",
  },
  {
    token: "seed",
    displayText: "Seed confidence",
    meaning:
      "draw.confidence: a first-pass geometric estimate, not a calibrated confidence score, a percentage, or a probability.",
  },
  {
    token: "side_corner",
    displayText: EDGE_WORDS.side_corner,
    meaning:
      "The property line runs along a corner lot's side yard, not its primary front or rear line.",
  },
  {
    token: "atom_path_pending",
    displayText: ATOM_PATH_PENDING_DISPLAY_TEXT,
    meaning:
      "Setbacks and the buildable envelope have not been ruled or baked for this jurisdiction yet; no distance or polygon exists to report.",
  },
  {
    token: "upgrade_required",
    displayText: UPGRADE_TO_OPEN,
    meaning:
      "The caller's tier does not include this depth of read. A plan upgrade or a 30-day unlock on the parcel is required.",
  },
  {
    token: "parcel_not_found",
    displayText: `${NOT_ON_FILE_PREFIX} <county>`,
    meaning:
      "No parcel record exists in this server's coverage for the given id. A genuine server-declared miss (missClass absent), distinct from 'open_did_not_reach_me', which is a client-side delivery failure and makes no claim about the parcel.",
  },
  {
    token: "baked_snapshot_not_found",
    displayText: `${NO_BAKED_SNAPSHOT_PREFIX} <parcelNodeId>`,
    meaning:
      "The parcel itself may exist, but the Smart Site facet snapshot has not been baked yet. parcelExists states whether the parcel itself was confirmed, independent of this snapshot miss.",
  },
  {
    token: "parcel_batch_cap",
    displayText: "Batch too large",
    meaning:
      "The request exceeded the array cap for this depth: 50 at stub, 25 at node.",
  },
  {
    token: "open_did_not_reach_me",
    displayText: OPEN_DID_NOT_REACH_ME,
    meaning:
      "Client-side only: the Open click produced no tool result within the host's timeout window. No claim was made about the parcel; this is not a miss, distinct from 'parcel_not_found'.",
  },
  {
    token: "depth_not_implemented",
    displayText: NOT_IMPLEMENTED_PREFIX,
    meaning:
      "hop1 and subgraph depths are not built yet. Not a data miss; the read path itself does not exist.",
  },
  {
    token: "declined-in-bake",
    displayText: "Declined in bake",
    meaning:
      "refusal.code: the producer evaluated this facet during the bake and declined it. refusal.declineReason carries the specific sub-reason (for example no-zoning-stamp).",
  },
  {
    token: "not-in-bake",
    displayText: "Not in bake",
    meaning:
      "refusal.code: this facet was never attempted in the bake that produced this snapshot.",
  },
  /**
   * P-91 v3 Q1. The five closed refusal codes radius-search and
   * street-search return as a 422 `serve_refused` body (gtmErrorClass.ts,
   * txgioRadiusSearch.ts, txgioStreetSearch.ts, read 2026-08-31). Every one
   * of these is a DECLARED REFUSAL, not an upstream fault: the producer
   * looked at the request and answered honestly that it will not (or
   * cannot) bound the result. tool-honesty.ts's declarePlaceSearchRefusal
   * reads the display text for these five back out of this table, so the
   * word the model sees and the word documented here cannot drift apart.
   * No numeric threshold (the radius max, the candidate ceiling) is
   * hardcoded into any meaning below: those values live in api-server, a
   * repo this package has no dependency on and cannot verify was not
   * bumped since this was written.
   */
  {
    token: "radius_invalid",
    displayText: "Invalid radius search input",
    meaning:
      "serve_refused reason (near): lat, lng, or radiusFt was missing, non-finite, or radiusFt was not a positive number. A caller-input problem on this specific call, not a claim about the area.",
  },
  {
    token: "radius_exceeds_max",
    displayText: "Radius exceeds the maximum",
    meaning:
      "serve_refused reason (near): radiusFt exceeded the stated maximum this search allows. Lower the radius and retry; not a claim that no parcels exist out there.",
  },
  {
    token: "radius_unbounded",
    displayText: "Too many parcels in that radius",
    meaning:
      "serve_refused reason (near): the candidate parcel count for that point and radius exceeded what this search can bound honestly. Too many parcels in that radius to answer, not that the search failed; narrow the radius or lower cap.",
  },
  {
    token: "bare_street_unbounded",
    displayText: "Street name needs a locality",
    meaning:
      "serve_refused reason (street): a bare street name with no city, ZIP, or countyFips was refused rather than run as an unbounded contains across every county in coverage. Add a city, ZIP, or countyFips and retry.",
  },
  {
    token: "bare_street_not_a_street",
    displayText: "Not a bare street name",
    meaning:
      "serve_refused reason (street): the query reads as a house-number-prefixed address, not a bare street name. Use find_parcel's plain query (or near) for one specific address instead of street.",
  },
] as const;

export const VOCABULARY_RESOURCE_URI = "docs://smartsite/vocabulary-p91v3.json";
export const VOCABULARY_MIME = "application/json";

/**
 * V2, payload half, resource leg. The vocabulary as an MCP resource the
 * assistant can read directly, independent of any single tool call.
 */
export function buildVocabularyResourceText(): string {
  return JSON.stringify({ vocabulary: VOCABULARY }, null, 2);
}

/** Same dual-signature shape as mcp-app.ts registerMcpApp, so one server object serves both. */
export function registerVocabularyResource(server: {
  registerResource?: (
    name: string,
    uri: string,
    config: Record<string, unknown>,
    handler: (uri: { href: string }) => Promise<{
      contents: Array<{ uri: string; mimeType: string; text: string }>;
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
      { uri: uri.href, mimeType: VOCABULARY_MIME, text: buildVocabularyResourceText() },
    ],
  });
  if (typeof server.registerResource === "function") {
    server.registerResource(
      "Smart Site vocabulary",
      VOCABULARY_RESOURCE_URI,
      { mimeType: VOCABULARY_MIME },
      handler,
    );
    return;
  }
  if (typeof server.resource === "function") {
    server.resource(
      "Smart Site vocabulary",
      VOCABULARY_RESOURCE_URI,
      { mimeType: VOCABULARY_MIME },
      handler,
    );
  }
}

/**
 * V2, payload half, standing-block leg. Attached to EVERY tool result as an
 * ADDITIONAL content entry (tools.ts attachStandingVocabBlock), never
 * replacing content[0], which stays the tool's own JSON. Lookup only: token,
 * displayText, meaning triples. No behavioural instruction lives here (that
 * is agentGuidance's job, attached per-facet in tool-honesty.ts, and it is
 * explicitly allowed to instruct); this block only ever tells the model what
 * a code means, never what to do about it.
 *
 * Computed once at module load from the static table above: no timestamp,
 * no per-request field, so it is byte-identical across every call and every
 * tool for the life of the process.
 *
 * What is true and load-bearing about this mechanism, and does not change
 * by adding more fields to it: it reaches the assistant only on a turn
 * where a Smart Site MCP tool is actually called. Every call re-arms the
 * vocabulary fresh, which is the point, but it holds no framing across a
 * run of turns where no Smart Site tool is invoked. Continuity across
 * off-topic turns is not this mechanism's job; the canonical-doc half of
 * V2 (planner-owned, filed in doc_repo, not in this repo) is what is
 * supposed to carry that, and this lane does not build it.
 */
export const STANDING_VOCAB_BLOCK_TEXT: string = JSON.stringify({
  smartSiteVocabulary: VOCABULARY.map(({ token, displayText, meaning }) => ({
    token,
    displayText,
    meaning,
  })),
  resource: VOCABULARY_RESOURCE_URI,
});

export const STANDING_VOCAB_CONTENT_PART: { type: "text"; text: string } = {
  type: "text",
  text: STANDING_VOCAB_BLOCK_TEXT,
};
