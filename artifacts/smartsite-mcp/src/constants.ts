/** WDLL P-91 / P-92 — eight live tools plus five screen/save tools (13). */
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
      "Return the signed-in user's smart site analysis and open the parcel panel in the MCP App. parcelNodeId is a string or an array (cap 50; over cap refuses). depth stub is label, node id, url, and five-state rails; depth node is today's full brief and draw. hop1 and subgraph refuse as not_implemented. A bare node id draws without a save.",
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
    name: "export_instrument",
    title: "Export an instrument",
    description:
      "Export a site plan, terrain model, dossier, or brief artifact the caller's tier allows. Proxies Hauska MCP when configured; returns degraded (not server-down) if Hauska is unreachable.",
    readiness: "live" as const,
  },
  {
    name: "ask_the_map",
    title: "Ask the map",
    description:
      "Ask a natural-language question about the current parcel and visible map context.",
    readiness: "live" as const,
  },
  {
    name: "create_screen",
    title: "Create a screen",
    description:
      "Create a named intake screen from pasted queries and open the screening board in the MCP App. v1 source is pasted only. Does not write a save. Unresolved rows keep the original query.",
    readiness: "live" as const,
  },
  {
    name: "add_to_screen",
    title: "Add to a screen",
    description:
      "Append a resolved parcel to an existing screen (walk, saved, or pasted). Idempotent on the same node. Does not write a save.",
    readiness: "live" as const,
  },
  {
    name: "list_screens",
    title: "List screens",
    description:
      "List the caller's screens, or reopen one screen's rows when screenId is set, and open the screening board in the MCP App. Soft-deleted screens are omitted. The board reads this screen, not list_my_properties.",
    readiness: "live" as const,
  },
  {
    name: "save_property",
    title: "Save a property",
    description:
      "Upsert a CRM save for a parcel. Sets crm status and note columns only. Does not write a screen row and does not replace snapshot.",
    readiness: "live" as const,
  },
  {
    name: "set_property_status",
    title: "Set property status",
    description:
      "Update CRM status on an existing save. Refuses if the parcel is not saved. Does not touch snapshot or screens.",
    readiness: "live" as const,
  },
] as const;

export type SmartsiteToolName = (typeof SMARTSITE_MCP_TOOLS)[number]["name"];

export const SERVER_NAME = "Smart Site";
export const SERVER_VERSION = "0.0.1";
