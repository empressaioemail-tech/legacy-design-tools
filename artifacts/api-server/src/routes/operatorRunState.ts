/**
 * Operator run-state status endpoints for the command center's Run Monitor.
 *
 * The command center (hauska-map `RunMonitor.tsx`) probes, in order:
 *   1. GET {cortex}/api/brokerage/v1/operator/warming/status
 *   2. GET {cortex}/api/internal/qa/run-state
 * and wins on the first that returns usable run-state. Both are served here by
 * the SAME honest projection (`buildOperatorRunState`) so whichever the console
 * reaches first, it sees identical, truthful state.
 *
 * These are OPERATOR / SERVICE endpoints — never anonymous:
 *   - The brokerage/v1 `/operator/*` router mounts UNDER the brokerageV1
 *     `requireBrokerageAuthOrServiceToken` gate (see routes/brokerageBrief.ts).
 *     The console proxy attaches the service Bearer server-side; a request with
 *     no credential or a wrong key is rejected by that gate before reaching the
 *     handler.
 *   - The `/internal/qa/run-state` router carries its OWN Bearer gate
 *     (`requireServiceToken`) because it mounts at the top-level `/api` router
 *     which has no auth in front of it — anonymous or wrong-key requests get a
 *     401 { error: "unauthorized" }.
 *
 * See lib/operatorRunState.ts for what the projection actually reports and why
 * the warming harness is honestly `not-scheduled`.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { buildOperatorRunState } from "../lib/operatorRunState";
import { requireServiceToken } from "../middlewares/serviceAuth";
import { logger } from "../lib/logger";

async function handleRunState(_req: Request, res: Response): Promise<void> {
  try {
    const state = await buildOperatorRunState();
    res.json(state);
  } catch (err) {
    logger.error({ err }, "operatorRunState: failed to build run-state");
    res.status(500).json({
      error: "run_state_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Mounts under brokerageV1 at `/operator`, so the full path is
 * `/api/brokerage/v1/operator/warming/status`. Auth is inherited from
 * brokerageV1's `requireBrokerageAuthOrServiceToken` gate — no extra
 * middleware here.
 */
export const brokerageOperatorRouter: IRouter = Router();
brokerageOperatorRouter.get("/warming/status", handleRunState);

/**
 * Mounts at the top-level `/api` router as `/internal/qa/run-state`. Because
 * the top-level router has no auth in front, this router carries its own
 * Bearer service-token gate so the endpoint is never anonymous.
 */
export const internalQaRunStateRouter: IRouter = Router();
internalQaRunStateRouter.get(
  "/internal/qa/run-state",
  requireServiceToken,
  handleRunState,
);
