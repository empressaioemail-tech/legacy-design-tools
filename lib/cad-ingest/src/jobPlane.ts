/**
 * Where a cad-ingest write is allowed to run (P-169, moved to the DigitalOcean job plane by Phase 1
 * B0-3, 2026-10-07).
 *
 * A write (anything that is not --dry-run) runs only inside a cluster Job execution. The markers are
 * the same pair hauska-factory's `executionIdentity` and hauska-engine's `isClusterJobExecution`
 * read:
 *   - KUBERNETES_SERVICE_HOST is set by the kubelet in every pod, never by a caller's flag;
 *   - FACTORY_K8S_JOB is the pod's own `batch.kubernetes.io/job-name` label through the downward
 *     API, so the run record names the Job object that ran the write.
 *
 * Until 2026-10-07 the marker was CLOUD_RUN_JOB. Google Cloud closed on 2026-09-22, so that gate
 * made cad-ingest unable to write anywhere; it no longer counts.
 *
 * Executes: cli.ts before any file is downloaded for a write run.
 * Fails:    LAPTOP_WRITE_FROZEN (exit 2).
 */

export const LAPTOP_WRITE_FROZEN = "LAPTOP_WRITE_FROZEN";

export const LAPTOP_WRITE_FROZEN_MESSAGE =
  "cad-ingest writes run only inside a cluster Job on the DigitalOcean job plane -- " +
  "no break-glass (2026-09-12 ruling, _decisions/2026-09-12_loaders_get_cloud_jobs_no_break_glass.md; " +
  "carried to DigitalOcean by the 2026-10-07 stage-3 ruling). KUBERNETES_SERVICE_HOST and " +
  "FACTORY_K8S_JOB are not both set: this process is not running inside the job. " +
  "Pass --dry-run to parse locally, or run this from the job.";

type Env = Record<string, string | undefined>;

export function isClusterJobExecution(env: Env): boolean {
  const host = String(env.KUBERNETES_SERVICE_HOST ?? "").trim();
  const job = String(env.FACTORY_K8S_JOB ?? "").trim();
  return host.length > 0 && job.length > 0;
}

/** The job and execution recorded on `cad_ingest_run` (columns keep their cloud_run_* names). */
export function runIdentity(env: Env): { job: string | null; execution: string | null } {
  if (isClusterJobExecution(env)) {
    return {
      job: String(env.FACTORY_K8S_JOB).trim(),
      execution: String(env.FACTORY_K8S_JOB_UID ?? "").trim() || null,
    };
  }
  return { job: null, execution: null };
}
