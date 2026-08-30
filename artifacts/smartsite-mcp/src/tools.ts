import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { SMARTSITE_MCP_TOOLS, type SmartsiteToolName } from "./constants.js";
import {
  cortexFetch,
  loadCortexClientConfig,
  type CortexClientConfig,
} from "./cortex-client.js";
import {
  canRunDeepReport,
  canRunStudioReport,
  isStudioExportKind,
  refuseDeepReport,
  refuseStudioReport,
  snapshotFromAuth,
} from "./entitlement.js";
import { requireAuthContext } from "./request-context.js";
import { executeExportInstrument } from "./export-instrument.js";
import { loadHauskaMcpConfig } from "./hauska-client.js";
import {
  buildRunReportEnvelope,
  buildRunReportErrorBody,
  mapGetSmartSiteNonOk,
  normalizeGetSmartSiteResponseText,
  stripSavedPropertiesForExternal,
} from "./tool-honesty.js";
import type { ToolResult } from "./tools-types.js";
import { appMetaFor, registerMcpApp } from "./mcp-app.js";

const SMARTSITE_BATCH_CAP = 50;
const GET_SMART_SITE_DEPTHS = ["stub", "node", "hop1", "subgraph"] as const;
const CRM_STATUSES = ["New", "Watching", "Chasing", "Passed"] as const;
const SCREEN_ROW_SOURCES = ["walk", "saved", "pasted"] as const;

const ASK_THE_MAP_REFUSAL = "ask_the_map accepts parcelNodeId and message.";
const ASK_THE_MAP_STRICT = z
  .object({
    parcelNodeId: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

/**
 * Strict at the type: tools/list publishes additionalProperties false and
 * the SDK refuses extra keys before the handler runs. The SDK prints every
 * zod issue verbatim, and a strict object's unrecognized_keys issue names
 * the extra keys, which is the P-91 item 10 leak on the MCP error path.
 * This instance keeps the strict schema (same shape, same published JSON
 * schema) and replaces only that issue with a fixed sentence.
 */
function askTheMapInputSchema(): typeof ASK_THE_MAP_STRICT {
  const guarded: typeof ASK_THE_MAP_STRICT = Object.create(ASK_THE_MAP_STRICT);
  guarded.safeParseAsync = async (data: unknown) => {
    const result = await ASK_THE_MAP_STRICT.safeParseAsync(data);
    if (
      result.success ||
      !result.error.issues.some((issue) => issue.code === "unrecognized_keys")
    ) {
      return result;
    }
    return {
      success: false,
      error: new z.ZodError([
        { code: z.ZodIssueCode.custom, path: [], message: ASK_THE_MAP_REFUSAL },
      ]),
    };
  };
  return guarded;
}

/**
 * P-91 QA 2026-08-30 D1. Cortex situs-search merges parcel hits with
 * address-point rows (`parcelNodeId: null`, lat/lon) that exist for the web
 * typeahead. To a third-party agent a null id inside `hits` is a trap. Here
 * `hits` carries parcel hits only; when there is no parcel hit, the address
 * points move to `located` (typed, never a hit) so a caller can say "address
 * exists, parcel not bound" instead of "no match". Non-JSON bodies pass through.
 */
export function splitFindParcelHits(bodyText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bodyText;
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.hits)) return bodyText;
  const parcelHits: unknown[] = [];
  const located: unknown[] = [];
  for (const raw of record.hits) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const hit = raw as Record<string, unknown>;
    if (typeof hit.parcelNodeId === "string" && hit.parcelNodeId.length > 0) {
      parcelHits.push(hit);
    } else if (hit.source === "address-point") {
      const { parcelNodeId: _null, ...point } = hit;
      located.push(point);
    }
  }
  const out: Record<string, unknown> = { ...record, hits: parcelHits };
  if (parcelHits.length === 0 && located.length > 0) {
    out.located = located;
    if (out.missClass === undefined) out.missClass = "located-unbound";
  }
  return JSON.stringify(out);
}

function notReadyMessage(tool: string, reason: string): string {
  return JSON.stringify({
    status: "not_ready",
    tool,
    reason,
    message: `${tool} is not available on Smart Site MCP yet.`,
  });
}

function degradedResult(reason: string, message: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ status: "degraded", reason, message }),
      },
    ],
    isError: true,
  };
}

function upgradeRequiredResult(
  refusal: ReturnType<typeof refuseDeepReport>,
): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(refusal) }],
    isError: true,
  };
}

async function withCortex(
  fn: (config: CortexClientConfig) => Promise<ToolResult>,
): Promise<ToolResult> {
  const config = loadCortexClientConfig();
  if (!config) {
    return degradedResult(
      "cortex_not_configured",
      "Smart Site MCP cannot reach the workbench backend.",
    );
  }
  return fn(config);
}

function inputSchemaFor(name: SmartsiteToolName) {
  switch (name) {
    case "find_parcel":
      return z.object({ query: z.string().min(1) });
    case "list_my_properties":
      return z.object({}).passthrough();
    case "create_screen":
      return z
        .object({
          name: z.string().optional(),
          queries: z.array(z.string()),
          source: z.enum(["pasted"]),
        })
        .strict();
    case "add_to_screen":
      return z
        .object({
          screenId: z.string().min(1),
          parcelNodeId: z.string().min(1),
          source: z.enum(SCREEN_ROW_SOURCES),
        })
        .strict();
    case "list_screens":
      return z
        .object({
          screenId: z.string().min(1).optional(),
        })
        .strict();
    case "save_property":
      return z
        .object({
          parcelNodeId: z.string().min(1),
          status: z.enum(CRM_STATUSES).optional(),
          note: z.string().optional(),
        })
        .strict();
    case "set_property_status":
      return z
        .object({
          parcelNodeId: z.string().min(1),
          status: z.enum(CRM_STATUSES),
        })
        .strict();
    case "check_request":
      return z.object({ jobId: z.string().min(1) });
    case "ask_the_map":
      return askTheMapInputSchema();
    case "export_instrument":
      return z.object({
        parcelNodeId: z.string().min(1),
        kind: z.enum(["brief", "siteplan", "terrain", "dossier"]),
      });
    case "get_smart_site":
      return z.object({
        parcelNodeId: z.union([
          z.string().min(1),
          z.array(z.string().min(1)).min(1).max(SMARTSITE_BATCH_CAP),
        ]),
        depth: z.enum(GET_SMART_SITE_DEPTHS).optional(),
      });
    default:
      return z.object({ parcelNodeId: z.string().min(1) });
  }
}

/** P-91 item 1 plus Wave B writes. Reads keep readOnlyHint true. */
function annotationsFor(name: SmartsiteToolName) {
  if (name === "list_screens") {
    return { readOnlyHint: true };
  }
  if (
    name === "request_records" ||
    name === "create_screen" ||
    name === "add_to_screen" ||
    name === "save_property" ||
    name === "set_property_status"
  ) {
    return { readOnlyHint: false, destructiveHint: false };
  }
  return { readOnlyHint: true };
}

export function registerTools(server: McpServer): void {
  registerMcpApp(server);
  for (const tool of SMARTSITE_MCP_TOOLS) {
    const uiMeta = appMetaFor(tool.name);
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: inputSchemaFor(tool.name),
        annotations: annotationsFor(tool.name),
        ...(uiMeta ? { _meta: uiMeta } : {}),
      },
      async (args: Record<string, unknown>) => {
        const auth = requireAuthContext();
        const entitlement = snapshotFromAuth(auth);

        if (tool.readiness === "blocked") {
          return {
            content: [
              {
                type: "text" as const,
                text: notReadyMessage(tool.name, tool.blockedReason ?? "blocked"),
              },
            ],
            isError: true,
          };
        }

        switch (tool.name) {
          case "find_parcel": {
            const { query } = args as { query: string };
            return withCortex(async (config) => {
              const res = await cortexFetch(
                config,
                `/api/brokerage/v1/place/situs-search?q=${encodeURIComponent(query)}`,
                { userId: auth.userId },
              );
              const body = await res.text();
              return {
                content: [
                  {
                    type: "text" as const,
                    text: res.ok ? splitFindParcelHits(body) : body,
                  },
                ],
                isError: !res.ok,
              };
            });
          }
          case "get_smart_site": {
            const { parcelNodeId, depth } = args as {
              parcelNodeId: string | string[];
              depth?: (typeof GET_SMART_SITE_DEPTHS)[number];
            };
            if (depth === "hop1" || depth === "subgraph") {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      status: "not_implemented",
                      depth,
                    }),
                  },
                ],
                isError: true,
              };
            }
            const ids = Array.isArray(parcelNodeId)
              ? parcelNodeId
              : [parcelNodeId];
            if (ids.length > SMARTSITE_BATCH_CAP) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      status: "refused",
                      reason: "parcel_batch_cap",
                      cap: SMARTSITE_BATCH_CAP,
                      received: ids.length,
                    }),
                  },
                ],
                isError: true,
              };
            }
            const briefBody: Record<string, unknown> = { parcelNodeId };
            if (depth) briefBody.depth = depth;
            return withCortex(async (config) => {
              const res = await cortexFetch(
                config,
                `/api/property-explorer/v1/research/brief`,
                {
                  method: "POST",
                  userId: auth.userId,
                  body: JSON.stringify(briefBody),
                },
              );
              const body = await res.text();
              if (!res.ok) {
                // Wire contract 4.1: a declared miss or refusal is a result
                // the host forwards to the panel; anything else is an error.
                const declared = mapGetSmartSiteNonOk(res.status, body, ids);
                return {
                  content: [{ type: "text" as const, text: declared ?? body }],
                  isError: declared === null,
                };
              }
              const mode =
                Array.isArray(parcelNodeId) || depth === "stub"
                  ? "stub-or-batch"
                  : "single-node";
              return {
                content: [
                  {
                    type: "text" as const,
                    text: normalizeGetSmartSiteResponseText(body, mode),
                  },
                ],
                isError: false,
              };
            });
          }
          case "list_my_properties": {
            const raw = args as Record<string, unknown>;
            if (Object.prototype.hasOwnProperty.call(raw, "screenId")) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({ error: "screen_id_not_accepted" }),
                  },
                ],
                isError: true,
              };
            }
            return withCortex(async (config) => {
              const res = await cortexFetch(
                config,
                `/api/property-explorer/v1/saved-properties`,
                { userId: auth.userId },
              );
              const body = await res.text();
              if (!res.ok) {
                return {
                  content: [{ type: "text" as const, text: body }],
                  isError: true,
                };
              }
              let parsed: unknown;
              try {
                parsed = JSON.parse(body);
              } catch {
                return {
                  content: [{ type: "text" as const, text: body }],
                  isError: true,
                };
              }
              const summary = stripSavedPropertiesForExternal(parsed);
              return {
                content: [
                  { type: "text" as const, text: JSON.stringify(summary) },
                ],
                isError: false,
              };
            });
          }
          case "run_report": {
            const { parcelNodeId } = args as { parcelNodeId: string };
            if (!canRunDeepReport(entitlement)) {
              return upgradeRequiredResult(refuseDeepReport(entitlement));
            }
            return withCortex(async (config) => {
              const res = await cortexFetch(
                config,
                `/api/property-explorer/v1/research/brief`,
                {
                  method: "POST",
                  userId: auth.userId,
                  body: JSON.stringify({ parcelNodeId }),
                },
              );
              const body = await res.text();
              if (!res.ok) {
                // No read happened, so no read stamp (reportKind /
                // reportReadMode / async). The upstream body travels as is.
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: JSON.stringify(buildRunReportErrorBody(body)),
                    },
                  ],
                  isError: true,
                };
              }
              const envelope = buildRunReportEnvelope(parcelNodeId, body);
              return {
                content: [
                  { type: "text" as const, text: JSON.stringify(envelope) },
                ],
                isError: false,
              };
            });
          }
          case "export_instrument": {
            const { parcelNodeId, kind } = args as {
              parcelNodeId: string;
              kind: "brief" | "siteplan" | "terrain" | "dossier";
            };
            if (isStudioExportKind(kind) && !canRunStudioReport(entitlement)) {
              return upgradeRequiredResult(refuseStudioReport(entitlement));
            }
            if (!loadHauskaMcpConfig()) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: notReadyMessage(
                      "export_instrument",
                      "P-87 export honesty — Hauska MCP export proxy not configured",
                    ),
                  },
                ],
                isError: true,
              };
            }
            return executeExportInstrument({ parcelNodeId, kind });
          }
          case "create_screen": {
            const body = args as {
              name?: string;
              queries: string[];
              source: string;
            };
            return withCortex(async (config) => {
              const res = await cortexFetch(
                config,
                `/api/property-explorer/v1/screens`,
                {
                  method: "POST",
                  userId: auth.userId,
                  body: JSON.stringify(body),
                },
              );
              const text = await res.text();
              return {
                content: [{ type: "text" as const, text }],
                isError: !res.ok,
              };
            });
          }
          case "add_to_screen": {
            const { screenId, parcelNodeId, source } = args as {
              screenId: string;
              parcelNodeId: string;
              source: string;
            };
            return withCortex(async (config) => {
              const res = await cortexFetch(
                config,
                `/api/property-explorer/v1/screens/${encodeURIComponent(screenId)}/rows`,
                {
                  method: "POST",
                  userId: auth.userId,
                  body: JSON.stringify({ parcelNodeId, source }),
                },
              );
              const text = await res.text();
              return {
                content: [{ type: "text" as const, text }],
                isError: !res.ok,
              };
            });
          }
          case "list_screens": {
            const { screenId } = args as { screenId?: string };
            const path = screenId
              ? `/api/property-explorer/v1/screens/${encodeURIComponent(screenId)}`
              : `/api/property-explorer/v1/screens`;
            return withCortex(async (config) => {
              const res = await cortexFetch(config, path, {
                userId: auth.userId,
              });
              const text = await res.text();
              return {
                content: [{ type: "text" as const, text }],
                isError: !res.ok,
              };
            });
          }
          case "save_property": {
            const { parcelNodeId, status, note } = args as {
              parcelNodeId: string;
              status?: string;
              note?: string;
            };
            const body: Record<string, string> = {};
            if (status !== undefined) body.status = status;
            if (note !== undefined) body.note = note;
            return withCortex(async (config) => {
              const res = await cortexFetch(
                config,
                `/api/property-explorer/v1/saved-properties/${encodeURIComponent(parcelNodeId)}/save`,
                {
                  method: "POST",
                  userId: auth.userId,
                  body: JSON.stringify(body),
                },
              );
              const text = await res.text();
              return {
                content: [{ type: "text" as const, text }],
                isError: !res.ok,
              };
            });
          }
          case "set_property_status": {
            const { parcelNodeId, status } = args as {
              parcelNodeId: string;
              status: string;
            };
            return withCortex(async (config) => {
              const res = await cortexFetch(
                config,
                `/api/property-explorer/v1/saved-properties/${encodeURIComponent(parcelNodeId)}/status`,
                {
                  method: "POST",
                  userId: auth.userId,
                  body: JSON.stringify({ status }),
                },
              );
              const text = await res.text();
              return {
                content: [{ type: "text" as const, text }],
                isError: !res.ok,
              };
            });
          }
          // ask_the_map has no handler while readiness is "blocked" (P-91
          // item 34): the blocked branch above answers not_ready before the
          // switch, the same as the records pair. Re-arming it means a case
          // here that builds the chat subject from the bake and keeps
          // sanitizeAskTheMapErrorBody on the cortex error path.
        }
      },
    );
  }
}
