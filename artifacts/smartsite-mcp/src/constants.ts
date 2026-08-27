/** WDLL P-87 item 12 — exactly eight tools, property-written names. */
export const SMARTSITE_MCP_TOOLS = [
  {
    name: "find_parcel",
    title: "Find a parcel",
    description:
      "Search for a parcel by address, APN, or parcel node id and return the best match with county and identifiers.",
    readiness: "live" as const,
  },
  {
    name: "get_smart_site",
    title: "Get its smart site",
    description:
      "Return the signed-in user's smart site analysis for a parcel: verdicts, citations, and stored artifacts at the caller's tier.",
    readiness: "live" as const,
  },
  {
    name: "list_my_properties",
    title: "List my properties",
    description:
      "List parcels the signed-in user has saved in Smart Site (id, parcel node id, label, updatedAt only — no chat or notes).",
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
    name: "export_instrument",
    title: "Export an instrument",
    description:
      "Export a site plan, terrain model, dossier, or brief artifact the caller's tier allows. Not available until cortex export routes exist for Smart Site MCP.",
    readiness: "blocked" as const,
    blockedReason: "P-87 export honesty — no parcel export endpoint",
  },
  {
    name: "ask_the_map",
    title: "Ask the map",
    description:
      "Ask a natural-language question about the current parcel and visible map context.",
    readiness: "live" as const,
  },
] as const;

export type SmartsiteToolName = (typeof SMARTSITE_MCP_TOOLS)[number]["name"];

export const SERVER_NAME = "Smart Site";
export const SERVER_VERSION = "0.0.1";
