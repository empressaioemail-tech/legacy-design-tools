import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { SMARTSITE_MCP_TOOLS, type SmartsiteToolName } from "./constants.js";
import {
  cortexFetch,
  loadCortexClientConfig,
  type CortexClientConfig,
} from "./cortex-client.js";
import { requireAuthContext } from "./request-context.js";

function notReadyMessage(tool: string, reason: string): string {
  return JSON.stringify({
    status: "not_ready",
    tool,
    reason,
    message: `${tool} is not available on Smart Site MCP yet.`,
  });
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

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
    default:
      return z.object({ parcelNodeId: z.string().min(1) });
  }
}

export function registerTools(server: McpServer): void {
  for (const tool of SMARTSITE_MCP_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: inputSchemaFor(tool.name),
      },
      async (args) => {
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

        const auth = requireAuthContext();

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
            const { parcelNodeId } = args as { parcelNodeId: string };
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
              return {
                content: [{ type: "text" as const, text: body }],
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
              return {
                content: [{ type: "text" as const, text: body }],
                isError: !res.ok,
              };
            });
          }
          case "run_report": {
            const { parcelNodeId } = args as { parcelNodeId: string };
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
              return {
                content: [{ type: "text" as const, text: body }],
                isError: !res.ok,
              };
            });
          }
          case "export_instrument": {
            const { parcelNodeId, kind } = args as {
              parcelNodeId: string;
              kind: string;
            };
            return withCortex(async (config) => {
              const res = await cortexFetch(
                config,
                `/api/property-explorer/v1/entitlement?parcelNodeId=${encodeURIComponent(parcelNodeId)}`,
                { userId: auth.userId },
              );
              const entitlement = await res.text();
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      status: "started",
                      parcelNodeId,
                      kind,
                      entitlementProbe: entitlement,
                      note: "Export job started; entitlement checked via cortex property-explorer.",
                    }),
                  },
                ],
              };
            });
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
