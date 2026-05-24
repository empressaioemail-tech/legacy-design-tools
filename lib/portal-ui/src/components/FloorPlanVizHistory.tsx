/**
 * Prior floor plan visualizations for an engagement.
 */
import { Download, Eye, RefreshCw, Trash2 } from "lucide-react";
import type { FloorPlanVizJob } from "../floor-plan-viz/types";

const STATUS_LABEL: Record<FloorPlanVizJob["status"], string> = {
  queued: "Queued",
  uploading: "Uploading",
  generating: "Generating",
  ready: "Ready",
  failed: "Failed",
};

function titleFor(job: FloorPlanVizJob): string {
  const d = new Date(job.createdAt);
  const date = Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `Floor plan viz · ${date}`;
}

export function FloorPlanVizHistory({
  jobs,
  activeJobId,
  onView,
  onRegenerate,
  onDelete,
}: {
  jobs: FloorPlanVizJob[];
  activeJobId?: string | null;
  onView?: (jobId: string) => void;
  onRegenerate?: (job: FloorPlanVizJob) => void;
  onDelete?: (jobId: string) => void;
}) {
  if (jobs.length === 0) {
    return (
      <p className="fpviz-history-empty sc-meta" data-testid="fpviz-history-empty">
        No floor plan visualizations yet.
      </p>
    );
  }

  return (
    <ul className="fpviz-history-list" data-testid="fpviz-history-list">
      {jobs.map((job) => {
        const thumb = job.outputPreviewUrl ?? job.sourcePreviewUrl;
        const active = job.id === activeJobId;
        return (
          <li key={job.id}>
            <article
              className={`fpviz-history-row${active ? " fpviz-history-row--active" : ""}`}
              data-testid={`fpviz-history-${job.id}`}
            >
              <img src={thumb} alt="" className="fpviz-history-thumb" />
              <section className="fpviz-history-copy">
                <h4 className="fpviz-history-title">{titleFor(job)}</h4>
                <p className="fpviz-history-source sc-meta">{job.source.label}</p>
                <span
                  className={`fpviz-status-pill fpviz-status-pill--${job.status}`}
                  data-testid={`fpviz-history-status-${job.id}`}
                >
                  {STATUS_LABEL[job.status]}
                </span>
              </section>
              <menu className="fpviz-history-actions">
                {onView ? (
                  <li>
                    <button
                      type="button"
                      className="sc-btn-ghost sc-btn-sm"
                      data-testid={`fpviz-history-view-${job.id}`}
                      onClick={() => onView(job.id)}
                    >
                      <Eye size={14} aria-hidden /> View
                    </button>
                  </li>
                ) : null}
                {job.outputPreviewUrl ? (
                  <li>
                    <a
                      href={job.outputPreviewUrl}
                      className="sc-btn-ghost sc-btn-sm"
                      data-testid={`fpviz-history-download-${job.id}`}
                      download
                    >
                      <Download size={14} aria-hidden /> Download
                    </a>
                  </li>
                ) : null}
                {onRegenerate ? (
                  <li>
                    <button
                      type="button"
                      className="sc-btn-ghost sc-btn-sm"
                      data-testid={`fpviz-history-regenerate-${job.id}`}
                      onClick={() => onRegenerate(job)}
                    >
                      <RefreshCw size={14} aria-hidden /> Regenerate
                    </button>
                  </li>
                ) : null}
                {onDelete ? (
                  <li>
                    <button
                      type="button"
                      className="sc-btn-ghost sc-btn-sm"
                      data-testid={`fpviz-history-delete-${job.id}`}
                      onClick={() => onDelete(job.id)}
                      title="Delete (stub)"
                    >
                      <Trash2 size={14} aria-hidden /> Delete
                    </button>
                  </li>
                ) : null}
              </menu>
            </article>
          </li>
        );
      })}
    </ul>
  );
}
