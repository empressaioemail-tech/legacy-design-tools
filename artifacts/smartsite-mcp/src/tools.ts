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
  normalizeGetSmartSiteResponseText,
  stripSavedPropertiesForExternal,
} from "./tool-honesty.js";
import type { ToolResult } from "./tools-types.js";

const SMARTSITE_BATCH_CAP = 50;
const GET_SMART_SITE_DEPTHS = ["stub", "node", "hop1", "subgraph"] as const;

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
      return z.object({});
    case "check_request":
      return z.object({ jobId: z.string().min(1) });
    case "ask_the_map":
      return z.object({
        parcelNodeId: z.string().min(1),
        message: z.string().min(1),
      });
    case "export_instrument":
      return z.object({
        parcelNodeId: z.string().min(1),
        kind: z.enum(["brief", "siteplan", "terrain", "dossier"]),
      });
    case "get_smart_site":
      return z.object({
        parcelNodeId: z.union([
          z.string().min(1),
          z.array(z.string().min(1)).min(1),
        ]),
        depth: z.enum(GET_SMART_SITE_DEPTHS).optional(),
      });
    default:
      return z.object({ parcelNodeId: z.string().min(1) });
  }
}

/** P-91 item 1. request_records starts a job; the other seven are reads. */
function annotationsFor(name: SmartsiteToolName) {
  if (name === "request_records") {
    return { readOnlyHint: false, destructiveHint: false };
  }
  return { readOnlyHint: true };
}

export function registerTools(server: McpServer): void {
  for (const tool of SMARTSITE_MCP_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: inputSchemaFor(tool.name),
        annotations: annotationsFor(tool.name),
      },
      async (args) => {
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
                content: [{ type: "text" as const, text: body }],
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
              const mode =
                Array.isArray(parcelNodeId) || depth === "stub"
                  ? "stub-or-batch"
                  : "single-node";
              const normalized = normalizeGetSmartSiteResponseText(body, mode);
              return {
                content: [{ type: "text" as const, text: normalized }],
                isError: !res.ok,
              };
            });
          }
          case "list_my_properties": {
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
              const envelope = buildRunReportEnvelope(parcelNodeId, body);
              return {
                content: [
                  { type: "text" as const, text: JSON.stringify(envelope) },
                ],
                isError: !res.ok,
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
          case "ask_the_map": {
            const { parcelNodeId, message } = args as {
              parcelNodeId: string;
              message: string;
            };
            return withCortex(async (config) => {
              const res = await cortexFetch(
                config,
                `/api/brokerage/v1/research/chat`,
                {
                  method: "POST",
                  userId: auth.userId,
                  body: JSON.stringify({ parcelNodeId, message }),
                },
              );
              const body = await res.text();
              return {
                content: [{ type: "text" as const, text: body }],
                isError: !res.ok,
              };
            });
          }
        }
      },
    );
  }
}
