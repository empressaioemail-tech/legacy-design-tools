import express, { type Express } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { Readable } from "node:stream";

import { buildEngineGateHeaders, loadEngineApiConfig } from "./engine-client.js";
import { FEASIBILITY_PACKAGE_ID } from "./feasibility-export.js";
import { verifyFileLink } from "./file-links.js";
import { SMARTSITE_INSTRUCTIONS } from "./voice.js";

import {
  buildMcpAuthMiddleware,
  isAuthConfigured,
  loadAuthConfig,
  type AuthConfig,
} from "./auth.js";
import {
  SERVER_ICONS,
  SERVER_NAME,
  SERVER_VERSION,
  SERVER_WEBSITE_URL,
} from "./constants.js";
import {
  buildDependenciesHealthReport,
  buildHealthReport,
  renderLlmsTxt,
} from "./health.js";
import {
  authkitIssuer,
  mcpResourceUrl,
  oauthProtectedResourceMetadata,
} from "./oauth-metadata.js";
import { registerTools } from "./tools.js";
import {
  recordMapRenderCardReport,
  snapshotMapRenderMetrics,
} from "./render-metrics.js";
import {
  requireSeatMetricsKey,
  requireSeatMetricsOrReportToken,
} from "./seat-metrics-auth.js";

/**
 * The Implementation every /mcp session announces on initialize. Exported so a
 * test can read it through a real client's initialize result, which is what a
 * host paints on the connector card (P-91 QA 2026-08-30: the card showed a
 * fallback icon because this carried no icons).
 */
export function serverImplementation(): {
  name: string;
  version: string;
  websiteUrl: string;
  icons: Array<{ src: string; mimeType: string; sizes: string[] }>;
} {
  return {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    websiteUrl: SERVER_WEBSITE_URL,
    icons: SERVER_ICONS.map((icon) => ({ ...icon, sizes: [...icon.sizes] })),
  };
}

async function buildPerRequestMcp(): Promise<{
  transport: StreamableHTTPServerTransport;
  close: () => Promise<void>;
}> {
  const mcpServer = new McpServer(serverImplementation(), { instructions: SMARTSITE_INSTRUCTIONS });
  registerTools(mcpServer);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await mcpServer.connect(transport);
  return {
    transport,
    close: async () => {
      await transport.close();
      await mcpServer.close();
    },
  };
}

export type CreateSmartsiteMcpAppOptions = {
  authConfig?: AuthConfig;
};

export function createSmartsiteMcpApp(
  options: CreateSmartsiteMcpAppOptions = {},
): Express {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.set("trust proxy", 1);

  const authConfig = options.authConfig ?? loadAuthConfig();
  const mcpAuth = buildMcpAuthMiddleware(authConfig);
  const authkit = authkitIssuer();

  // The MCP host has no page of its own. A browser or a host probing for a
  // site icon lands on the product, never on "Cannot GET /".
  app.get("/", (_req, res) => {
    res.redirect(302, SERVER_WEBSITE_URL);
  });
  app.get("/favicon.ico", (_req, res) => {
    res.redirect(302, `${SERVER_WEBSITE_URL}/favicon.ico`);
  });

  // B3/C3: signed, short-lived export download links (file-links.ts).
  app.get("/files/feasibility/:token", async (req, res) => {
    const verified = verifyFileLink("feasibility", req.params.token ?? "");
    if ("refused" in verified) {
      res.status(verified.refused === "expired" ? 410 : 403).json({ error: "file_link_" + verified.refused });
      return;
    }
    const config = loadEngineApiConfig();
    if (!config) {
      res.status(503).json({ error: "engine_not_configured" });
      return;
    }
    const path = `/v1/property-nodes/${encodeURIComponent(verified.parcelNodeId)}/feasibility-export/download`;
    try {
      const upstream = await fetch(`${config.baseUrl}${path}`, {
        headers: {
          Authorization: `Bearer ${config.gateToken}`,
          // The link was minted only after the paid gate passed.
          ...buildEngineGateHeaders({ packageId: FEASIBILITY_PACKAGE_ID, callerTier: "public-paid" }),
        },
      });
      if (!upstream.ok || !upstream.body) {
        res.status(upstream.status === 410 ? 410 : 502).json({ error: "file_unavailable", upstreamStatus: upstream.status });
        return;
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="feasibility-${verified.parcelNodeId.replace(/[^0-9A-Za-z_-]/g, "_")}.pdf"`);
      const len = upstream.headers.get("content-length");
      if (len) res.setHeader("Content-Length", len);
      Readable.fromWeb(upstream.body as never).pipe(res);
    } catch {
      res.status(502).json({ error: "file_unavailable" });
    }
  });

  app.get("/health", (_req, res) => {
    // Same AuthConfig object the /mcp gate was built from, so /health and
    // /mcp cannot disagree about authConfigured (P-91 deep dive 4.1 row 5).
    res.json(buildHealthReport(authConfig));
  });

  app.get("/health/dependencies", async (_req, res) => {
    res.json(await buildDependenciesHealthReport());
  });

  /** P-456b: card-reported draw counts; seat key required. */
  app.get("/internal/map-render-metrics", requireSeatMetricsKey, (_req, res) => {
    res.json({ hosts: snapshotMapRenderMetrics() });
  });

  app.post(
    "/internal/map-render-report",
    requireSeatMetricsOrReportToken,
    (req, res) => {
      const body = req.body as Record<string, unknown>;
      const outcome = body?.outcome;
      if (
        outcome !== "drawn" &&
        outcome !== "fallback" &&
        outcome !== "failed"
      ) {
        res.status(400).json({ ok: false, error: "invalid_outcome" });
        return;
      }
      const result = recordMapRenderCardReport({
        correlationId: String(body?.correlationId ?? ""),
        outcome,
        reasonCode: String(body?.reasonCode ?? ""),
        tool: body?.tool != null ? String(body.tool) : undefined,
      });
      if (!result.ok) {
        res.status(400).json(result);
        return;
      }
      res.status(204).end();
    },
  );

  app.get("/llms.txt", (_req, res) => {
    res
      .type("text/plain")
      .send(renderLlmsTxt(mcpResourceUrl().replace(/\/mcp$/, "")));
  });

  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json(oauthProtectedResourceMetadata());
  });

  app.get("/.well-known/oauth-authorization-server", async (_req, res) => {
    try {
      const upstream = await fetch(
        `${authkit}/.well-known/oauth-authorization-server`,
      );
      const metadata = await upstream.json();
      res.status(upstream.status).json(metadata);
    } catch {
      res.status(503).json({ error: "authkit_metadata_unavailable" });
    }
  });

  app.post(
    "/mcp",
    (req, res, next) => {
      if (!isAuthConfigured(authConfig)) {
        res.status(503).json({
          error: "auth_not_configured",
          message: "WorkOS AuthKit is not configured for Smart Site MCP.",
        });
        return;
      }
      mcpAuth(req, res, next);
    },
    async (req, res) => {
      const { transport, close } = await buildPerRequestMcp();
      res.on("close", () => {
        void close();
      });
      await transport.handleRequest(req, res, req.body);
    },
  );

  return app;
}
