import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { startQueueWorker } from "@workspace/codes";
import router from "./routes";
import { logger } from "./lib/logger";

// Start the code-atom fetch queue drainer at module load. Polls every
// CODE_ATOM_QUEUE_TICK_MS (default 10s) for pending entries.
startQueueWorker(logger);

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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
