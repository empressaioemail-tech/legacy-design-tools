#!/usr/bin/env node
/**
 * Exit-bounded rail coverage capability probe for operators.
 * Prints JSON to stdout; exit 0 on success, 1 on fatal error.
 */
import { execFileSync } from "node:child_process";
import pg from "pg";

import { probeRailCapabilities, type CapabilityDbHandle } from "@workspace/db";

const { Pool } = pg;

function resolveDatabaseUrl(): string {
  const direct = process.env.DATABASE_URL?.trim();
  if (direct) return direct;
  const gcloud =
    process.env.GCLOUD_BIN ??
    (process.platform === "win32"
      ? "C:\\Users\\cente\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd"
      : "gcloud");
  const project = process.env.GCP_PROJECT ?? "legacy-design-tools-prod";
  try {
    const out = execFileSync(
      gcloud,
      [
        "secrets",
        "versions",
        "access",
        "latest",
        "--secret=DEPLOYMENT_DATABASE_URL",
        `--project=${project}`,
      ],
      { encoding: "utf8" },
    ).trim();
    if (out) return out;
  } catch (err) {
    console.error(
      "[rail-capability-probe] DATABASE_URL not set and gcloud failed:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
  console.error("[rail-capability-probe] DATABASE_URL could not be resolved");
  process.exit(1);
}

async function main(): Promise<void> {
  const databaseUrl = resolveDatabaseUrl();
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("sslmode=") ? undefined : { rejectUnauthorized: false },
    max: 2,
  });
  try {
    const db: CapabilityDbHandle = {
      execute: async (query) => {
        const { rows } = await pool.query(String(query));
        return { rows: rows as Record<string, unknown>[] };
      },
    };
    const outcome = await probeRailCapabilities(db);
    console.log(JSON.stringify(outcome, null, 2));
    if (outcome.railCapabilities === null) {
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
