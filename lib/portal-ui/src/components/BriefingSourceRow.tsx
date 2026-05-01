import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListEngagementBriefingSources,
  useRetryBriefingSourceConversion,
  getGetEngagementBriefingQueryKey,
  type EngagementBriefingSource,
} from "@workspace/api-client-react";
import { summarizeFederalPayload } from "@workspace/adapters/federal/summaries";
import { summarizeStatePayload } from "@workspace/adapters/state/summaries";
import { summarizeLocalPayload } from "@workspace/adapters/local/summaries";
import { BriefingSourceDetails } from "./BriefingSourceDetails";
import { BriefingSourceHistoryPanel } from "./BriefingSourceHistoryPanel";
import { relativeTime } from "../lib/relativeTime";
import {
  BRIEFING_GENERATE_LAYERS_ACTOR_LABEL,
  BRIEFING_SOURCE_HISTORY_TIER_LABEL,
  CONVERSION_STATUS_STYLE,
  SOURCE_KIND_BADGE_LABEL,
  computeBriefingSourceRange,
  extractAdapterKeyFromProvider,
  formatBriefingSourceRangeShort,
  formatByteSize,
  formatCacheAgeLabel,
  isAdapterSourceKind,
  useBriefingSourceHistoryTier,
} from "../lib/briefingSourceHelpers";

/**
 * Per-source briefing row, shared across design-tools (architect)
 * and plan-review (read-only reviewer).
 *
 * `readOnly` flips the row into reviewer mode:
 *   - the failed-conversion "Retry" button is hidden;
 *   - the "Refresh this layer" affordance is hidden, regardless of
 *     whether the parent passed `onRefreshLayer`;
 *   - the per-version "Restore this version" button inside the
 *     history disclosure is hidden (forwarded into
 *     {@link BriefingSourceHistoryPanel}).
 *
 * The structured "View layer details" expander, history disclosure,
 * cached-pill, divergence pills, and per-source data-testids stay
 * intact in both modes so reviewers see the same provenance the
 * architect sees.
 */
export interface BriefingSourceRowProps {
  engagementId: string;
  source: EngagementBriefingSource;
  isHighlighted?: boolean;
  cacheInfo?: {
    fromCache: boolean;
    cachedAt: string | null;
    upstreamFreshness?: {
      status: "fresh" | "stale" | "unknown";
      reason: string | null;
    } | null;
  } | null;
  onRefreshLayer?: ((adapterKey: string) => void) | null;
  isRefreshing?: boolean;
  rerunStaleAdapterError?: string | null;
  rerunStaleAdapterSuccessAt?: number | null;
  /**
   * When `true` the row drops architect-only mutate affordances
   * (Retry conversion, Refresh this layer, Restore this version).
   * Reviewers (plan-review) get the same provenance / divergence
   * / history surfaces without the mutations.
   */
  readOnly?: boolean;
}

export function BriefingSourceRow({
  engagementId,
  source,
  isHighlighted = false,
  cacheInfo = null,
  onRefreshLayer = null,
  isRefreshing = false,
  rerunStaleAdapterError = null,
  rerunStaleAdapterSuccessAt = null,
  readOnly = false,
}: BriefingSourceRowProps) {
  const isManual = source.sourceKind === "manual-upload";
  const isAdapter = isAdapterSourceKind(source.sourceKind);
  const adapterKeyForRefresh = extractAdapterKeyFromProvider(source.provider);
  const showRefreshLayer =
    !readOnly &&
    onRefreshLayer !== null &&
    source.sourceKind === "federal-adapter" &&
    adapterKeyForRefresh !== null;
  const adapterSummary =
    source.sourceKind === "federal-adapter"
      ? summarizeFederalPayload(source.layerKind, source.payload)
      : source.sourceKind === "state-adapter"
        ? summarizeStatePayload(source.layerKind, source.payload)
        : source.sourceKind === "local-adapter"
          ? summarizeLocalPayload(source.layerKind, source.payload)
          : null;
  const [expanded, setExpanded] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const queryClient = useQueryClient();
  const retryMutation = useRetryBriefingSourceConversion({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: getGetEngagementBriefingQueryKey(engagementId),
        });
      },
    },
  });
  const historyHintQuery = useListEngagementBriefingSources(engagementId, {
    layerKind: source.layerKind,
    includeSuperseded: true,
  });
  const historyHint = useMemo(() => {
    const sources = historyHintQuery.data?.sources ?? [];
    const priors = sources.filter(
      (s: { id: string }) => s.id !== source.id,
    );
    if (priors.length === 0) return null;
    const range = computeBriefingSourceRange(priors);
    const rangeShort = range
      ? formatBriefingSourceRangeShort(range.oldest, range.newest)
      : null;
    return { count: priors.length, rangeShort };
  }, [historyHintQuery.data, source.id]);
  const conversionStatus = source.conversionStatus;
  const conversionStyle = conversionStatus
    ? CONVERSION_STATUS_STYLE[conversionStatus]
    : null;
  const persistedHistoryTier = useBriefingSourceHistoryTier(engagementId);
  const persistedHistoryTierLabel =
    BRIEFING_SOURCE_HISTORY_TIER_LABEL[persistedHistoryTier];
  return (
    <div
      className="sc-card"
      style={{
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        outline: isHighlighted ? "2px solid var(--cyan)" : "2px solid transparent",
        outlineOffset: 2,
        boxShadow: isHighlighted
          ? "0 0 0 4px rgba(0, 180, 216, 0.18)"
          : undefined,
        transition: "outline-color 200ms ease, box-shadow 200ms ease",
      }}
      data-testid={`briefing-source-${source.id}`}
      data-highlighted={isHighlighted ? "true" : undefined}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          {source.layerKind}
        </span>
        <div
          style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}
        >
          {conversionStyle && (
            <span
              className="sc-pill"
              data-testid={`briefing-source-conversion-status-${source.id}`}
              style={{
                fontSize: 10,
                padding: "2px 8px",
                borderRadius: 999,
                background: conversionStyle.bg,
                color: conversionStyle.fg,
                textTransform: "uppercase",
                letterSpacing: 0.3,
              }}
            >
              {conversionStyle.label}
            </span>
          )}
          <span
            className="sc-pill"
            data-testid={`briefing-source-kind-badge-${source.id}`}
            style={{
              fontSize: 10,
              padding: "2px 8px",
              borderRadius: 999,
              background: isManual ? "var(--info-dim)" : "var(--success-dim)",
              color: isManual ? "var(--info-text)" : "var(--success-text)",
              textTransform: "uppercase",
              letterSpacing: 0.3,
            }}
          >
            {SOURCE_KIND_BADGE_LABEL[source.sourceKind] ?? source.sourceKind}
          </span>
          {cacheInfo?.fromCache && (() => {
            const isStale = cacheInfo.upstreamFreshness?.status === "stale";
            const baseAgeLabel = formatCacheAgeLabel(cacheInfo.cachedAt);
            const label = isStale ? "cache may be stale" : baseAgeLabel;
            const captureLine = cacheInfo.cachedAt
              ? `Reused a cached upstream response captured at ${new Date(cacheInfo.cachedAt).toLocaleString()}.`
              : "Reused a cached upstream response.";
            const reasonLine = cacheInfo.upstreamFreshness?.reason
              ? ` ${cacheInfo.upstreamFreshness.reason}`
              : "";
            const ctaLine = ' Click "Force refresh" above to bypass the cache.';
            const tooltip = isStale
              ? `Cache may be stale.${reasonLine}${" "}${captureLine}${ctaLine}`
              : `${captureLine}${reasonLine}${ctaLine}`;
            return (
              <span
                className="sc-pill"
                data-testid={`briefing-source-cache-pill-${source.id}`}
                data-cache-freshness={
                  cacheInfo.upstreamFreshness?.status ?? "unchecked"
                }
                title={tooltip}
                style={{
                  fontSize: 10,
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: isStale
                    ? "var(--danger-dim)"
                    : "var(--surface-muted)",
                  color: isStale
                    ? "var(--danger-text)"
                    : "var(--text-secondary)",
                  textTransform: "uppercase",
                  letterSpacing: 0.3,
                  fontWeight: isStale ? 600 : undefined,
                }}
              >
                {label}
              </span>
            );
          })()}
        </div>
      </div>
      {adapterSummary && (
        <div
          data-testid={`briefing-source-summary-${source.id}`}
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: "var(--text-primary)",
            background: "var(--surface-muted)",
            borderRadius: 4,
            padding: "4px 8px",
            marginTop: 2,
            alignSelf: "flex-start",
          }}
        >
          {adapterSummary}
        </div>
      )}
      {conversionStatus === "failed" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: "6px 8px",
            background: "var(--danger-dim)",
            borderRadius: 4,
            marginTop: 4,
          }}
          data-testid={`briefing-source-conversion-failed-${source.id}`}
        >
          <span
            style={{
              fontSize: 11,
              color: "var(--danger-text)",
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {source.conversionError ?? "Conversion failed."}
          </span>
          {!readOnly && (
            <button
              type="button"
              className="sc-btn"
              disabled={retryMutation.isPending}
              onClick={() =>
                retryMutation.mutate({
                  id: engagementId,
                  sourceId: source.id,
                })
              }
              data-testid={`briefing-source-retry-conversion-${source.id}`}
              style={{ fontSize: 11, padding: "2px 8px" }}
            >
              {retryMutation.isPending ? "Retrying…" : "Retry"}
            </button>
          )}
        </div>
      )}
      {source.uploadOriginalFilename && (
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          {source.uploadOriginalFilename}
          {source.uploadByteSize !== null && (
            <span style={{ color: "var(--text-muted)" }}>
              {" · "}
              {formatByteSize(source.uploadByteSize)}
            </span>
          )}
        </div>
      )}
      {source.provider && (
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
          Provider: {source.provider}
        </div>
      )}
      {source.note && (
        <div
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            whiteSpace: "pre-wrap",
          }}
        >
          {source.note}
        </div>
      )}
      <div
        style={{
          fontSize: 10,
          color: "var(--text-muted)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span>
          Snapshot {new Date(source.snapshotDate).toLocaleDateString()} ·
          added {relativeTime(source.createdAt)}
        </span>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {showRefreshLayer && (
            <button
              type="button"
              onClick={() => onRefreshLayer!(adapterKeyForRefresh!)}
              disabled={isRefreshing}
              data-testid={`briefing-source-refresh-layer-${source.id}`}
              data-adapter-key={adapterKeyForRefresh}
              title={`Re-fetch this layer live from the upstream feed (adapter: ${adapterKeyForRefresh}). Other adapters are not re-run.`}
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: isRefreshing ? "not-allowed" : "pointer",
                fontSize: 11,
                color: "var(--info-text)",
                textDecoration: "underline",
                opacity: isRefreshing ? 0.5 : 1,
              }}
            >
              {isRefreshing ? "Refreshing…" : "Refresh this layer"}
            </button>
          )}
          {!isManual && (
            <button
              type="button"
              onClick={() => setDetailsExpanded((v) => !v)}
              aria-expanded={detailsExpanded}
              aria-controls={`briefing-source-details-${source.id}`}
              data-testid={`briefing-source-details-toggle-${source.id}`}
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                fontSize: 11,
                color: "var(--info-text)",
                textDecoration: "underline",
              }}
            >
              {detailsExpanded ? "Hide layer details" : "View layer details"}
            </button>
          )}
          {persistedHistoryTierLabel && (
            <span
              data-testid={`briefing-source-history-filter-cue-${source.id}`}
              data-tier={persistedHistoryTier}
              title={`History filtered to ${persistedHistoryTierLabel}`}
              style={{
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 999,
                background:
                  persistedHistoryTier === "manual"
                    ? "var(--info-dim)"
                    : "var(--success-dim)",
                color:
                  persistedHistoryTier === "manual"
                    ? "var(--info-text)"
                    : "var(--success-text)",
                textTransform: "uppercase",
                letterSpacing: 0.3,
                whiteSpace: "nowrap",
              }}
            >
              Filtered: {persistedHistoryTierLabel}
            </span>
          )}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-controls={`briefing-source-history-${source.id}`}
            data-testid={`briefing-source-history-toggle-${source.id}`}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
              fontSize: 11,
              color: "var(--info-text)",
              textDecoration: "underline",
            }}
          >
            {expanded ? "Hide history" : "View history"}
            {!expanded && historyHint && (
              <>
                {" "}
                <span
                  data-testid={`briefing-source-history-toggle-hint-${source.id}`}
                  style={{ opacity: 0.8 }}
                >
                  ({historyHint.count} prior
                  {historyHint.rangeShort ? ` · ${historyHint.rangeShort}` : ""})
                </span>
              </>
            )}
          </button>
        </div>
      </div>
      {detailsExpanded && !isManual && (
        <BriefingSourceDetails
          source={source}
          onRerunStaleAdapter={readOnly ? null : onRefreshLayer}
          isRerunningStaleAdapter={isRefreshing}
          rerunStaleAdapterError={rerunStaleAdapterError}
          rerunStaleAdapterSuccessAt={rerunStaleAdapterSuccessAt}
        />
      )}
      {isAdapter && (
        <div
          data-testid={`briefing-source-last-refreshed-${source.id}`}
          style={{
            fontSize: 10,
            color: "var(--text-muted)",
            fontStyle: "italic",
          }}
        >
          Last refreshed {relativeTime(source.createdAt)} by{" "}
          {BRIEFING_GENERATE_LAYERS_ACTOR_LABEL}
        </div>
      )}
      {expanded && (
        <BriefingSourceHistoryPanel
          engagementId={engagementId}
          layerKind={source.layerKind}
          currentSourceId={source.id}
          panelId={`briefing-source-history-${source.id}`}
          readOnly={readOnly}
        />
      )}
    </div>
  );
}
