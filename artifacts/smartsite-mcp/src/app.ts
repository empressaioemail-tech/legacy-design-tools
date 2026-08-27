import express, { type Express } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import {
  buildMcpAuthMiddleware,
  isAuthConfigured,
  loadAuthConfig,
  type AuthConfig,
} from "./auth.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
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

async function buildPerRequestMcp(): Promise<{
  transport: StreamableHTTPServerTransport;
  close: () => Promise<void>;
}> {
  const mcpServer = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
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

  app.get("/health", (_req, res) => {
    res.json(buildHealthReport());
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
