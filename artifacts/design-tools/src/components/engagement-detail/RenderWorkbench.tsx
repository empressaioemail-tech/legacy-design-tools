import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  Expand,
  ImageIcon,
  Loader2,
  Minus,
  Plus,
  Sparkles,
} from "lucide-react";
import {
  useListEngagementRenders,
  useGetRender,
  getListEngagementRendersQueryKey,
  getGetRenderQueryKey,
  ApiError,
  type RenderDetailResponse,
  type RenderListItem,
} from "@workspace/api-client-react";
import {
  BeforeAfterSlider,
  ConstellationCanvas,
  isRenderInFlight,
  RenderCard,
  RenderKickoffPanel,
  RenderPowerToolDialog,
} from "@workspace/portal-ui";
import type { KickoffRenderResponse } from "@workspace/api-client-react";
import { StudioCreateOverview } from "./StudioCreateOverview";
import { StudioRefinePanel } from "./StudioRefinePanel";
import {
  STUDIO_MODE_LABEL,
  type PowerToolId,
  type StudioWorkbenchMode,
} from "./studioMnmlCatalog";

const KIND_HISTORY_LABEL: Record<string, string> = {
  still: "Still render",
  "elevation-set": "Elevation set",
  video: "Video render",
};

function previewHrefFor(
  output: { previewUrl?: string | null; mirroredObjectKey?: string | null; id: string },
): string | null {
  if (output.previewUrl) return output.previewUrl;
  if (output.mirroredObjectKey) return `/api/render-outputs/${output.id}/file`;
  return null;
}

function downloadHrefFor(
  output: { downloadUrl?: string | null; mirroredObjectKey?: string | null; id: string },
): string | null {
  if (output.downloadUrl) return output.downloadUrl;
  if (output.mirroredObjectKey)
    return `/api/render-outputs/${output.id}/file?download=1`;
  return null;
}

function formatHistoryTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function RenderWorkbench({
  engagementId,
  defaultGlbUrl,
  hasBim,
  onOpenBimTab,
}: {
  engagementId: string;
  defaultGlbUrl?: string | null;
  hasBim: boolean;
  onOpenBimTab?: () => void;
}) {
  const [mode, setMode] = useState<StudioWorkbenchMode>("create");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [constellation, setConstellation] = useState(false);
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [activeTool, setActiveTool] = useState<PowerToolId | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const listQuery = useListEngagementRenders(engagementId, {
    query: {
      enabled: !!engagementId,
      queryKey: getListEngagementRendersQueryKey(engagementId),
      refetchInterval: 8000,
    },
  });

  const rootItems = useMemo(() => {
    const items = listQuery.data?.items ?? [];
    return [...items]
      .filter((i) => !i.parentRenderOutputId)
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
  }, [listQuery.data?.items]);

  useEffect(() => {
    if (rootItems.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !rootItems.some((r) => r.id === selectedId)) {
      setSelectedId(rootItems[0]!.id);
    }
  }, [rootItems, selectedId]);

  const selectedListItem = rootItems.find((r) => r.id === selectedId) ?? null;

  const detailQuery = useGetRender(selectedId ?? "", {
    query: {
      enabled: !!selectedId,
      queryKey: getGetRenderQueryKey(selectedId ?? ""),
      refetchInterval: ((query: { state: { data?: unknown } }) => {
        const data = query.state.data as RenderDetailResponse | undefined;
        const status = data?.status ?? selectedListItem?.status;
        return status && isRenderInFlight(status) ? 3000 : false;
      }) as unknown as number,
    },
  });

  const detail = detailQuery.data;
  const primaryOutput = detail?.outputs?.find(
    (o) => o.role === "primary" || o.role === "video-primary",
  );
  const previewUrl = primaryOutput ? previewHrefFor(primaryOutput) : null;
  const downloadUrl = primaryOutput ? downloadHrefFor(primaryOutput) : null;
  const beforeSrc =
    detail?.sourceUploadUrl && primaryOutput ? detail.sourceUploadUrl : undefined;
  const afterSrc = previewUrl ?? undefined;
  const showCompare =
    Boolean(
      detail?.status === "ready" &&
        beforeSrc &&
        afterSrc &&
        primaryOutput &&
        primaryOutput.format !== "mp4" &&
        primaryOutput.format !== "webm",
    );

  const handleKickedOff = useCallback((resp: KickoffRenderResponse) => {
    setSelectedId(resp.renderId);
    setMode("create");
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void el.requestFullscreen();
    }
  }, []);

  const previewDisabled =
    listQuery.error instanceof ApiError &&
    listQuery.error.status === 503 &&
    extractErrorCode(listQuery.error) === "renders_preview_disabled";

  return (
    <div
      className="render-workbench-shell"
      data-testid="renders-tab-dashboard"
    >
      <div className="render-workbench-modebar" data-testid="render-workbench-modebar">
        <div
          className="render-workbench-modes"
          role="tablist"
          aria-label="Workbench mode"
        >
          {(["create", "refine"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              data-active={mode === m ? "true" : "false"}
              data-testid={`render-workbench-mode-${m}`}
              className="render-workbench-mode-btn"
              onClick={() => setMode(m)}
            >
              {STUDIO_MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <div className="render-workbench-modebar-actions">
          <button
            type="button"
            className="cockpit-btn-ghost render-workbench-backdrop-btn"
            data-testid="design-tools-backdrop-toggle"
            aria-pressed={constellation}
            onClick={() => setConstellation((v) => !v)}
            title={
              constellation
                ? "Hide constellation backdrop"
                : "Show constellation backdrop"
            }
          >
            <Sparkles size={14} aria-hidden />
          </button>
        </div>
      </div>

      <div className="render-workbench-main">
        <aside
          className="render-workbench-history"
          aria-label="Render history"
          data-testid="render-workbench-history"
        >
          <div className="render-workbench-history-head">
            <h2 className="render-workbench-history-title">History</h2>
            {rootItems.length > 0 && (
              <span className="render-workbench-history-meta">
                {rootItems.length} session{rootItems.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <div className="render-workbench-history-list sc-scroll">
            {listQuery.isLoading && (
              <div className="render-workbench-history-loading sc-body opacity-60">
                Loading…
              </div>
            )}
            {previewDisabled && (
              <div
                className="render-workbench-history-empty sc-prose"
                data-testid="renders-preview-disabled"
              >
                Renders preview is disabled in this environment.
              </div>
            )}
            {!listQuery.isLoading &&
              !previewDisabled &&
              rootItems.length === 0 && (
                <div
                  className="render-workbench-history-empty sc-prose opacity-70"
                  data-testid="renders-gallery-empty"
                >
                  No renders yet. Use the panel on the right to queue your
                  first job.
                </div>
              )}
            {!listQuery.isLoading && rootItems.length > 0 && (
              <ul
                className="render-workbench-history-items"
                data-testid="renders-gallery"
              >
                {rootItems.map((item) => (
                  <HistoryRow
                    key={item.id}
                    item={item}
                    selected={item.id === selectedId}
                    onSelect={() => setSelectedId(item.id)}
                  />
                ))}
              </ul>
            )}
          </div>
        </aside>

        <section
          ref={canvasRef}
          className="render-workbench-canvas"
          data-testid="render-workbench-canvas"
          aria-label="Render preview"
        >
          {constellation && (
            <div className="render-workbench-canvas-backdrop" aria-hidden>
              <ConstellationCanvas />
            </div>
          )}

          <div
            className="render-workbench-canvas-stage"
            style={{ transform: `scale(${canvasZoom})` }}
          >
            {!selectedId && (
              <CanvasPlaceholder
                title="No render selected"
                hint="Pick a job from History or configure a new render on the right."
              />
            )}
            {selectedId && detailQuery.isLoading && !detail && (
              <CanvasPlaceholder
                title="Loading preview"
                hint="Fetching render outputs…"
                busy
              />
            )}
            {selectedId && detail && isRenderInFlight(detail.status) && (
              <CanvasPlaceholder
                title={detail.status === "queued" ? "Queued" : "Rendering"}
                hint="The preview will appear when the job finishes."
                busy
              />
            )}
            {selectedId &&
              detail &&
              detail.status === "failed" &&
              detail.errorMessage && (
                <CanvasPlaceholder
                  title="Render failed"
                  hint={detail.errorMessage}
                />
              )}
            {selectedId && detail && showCompare && beforeSrc && afterSrc && (
              <BeforeAfterSlider
                beforeSrc={beforeSrc}
                afterSrc={afterSrc}
                testId="render-workbench-compare"
              />
            )}
            {selectedId &&
              detail &&
              detail.status === "ready" &&
              !showCompare &&
              afterSrc && (
                <img
                  src={afterSrc}
                  alt="Render output"
                  className="render-workbench-canvas-image"
                  data-testid="render-workbench-preview-image"
                />
              )}
            {selectedId &&
              detail &&
              detail.status === "ready" &&
              !afterSrc &&
              detail.kind === "elevation-set" && (
              <div className="render-workbench-canvas-elevation-wrap sc-scroll">
                <RenderCard
                  render={detail}
                  engagementId={engagementId}
                  showPowerTools={false}
                  canCancel={false}
                />
              </div>
            )}
          </div>

          <div className="render-workbench-canvas-floats">
            <button
              type="button"
              className="render-workbench-float-chip"
              data-testid="render-workbench-fullscreen"
              onClick={toggleFullscreen}
              title="Full screen"
            >
              <Expand size={14} aria-hidden />
              <span>Full screen</span>
            </button>

            <div
              className="render-workbench-float-toolbar"
              data-testid="render-workbench-canvas-toolbar"
            >
              {downloadUrl && (
                <a
                  href={downloadUrl}
                  className="render-workbench-float-icon-btn"
                  data-testid="render-workbench-download"
                  download
                  title="Download"
                >
                  <Download size={16} aria-hidden />
                </a>
              )}
              <button
                type="button"
                className="render-workbench-float-icon-btn"
                data-testid="render-workbench-zoom-out"
                onClick={() =>
                  setCanvasZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10))
                }
                title="Zoom out"
              >
                <Minus size={16} aria-hidden />
              </button>
              <span
                className="render-workbench-zoom-label"
                data-testid="render-workbench-zoom-level"
              >
                {Math.round(canvasZoom * 100)}%
              </span>
              <button
                type="button"
                className="render-workbench-float-icon-btn"
                data-testid="render-workbench-zoom-in"
                onClick={() =>
                  setCanvasZoom((z) => Math.min(2, Math.round((z + 0.1) * 10) / 10))
                }
                title="Zoom in"
              >
                <Plus size={16} aria-hidden />
              </button>
            </div>
          </div>
        </section>

        <aside
          className="render-workbench-configure"
          aria-label={
            mode === "create" ? "Create render" : "Refine output"
          }
          data-testid="render-workbench-configure"
        >
          {mode === "create" && (
            <>
              <div className="render-workbench-configure-head">
                <div className="render-workbench-configure-overline">Studio</div>
                <div className="render-workbench-configure-title">Create</div>
                <p className="render-workbench-configure-sub">
                  Queue a new mnml job — still, elevation set, or video.
                </p>
              </div>
              <StudioCreateOverview />
              {!hasBim && (
                <div
                  className="render-workbench-bim-nudge"
                  data-testid="design-tools-bim-hint"
                  role="note"
                >
                  <ImageIcon size={14} aria-hidden />
                  <span>
                    No BIM model on file — upload an image or paste a GLB URL as
                    the source.
                  </span>
                  {onOpenBimTab && (
                    <button
                      type="button"
                      className="cockpit-btn-ghost"
                      onClick={onOpenBimTab}
                      data-testid="design-tools-open-bim"
                    >
                      Open 3D
                    </button>
                  )}
                </div>
              )}
              <div
                className="render-workbench-configure-scroll sc-scroll"
                data-testid="render-workbench-kickoff-rail"
                data-open="true"
              >
                <RenderKickoffPanel
                  engagementId={engagementId}
                  defaultGlbUrl={defaultGlbUrl ?? null}
                  onKickedOff={handleKickedOff}
                />
              </div>
            </>
          )}

          {mode === "refine" && (
            <StudioRefinePanel
              detail={detail}
              primaryOutputId={primaryOutput?.id}
              previewUrl={previewUrl}
              onSelectTool={setActiveTool}
            />
          )}
        </aside>
      </div>

      {activeTool && engagementId && primaryOutput && previewUrl && (
        <RenderPowerToolDialog
          engagementId={engagementId}
          parentOutput={primaryOutput}
          previewUrl={previewUrl}
          tool={activeTool}
          isOpen
          onClose={() => setActiveTool(null)}
        />
      )}
    </div>
  );
}

function HistoryRow({
  item,
  selected,
  onSelect,
}: {
  item: RenderListItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const detailQuery = useGetRender(item.id, {
    query: {
      enabled: true,
      queryKey: getGetRenderQueryKey(item.id),
      refetchInterval: isRenderInFlight(item.status) ? 3000 : false,
    },
  });
  const thumbOutput = detailQuery.data?.outputs?.find(
    (o) => o.role === "primary" || o.role === "video-primary",
  );
  const thumbSrc = thumbOutput ? previewHrefFor(thumbOutput) : null;

  return (
    <li>
      <button
        type="button"
        className="render-workbench-history-item"
        data-testid={`render-history-row-${item.id}`}
        data-selected={selected ? "true" : "false"}
        onClick={onSelect}
      >
        <div className="render-workbench-history-thumb">
          {thumbSrc && item.status === "ready" ? (
            <img src={thumbSrc} alt="" />
          ) : isRenderInFlight(item.status) ? (
            <Loader2 size={16} className="render-workbench-history-spin" />
          ) : (
            <ImageIcon size={16} aria-hidden />
          )}
        </div>
        <div className="render-workbench-history-item-body">
          <span className="render-workbench-history-item-label">
            {KIND_HISTORY_LABEL[item.kind] ?? item.kind}
          </span>
          <span className="render-workbench-history-item-time">
            {formatHistoryTime(item.createdAt)}
          </span>
        </div>
        {selected && (
          <span className="render-workbench-history-item-dot" aria-hidden />
        )}
      </button>
    </li>
  );
}

function CanvasPlaceholder({
  title,
  hint,
  busy,
}: {
  title: string;
  hint: string;
  busy?: boolean;
}) {
  return (
    <div className="render-workbench-canvas-placeholder" data-testid="render-workbench-placeholder">
      {busy && <Loader2 size={28} className="render-workbench-history-spin" />}
      <div className="render-workbench-canvas-placeholder-title">{title}</div>
      <p className="render-workbench-canvas-placeholder-hint">{hint}</p>
    </div>
  );
}

function extractErrorCode(err: ApiError<unknown>): string | null {
  const data = err.data;
  if (data && typeof data === "object") {
    const code = (data as Record<string, unknown>).errorCode;
    if (typeof code === "string") return code;
  }
  return null;
}
