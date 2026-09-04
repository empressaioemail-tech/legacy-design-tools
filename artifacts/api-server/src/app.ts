import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { startQueueWorker } from "@workspace/codes";
import router from "./routes";
import { logger } from "./lib/logger";
import { sessionMiddleware } from "./middlewares/session";
import { userRateLimitMiddleware } from "./middlewares/userRateLimit";
import { mountSpaStatic } from "./middlewares/spaStatic";
import { stripeWebhookHandler } from "./routes/brokerageBilling";
import { startBriefingGenerationJobsSweep } from "./lib/briefingGenerationJobsSweep";
import { startFindingRunsSweep } from "./lib/findingRunsSweep";
import { startTerrainJobsSweep } from "./lib/terrainGenerationJobsSweep";
import { startAdapterCacheSweepWorker } from "./lib/adapterCache";

// Start the code-atom fetch queue drainer at module load. Polls every
// CODE_ATOM_QUEUE_TICK_MS (default 10s) for pending entries.
startQueueWorker(logger);

// Start the briefing-generation-jobs sweeper. Daily-cadence DELETE of
// terminal rows older than the retention window AND not the latest
// row for their engagement — keeps the table bounded as the
// architect-driven kickoff cadence accrues completed/failed history.
// See `lib/briefingGenerationJobsSweep.ts` for the retention contract.
startBriefingGenerationJobsSweep(logger);

// Rescue stale pending finding_runs after worker crashes / deploy
// restarts; also one-time expire on boot for operator keystone engagement.
startFindingRunsSweep(logger);

// Rescue orphaned terrain_generation_jobs (queued/generating rows left by a
// worker crash / deploy restart) and reap old terminal rows. The async
// parcel-terrain authoring runs off the request path (terrainJobWorker); this
// sweep is its orphan-recovery + retention path. See
// `lib/terrainGenerationJobsSweep.ts`.
startTerrainJobsSweep(logger);

// Sweep expired federal-adapter cache rows (Task #203). Reads filter
// `expires_at > now()` so expired rows never serve, but the table
// would otherwise grow without bound for parcels that are looked up
// once and never re-cached. Disabled with
// ADAPTER_CACHE_SWEEP_INTERVAL_MS=0.
startAdapterCacheSweepWorker({ log: logger });

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(cookieParser());
app.post(
  "/api/brokerage/v1/billing/stripe/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    void stripeWebhookHandler(req, res);
  },
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Session middleware MUST run after cookieParser (it reads `pr_session`
// from `req.cookies`) and before any route that calls `req.session`.
// See `middlewares/session.ts` for the cookie shape and the
// dev-only header overrides honored when NODE_ENV !== "production".
app.use(sessionMiddleware);
app.use(userRateLimitMiddleware);

app.use("/api", router);

/**
 * A 4xx the framework itself raised for the client (body-parser's
 * entity.parse.failed / entity.too.large carry `status` and `expose: true`).
 * Anything else, including app errors that happen to carry a status, is an
 * internal error. Narrow on purpose: a boundary that rewrites every error
 * into a client fault is the over-broad control.
 */
function exposedClientErrorStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { status?: unknown; statusCode?: unknown; expose?: unknown };
  const status =
    typeof e.status === "number"
      ? e.status
      : typeof e.statusCode === "number"
        ? e.statusCode
        : null;
  if (status === null || e.expose !== true) return null;
  return status >= 400 && status <= 499 ? status : null;
}

// JSON error boundary for every /api route. Without it Express renders the
// finalhandler HTML page: an MCP caller passes that page through verbatim
// with isError: true, and outside production a DrizzleQueryError embeds SQL
// and params in it. Express 5 forwards a rejected async handler here on its
// own (no wrapper). Mounted at /api so the SPA static path is untouched.
app.use(
  "/api",
  (err: unknown, req: Request, res: Response, next: NextFunction) => {
    const path = req.originalUrl?.split("?")[0] ?? req.url;
    const clientStatus = exposedClientErrorStatus(err);
    if (clientStatus === null) {
      logger.error({ err, path, method: req.method }, "api_internal_error");
    } else {
      logger.warn(
        { err, path, method: req.method, status: clientStatus },
        "api_client_error",
      );
    }
    if (res.headersSent) {
      next(err);
      return;
    }
    if (clientStatus !== null) {
      const type = (err as { type?: unknown }).type;
      res.status(clientStatus).json({
        error: "bad_request",
        type: typeof type === "string" ? type : "client_error",
      });
      return;
    }
    res.status(500).json({ error: "internal_error" });
  },
);

// Production single-service static-serve: when SPA_STATIC_ROOT is set
// (the Cloud Run image), api-server also serves the built Vite SPAs.
// MUST come after the /api router so the root SPA catch-all cannot
// swallow API requests. No-op in local dev (env var unset).
mountSpaStatic(app);

export default app;
