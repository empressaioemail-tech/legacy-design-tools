import { randomUUID } from "node:crypto";
import { logger } from "./logger";

let cached: string | null = null;

/**
 * The shared service-token the bearer-auth middleware
 * ({@link requireServiceToken}) validates `Authorization: Bearer`
 * against.
 *
 * Service callers present this exact value. cc-agent-M's
 * hauska-mcp-server sends it from its own `LEGACY_BACKEND_API_KEY`
 * env var (see `hauska-mcp-server/src/legacy-client.ts`); the two
 * sides must be configured to the same secret.
 *
 * Mirrors {@link getSnapshotSecret} (`lib/snapshotSecret.ts`): the env
 * var is required in production (fail-fast), and in dev a temporary
 * one is generated with a loud warning so local work is not blocked.
 */
export function getServiceApiKey(): string {
  if (cached) return cached;
  const env = process.env["SERVICE_API_KEY"];
  if (env) {
    cached = env;
    return cached;
  }
  if (process.env["NODE_ENV"] === "production") {
    logger.fatal(
      "SERVICE_API_KEY env var is required in production. Refusing to start.",
    );
    process.exit(1);
  }
  cached = "dev-service-api-key-" + randomUUID();
  logger.warn(
    "SERVICE_API_KEY not set; generated a single temporary one for this dev process. Configure SERVICE_API_KEY env var before deploying.",
  );
  return cached;
}

/**
 * Test-only: clear the module-level cache so a test can re-stub
 * `process.env.SERVICE_API_KEY` between cases.
 */
export function __resetServiceApiKeyCacheForTests(): void {
  cached = null;
}
