import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { startQueueWorker } from "@workspace/codes";
import router from "./routes";
import { logger } from "./lib/logger";
import { sessionMiddleware } from "./middlewares/session";
import { startBriefingGenerationJobsSweep } from "./lib/briefingGenerationJobsSweep";

// Start the code-atom fetch queue drainer at module load. Polls every
// CODE_ATOM_QUEUE_TICK_MS (default 10s) for pending entries.
startQueueWorker(logger);

// Start the briefing-generation-jobs sweeper. Daily-cadence DELETE of
// terminal rows older than the retention window AND not the latest
// row for their engagement — keeps the table bounded as the
// architect-driven kickoff cadence accrues completed/failed history.
// See `lib/briefingGenerationJobsSweep.ts` for the retention contract.
startBriefingGenerationJobsSweep(logger);

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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Session middleware MUST run after cookieParser (it reads `pr_session`
// from `req.cookies`) and before any route that calls `req.session`.
// See `middlewares/session.ts` for the cookie shape and the
// dev-only header overrides honored when NODE_ENV !== "production".
app.use(sessionMiddleware);

app.use("/api", router);

export default app;
