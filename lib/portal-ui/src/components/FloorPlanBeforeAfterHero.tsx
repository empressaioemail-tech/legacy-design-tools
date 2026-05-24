/**
 * Before/after hero — side-by-side on desktop, slider on narrow viewports.
 */
import { useEffect, useState } from "react";
import { Download, ExternalLink, RefreshCw } from "lucide-react";
import { BeforeAfterSlider } from "./BeforeAfterSlider";
import {
  FLOOR_PLAN_PRESET_META,
  type FloorPlanVizJob,
} from "../floor-plan-viz/types";

function useNarrowViewport(maxWidth = 768) {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia(`(max-width: ${maxWidth}px)`).matches
      : false,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [maxWidth]);
  return narrow;
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function FloorPlanBeforeAfterHero({
  job,
  onRegenerate,
  onSendToCanva,
}: {
  job: FloorPlanVizJob;
  onRegenerate?: () => void;
  onSendToCanva?: () => void;
}) {
  const narrow = useNarrowViewport();
  const before = job.sourcePreviewUrl;
  const after = job.outputPreviewUrl;
  const presetLabel = FLOOR_PLAN_PRESET_META[job.preset]?.label ?? job.preset;

  if (!after) return null;

  return (
    <section className="fpviz-result-hero" data-testid="fpviz-result-hero">
      {narrow ? (
        <BeforeAfterSlider
          beforeSrc={before}
          afterSrc={after}
          beforeLabel="2D plan"
          afterLabel="3D visualization"
          testId="fpviz-compare-slider"
        />
      ) : (
        <figure className="fpviz-compare-split" data-testid="fpviz-compare-split">
          <figcaption className="fpviz-compare-panel">
            <span className="fpviz-badge fpviz-badge--before">2D plan</span>
            <img src={before} alt="2D floor plan source" />
          </figcaption>
          <span className="fpviz-compare-arrow" aria-hidden>
            →
          </span>
          <figcaption className="fpviz-compare-panel">
            <span className="fpviz-badge fpviz-badge--after">3D visualization</span>
            <img src={after} alt="3D floor plan visualization" />
          </figcaption>
        </figure>
      )}

      <footer className="fpviz-result-actions">
        <a
          href={after}
          className="sc-btn-primary sc-btn-sm"
          data-testid="fpviz-download"
          download={`floor-plan-viz-${job.id}.png`}
        >
          <Download size={14} aria-hidden /> Download PNG
        </a>
        <a
          href={after}
          target="_blank"
          rel="noopener noreferrer"
          className="sc-btn-ghost sc-btn-sm"
          data-testid="fpviz-open-full"
        >
          <ExternalLink size={14} aria-hidden /> Open full size
        </a>
        {onRegenerate ? (
          <button
            type="button"
            className="sc-btn-ghost sc-btn-sm"
            data-testid="fpviz-regenerate"
            onClick={onRegenerate}
          >
            <RefreshCw size={14} aria-hidden /> Regenerate
          </button>
        ) : null}
        <button
          type="button"
          className="sc-btn-ghost sc-btn-sm"
          data-testid="fpviz-send-canva"
          disabled={!onSendToCanva}
          title={onSendToCanva ? "Send to client materials" : "Coming soon"}
          onClick={onSendToCanva}
        >
          Send to Canva
        </button>
      </footer>

      <dl className="fpviz-result-meta sc-meta">
        <div>
          <dt>Generated</dt>
          <dd data-testid="fpviz-result-time">{formatRelative(job.createdAt)}</dd>
        </div>
        <div>
          <dt>Style</dt>
          <dd>{presetLabel}</dd>
        </div>
        {job.creditsUsed != null ? (
          <div>
            <dt>Credits</dt>
            <dd>{job.creditsUsed}</dd>
          </div>
        ) : null}
        <div>
          <dt>Source</dt>
          <dd data-testid="fpviz-result-source">{job.source.label}</dd>
        </div>
      </dl>
    </section>
  );
}
