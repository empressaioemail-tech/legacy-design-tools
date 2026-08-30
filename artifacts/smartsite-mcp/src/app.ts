import express, { type Express } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

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
  const mcpServer = new McpServer(serverImplementation());
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

  app.get("/health", (_req, res) => {
    // Same AuthConfig object the /mcp gate was built from, so /health and
    // /mcp cannot disagree about authConfigured (P-91 deep dive 4.1 row 5).
    res.json(buildHealthReport(authConfig));
  });

  app.get("/health/dependencies", async (_req, res) => {
    res.json(await buildDependenciesHealthReport());
  });

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
