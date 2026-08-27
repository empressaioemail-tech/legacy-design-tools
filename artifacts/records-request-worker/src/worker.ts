/**
 * P-85 item 5 — core job runner (shared by CLI and HTTP entry).
 */

import {
  loadRecordsRequestJob,
  markRecordsRequestJobRunning,
  markRecordsRequestJobTerminal,
  type RecordsRequestJobRow,
} from "./jobStore.js";
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
  };
}

/** Fire-and-forget vision read after successful capture (cortex api-server). */
function triggerVisionReads(jobId: string): void {
  const url = process.env.RECORDS_REQUEST_VISION_URL?.trim();
  if (!url) return;
  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId }),
  }).catch(() => {});
}

async function executeRecipe(
  job: RecordsRequestJobRow,
  portalId: string,
  browserFactory: (fn: (b: RecordsRecipeBrowser) => Promise<unknown>) => Promise<unknown>,
): Promise<RunRecordsRequestJobResult> {
  const recipeResult = (await browserFactory(async (browser) =>
    runRecipeForJob(buildRecipeContext(job, portalId), browser),
  )) as Awaited<ReturnType<typeof runRecipeForJob>>;

  if (recipeResult.status === "complete") {
    await markRecordsRequestJobTerminal(job.id, {
      status: "complete",
      scopeSearched: recipeResult.scopeSearched ?? null,
      errorCode: null,
      errorMessage: null,
    });
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
    return { jobId: job.id, outcome: "complete" };
  }

  if (recipeResult.status === "needs-human") {
    const isPurchase =
      recipeResult.errorCode === "awaiting-purchase-approval";
    await markRecordsRequestJobTerminal(job.id, {
      status: isPurchase ? "awaiting-purchase-approval" : "needs-human",
      scopeSearched: recipeResult.scopeSearched ?? null,
      errorCode: recipeResult.errorCode ?? "needs-human",
      errorMessage: recipeResult.errorMessage ?? "Portal requires human clerk",
      runCost:
        typeof recipeResult.scopeSearched?.acquisition === "object"
          ? {
              purchaseCostCents: (
                recipeResult.scopeSearched.acquisition as Record<string, unknown>
              ).purchaseCostCents,
            }
          : null,
    });
    return {
      jobId: job.id,
      outcome: isPurchase ? "awaiting-purchase-approval" : "needs-human",
      errorCode: recipeResult.errorCode,
      errorMessage: recipeResult.errorMessage,
    };
  }

  await markRecordsRequestJobTerminal(job.id, {
    status: "failed",
    errorCode: recipeResult.errorCode ?? "recipe-failed",
    errorMessage: recipeResult.errorMessage ?? "Records recipe failed",
  });
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
