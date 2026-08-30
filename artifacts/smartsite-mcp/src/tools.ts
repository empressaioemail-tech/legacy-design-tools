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
  declareUpstreamNonOk,
  mapGetSmartSiteNonOk,
  normalizeGetSmartSiteResponseText,
  stripSavedPropertiesForExternal,
} from "./tool-honesty.js";
import type { ToolResult } from "./tools-types.js";
import { appMetaFor, registerMcpApp } from "./mcp-app.js";

const SMARTSITE_BATCH_CAP = 50;
/**
 * H2 (measured 2026-08-30 on p557): a node body averages 4,711 characters
 * (largest 5,549), and the host writes any tool result over roughly 150,000
 * characters to a file and hands the panel a pointer, so a 50-id node batch
 * (about 235,000) never reaches the panel. Node arrays cap at 25; stub keeps
 * 50. The JSON schema cannot express a depth-dependent cap, so the array
 * stays max(50) there and this rule is enforced here and published in the
 * description.
 */
const SMARTSITE_NODE_BATCH_CAP = 25;
const GET_SMART_SITE_DEPTHS = ["stub", "node", "hop1", "subgraph"] as const;
type ImplementedDepth = "stub" | "node";

function batchCapFor(depth: ImplementedDepth): number {
  return depth === "node" ? SMARTSITE_NODE_BATCH_CAP : SMARTSITE_BATCH_CAP;
}
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

/** H1: a cortex non-OK travels as a declared error body, never raw. */
function upstreamErrorResult(httpStatus: number, bodyText: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(declareUpstreamNonOk(httpStatus, bodyText)),
      },
    ],
    isError: true,
  };
}

function isDeclaredErrorText(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const rec = parsed as Record<string, unknown>;
    return (
      typeof rec.status === "string" &&
      rec.status.length > 0 &&
      typeof rec.reason === "string" &&
      rec.reason.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * H1 for a result built outside this file (the export proxy): an error
 * result whose text is not already a declared body is wrapped here. The
 * upstream HTTP status did not travel with it, so it is `"unmeasured"`,
 * never a guessed number.
 */
function ensureDeclaredError(result: ToolResult): ToolResult {
  if (!result.isError) return result;
  const text = result.content[0]?.text;
  if (typeof text !== "string" || isDeclaredErrorText(text)) return result;
  return {
    ...result,
    content: [
      {
        type: "text",
        text: JSON.stringify(declareUpstreamNonOk("unmeasured", text)),
      },
    ],
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
              if (!res.ok) return upstreamErrorResult(res.status, body);
              return {
                content: [
                  { type: "text" as const, text: splitFindParcelHits(body) },
                ],
                isError: false,
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
                      reason: "depth_not_implemented",
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
            // Published defaults: an array reads at stub, one id at node.
            const effectiveDepth: ImplementedDepth =
              depth ?? (Array.isArray(parcelNodeId) ? "stub" : "node");
            const cap = batchCapFor(effectiveDepth);
            if (Array.isArray(parcelNodeId) && ids.length > cap) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      status: "refused",
                      reason: "parcel_batch_cap",
                      cap,
                      received: ids.length,
                      depth: effectiveDepth,
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
                if (declared === null) {
                  return upstreamErrorResult(res.status, body);
                }
                return {
                  content: [{ type: "text" as const, text: declared }],
                  isError: false,
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
                    text: JSON.stringify({
                      status: "refused",
                      reason: "screen_id_not_accepted",
                      error: "screen_id_not_accepted",
                    }),
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
              if (!res.ok) return upstreamErrorResult(res.status, body);
              let parsed: unknown;
              try {
                parsed = JSON.parse(body);
              } catch {
                // A 200 that is not JSON is still an error this server
                // declares (H1), carrying the status it actually saw.
                return upstreamErrorResult(res.status, body);
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
                // reportReadMode / async). The upstream body travels under
                // its own keys as a declared error (H1).
                return upstreamErrorResult(res.status, body);
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
            return ensureDeclaredError(
              await executeExportInstrument({ parcelNodeId, kind }),
            );
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
              if (!res.ok) return upstreamErrorResult(res.status, text);
              return {
                content: [{ type: "text" as const, text }],
                isError: false,
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
              if (!res.ok) return upstreamErrorResult(res.status, text);
              return {
                content: [{ type: "text" as const, text }],
                isError: false,
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
              if (!res.ok) return upstreamErrorResult(res.status, text);
              return {
                content: [{ type: "text" as const, text }],
                isError: false,
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
              if (!res.ok) return upstreamErrorResult(res.status, text);
              return {
                content: [{ type: "text" as const, text }],
                isError: false,
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
              if (!res.ok) return upstreamErrorResult(res.status, text);
              return {
                content: [{ type: "text" as const, text }],
                isError: false,
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
