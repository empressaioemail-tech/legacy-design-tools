/**
 * G-60 remount: /api/plan-review is a proxy to plan-review Cloud Run.
 * Not a second BFF. Not a 404. PLAN-ROW G-60 / A-026 / WDLL 24.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { requireServiceTokenOrSession } from "../middlewares/serviceAuth";

const FORBIDDEN_HOST = /cortex-api|legacy-design-tools|fancy-fire/i;
const TIMEOUT_MS = 30_000;

export function planReviewBackendUrl(): string {
  const url = (process.env.PLAN_REVIEW_BACKEND_URL ?? "").replace(/\/$/, "");
  if (!url) {
    throw new Error("PLAN_REVIEW_BACKEND_URL is required");
  }
  if (FORBIDDEN_HOST.test(url)) {
    throw new Error(
      "PLAN_REVIEW_BACKEND_URL refuses cortex-api as the plan-review host",
    );
  }
  return url;
}

function serviceToken(): string {
  return (
    process.env.PLAN_REVIEW_API_KEY ??
    process.env.PLAN_REVIEW_SERVICE_TOKEN ??
    ""
  );
}

async function proxy(req: Request, res: Response): Promise<void> {
  let backend: string;
  try {
    backend = planReviewBackendUrl();
  } catch (err) {
    res.status(503).json({
      error: "plan_review_unconfigured",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const token = serviceToken();
  if (!token) {
    res.status(503).json({
      error: "plan_review_unconfigured",
      message: "PLAN_REVIEW_API_KEY is required",
    });
    return;
  }

  const target = `${backend}${req.originalUrl}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "x-plan-review-source": "cortex-proxy",
    "user-agent": "cortex-api/g60-plan-review-proxy",
  };
  const contentType = req.headers["content-type"];
  if (typeof contentType === "string") headers["content-type"] = contentType;

  const method = req.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && req.body !== undefined;
  const body = hasBody ? JSON.stringify(req.body ?? {}) : undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const fetched = await fetch(target, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const text = await fetched.text();
    res.status(fetched.status);
    const ct = fetched.headers.get("content-type");
    if (ct) res.set("content-type", ct);
    res.set("x-plan-review-proxied", "1");
    res.send(text);
  } catch (err) {
    res.status(502).json({
      error: "plan_review_unreachable",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timeout);
  }
}

const router: IRouter = Router();
router.use(requireServiceTokenOrSession);
router.use((req, res, next) => {
  proxy(req, res).catch(next);
});

export default router;
