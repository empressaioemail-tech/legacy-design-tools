/**
 * Background queue drainer for the code-atom warmup pipeline.
 *
 * Boot at api-server startup with `startQueueWorker(logger)`. The worker
 * polls the queue every TICK_MS milliseconds; each tick attempts to drain a
 * small batch via the orchestrator. The poll interval is intentionally
 * loose — politeness limits inside individual adapters (e.g. Municode's
 * 1.5s spacing) dominate throughput.
 *
 * Notes:
 *   - One worker per process. We early-return if startQueueWorker() is
 *     called twice.
 *   - We never throw out of the tick handler; failures are logged and we
 *     wait for the next tick.
 *   - SIGTERM/SIGINT are handled at the process level by the host (Express);
 *     stopQueueWorker() is exposed for tests.
 */

import { drainQueue, type OrchestratorLogger } from "./orchestrator";

const TICK_MS = Number(process.env.CODE_ATOM_QUEUE_TICK_MS ?? "10000");
const BATCH_SIZE = Number(process.env.CODE_ATOM_QUEUE_BATCH_SIZE ?? "3");

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export function startQueueWorker(log: OrchestratorLogger): void {
  if (timer) {
    log.warn({}, "code-atom queue worker: startQueueWorker called twice, ignoring");
    return;
  }
  log.info(
    { tickMs: TICK_MS, batchSize: BATCH_SIZE },
    "code-atom queue worker: starting",
  );
  timer = setInterval(() => {
    void tick(log);
  }, TICK_MS);
  // unref so the worker doesn't block process exit during graceful shutdown.
  if (typeof timer.unref === "function") timer.unref();
  // Also drain once on boot so freshly-enqueued work doesn't wait a full tick.
  setTimeout(() => void tick(log), 1000);
}

export function stopQueueWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick(log: OrchestratorLogger): Promise<void> {
  if (inFlight) return; // skip if a previous tick is still running
  inFlight = true;
  try {
    const result = await drainQueue(log, BATCH_SIZE);
    if (result.picked > 0) {
      log.info(result, "code-atom queue worker: drained batch");
    }
  } catch (err) {
    log.error({ err }, "code-atom queue worker: tick failed");
  } finally {
    inFlight = false;
  }
}
