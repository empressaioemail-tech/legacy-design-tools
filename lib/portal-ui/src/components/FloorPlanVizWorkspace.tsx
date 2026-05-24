/**
 * Floor plan → 3D visualization workspace (stub-driven).
 *
 * Expected backend endpoints:
 *   POST /api/engagements/:id/renders/source-upload
 *   POST /api/engagements/:id/renders (expertName: plan)
 *   GET  /api/renders/:id
 *   GET  /api/engagements/:id/renders
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { FloorPlanBeforeAfterHero } from "./FloorPlanBeforeAfterHero";
import { FloorPlanFormatBadges } from "./FloorPlanFormatBadges";
import { FloorPlanSourcePicker } from "./FloorPlanSourcePicker";
import { FloorPlanVizControls } from "./FloorPlanVizControls";
import { FloorPlanVizHistory } from "./FloorPlanVizHistory";
import { FloorPlanVizProgress } from "./FloorPlanVizProgress";
import { mockFloorPlanVizService, registerMockFloorPlanSource } from "../floor-plan-viz/mockFloorPlanVizService";
import { MOCK_FLOOR_PLAN_BEFORE } from "../floor-plan-viz/mockFixtures";
import type {
  FloorPlanVizJob,
  FloorPlanVizService,
  FloorPlanVizSource,
} from "../floor-plan-viz/types";

const DEFAULT_PROMPT =
  "Furnished interior floor plan, photoreal top-down 3D visualization, natural lighting";

const ERROR_COPY: Record<
  NonNullable<FloorPlanVizJob["errorCode"]>,
  { title: string; body: string; retry?: boolean }
> = {
  upload: {
    title: "Upload failed",
    body: "We couldn't upload your floor plan. Check your connection and try again.",
    retry: true,
  },
  invalid: {
    title: "Invalid image",
    body: "The image is too small or an unsupported format. Use PNG, JPEG, WebP, or PDF.",
  },
  credits: {
    title: "Insufficient credits",
    body: "You need more render credits to visualize this floor plan.",
  },
  engine: {
    title: "Render engine failed",
    body: "Something went wrong while generating. Try again with the same settings.",
    retry: true,
  },
  timeout: {
    title: "Timed out",
    body: "Generation took longer than expected. Try again — large plans may need a retry.",
    retry: true,
  },
};

function isInFlight(status: FloorPlanVizJob["status"]): boolean {
  return status === "queued" || status === "uploading" || status === "generating";
}

export function FloorPlanVizWorkspace({
  engagementId,
  service = mockFloorPlanVizService,
  preselectedSourceId = null,
  onSendToCanva,
}: {
  engagementId: string;
  service?: FloorPlanVizService;
  preselectedSourceId?: string | null;
  onSendToCanva?: (job: FloorPlanVizJob) => void;
}) {
  const [sources, setSources] = useState<FloorPlanVizSource[]>([]);
  const [jobs, setJobs] = useState<FloorPlanVizJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(
    preselectedSourceId,
  );
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<FloorPlanVizJob | null>(null);
  const [generating, setGenerating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const pollRef = useRef<number | null>(null);
  const elapsedRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const [sourceList, jobList] = await Promise.all([
      service.listSources(engagementId),
      service.listJobs(engagementId),
    ]);
    setSources(sourceList);
    setJobs(jobList);
    return { sourceList, jobList };
  }, [engagementId, service]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { sourceList } = await refresh();
      if (cancelled) return;
      if (preselectedSourceId) {
        const match = sourceList.find((s) => s.id === preselectedSourceId);
        if (match && !match.disabled) {
          setSelectedSourceId(preselectedSourceId);
        } else {
          const sheet = sourceList.find((s) => s.kind === "sheet" && !s.disabled);
          setSelectedSourceId(sheet?.id ?? null);
        }
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [preselectedSourceId, refresh]);

  useEffect(() => {
    if (!activeJobId) {
      setActiveJob(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const job = await service.getJob(activeJobId);
        if (cancelled) return;
        setActiveJob(job);
        if (job.status === "ready" || job.status === "failed") {
          setGenerating(false);
          void refresh();
          if (pollRef.current != null) {
            window.clearInterval(pollRef.current);
            pollRef.current = null;
          }
          if (elapsedRef.current != null) {
            window.clearInterval(elapsedRef.current);
            elapsedRef.current = null;
          }
        }
      } catch {
        /* stub — ignore transient poll errors */
      }
    };
    void poll();
    pollRef.current = window.setInterval(poll, 800);
    return () => {
      cancelled = true;
      if (pollRef.current != null) window.clearInterval(pollRef.current);
    };
  }, [activeJobId, refresh, service]);

  const selectedSource = useMemo(
    () => sources.find((s) => s.id === selectedSourceId) ?? null,
    [sources, selectedSourceId],
  );

  const canGenerate = Boolean(selectedSource && !selectedSource.disabled);

  const handleUpload = useCallback(async () => {
    setUploading(true);
    setBannerError(null);
    await new Promise((r) => window.setTimeout(r, 900));
    const uploadId = `${engagementId}-upload-${Date.now()}`;
    const uploadSource: FloorPlanVizSource = {
      id: uploadId,
      kind: "upload",
      label: "Uploaded floor plan",
      thumbnailUrl: MOCK_FLOOR_PLAN_BEFORE,
      previewUrl: MOCK_FLOOR_PLAN_BEFORE,
      fileFormat: "png",
      fileSizeLabel: "1.8 MB",
      dimensionsLabel: "2000 × 1500",
    };
    registerMockFloorPlanSource(uploadSource);
    setSources((prev) => [uploadSource, ...prev.filter((s) => s.id !== uploadId)]);
    setSelectedSourceId(uploadId);
    setUploading(false);
  }, [engagementId]);

  const handleGenerate = useCallback(async () => {
    if (!selectedSourceId || !canGenerate) return;
    setBannerError(null);
    setGenerating(true);
    setElapsedSeconds(0);
    if (elapsedRef.current != null) window.clearInterval(elapsedRef.current);
    elapsedRef.current = window.setInterval(() => {
      setElapsedSeconds((s) => s + 1);
    }, 1000);
    try {
      const { jobId } = await service.startVisualization({
        engagementId,
        sourceId: selectedSourceId,
        preset: "standard-3d",
        prompt,
      });
      setActiveJobId(jobId);
    } catch {
      setGenerating(false);
      setBannerError("Could not start visualization. Try again.");
      if (elapsedRef.current != null) {
        window.clearInterval(elapsedRef.current);
        elapsedRef.current = null;
      }
    }
  }, [canGenerate, engagementId, prompt, selectedSourceId, service]);

  const handleCancel = useCallback(() => {
    setGenerating(false);
    setActiveJobId(null);
    setActiveJob(null);
    if (pollRef.current != null) window.clearInterval(pollRef.current);
    if (elapsedRef.current != null) window.clearInterval(elapsedRef.current);
  }, []);

  const displayJob =
    activeJob ??
    jobs.find((j) => j.id === activeJobId) ??
    jobs.find((j) => j.status === "ready") ??
    null;

  const errorInfo =
    displayJob?.status === "failed" && displayJob.errorCode
      ? ERROR_COPY[displayJob.errorCode]
      : null;

  return (
    <section className="fpviz-workspace" data-testid="fpviz-workspace">
      {bannerError ? (
        <aside className="fpviz-error-banner" data-testid="fpviz-error-banner" role="alert">
          <AlertTriangle size={16} aria-hidden />
          <span>{bannerError}</span>
        </aside>
      ) : null}

      <section className="fpviz-workspace-grid">
        <article className="fpviz-zone fpviz-zone--source">
          <header className="fpviz-zone-head">
            <h2 className="sc-section-title">Source floor plan</h2>
            <p className="sc-meta">
              Upload a 2D plan or pick one from this engagement.
            </p>
          </header>
          <FloorPlanFormatBadges />
          {uploading ? (
            <p className="fpviz-upload-progress sc-meta" data-testid="fpviz-upload-progress">
              <Loader2 size={14} className="fpviz-progress-spin" aria-hidden />
              Uploading plan…
            </p>
          ) : null}
          <FloorPlanSourcePicker
            sources={sources}
            selectedId={selectedSourceId}
            onSelect={setSelectedSourceId}
            onUploadClick={() => void handleUpload()}
            loading={loading}
          />
        </article>

        <article className="fpviz-zone fpviz-zone--controls">
          <header className="fpviz-zone-head">
            <h2 className="sc-section-title">Visualization settings</h2>
          </header>
          <FloorPlanVizControls
            prompt={prompt}
            onPromptChange={setPrompt}
            onGenerate={() => void handleGenerate()}
            generating={generating}
            canGenerate={canGenerate}
          />
        </article>

        <article className="fpviz-zone fpviz-zone--result">
          <header className="fpviz-zone-head">
            <h2 className="sc-section-title">Result</h2>
          </header>

          {generating || (activeJob && isInFlight(activeJob.status)) ? (
            <FloorPlanVizProgress
              status={activeJob?.status ?? "queued"}
              elapsedSeconds={elapsedSeconds}
              onCancel={handleCancel}
            />
          ) : null}

          {errorInfo ? (
            <aside className="fpviz-error-banner" data-testid="fpviz-job-error" role="alert">
              <AlertTriangle size={16} aria-hidden />
              <section>
                <strong>{errorInfo.title}</strong>
                <p className="sc-meta">{displayJob?.error ?? errorInfo.body}</p>
                {errorInfo.retry ? (
                  <button
                    type="button"
                    className="sc-btn-primary sc-btn-sm"
                    data-testid="fpviz-retry"
                    onClick={() => void handleGenerate()}
                  >
                    Retry
                  </button>
                ) : null}
                {displayJob?.errorCode === "credits" ? (
                  <a
                    href="#"
                    className="sc-btn-ghost sc-btn-sm"
                    data-testid="fpviz-credits-link"
                    onClick={(e) => e.preventDefault()}
                  >
                    View credits & billing
                  </a>
                ) : null}
              </section>
            </aside>
          ) : null}

          {displayJob?.status === "ready" && displayJob.outputPreviewUrl ? (
            <FloorPlanBeforeAfterHero
              job={displayJob}
              onRegenerate={() => void handleGenerate()}
              onSendToCanva={
                onSendToCanva ? () => onSendToCanva(displayJob) : undefined
              }
            />
          ) : null}

          {!generating &&
          !errorInfo &&
          !(displayJob?.status === "ready" && displayJob.outputPreviewUrl) ? (
            <p className="fpviz-result-empty sc-meta" data-testid="fpviz-result-empty">
              Select a floor plan and click Visualize to see your before/after
              comparison here.
            </p>
          ) : null}
        </article>
      </section>

      <section className="fpviz-history-section">
        <header className="fpviz-zone-head">
          <h2 className="sc-section-title">Floor plan history</h2>
        </header>
        <FloorPlanVizHistory
          jobs={jobs}
          activeJobId={activeJobId ?? displayJob?.id}
          onView={(id) => {
            setActiveJobId(id);
            const job = jobs.find((j) => j.id === id);
            if (job) setActiveJob(job);
          }}
          onRegenerate={(job) => {
            setSelectedSourceId(job.source.id);
            void handleGenerate();
          }}
          onDelete={() => {
            /* stub — backend delete hook */
          }}
        />
      </section>
    </section>
  );
}
