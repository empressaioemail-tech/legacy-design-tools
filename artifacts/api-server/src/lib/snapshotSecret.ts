import { randomUUID } from "node:crypto";
import { logger } from "./logger";

let cached: string | null = null;

export function getSnapshotSecret(): string {
  if (cached) return cached;
  const env = process.env["SNAPSHOT_SECRET"];
  if (env) {
    cached = env;
    return cached;
  }
  if (process.env["NODE_ENV"] === "production") {
    logger.fatal(
      "SNAPSHOT_SECRET env var is required in production. Refusing to start.",
    );
    process.exit(1);
  }
  cached = "dev-snapshot-secret-" + randomUUID();
  logger.warn(
    "SNAPSHOT_SECRET not set; generated a single temporary one for this dev process. Configure SNAPSHOT_SECRET env var before deploying.",
  );
  return cached;
}
