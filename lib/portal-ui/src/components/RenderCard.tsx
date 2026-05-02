import type {
  DomainRenderKind,
  ElevationSetJob,
  RenderDetailResponse,
  RenderListItem,
  RenderOutputProjection,
  RenderStatus,
} from "@workspace/api-client-react";

/**
 * Shared render card. Presentational only; the parent owns selection
 * state, polling, and action callbacks so the same component renders
 * with or without architect-only affordances.
 *
 * Accepts either the slim list-shape (`RenderListItem`) or the full
 * detail (`RenderDetailResponse`). When detail is supplied, the card
 * surfaces the primary preview (still / video) or the elevation-set's
 * per-direction child grid.
 */

const STATUS_LABEL: Record<RenderStatus, string> = {
  queued: "Queued",
  rendering: "Rendering",
  ready: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATUS_COLOR: Record<RenderStatus, string> = {
  queued: "var(--text-secondary)",
  rendering: "var(--cyan)",
  ready: "#22c55e",
  failed: "#ef4444",
  cancelled: "var(--text-secondary)",
};

const KIND_LABEL: Record<DomainRenderKind, string> = {
  still: "Still",
  "elevation-set": "Elevation set",
  video: "Video",
};

const ELEVATION_DIRECTION_LABEL: Record<ElevationSetJob["role"], string> = {
  "elevation-n": "North",
  "elevation-e": "East",
  "elevation-s": "South",
  "elevation-w": "West",
};

export function isRenderInFlight(status: RenderStatus): boolean {
  return status === "queued" || status === "rendering";
}

export function isRenderCancellable(status: RenderStatus): boolean {
  return isRenderInFlight(status);
}

/** Endpoint that streams the durable mirrored bytes for an output. */
function previewHrefFor(output: RenderOutputProjection): string | null {
  if (output.previewUrl) return output.previewUrl;
  if (output.mirroredObjectKey) return `/api/render-outputs/${output.id}/file`;
  return null;
}

function downloadHrefFor(output: RenderOutputProjection): string | null {
  if (output.downloadUrl) return output.downloadUrl;
  if (output.mirroredObjectKey)
    return `/api/render-outputs/${output.id}/file?download=1`;
  return null;
}

function isVideoOutput(output: RenderOutputProjection): boolean {
  return output.format === "mp4" || output.format === "webm";
}

function formatRelative(input: string | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return String(input);
  const diffSec = Math.round((Date.now() - date.getTime()) / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

function StatusPill({ status }: { status: RenderStatus }) {
  return (
    <span
      data-testid="render-status-pill"
      data-render-status={status}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: 999,
        border: `1px solid ${STATUS_COLOR[status]}`,
        color: STATUS_COLOR[status],
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.2,
        textTransform: "uppercase",
      }}
    >
      {isRenderInFlight(status) && (
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: STATUS_COLOR[status],
            animation: "pulse 1.4s ease-in-out infinite",
          }}
        />
      )}
      {STATUS_LABEL[status]}
    </span>
  );
}

export interface RenderCardProps {
  render: RenderListItem | RenderDetailResponse;
  /**
   * Cancel handler. Hidden when the render is in a terminal state or
   * when `canCancel === false`. The parent is expected to confirm
   * with the user before invoking the mutation.
   */
  onCancel?: () => void;
  cancelPending?: boolean;
  /** Reviewer surfaces pass `false`; architect surfaces use the default. */
  canCancel?: boolean;
  cancelError?: string | null;
}

export function RenderCard({
  render,
  onCancel,
  cancelPending = false,
  canCancel = true,
  cancelError = null,
}: RenderCardProps) {
  const isDetail = "outputs" in render;
  const detail = isDetail ? (render as RenderDetailResponse) : null;

  const primaryOutput = detail?.outputs?.find(
    (o) => o.role === "primary" || o.role === "video-primary",
  );

  const cancellable = canCancel && isRenderCancellable(render.status);
  const showError =
    render.status === "failed" &&
    "errorMessage" in render &&
    typeof render.errorMessage === "string" &&
    render.errorMessage.length > 0;

  return (
    <div
      data-testid={`render-card-${render.id}`}
      data-render-kind={render.kind}
      data-render-status={render.status}
      className="sc-card"
      style={{
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div className="flex items-center justify-between" style={{ gap: 8 }}>
        <div className="flex items-center" style={{ gap: 8 }}>
          <span
            className="sc-label"
            style={{ color: "var(--text-primary)", fontWeight: 600 }}
          >
            {KIND_LABEL[render.kind]}
          </span>
          <StatusPill status={render.status} />
        </div>
        <span
          className="sc-meta opacity-70"
          title={new Date(render.createdAt).toLocaleString()}
        >
          {formatRelative(render.createdAt)}
        </span>
      </div>

      {detail && detail.kind === "elevation-set" ? (
        <ElevationSetGrid detail={detail} />
      ) : (
        <PrimaryThumb
          status={render.status}
          output={primaryOutput ?? null}
        />
      )}

      {showError && (
        <div
          data-testid={`render-error-${render.id}`}
          className="sc-meta"
          style={{
            color: "#ef4444",
            background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.35)",
            borderRadius: 4,
            padding: "6px 8px",
          }}
        >
          {(render as RenderDetailResponse).errorMessage}
        </div>
      )}

      {cancellable && onCancel && (
        <div className="flex items-center justify-end" style={{ gap: 8 }}>
          <button
            type="button"
            className="sc-btn-ghost"
            data-testid={`render-cancel-${render.id}`}
            disabled={cancelPending}
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
            style={{ fontSize: 11, padding: "2px 10px" }}
          >
            {cancelPending ? "Cancelling…" : "Cancel"}
          </button>
        </div>
      )}

      {cancelError && (
        <div
          data-testid={`render-cancel-error-${render.id}`}
          role="alert"
          className="sc-meta"
          style={{ color: "#ef4444" }}
        >
          {cancelError}
        </div>
      )}
    </div>
  );
}

function PrimaryThumb({
  status,
  output,
}: {
  status: RenderStatus;
  output: RenderOutputProjection | null;
}) {
  const previewHref = output ? previewHrefFor(output) : null;
  const downloadHref = output ? downloadHrefFor(output) : null;
  const ready = status === "ready" && !!output && !!previewHref;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {ready && output ? (
        <div data-testid={`render-primary-preview-${output.id}`}>
          {isVideoOutput(output) ? (
            <video
              src={previewHref ?? undefined}
              controls
              poster={output.thumbnailUrl ?? undefined}
              style={{
                width: "100%",
                maxHeight: 320,
                background: "var(--bg-input)",
                borderRadius: 4,
              }}
            />
          ) : (
            <img
              src={previewHref ?? undefined}
              alt="Render output"
              style={{
                width: "100%",
                maxHeight: 320,
                objectFit: "contain",
                background: "var(--bg-input)",
                borderRadius: 4,
              }}
            />
          )}
        </div>
      ) : (
        <PlaceholderTile status={status} />
      )}
      {ready && output && downloadHref && (
        <div className="flex justify-end">
          <a
            data-testid={`render-download-${output.id}`}
            href={downloadHref}
            target="_blank"
            rel="noreferrer"
            className="sc-btn-ghost"
            style={{ fontSize: 11, padding: "2px 10px" }}
            onClick={(e) => e.stopPropagation()}
          >
            Download {output.format.toUpperCase()}
          </a>
        </div>
      )}
    </div>
  );
}

function PlaceholderTile({ status }: { status: RenderStatus }) {
  const text =
    status === "ready"
      ? "Mirror pending — preview will appear shortly."
      : status === "failed"
        ? "Render failed."
        : status === "cancelled"
          ? "Render cancelled."
          : "Awaiting render…";
  return (
    <div
      className="sc-meta opacity-70"
      style={{
        height: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-input)",
        borderRadius: 4,
        textAlign: "center",
        padding: 12,
      }}
    >
      {text}
    </div>
  );
}

/**
 * Per-direction child grid for `elevation-set` parents. The parent's
 * `outputs` array carries one row per ready child; `mnmlJobs` carries
 * the in-flight tracking for the rest. Each cell sources its preview
 * from whichever surface has data.
 */
function ElevationSetGrid({ detail }: { detail: RenderDetailResponse }) {
  const order: ElevationSetJob["role"][] = [
    "elevation-n",
    "elevation-e",
    "elevation-s",
    "elevation-w",
  ];
  const jobByRole = new Map<ElevationSetJob["role"], ElevationSetJob>();
  for (const j of detail.mnmlJobs ?? []) jobByRole.set(j.role, j);
  const outputByRole = new Map<
    ElevationSetJob["role"],
    RenderOutputProjection
  >();
  for (const o of detail.outputs) {
    if (
      o.role === "elevation-n" ||
      o.role === "elevation-e" ||
      o.role === "elevation-s" ||
      o.role === "elevation-w"
    ) {
      outputByRole.set(o.role, o);
    }
  }
  return (
    <div
      data-testid={`render-elevation-grid-${detail.id}`}
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(2, 1fr)",
        gap: 8,
      }}
    >
      {order.map((role) => {
        const job = jobByRole.get(role) ?? null;
        const output = outputByRole.get(role) ?? null;
        const status = output ? "ready" : (job?.status ?? "pending-trigger");
        const previewHref = output ? previewHrefFor(output) : null;
        const downloadHref = output ? downloadHrefFor(output) : null;
        return (
          <div
            key={role}
            data-testid={`render-elevation-cell-${detail.id}-${role}`}
            data-elevation-role={role}
            data-elevation-status={status}
            className="sc-card"
            style={{
              padding: 8,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div className="flex items-center justify-between">
              <span
                className="sc-label"
                style={{ color: "var(--text-primary)", fontSize: 11 }}
              >
                {ELEVATION_DIRECTION_LABEL[role]}
              </span>
              <span className="sc-meta" style={{ fontSize: 10, opacity: 0.7 }}>
                {status}
              </span>
            </div>
            {previewHref ? (
              <img
                src={previewHref}
                alt={`${ELEVATION_DIRECTION_LABEL[role]} elevation`}
                style={{
                  width: "100%",
                  height: 120,
                  objectFit: "contain",
                  background: "var(--bg-input)",
                  borderRadius: 4,
                }}
              />
            ) : (
              <div
                className="sc-meta opacity-60"
                style={{
                  height: 120,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "var(--bg-input)",
                  borderRadius: 4,
                  fontSize: 11,
                  textAlign: "center",
                  padding: 8,
                }}
              >
                {job?.error?.message ?? "Awaiting render…"}
              </div>
            )}
            {downloadHref && (
              <div className="flex justify-end">
                <a
                  data-testid={`render-elevation-download-${detail.id}-${role}`}
                  href={downloadHref}
                  target="_blank"
                  rel="noreferrer"
                  className="sc-btn-ghost"
                  style={{ fontSize: 10, padding: "2px 8px" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  Download
                </a>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
