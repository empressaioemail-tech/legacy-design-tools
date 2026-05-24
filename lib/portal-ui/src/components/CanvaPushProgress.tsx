/**
 * Async Canva push job progress (stub — mirrors render polling UX).
 *
 * Expected API: GET /api/canva/push-jobs/:jobId
 */
import { ExternalLink, Loader2, XCircle } from "lucide-react";
import type { CanvaPushJob } from "../canva/types";

const STEPS: CanvaPushJob["step"][] = [
  "preparing",
  "uploading",
  "creating",
  "ready",
];

export function CanvaPushProgress({
  job,
  onCancel,
  onRetry,
  onCopyLink,
}: {
  job: CanvaPushJob | null;
  onCancel?: () => void;
  onRetry?: () => void;
  onCopyLink?: (url: string) => void;
}) {
  if (!job) return null;

  if (job.step === "failed") {
    return (
      <div className="canva-push-progress canva-push-progress--failed" data-testid="canva-push-progress">
        <XCircle size={20} aria-hidden />
        <div>
          <p className="canva-push-progress-title">Could not create design</p>
          <p className="canva-push-progress-body">{job.error?.message ?? job.progressLabel}</p>
        </div>
        <button type="button" className="sc-btn-primary sc-btn-sm" data-testid="canva-push-retry" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }

  if (job.step === "ready") {
    return (
      <div className="canva-push-progress canva-push-progress--ready" data-testid="canva-push-progress">
        {job.designThumbnailUrl ? (
          <img src={job.designThumbnailUrl} alt="" className="canva-push-thumb" />
        ) : null}
        <div className="canva-push-ready-copy">
          <p className="canva-push-progress-title">Design ready in Canva</p>
          <p className="canva-push-progress-hint">
            When you&apos;re done editing, use Canva&apos;s Return button to come back here.
          </p>
          <div className="canva-push-ready-actions">
            {job.designUrl ? (
              <>
                <a
                  href={job.designUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="sc-btn-primary sc-btn-sm"
                  data-testid="canva-open-design"
                >
                  Open in Canva <ExternalLink size={14} aria-hidden />
                </a>
                <button
                  type="button"
                  className="sc-btn-ghost sc-btn-sm"
                  data-testid="canva-copy-link"
                  onClick={() => job.designUrl && onCopyLink?.(job.designUrl)}
                >
                  Copy link
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  const stepIndex = STEPS.indexOf(job.step);

  return (
    <div className="canva-push-progress canva-push-progress--active" data-testid="canva-push-progress">
      <Loader2 size={20} className="canva-push-spinner" aria-hidden />
      <div className="canva-push-active-copy">
        <p className="canva-push-progress-title">{job.progressLabel}</p>
        <ol className="canva-push-steps" aria-label="Push progress">
          {STEPS.slice(0, -1).map((step, i) => (
            <li
              key={step}
              data-step={step}
              data-complete={i < stepIndex ? "true" : i === stepIndex ? "active" : "false"}
            >
              {labelForStep(step)}
            </li>
          ))}
        </ol>
      </div>
      {onCancel ? (
        <button type="button" className="sc-btn-ghost sc-btn-sm" data-testid="canva-push-cancel" onClick={onCancel}>
          Cancel
        </button>
      ) : null}
    </div>
  );
}

function labelForStep(step: CanvaPushJob["step"]): string {
  switch (step) {
    case "preparing":
      return "Preparing assets";
    case "uploading":
      return "Uploading to Canva";
    case "creating":
      return "Creating design";
    default:
      return step;
  }
}
