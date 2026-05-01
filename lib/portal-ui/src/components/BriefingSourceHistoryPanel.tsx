import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListEngagementBriefingSources,
  useRestoreEngagementBriefingSource,
  getGetEngagementBriefingQueryKey,
  getListEngagementBriefingSourcesQueryKey,
} from "@workspace/api-client-react";
import {
  diffFederalPayload,
} from "@workspace/adapters/federal/summaries";
import {
  diffStatePayload,
} from "@workspace/adapters/state/summaries";
import {
  diffLocalPayload,
} from "@workspace/adapters/local/summaries";
import { relativeTime } from "../lib/relativeTime";
import {
  BRIEFING_GENERATE_LAYERS_ACTOR_LABEL,
  BRIEFING_SOURCE_STALE_THRESHOLD_DAYS,
  SOURCE_KIND_BADGE_LABEL,
  briefingSourceHistoryTierStorageKey,
  diffBriefingSourceFields,
  formatBriefingDiffValue,
  formatBriefingSourceRangeShort,
  formatBriefingSourceRangeTitle,
  formatByteSize,
  isAdapterSourceKind,
  isBriefingSourceRangeStale,
  readBriefingSourceHistoryTier,
  subscribeBriefingSourceHistoryTier,
  writeBriefingSourceHistoryTier,
} from "../lib/briefingSourceHelpers";

/**
 * Lazily-loaded per-layer history list rendered beneath a current
 * briefing source row. Fetches with `includeSuperseded=true` and
 * filters the current row out client-side so only prior versions
 * show in the collapsible panel. Each prior version exposes a
 * "Restore this version" action (architect surface only — gated on
 * `readOnly={false}`) that POSTs to the restore endpoint and
 * invalidates both the briefing read and the history list.
 *
 * `readOnly` is set by the plan-review reviewer surface so reviewers
 * can audit the same per-layer divergence pills, prior-version
 * comparison disclosures, and tier filter the architect uses without
 * being able to mutate the briefing.
 */
export interface BriefingSourceHistoryPanelProps {
  engagementId: string;
  layerKind: string;
  currentSourceId: string;
  panelId: string;
  /**
   * When `true` the "Restore this version" affordance is suppressed
   * and the restore-mutation hook is not wired into the rendered
   * tree. Reviewers (plan-review) get the comparison disclosure
   * without the mutation; architects (design-tools) get the full
   * surface.
   */
  readOnly?: boolean;
}

export function BriefingSourceHistoryPanel({
  engagementId,
  layerKind,
  currentSourceId,
  panelId,
  readOnly = false,
}: BriefingSourceHistoryPanelProps) {
  const queryClient = useQueryClient();
  const historyQuery = useListEngagementBriefingSources(engagementId, {
    layerKind,
    includeSuperseded: true,
  });
  const restoreMutation = useRestoreEngagementBriefingSource({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: getGetEngagementBriefingQueryKey(engagementId),
          }),
          queryClient.invalidateQueries({
            queryKey: getListEngagementBriefingSourcesQueryKey(
              engagementId,
              { layerKind, includeSuperseded: true },
            ),
          }),
        ]);
      },
    },
  });

  const tierStorageKey = briefingSourceHistoryTierStorageKey(engagementId);
  const [tierFilter, setTierFilterState] = useState<
    "all" | "adapter" | "manual"
  >(() => readBriefingSourceHistoryTier(tierStorageKey));
  useEffect(() => {
    const unsubscribe = subscribeBriefingSourceHistoryTier(
      tierStorageKey,
      (next) => {
        setTierFilterState((prev) => (prev === next ? prev : next));
      },
    );
    return unsubscribe;
  }, [tierStorageKey]);
  const setTierFilter = (next: "all" | "adapter" | "manual") => {
    setTierFilterState(next);
    writeBriefingSourceHistoryTier(tierStorageKey, next);
  };

  const [expandedDiffs, setExpandedDiffs] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleDiffExpanded = (priorId: string) => {
    setExpandedDiffs((prev) => {
      const next = new Set(prev);
      if (next.has(priorId)) next.delete(priorId);
      else next.add(priorId);
      return next;
    });
  };

  const allSources = historyQuery.data?.sources ?? [];
  const allPriorVersions = useMemo(
    () => allSources.filter((s) => s.id !== currentSourceId),
    [allSources, currentSourceId],
  );
  const currentSource = useMemo(
    () => allSources.find((s) => s.id === currentSourceId) ?? null,
    [allSources, currentSourceId],
  );

  const priorVersions = useMemo(() => {
    if (tierFilter === "all") return allPriorVersions;
    if (tierFilter === "adapter") {
      return allPriorVersions.filter((s) => isAdapterSourceKind(s.sourceKind));
    }
    return allPriorVersions.filter((s) => s.sourceKind === "manual-upload");
  }, [allPriorVersions, tierFilter]);

  const tierCounts = useMemo(() => {
    let adapter = 0;
    let manual = 0;
    for (const s of allPriorVersions) {
      if (isAdapterSourceKind(s.sourceKind)) adapter += 1;
      else if (s.sourceKind === "manual-upload") manual += 1;
    }
    return { all: allPriorVersions.length, adapter, manual };
  }, [allPriorVersions]);

  const tierRanges = useMemo(() => {
    type Range = { oldest: string; newest: string } | null;
    const ranges: { all: Range; adapter: Range; manual: Range } = {
      all: null,
      adapter: null,
      manual: null,
    };
    const widen = (key: "all" | "adapter" | "manual", createdAt: string) => {
      const cur = ranges[key];
      if (cur === null) {
        ranges[key] = { oldest: createdAt, newest: createdAt };
        return;
      }
      if (createdAt < cur.oldest) cur.oldest = createdAt;
      if (createdAt > cur.newest) cur.newest = createdAt;
    };
    for (const s of allPriorVersions) {
      widen("all", s.createdAt);
      if (isAdapterSourceKind(s.sourceKind)) widen("adapter", s.createdAt);
      else if (s.sourceKind === "manual-upload") widen("manual", s.createdAt);
    }
    return ranges;
  }, [allPriorVersions]);

  const tierStale = useMemo(
    () => ({
      all: isBriefingSourceRangeStale(tierRanges.all),
      adapter: isBriefingSourceRangeStale(tierRanges.adapter),
      manual: isBriefingSourceRangeStale(tierRanges.manual),
    }),
    [tierRanges],
  );

  const emptyMessage =
    tierFilter === "adapter"
      ? "No prior Generate Layers runs of this layer."
      : tierFilter === "manual"
        ? "No prior manual uploads of this layer."
        : "No prior versions of this layer.";

  return (
    <div
      id={panelId}
      data-testid={`briefing-source-history-${currentSourceId}`}
      style={{
        marginTop: 8,
        paddingTop: 8,
        borderTop: "1px dashed var(--border-subtle)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {!historyQuery.isLoading && !historyQuery.isError && (
        <div
          role="radiogroup"
          aria-label="Filter prior versions by source"
          data-testid={`briefing-source-history-filter-${currentSourceId}`}
          style={{
            display: "flex",
            gap: 4,
            alignItems: "center",
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          <span>Show:</span>
          {(
            [
              { value: "all", label: "All" },
              { value: "adapter", label: "Generate Layers" },
              { value: "manual", label: "Manual uploads" },
            ] as const
          ).map((opt) => {
            const active = tierFilter === opt.value;
            const count = tierCounts[opt.value];
            const range = tierRanges[opt.value];
            const stale = tierStale[opt.value];
            const rangeShort = range
              ? formatBriefingSourceRangeShort(range.oldest, range.newest)
              : null;
            const baseTitle = range
              ? formatBriefingSourceRangeTitle(range.oldest, range.newest)
              : undefined;
            const pillTitle =
              baseTitle && stale
                ? `${baseTitle} (stale — newest is over ${BRIEFING_SOURCE_STALE_THRESHOLD_DAYS} days old)`
                : baseTitle;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`briefing-source-history-filter-${opt.value}-${currentSourceId}`}
                data-stale={stale ? "true" : undefined}
                onClick={() => setTierFilter(opt.value)}
                title={pillTitle}
                style={{
                  background: active
                    ? "var(--info-dim)"
                    : "transparent",
                  color: active
                    ? "var(--info-text)"
                    : "var(--text-secondary)",
                  border: stale
                    ? "1px solid var(--warning-text, #b45309)"
                    : "1px solid var(--border-subtle)",
                  borderRadius: 999,
                  padding: "1px 8px",
                  cursor: "pointer",
                  fontSize: 11,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                {stale && (
                  <span
                    aria-hidden="true"
                    data-testid={`briefing-source-history-filter-${opt.value}-stale-dot-${currentSourceId}`}
                    style={{
                      display: "inline-block",
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      background: "var(--warning-text, #b45309)",
                    }}
                  />
                )}
                <span>
                  {opt.label}{" "}
                  <span
                    data-testid={`briefing-source-history-filter-${opt.value}-count-${currentSourceId}`}
                    style={{ opacity: 0.8 }}
                  >
                    ({count})
                  </span>
                  {rangeShort && (
                    <>
                      {" "}
                      <span
                        data-testid={`briefing-source-history-filter-${opt.value}-range-${currentSourceId}`}
                        style={{ opacity: 0.7 }}
                      >
                        · {rangeShort}
                      </span>
                    </>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {historyQuery.isLoading && (
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
          Loading prior versions…
        </div>
      )}
      {historyQuery.isError && (
        <div
          role="alert"
          style={{
            fontSize: 11,
            color: "var(--danger-text)",
            background: "var(--danger-dim)",
            padding: 6,
            borderRadius: 4,
          }}
        >
          Failed to load history.
        </div>
      )}
      {!historyQuery.isLoading &&
        !historyQuery.isError &&
        priorVersions.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {emptyMessage}
          </div>
        )}
      {priorVersions.map((prior) => {
        const priorIsAdapter = isAdapterSourceKind(prior.sourceKind);
        const changedFields =
          priorIsAdapter && currentSource
            ? diffBriefingSourceFields(prior, currentSource)
            : [];
        let payloadChanges: ReturnType<typeof diffFederalPayload> = null;
        if (
          priorIsAdapter &&
          currentSource &&
          prior.sourceKind === currentSource.sourceKind
        ) {
          if (prior.sourceKind === "federal-adapter") {
            payloadChanges = diffFederalPayload(
              prior.layerKind,
              prior.payload,
              currentSource.payload,
            );
          } else if (prior.sourceKind === "state-adapter") {
            payloadChanges = diffStatePayload(
              prior.layerKind,
              prior.payload,
              currentSource.payload,
            );
          } else if (prior.sourceKind === "local-adapter") {
            payloadChanges = diffLocalPayload(
              prior.layerKind,
              prior.payload,
              currentSource.payload,
            );
          }
        }
        const hasPayloadChanges =
          payloadChanges !== null && payloadChanges.length > 0;
        const hintParts: string[] = [
          ...changedFields,
          ...(payloadChanges?.map((c) => c.label) ?? []),
        ];
        return (
          <div
            key={prior.id}
            data-testid={`briefing-source-history-row-${prior.id}`}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              padding: 8,
              background: "var(--bg-subtle)",
              borderRadius: 4,
            }}
          >
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              {priorIsAdapter
                ? prior.layerKind
                : (prior.uploadOriginalFilename ?? "(no filename)")}
              {!priorIsAdapter && prior.uploadByteSize !== null && (
                <span style={{ color: "var(--text-muted)" }}>
                  {" · "}
                  {formatByteSize(prior.uploadByteSize)}
                </span>
              )}
              <span
                style={{
                  marginLeft: 6,
                  fontSize: 10,
                  padding: "1px 6px",
                  borderRadius: 999,
                  background: priorIsAdapter
                    ? "var(--success-dim)"
                    : "var(--info-dim)",
                  color: priorIsAdapter
                    ? "var(--success-text)"
                    : "var(--info-text)",
                  textTransform: "uppercase",
                  letterSpacing: 0.3,
                  verticalAlign: "middle",
                }}
                data-testid={`briefing-source-history-row-kind-${prior.id}`}
              >
                {SOURCE_KIND_BADGE_LABEL[prior.sourceKind] ?? prior.sourceKind}
              </span>
            </div>
            {priorIsAdapter && prior.provider && (
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                }}
              >
                Provider: {prior.provider}
              </div>
            )}
            {prior.note && (
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {prior.note}
              </div>
            )}
            <div
              style={{ fontSize: 10, color: "var(--text-muted)" }}
              data-testid={`briefing-source-history-row-meta-${prior.id}`}
            >
              Snapshot{" "}
              {new Date(prior.snapshotDate).toLocaleDateString()} · added{" "}
              {relativeTime(prior.createdAt)}
              {prior.supersededAt && (
                <>
                  {" · superseded "}
                  {relativeTime(prior.supersededAt)}
                </>
              )}
              {priorIsAdapter && (
                <>
                  {" · by "}
                  {BRIEFING_GENERATE_LAYERS_ACTOR_LABEL}
                </>
              )}
            </div>
            {(changedFields.length > 0 || hasPayloadChanges) && currentSource && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <button
                  type="button"
                  onClick={() => toggleDiffExpanded(prior.id)}
                  aria-expanded={expandedDiffs.has(prior.id)}
                  aria-controls={`briefing-source-history-row-changed-detail-${prior.id}`}
                  data-testid={`briefing-source-history-row-changed-${prior.id}`}
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    margin: 0,
                    textAlign: "left",
                    fontSize: 10,
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    textDecoration: "underline dotted",
                  }}
                >
                  {expandedDiffs.has(prior.id) ? "▾" : "▸"} Changed:{" "}
                  {hintParts.join(", ")}
                </button>
                {expandedDiffs.has(prior.id) && (
                  <div
                    id={`briefing-source-history-row-changed-detail-${prior.id}`}
                    data-testid={`briefing-source-history-row-changed-detail-${prior.id}`}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      marginLeft: 12,
                    }}
                  >
                    {changedFields.length > 0 && (
                      <table
                        style={{
                          fontSize: 10,
                          color: "var(--text-muted)",
                          borderCollapse: "collapse",
                        }}
                      >
                        <tbody>
                          {changedFields.map((f) => (
                            <tr key={f}>
                              <th
                                scope="row"
                                style={{
                                  textAlign: "left",
                                  fontWeight: 500,
                                  padding: "1px 8px 1px 0",
                                  whiteSpace: "nowrap",
                                  verticalAlign: "top",
                                }}
                              >
                                {f}
                              </th>
                              <td style={{ padding: "1px 0" }}>
                                <span
                                  data-testid={`briefing-source-history-row-changed-before-${f}-${prior.id}`}
                                >
                                  {formatBriefingDiffValue(
                                    f,
                                    (prior[f] as string | null) ?? null,
                                  )}
                                </span>
                                {" → "}
                                <span
                                  data-testid={`briefing-source-history-row-changed-after-${f}-${prior.id}`}
                                >
                                  {formatBriefingDiffValue(
                                    f,
                                    (currentSource[f] as string | null) ?? null,
                                  )}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {hasPayloadChanges && payloadChanges && (
                      <div
                        data-testid={`briefing-source-history-row-payload-changes-${prior.id}`}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 2,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            color: "var(--text-muted)",
                            textTransform: "uppercase",
                            letterSpacing: 0.3,
                          }}
                        >
                          Payload changes
                        </div>
                        <table
                          style={{
                            fontSize: 10,
                            color: "var(--text-muted)",
                            borderCollapse: "collapse",
                          }}
                        >
                          <tbody>
                            {payloadChanges.map((c) => (
                              <tr key={c.key}>
                                <th
                                  scope="row"
                                  style={{
                                    textAlign: "left",
                                    fontWeight: 500,
                                    padding: "1px 8px 1px 0",
                                    whiteSpace: "nowrap",
                                    verticalAlign: "top",
                                  }}
                                >
                                  {c.label}
                                </th>
                                <td style={{ padding: "1px 0" }}>
                                  <span
                                    data-testid={`briefing-source-history-row-payload-before-${c.key}-${prior.id}`}
                                  >
                                    {c.before}
                                  </span>
                                  {" → "}
                                  <span
                                    data-testid={`briefing-source-history-row-payload-after-${c.key}-${prior.id}`}
                                  >
                                    {c.after}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            {!readOnly && (
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="sc-btn sc-btn-secondary"
                  style={{ fontSize: 11, padding: "2px 8px" }}
                  disabled={restoreMutation.isPending}
                  onClick={() =>
                    restoreMutation.mutate({
                      id: engagementId,
                      sourceId: prior.id,
                    })
                  }
                  data-testid={`briefing-source-restore-${prior.id}`}
                >
                  {restoreMutation.isPending &&
                  restoreMutation.variables?.sourceId === prior.id
                    ? "Restoring…"
                    : "Restore this version"}
                </button>
              </div>
            )}
          </div>
        );
      })}
      {!readOnly && restoreMutation.isError && (
        <div
          role="alert"
          style={{
            fontSize: 11,
            color: "var(--danger-text)",
            background: "var(--danger-dim)",
            padding: 6,
            borderRadius: 4,
          }}
        >
          Failed to restore the selected version.
        </div>
      )}
    </div>
  );
}
