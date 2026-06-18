import express, { type Express } from "express";
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

// Production single-service static-serve: when SPA_STATIC_ROOT is set
// (the Cloud Run image), api-server also serves the built Vite SPAs.
// MUST come after the /api router so the root SPA catch-all cannot
// swallow API requests. No-op in local dev (env var unset).
mountSpaStatic(app);

export default app;
