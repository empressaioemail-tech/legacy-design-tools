import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListEngagementRenders,
  useGetRender,
  useCancelRender,
  getListEngagementRendersQueryKey,
  getGetRenderQueryKey,
  ApiError,
  type RenderDetailResponse,
  type RenderListItem,
} from "@workspace/api-client-react";
import { RenderCard, isRenderInFlight } from "./RenderCard";

/**
 * Shared render gallery. Renders one card per render in a responsive
 * grid; in-flight cards self-poll on a 3 s interval and the gallery
 * invalidates the list whenever a card transitions to a terminal
 * status so the slim list catches up to the detail without waiting
 * for its own refetch.
 *
 * Audience model:
 *   - Architect surfaces use the default `canCancel` (true).
 *   - Reviewer surfaces pass `canCancel={false}`; the route would 403
 *     anyway but hiding the affordance keeps the surface honest.
 *
 * 503 from the listing endpoint with errorCode
 * `renders_preview_disabled` is surfaced inline as a friendly
 * "preview disabled" notice rather than the generic error tile.
 */
export interface RenderGalleryProps {
  engagementId: string;
  canCancel?: boolean;
  emptyStateHint?: string;
  /**
   * When true, each card's still preview is wrapped in a link that
   * opens the full-resolution mirrored asset in a new tab. Reviewer
   * surfaces (Task #428) opt in so a click on the thumbnail reveals
   * the underlying render at native resolution.
   */
  openPreviewInNewTab?: boolean;
  /** Architect Renders tab: enable Enhance / Upscale / … on ready stills. */
  showPowerTools?: boolean;
}

const POLL_INTERVAL_MS = 3000;
const LIST_REFETCH_INTERVAL_MS = 8000;

export function RenderGallery({
  engagementId,
  canCancel = true,
  emptyStateHint,
  openPreviewInNewTab = false,
  showPowerTools = false,
}: RenderGalleryProps) {
  const listQuery = useListEngagementRenders(engagementId, {
    query: {
      enabled: !!engagementId,
      queryKey: getListEngagementRendersQueryKey(engagementId),
      refetchInterval: LIST_REFETCH_INTERVAL_MS,
    },
  });

  const items: RenderListItem[] = listQuery.data?.items ?? [];
  const rootItems = useMemo(
    () =>
      [...items]
        .filter((i) => !i.parentRenderOutputId)
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        ),
    [items],
  );
  const childItems = useMemo(
    () => items.filter((i) => i.parentRenderOutputId),
    [items],
  );
  const [claimedChildIds, setClaimedChildIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [linkageReady, setLinkageReady] = useState(false);

  const claimChildren = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setClaimedChildIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of ids) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const itemIdsKey = useMemo(
    () => items.map((i) => i.id).sort().join(","),
    [items],
  );

  useEffect(() => {
    setClaimedChildIds(new Set());
    setLinkageReady(false);
    const frame = requestAnimationFrame(() => setLinkageReady(true));
    return () => cancelAnimationFrame(frame);
  }, [itemIdsKey]);

  const orphanChildren = useMemo(
    () =>
      childItems
        .filter((c) => !claimedChildIds.has(c.id))
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        ),
    [childItems, claimedChildIds],
  );

  if (listQuery.isLoading) {
    return (
      <div
        className="sc-card p-6 text-center"
        data-testid="renders-gallery-loading"
      >
        <div className="sc-body opacity-60">Loading renders…</div>
      </div>
    );
  }

  if (listQuery.error) {
    const err = listQuery.error;
    if (err instanceof ApiError && err.status === 503) {
      const code = extractErrorCode(err);
      if (code === "renders_preview_disabled") {
        return (
          <div
            className="sc-card p-6 text-center"
            data-testid="renders-preview-disabled"
          >
            <div className="sc-prose opacity-70" style={{ maxWidth: 480 }}>
              Renders preview is disabled in this environment. Ask an
              operator to enable mnml.ai integration to start kicking
              off renders.
            </div>
          </div>
        );
      }
    }
    return (
      <div
        className="sc-card p-6 text-center"
        data-testid="renders-gallery-error"
      >
        <div className="sc-prose" style={{ color: "#ef4444", maxWidth: 480 }}>
          Failed to load renders:{" "}
          {err instanceof Error ? err.message : "unknown error"}
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div
        className="sc-card p-6 text-center"
        data-testid="renders-gallery-empty"
      >
        <div className="sc-prose opacity-70" style={{ maxWidth: 480 }}>
          {emptyStateHint ??
            "No renders yet. Renders kicked off for this engagement appear here."}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="renders-gallery"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
        gap: 16,
        alignItems: "start",
      }}
    >
      {rootItems.map((root) => (
        <RenderGalleryGroup
          key={root.id}
          engagementId={engagementId}
          root={root}
          childCandidates={childItems}
          canCancel={canCancel}
          openPreviewInNewTab={openPreviewInNewTab}
          showPowerTools={showPowerTools}
          onClaimChildren={claimChildren}
        />
      ))}
      {linkageReady &&
        orphanChildren.map((item) => (
        <RenderGalleryCard
          key={item.id}
          engagementId={engagementId}
          listItem={item}
          canCancel={canCancel}
          openPreviewInNewTab={openPreviewInNewTab}
          showPowerTools={showPowerTools}
        />
      ))}
    </div>
  );
}

/**
 * Parent render plus expandable nested tool-output cards (doc 40e B.5).
 */
function RenderGalleryGroup({
  engagementId,
  root,
  childCandidates,
  canCancel,
  openPreviewInNewTab,
  showPowerTools,
  onClaimChildren,
}: {
  engagementId: string;
  root: RenderListItem;
  childCandidates: RenderListItem[];
  canCancel: boolean;
  openPreviewInNewTab: boolean;
  showPowerTools: boolean;
  onClaimChildren: (ids: string[]) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  const detailQuery = useGetRender(root.id, {
    query: {
      enabled: true,
      queryKey: getGetRenderQueryKey(root.id),
    },
  });

  const matchedChildren = useMemo(() => {
    const outputs = detailQuery.data?.outputs ?? [];
    if (outputs.length === 0) return [];
    const outputIds = new Set(outputs.map((o) => o.id));
    return childCandidates.filter(
      (c) =>
        c.parentRenderOutputId && outputIds.has(c.parentRenderOutputId),
    );
  }, [childCandidates, detailQuery.data?.outputs]);

  useEffect(() => {
    if (matchedChildren.length > 0) {
      onClaimChildren(matchedChildren.map((c) => c.id));
    }
  }, [matchedChildren, onClaimChildren]);

  return (
    <div
      data-testid={`render-gallery-group-${root.id}`}
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
    >
      <RenderGalleryCard
        engagementId={engagementId}
        listItem={root}
        canCancel={canCancel}
        openPreviewInNewTab={openPreviewInNewTab}
        showPowerTools={showPowerTools}
      />
      {matchedChildren.length > 0 && (
        <>
          <button
            type="button"
            className="sc-btn-ghost"
            data-testid={`render-group-toggle-${root.id}`}
            onClick={() => setExpanded((v) => !v)}
            style={{ alignSelf: "flex-start", fontSize: 11, marginLeft: 4 }}
          >
            {expanded ? "Hide" : "Show"} {matchedChildren.length} tool output
            {matchedChildren.length === 1 ? "" : "s"}
          </button>
          {expanded && (
            <div
              data-testid={`render-group-children-${root.id}`}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 12,
                marginLeft: 8,
                paddingLeft: 8,
                borderLeft: "2px solid var(--border-default)",
              }}
            >
              {matchedChildren.map((child) => (
                <RenderGalleryCard
                  key={child.id}
                  engagementId={engagementId}
                  listItem={child}
                  canCancel={canCancel}
                  openPreviewInNewTab={openPreviewInNewTab}
                  showPowerTools={showPowerTools}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One card slot in the gallery. Owns its own detail query so each
 * in-flight render polls independently — the previous master/detail
 * version only polled the selected row, which left other in-flight
 * cards stale.
 */
function RenderGalleryCard({
  engagementId,
  listItem,
  canCancel,
  openPreviewInNewTab,
  showPowerTools,
}: {
  engagementId: string;
  listItem: RenderListItem;
  canCancel: boolean;
  openPreviewInNewTab: boolean;
  showPowerTools: boolean;
}) {
  const qc = useQueryClient();
  const [cancelError, setCancelError] = useState<string | null>(null);

  const detailQuery = useGetRender(listItem.id, {
    query: {
      enabled: true,
      queryKey: getGetRenderQueryKey(listItem.id),
      refetchInterval: ((query: { state: { data?: unknown } }) => {
        const data = query.state.data as RenderDetailResponse | undefined;
        const status = data?.status ?? listItem.status;
        return isRenderInFlight(status) ? POLL_INTERVAL_MS : false;
      }) as unknown as number,
    },
  });

  const detail: RenderDetailResponse | undefined = detailQuery.data ?? undefined;

  // When the detail flips to terminal, refresh the slim list so its
  // status pill catches up immediately.
  useEffect(() => {
    if (!detail) return;
    if (isRenderInFlight(detail.status)) return;
    if (detail.status === listItem.status) return;
    qc.invalidateQueries({
      queryKey: getListEngagementRendersQueryKey(engagementId),
    });
  }, [detail?.status, detail?.id, engagementId, listItem.status, qc]);

  const cancel = useCancelRender({
    mutation: {
      onSuccess: async (_resp, variables) => {
        setCancelError(null);
        await Promise.all([
          qc.invalidateQueries({
            queryKey: getListEngagementRendersQueryKey(engagementId),
          }),
          qc.invalidateQueries({
            queryKey: getGetRenderQueryKey(variables.id),
          }),
        ]);
      },
      onError: (err) => {
        setCancelError(formatCancelError(err));
      },
    },
  });

  // Prefer the detail (richer projection) when we have it; fall back
  // to the slim list item until the first detail roundtrip resolves.
  const renderForCard: RenderListItem | RenderDetailResponse = detail ?? listItem;

  const handleCancel = () => {
    if (
      typeof window !== "undefined" &&
      typeof window.confirm === "function" &&
      !window.confirm(
        "Cancel this render? Outputs already mirrored will be kept; remaining work stops.",
      )
    ) {
      return;
    }
    setCancelError(null);
    cancel.mutate({ id: listItem.id });
  };

  return (
    <RenderCard
      render={renderForCard}
      canCancel={canCancel}
      cancelPending={cancel.isPending}
      cancelError={cancelError}
      onCancel={handleCancel}
      openPreviewInNewTab={openPreviewInNewTab}
      showPowerTools={showPowerTools}
      engagementId={engagementId}
    />
  );
}

function formatCancelError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) {
      return "This render is already in a terminal state and cannot be cancelled.";
    }
    if (err.status === 404) {
      return "This render no longer exists.";
    }
    if (err.status === 403) {
      return "Only architects can cancel renders.";
    }
    const detail = extractApiDetail(err);
    if (detail) return detail;
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Failed to cancel render — please try again.";
}

function extractErrorCode(err: ApiError<unknown>): string | null {
  const data = err.data;
  if (data && typeof data === "object") {
    const code = (data as Record<string, unknown>).errorCode;
    if (typeof code === "string") return code;
  }
  return null;
}

function extractApiDetail(err: ApiError<unknown>): string | null {
  const data = err.data;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["detail", "message", "title", "error"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }
  if (typeof data === "string" && data.trim().length > 0) {
    return data.trim();
  }
  return null;
}
