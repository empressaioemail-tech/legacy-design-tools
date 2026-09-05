/** WDLL P-91 / P-92 — eight live tools plus five screen/save tools, plus P-106 find_parcels (14), plus P-113 list_purchased_records / read_purchased_record (16). */
export const SMARTSITE_MCP_TOOLS = [
  {
    name: "find_parcel",
    title: "Find a parcel",
    description:
      "Resolve one address or parcel node id to candidate parcels from county parcel records in Smart Site's Texas coverage today (coverage widens over time; never assume a fixed county list). Exactly one of query, near, or street is required; giving none or more than one is refused. query: returns hits (up to 10 parcel records, each with parcelNodeId, situs and county) or hits: [] with a missClass. When nothing binds to a parcel but the address itself is known, `located` lists address points (latitude, longitude, county; no parcel id) and missClass is located-unbound; a located row is not a parcel and must never be passed to get_smart_site or add_to_screen. A query mode address that resolves to a state outside coverage (e.g. Phoenix, AZ) comes back as hits: [] with missClass out_of_coverage, plus missClassDisplayText and an agentGuidance sentence naming what is covered today — this is the honest opposite of no-hit: not \"looked and found nothing\", but \"never had coverage to look\". near {query, radiusFt, cap?}: every parcel within radiusFt feet of query (an address or a parcel node id as centre). street {query, cap?, countyFips?}: every parcel on a bare street name (\"everyone on Pine St\"), city/ZIP/countyFips required to bound it. Both near and street return cap, received and truncated on success; truncated true means more parcels matched than cap allowed, the set is not complete, and the caller should narrow the radius or street, or raise cap. An invalid or too-large radius, too many candidates to bound honestly, a street with no locality, or a street query that is actually a house-numbered address comes back as status refused with a reason (radius_invalid, radius_exceeds_max, radius_unbounded, bare_street_unbounded, bare_street_not_a_street) and a reasonDisplayText — a declared refusal, not an error. Use query for a single lookup or to disambiguate one ambiguous screen row, then call get_smart_site on the chosen id. For two or more addresses, or a list the user wants to keep, use create_screen instead. An empty in-coverage result (no-hit) means no match on file, not that the parcel does not exist; an out-of-coverage result means the same about the PLACE, not the parcel.",
    readiness: "live" as const,
  },
  {
    name: "find_parcels",
    title: "Find parcels by constraint",
    description:
      "PLURAL. Ask a question ACROSS parcels in one county: \"Bastrop County, two acres or more, outside the floodplain\". Requires countyFips (one of 48021 Bastrop, 48055 Caldwell, 48209 Hays, 48309 McLennan, 48453 Travis, 48491 Williamson) plus a non-empty filters array; a request with no county, or one whose text reads as a single street address, is refused and routed to find_parcel. This is NOT the tool for looking up an address, a bare street, or a radius; that is find_parcel, singular. Filters are {rail, op, value} over rails acreage, landUse, cityLimits, etj, zoningDistrict, flood, specialDistrict, marketValue, landValue, improvementValue, yearBuilt. ops: gte/lte/eq on an ordered rail, eq/in on a categorical one, absent (matches ONLY a positive verified absence, never an unmeasured cell), is_true/is_false on flood's SFHA flag. THE RESULT IS THREE SETS AND ALL THREE ARE ALWAYS PRESENT: matched (the parcels, capped, with truncated true when more matched than cap allowed), excluded (parcels that definitively failed a filter, broken down byRail), and notEvaluated (parcels whose qualification turns on a rail nobody measured on them, broken down byRail). A parcel that fails a measured filter is EXCLUDED even when another rail is unmeasured, because it fails whatever that rail turns out to be. Never report matched alone: notEvaluated is where the caller's own diligence is still owed. byRail counts parcels per rail and a parcel missing two rails increments both, so byRail sums exceed the set count by design. unmeasuredPctByRail carries each filtered rail's unmeasured share of the whole county. projection.builtAt is when the cache was built, projection.stale says whether it is past its budget, and neither is the time of this call. A filter on a rail unmeasured beyond the configured ceiling comes back status refused, reason constraint_rail_unmeasured, carrying the measured percentage; other declared refusals are constraint_bound_missing, constraint_county_out_of_scope, constraint_single_address, constraint_filters_missing, constraint_rail_unknown, constraint_op_unsupported and constraint_projection_missing. A refusal is a declared answer, not an error. Returns no owner data, no listings, no sales, and no ranking: it returns parcels that satisfy stated constraints and says nothing about which is better. Pass the returned parcelNodeId values straight to create_screen as queries to build a screen from the result.",
    readiness: "live" as const,
  },
  {
    name: "get_smart_site",
    title: "Get its smart site",
    description:
      "Read one parcel's on-record Smart Site facts by parcel node id (from find_parcel or a screen row). Any parcel in coverage; it does not need to be saved or on a screen. depth \"stub\" (default for an array): label, node id, smartsite.cloud link, and one of present / absent-verified / unknown / refused / unread for situs, zoning, landUse, flood, drainage, envelope. depth \"node\" (default for one id) is this connector's equivalent of the web app's Brief/Inspect dock -- the same basic property snapshot, not a formal report: onRecord (apn, acreage, county, situs state, CAD-roll market/assessed/land/improvement value), structuralFact (living area, year built), the five brief sections (zoning district and jurisdiction, land use, flood zone, setbacks-envelope, drainage) each with disposition and citations -- setbacks-envelope's data carries real setback distances and buildable-envelope area whenever a ruled table exists for that district, never withheld by depth -- plus cityLimitsFact, utilityServiceFact, overlayDistrictsFact, agValuationFact, schoolDistrictFact, maxImperviousCoverPctFact, buildingFootprintFact (each the same present / absent / refused read the dock's own equivalent row shows), and a draw block (ring in local feet, named edges, overlays) the panel renders. Never contains permitted-use tables, listings, sales, or owner data -- owner is a separate Studio/Team-gated read this tool does not carry at any depth. Requires Solo or above, or a 30-day unlock on that parcel; otherwise returns refused with reason upgrade_required. Array cap 50 at depth stub; depth node: array cap 25, because a larger batch exceeds what the host delivers to the panel; over the cap returns refused with reason parcel_batch_cap. Ids with no record come back in notFound with a reason. bakedAt, asOf and stampedAt are the snapshot's bake time, not the time of this call, and runId names that bake, so the same runId repeats across calls on one parcel. hop1 and subgraph are not implemented.",
    readiness: "live" as const,
  },
  {
    name: "list_my_properties",
    title: "List my properties",
    description:
      "List parcels the signed-in user has saved in Smart Site. Input is {}. screenId is refused. Returns saved rows only (id, parcel node id, label, situs, stub rails, CRM status, note, updatedAt). A punctuation-only situs falls back to the node id with situs unknown.",
    readiness: "live" as const,
  },
  {
    name: "run_report",
    title: "Run a report",
    description:
      "Read the R1 property intelligence report for a parcel from the baked facet snapshot. Returns synchronously; no async job is started.",
    readiness: "live" as const,
  },
  {
    name: "request_records",
    title: "Request records",
    description:
      "Start a public-records request for a parcel. Not available until Records Request is live on production.",
    readiness: "blocked" as const,
    blockedReason: "P-85 item 4",
  },
  {
    name: "check_request",
    title: "Check a request",
    description:
      "Poll an async report or records job for queued, running, complete, failed, or needs-human.",
    readiness: "blocked" as const,
    blockedReason: "P-85 item 4",
  },
  {
    name: "list_purchased_records",
    title: "List purchased records",
    description:
      "List purchased-courthouse-document jobs for one parcel (parcelNodeId), each with its documents' vision-read state (pending, complete, failed, skipped) and classification state (pending, written, refused, skipped). Never returns full document text — call read_purchased_record with the artifactId from a listed document for that. Requires Studio or above; otherwise returns refused with reason upgrade_required. An empty jobs array is a genuine result: no records purchase has been made for this parcel by this account, not an error.",
    readiness: "live" as const,
  },
  {
    name: "read_purchased_record",
    title: "Read a purchased record",
    description:
      "Read one purchased document in full: extracted vision-read text (when the read completed) and classification detail, by parcelNodeId and artifactId (from list_purchased_records). Requires Studio or above; otherwise returns refused with reason upgrade_required. An artifactId that does not exist, or that belongs to a different parcel or a different account, comes back as the same refused/artifact_not_found response — existence is never confirmed or denied across an ownership mismatch.",
    readiness: "live" as const,
  },
  {
    name: "export_instrument",
    title: "Export an instrument",
    description:
      "Export a site plan, terrain model, feasibility study, or property dossier (X-ray) artifact, each a two-hop refresh-then-download call (P-110; feasibility calls hauska-engine-api directly, the other three go through Hauska's MCP export contract). Site plan, terrain, and feasibility study require Studio or Team, or a 30-day unlock on the parcel. The property dossier (X-ray) requires only Solo or above, or a 30-day unlock on the parcel — matching the web app (P-119; a prior Studio-only gate here on the connector was corrected, OPS-16 A-103). `brief` is accepted as a kind for discoverability but always returns status kind_not_available: Hauska's export contract has no brief kind and never has.",
    readiness: "live" as const,
  },
  {
    name: "ask_the_map",
    title: "Ask the map",
    description:
      "Ask a question about one parcel's on-record facts. Takes parcelNodeId and message only. Answers from that jurisdiction's code corpus and the parcel's baked facts, with citations. No map, no listing or sale data, no web, no owner data. Not available until the parcel path is live; returns not_ready today.",
    readiness: "blocked" as const,
    blockedReason:
      "P-91 item 34: parcel chat path unwired (cortex research/chat requires runId | address | areaContext)",
  },
  {
    name: "create_screen",
    title: "Create a screen",
    description:
      "Create a named intake screen from pasted queries and open the screening board in the MCP App. source must be exactly \"pasted\". A query that resolves to a parcel already on the screen is reported in degraded.duplicates and not written twice. Resolved rows carry six rail states. Does not write a save. Unresolved rows keep the original query.",
    readiness: "live" as const,
  },
  {
    name: "add_to_screen",
    title: "Add to a screen",
    description:
      "Append a parcel node id to an existing screen. source is exactly one of walk, saved, pasted. Idempotent on the same node. A node id with no parcel record is written unresolved with no Open. Does not write a save.",
    readiness: "live" as const,
  },
  {
    name: "list_screens",
    title: "List screens",
    description:
      "Without screenId, lists the caller's screens (id, name, rowCount, updatedAt) and does not open a board. With screenId, returns that screen's rows, each resolved row carrying its six rail states, and opens the board. To reopen a screen, list first, then call again with the chosen screenId. Soft-deleted screens are omitted. The board reads this screen, not list_my_properties.",
    readiness: "live" as const,
  },
  {
    name: "save_property",
    title: "Save a property",
    description:
      "Upsert a CRM save for a parcel. status must be exactly one of New, Watching, Chasing, Passed (optional on save). Sets crm status and note columns only. Does not write a screen row and does not replace snapshot.",
    readiness: "live" as const,
  },
  {
    name: "set_property_status",
    title: "Set property status",
    description:
      "Update CRM status on an existing save. status must be exactly one of New, Watching, Chasing, Passed. The parcel must already be saved; use save_property with a status otherwise. Does not touch snapshot or screens.",
    readiness: "live" as const,
  },
] as const;

export type SmartsiteToolName = (typeof SMARTSITE_MCP_TOOLS)[number]["name"];

export const SERVER_NAME = "Smart Site";
export const SERVER_VERSION = "0.0.1";
export const SERVER_WEBSITE_URL = "https://smartsite.cloud";
/**
 * Connector card icon (MCP Implementation.icons, SDK 1.29). Points at the
 * live Smart Site mark on smartsite.cloud (P-96), never at a copy in this
 * package, so the card follows the product. PNG first: clients MUST support
 * png/jpeg; svg is optional.
 */
export const SERVER_ICONS = [
  {
    src: "https://smartsite.cloud/apple-touch-icon.png",
    mimeType: "image/png",
    sizes: ["180x180"],
  },
  {
    src: "https://smartsite.cloud/icons/icon-512.svg",
    mimeType: "image/svg+xml",
    sizes: ["512x512"],
  },
] as const;
