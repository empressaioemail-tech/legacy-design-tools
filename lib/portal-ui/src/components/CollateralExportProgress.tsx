/**
 * Async Placid PDF export job progress.
 */
import { Download, ExternalLink, Loader2, XCircle } from "lucide-react";
import type { CollateralExportJob } from "../collateral/types";

const STEPS: CollateralExportJob["step"][] = [
  "preparing",
  "resolving_assets",
  "rendering",
  "ready",
];

export function CollateralExportProgress({
  job,
  onCancel,
  onRetry,
}: {
  job: CollateralExportJob | null;
  onCancel?: () => void;
  onRetry?: () => void;
}) {
  if (!job) return null;

  if (job.step === "failed") {
    return (
      <div
        className="canva-push-progress canva-push-progress--failed"
        data-testid="collateral-export-progress"
      >
        <XCircle size={20} aria-hidden />
        <div>
          <p className="canva-push-progress-title">Could not generate PDF</p>
          <p className="canva-push-progress-body">
            {job.error?.message ?? job.progressLabel}
          </p>
        </div>
        <button
          type="button"
          className="sc-btn-primary sc-btn-sm"
          data-testid="collateral-export-retry"
          onClick={onRetry}
        >
          Retry
        </button>
      </div>
    );
  }

  if (job.step === "ready") {
    return (
      <div
        className="canva-push-progress canva-push-progress--ready"
        data-testid="collateral-export-progress"
      >
        {job.thumbnailUrl ? (
          <img src={job.thumbnailUrl} alt="" className="canva-push-thumb" />
        ) : null}
        <div className="canva-push-ready-copy">
          <p className="canva-push-progress-title">Client PDF ready</p>
          {job.creditsActual != null ? (
            <p className="canva-push-progress-hint sc-meta">
              {job.creditsActual} export credits used
            </p>
          ) : null}
          <div className="canva-push-ready-actions">
            {job.downloadUrl ? (
              <a
                href={job.downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
                download
                className="sc-btn-primary sc-btn-sm"
                data-testid="collateral-download-pdf"
              >
                Download PDF <Download size={14} aria-hidden />
              </a>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  const stepIndex = STEPS.indexOf(job.step);

  return (
    <div
      className="canva-push-progress canva-push-progress--active"
      data-testid="collateral-export-progress"
    >
      <Loader2 size={20} className="canva-push-spinner" aria-hidden />
      <div className="canva-push-active-copy">
        <p className="canva-push-progress-title">{job.progressLabel}</p>
        <ol className="canva-push-steps" aria-label="Export progress">
          {STEPS.slice(0, -1).map((step, i) => (
            <li
              key={step}
              data-step={step}
              data-complete={
                i < stepIndex ? "true" : i === stepIndex ? "active" : "false"
              }
            >
              {labelForStep(step)}
            </li>
          ))}
        </ol>
      </div>
      {onCancel ? (
        <button
          type="button"
          className="sc-btn-ghost sc-btn-sm"
          data-testid="collateral-export-cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
      ) : null}
    </div>
  );
}

function labelForStep(step: CollateralExportJob["step"]): string {
  switch (step) {
    case "preparing":
      return "Preparing";
    case "resolving_assets":
      return "Resolving assets";
    case "rendering":
      return "Rendering PDF";
    default:
      return step;
  }
}
