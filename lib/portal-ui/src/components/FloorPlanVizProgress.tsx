/**
 * Job progress stepper for floor plan visualization.
 */
import { Loader2, X } from "lucide-react";
import type { FloorPlanVizJobStatus } from "../floor-plan-viz/types";

const STEPS: { key: FloorPlanVizJobStatus; label: string }[] = [
  { key: "uploading", label: "Uploading plan" },
  { key: "queued", label: "Sending to render engine" },
  { key: "generating", label: "Generating visualization" },
  { key: "ready", label: "Ready" },
];

function stepIndex(status: FloorPlanVizJobStatus): number {
  if (status === "failed") return -1;
  if (status === "ready") return STEPS.length;
  const idx = STEPS.findIndex((s) => s.key === status);
  return idx >= 0 ? idx : 0;
}

export function FloorPlanVizProgress({
  status,
  elapsedSeconds,
  onCancel,
}: {
  status: FloorPlanVizJobStatus;
  elapsedSeconds?: number;
  onCancel?: () => void;
}) {
  const activeIdx = stepIndex(status);
  const inFlight = status !== "ready" && status !== "failed";

  return (
    <div
      className="fpviz-progress"
      data-testid="fpviz-progress"
      data-status={status}
    >
      <div className="fpviz-progress-head">
        {inFlight ? (
          <Loader2 size={16} className="fpviz-progress-spin" aria-hidden />
        ) : null}
        <span className="fpviz-progress-title">
          {status === "ready"
            ? "Visualization ready"
            : status === "failed"
              ? "Generation failed"
              : "Generating visualization…"}
        </span>
        {inFlight && onCancel ? (
          <button
            type="button"
            className="sc-btn-ghost sc-btn-sm"
            data-testid="fpviz-cancel-job"
            onClick={onCancel}
          >
            <X size={14} aria-hidden /> Cancel
          </button>
        ) : null}
      </div>
      <p className="fpviz-progress-hint sc-meta">
        Usually 30–60 seconds
        {elapsedSeconds != null && inFlight
          ? ` · ${elapsedSeconds}s elapsed`
          : null}
      </p>
      <ol className="fpviz-progress-steps">
        {STEPS.map((step, i) => {
          const complete = i < activeIdx;
          const active = i === activeIdx && inFlight;
          return (
            <li
              key={step.key}
              data-complete={complete ? "true" : active ? "active" : "false"}
              data-testid={`fpviz-step-${step.key}`}
            >
              {step.label}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
