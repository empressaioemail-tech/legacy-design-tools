#!/usr/bin/env node
/**
 * P-85 item 5 — Records Request Playwright worker entry.
 *
 * Modes:
 *  - Cloud Run Job / local CLI: RECORDS_REQUEST_JOB_ID or --job-id
 *  - Cloud Run Service: PORT set → POST /run { "jobId": "..." }
 */

import { createServer } from "node:http";
import { closeJobStorePool } from "./jobStore.js";
import { runRecordsRequestJob } from "./worker.js";

function parseJobIdFromArgs(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--job-id" && argv[i + 1]) {
      return argv[i + 1]!.trim();
    }
    if (arg.startsWith("--job-id=")) {
      return arg.slice("--job-id=".length).trim();
    }
  }
  return null;
}

function resolveJobId(): string | null {
  return (
    process.env.RECORDS_REQUEST_JOB_ID?.trim() ||
    parseJobIdFromArgs(process.argv.slice(2)) ||
    null
  );
}

async function runOnce(jobId: string): Promise<number> {
  const result = await runRecordsRequestJob(jobId);
  const payload = JSON.stringify(result);
  process.stdout.write(`${payload}\n`);
  if (result.outcome === "refused") {
    return 2;
  }
  if (result.outcome === "failed") {
    return 1;
  }
  return 0;
}

async function startHttpServer(port: number): Promise<void> {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/run") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    let body: { jobId?: unknown };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        jobId?: unknown;
      };
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_json" }));
      return;
    }

    const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
    if (!jobId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing_job_id" }));
      return;
    }

    const result = await runRecordsRequestJob(jobId);
    const status =
      result.outcome === "complete"
        ? 200
        : result.outcome === "refused"
          ? 409
          : result.outcome === "needs-human" ||
              result.outcome === "awaiting-purchase-approval"
            ? 202
            : 500;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, () => resolve());
    server.on("error", reject);
  });

  process.stdout.write(
    JSON.stringify({ status: "listening", port, path: "/run" }) + "\n",
  );
}

async function main(): Promise<void> {
  const portRaw = process.env.PORT?.trim();
  if (portRaw) {
    const port = Number(portRaw);
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error(`Invalid PORT=${portRaw}`);
    }
    await startHttpServer(port);
    return;
  }

  const jobId = resolveJobId();
  if (!jobId) {
    process.stderr.write(
      "records-request-worker: set RECORDS_REQUEST_JOB_ID, pass --job-id, or set PORT for HTTP mode\n",
    );
    process.exitCode = 2;
    return;
  }

  process.exitCode = await runOnce(jobId);
}

main()
  .catch((err) => {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeJobStorePool();
  });
