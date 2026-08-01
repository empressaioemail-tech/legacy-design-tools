import { Router, type IRouter, type RequestHandler } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();
const FUNCTIONAL_HEALTH_TIMEOUT_MS = 5_000;

const healthHandler: RequestHandler = (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
};

type ComponentStatus = {
  status: "ok" | "error";
  latencyMs: number;
  detail?: string;
};

function dependencyBaseUrl(names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value.replace(/\/$/, "");
  }
  return null;
}

async function checkDatabase(): Promise<ComponentStatus> {
  const startedAt = Date.now();
  try {
    await db.execute(sql`select 1 as ready`);
    return { status: "ok", latencyMs: Date.now() - startedAt };
  } catch {
    return {
      status: "error",
      latencyMs: Date.now() - startedAt,
      detail: "database query failed",
    };
  }
}

async function checkDependency(
  componentName: string,
  envNames: string[],
): Promise<ComponentStatus> {
  const startedAt = Date.now();
  const baseUrl = dependencyBaseUrl(envNames);
  if (!baseUrl) {
    return {
      status: "error",
      latencyMs: Date.now() - startedAt,
      detail: `${componentName} URL is not configured`,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    FUNCTIONAL_HEALTH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        status: "error",
        latencyMs: Date.now() - startedAt,
        detail: `${componentName} health returned HTTP ${response.status}`,
      };
    }
    return { status: "ok", latencyMs: Date.now() - startedAt };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return {
      status: "error",
      latencyMs: Date.now() - startedAt,
      detail: timedOut
        ? `${componentName} health timed out`
        : `${componentName} health request failed`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

const readinessHandler: RequestHandler = async (_req, res) => {
  const checkedAt = new Date().toISOString();
  const [database, engineApi, retrievalApi] = await Promise.all([
    checkDatabase(),
    checkDependency("engine-api", ["ENGINE_API_URL"]),
    checkDependency("retrieval-api", [
      "BRIEF_RETRIEVAL_API_URL",
      "HAUSKA_RETRIEVAL_API_URL",
      "RETRIEVAL_API_URL",
    ]),
  ]);
  const components = { database, engineApi, retrievalApi };
  const healthy = Object.values(components).every(
    (component) => component.status === "ok",
  );

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "error",
    service: "cortex-api",
    components,
    checkedAt,
  });
};

// /healthz is canonical; /health is a back-compat alias for callers expecting
// the unsuffixed convention (k8s/AWS-style probes vs. classic monitoring URLs).
router.get("/healthz", healthHandler);
router.get("/health", healthHandler);
router.get("/health/ready", readinessHandler);

export default router;
