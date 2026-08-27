/**
 * P-85 item 5 — core job runner (shared by CLI and HTTP entry).
 */

import {
  loadRecordsRequestJob,
  markRecordsRequestJobRunning,
  markRecordsRequestJobTerminal,
  type RecordsRequestJobRow,
  type TerminalJobUpdate,
} from "./jobStore.js";
import {
  loadPortalCanaryStatus,
  portalCanaryBlocksRun,
} from "./portalCanaryStore.js";
import { portalCanaryBlockMessage } from "./portalCanary.js";
import { deriveRunCostFromScope } from "./runCost.js";
import {
  resolvePortalIdForJob,
  runRecipeForJob,
  type RecordsRecipeBrowser,
} from "./recipes/index.js";
import { withPlaywrightBrowser } from "./playwrightBrowser.js";

export interface RunRecordsRequestJobResult {
  jobId: string;
  outcome:
    | "complete"
    | "failed"
    | "needs-human"
    | "awaiting-purchase-approval"
    | "refused";
  errorCode?: string;
  errorMessage?: string;
}

function buildRecipeContext(job: RecordsRequestJobRow, portalId: string) {
  return {
    jobId: job.id,
    countyFips: job.countyFips,
    parcelKey: job.parcelKey,
    portalId,
    requestPayload: job.requestPayload ?? {},
    scopeSearched: job.scopeSearched ?? undefined,
  };
}

/** Fire-and-forget vision read after successful capture (cortex api-server). */
function triggerVisionReads(jobId: string): void {
  const url = process.env.RECORDS_REQUEST_VISION_URL?.trim();
  if (!url) return;
  const serviceKey = process.env.SERVICE_API_KEY?.trim();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (serviceKey) {
    headers.Authorization = `Bearer ${serviceKey}`;
  }
  void fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jobId }),
  }).catch(() => {});
}

/** Fire-and-forget completion email (cortex internal notify route). */
function triggerCompletionNotify(
  jobId: string,
  kind:
    | "complete"
    | "failed"
    | "needs-human"
    | "awaiting-purchase-approval",
): void {
  const url = process.env.RECORDS_REQUEST_NOTIFY_URL?.trim();
  if (!url) return;
  const serviceKey = process.env.SERVICE_API_KEY?.trim();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (serviceKey) {
    headers.Authorization = `Bearer ${serviceKey}`;
  }
  void fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jobId, kind }),
  }).catch(() => {});
}

function terminalUpdateWithRunCost(
  update: TerminalJobUpdate,
  scopeSearched: Record<string, unknown> | null | undefined,
  computeMs: number,
): TerminalJobUpdate {
  return {
    ...update,
    runCost: deriveRunCostFromScope({
      scopeSearched,
      computeMs,
      terminalStatus: update.status,
    }),
  };
}

async function executeRecipe(
  job: RecordsRequestJobRow,
  portalId: string,
  browserFactory: (fn: (b: RecordsRecipeBrowser) => Promise<unknown>) => Promise<unknown>,
): Promise<RunRecordsRequestJobResult> {
  const startedAt = Date.now();
  const recipeResult = (await browserFactory(async (browser) =>
    runRecipeForJob(buildRecipeContext(job, portalId), browser),
  )) as Awaited<ReturnType<typeof runRecipeForJob>>;
  const computeMs = Date.now() - startedAt;

  if (recipeResult.status === "complete") {
    await markRecordsRequestJobTerminal(
      job.id,
      terminalUpdateWithRunCost(
        {
          status: "complete",
          scopeSearched: recipeResult.scopeSearched ?? null,
          errorCode: null,
          errorMessage: null,
        },
        recipeResult.scopeSearched,
        computeMs,
      ),
    );
    const acquired =
      typeof recipeResult.scopeSearched?.acquisition === "object"
        ? Number(
            (recipeResult.scopeSearched.acquisition as Record<string, unknown>)
              .acquired,
          )
        : 0;
    if (acquired > 0) {
      triggerVisionReads(job.id);
    }
    triggerCompletionNotify(job.id, "complete");
    return { jobId: job.id, outcome: "complete" };
  }

  if (recipeResult.status === "needs-human") {
    const isPurchase =
      recipeResult.errorCode === "awaiting-purchase-approval";
    const terminalStatus = isPurchase
      ? "awaiting-purchase-approval"
      : "needs-human";
    await markRecordsRequestJobTerminal(
      job.id,
      terminalUpdateWithRunCost(
        {
          status: terminalStatus,
          scopeSearched: recipeResult.scopeSearched ?? null,
          errorCode: recipeResult.errorCode ?? "needs-human",
          errorMessage:
            recipeResult.errorMessage ?? "Portal requires human clerk",
        },
        recipeResult.scopeSearched,
        computeMs,
      ),
    );
    triggerCompletionNotify(
      job.id,
      isPurchase ? "awaiting-purchase-approval" : "needs-human",
    );
    return {
      jobId: job.id,
      outcome: isPurchase ? "awaiting-purchase-approval" : "needs-human",
      errorCode: recipeResult.errorCode,
      errorMessage: recipeResult.errorMessage,
    };
  }

  await markRecordsRequestJobTerminal(
    job.id,
    terminalUpdateWithRunCost(
      {
        status: "failed",
        scopeSearched: recipeResult.scopeSearched ?? null,
        errorCode: recipeResult.errorCode ?? "recipe-failed",
        errorMessage: recipeResult.errorMessage ?? "Records recipe failed",
      },
      recipeResult.scopeSearched,
      computeMs,
    ),
  );
  triggerCompletionNotify(job.id, "failed");
  return {
    jobId: job.id,
    outcome: "failed",
    errorCode: recipeResult.errorCode,
    errorMessage: recipeResult.errorMessage,
  };
}

/**
 * Load a queued job, transition queued→running→terminal, run the portal recipe.
 * Fail-closed on missing job, wrong status, or unregistered portal.
 */
export async function runRecordsRequestJob(
  jobId: string,
  options?: {
    /** Test seam — skip Playwright and inject a mock browser runner. */
    browserFactory?: (
      fn: (browser: RecordsRecipeBrowser) => Promise<unknown>,
    ) => Promise<unknown>;
  },
): Promise<RunRecordsRequestJobResult> {
  const trimmed = jobId.trim();
  if (!trimmed) {
    return {
      jobId: trimmed,
      outcome: "refused",
      errorCode: "missing-job-id",
      errorMessage: "jobId is required",
    };
  }

  const job = await loadRecordsRequestJob(trimmed);
  if (!job) {
    return {
      jobId: trimmed,
      outcome: "refused",
      errorCode: "job-not-found",
      errorMessage: `records_request_jobs row not found for id=${trimmed}`,
    };
  }

  if (job.status !== "queued") {
    return {
      jobId: trimmed,
      outcome: "refused",
      errorCode: "job-not-queued",
      errorMessage: `job ${trimmed} has status=${job.status}; expected queued`,
    };
  }

  const portalId = resolvePortalIdForJob(job.countyFips, job.requestPayload);
  if (!portalId) {
    await markRecordsRequestJobRunning(trimmed);
    await markRecordsRequestJobTerminal(trimmed, {
      status: "failed",
      errorCode: "portal-unresolved",
      errorMessage: `No portal recipe for countyFips=${job.countyFips}`,
    });
    return {
      jobId: trimmed,
      outcome: "failed",
      errorCode: "portal-unresolved",
      errorMessage: `No portal recipe for countyFips=${job.countyFips}`,
    };
  }

  const canaryRow = await loadPortalCanaryStatus(portalId).catch(() => null);
  if (portalCanaryBlocksRun(canaryRow)) {
    await markRecordsRequestJobRunning(trimmed);
    const blockMessage = portalCanaryBlockMessage(
      canaryRow ?? {
        portalId,
        canaryStatus: "lookup-failed",
        canaryCheckedAt: null,
        canaryFailureReason: null,
        canaryRecipeVersion: null,
      },
    );
    await markRecordsRequestJobTerminal(trimmed, {
      status: "failed",
      errorCode: "portal-lookup-failed",
      errorMessage: blockMessage,
      runCost: deriveRunCostFromScope({
        scopeSearched: null,
        computeMs: 0,
        terminalStatus: "failed",
      }),
    });
    triggerCompletionNotify(trimmed, "failed");
    return {
      jobId: trimmed,
      outcome: "failed",
      errorCode: "portal-lookup-failed",
      errorMessage: blockMessage,
    };
  }

  await markRecordsRequestJobRunning(trimmed);

  const browserFactory = options?.browserFactory ?? withPlaywrightBrowser;

  try {
    return await executeRecipe(job, portalId, browserFactory);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markRecordsRequestJobTerminal(trimmed, {
      status: "failed",
      errorCode: "worker-error",
      errorMessage: message,
    }).catch(() => {});
    return {
      jobId: trimmed,
      outcome: "failed",
      errorCode: "worker-error",
      errorMessage: message,
    };
  }
}
