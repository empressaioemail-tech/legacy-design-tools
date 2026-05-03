import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGenerateEngagementBriefing,
  useGetEngagementBriefingGenerationStatus,
  useListEngagementBriefingGenerationRuns,
  getGetEngagementBriefingQueryKey,
  getGetEngagementBriefingGenerationStatusQueryKey,
  getListEngagementBriefingGenerationRunsQueryKey,
  type EngagementBriefingNarrative,
  type EngagementBriefingSource,
} from "@workspace/api-client-react";
import { formatBriefingActor } from "@workspace/briefing-diff";
import {
  BriefingInvalidCitationPill,
  renderBriefingMarkdown,
} from "./briefingCitations";

type BriefingSectionKey = "a" | "b" | "c" | "d" | "e" | "f" | "g";

const SECTION_ORDER: ReadonlyArray<{
  key: BriefingSectionKey;
  label: string;
  blurb: string;
}> = [
  { key: "a", label: "A — Executive Summary", blurb: "Three to five sentences capturing the buildable thesis." },
  { key: "b", label: "B — Threshold Issues", blurb: "Heavy: hard blockers and conditional gates." },
  { key: "c", label: "C — Regulatory Gates", blurb: "Tight: zoning, overlays, code triggers." },
  { key: "d", label: "D — Site Infrastructure", blurb: "Tight: utilities, access, easements." },
  { key: "e", label: "E — Buildable Envelope", blurb: "Heavy: setbacks, height, FAR, geometry." },
  { key: "f", label: "F — Neighboring Context", blurb: "Heavy: adjacent uses, scale, character." },
  { key: "g", label: "G — Next-Step Checklist", blurb: "No citations: action items for the architect." },
];

function pickSection(
  narrative: EngagementBriefingNarrative | null,
  key: BriefingSectionKey,
): string | null {
  if (!narrative) return null;
  switch (key) {
    case "a":
      return narrative.sectionA;
    case "b":
      return narrative.sectionB;
    case "c":
      return narrative.sectionC;
    case "d":
      return narrative.sectionD;
    case "e":
      return narrative.sectionE;
    case "f":
      return narrative.sectionF;
    case "g":
      return narrative.sectionG;
  }
}

function defaultExpansion(
  narrative: EngagementBriefingNarrative | null,
): Record<BriefingSectionKey, boolean> {
  const hasB = !!pickSection(narrative, "b");
  const hasE = !!pickSection(narrative, "e");
  return {
    a: true,
    b: hasB,
    c: false,
    d: false,
    e: hasE,
    f: false,
    g: false,
  };
}

/**
 * "Site briefing (A–G)" panel — extracted from
 * `artifacts/design-tools/src/pages/EngagementDetail.tsx` so the
 * plan-review reviewer surface can render the same narrative card,
 * status banners, and per-section disclosures without copy-pasting
 * the JSX. The "Recent runs" disclosure is supplied as a slot
 * (`recentRunsSlot`) because design-tools and plan-review pass
 * different `BriefingRecentRunsPanel` props (design-tools uses
 * `narrativeGenerationId` / `narrativeIsLoaded` / `currentNarrative`,
 * while plan-review uses `currentGenerationId` /
 * `producingGenerationId`); accepting the panel as a node lets the
 * narrative card stay agnostic of which signature is in scope.
 */
export interface BriefingNarrativePanelProps {
  engagementId: string;
  narrative: EngagementBriefingNarrative | null;
  sourceCount: number;
  sources: EngagementBriefingSource[];
  /**
   * Invoked when an inline citation pill in any A–G section card
   * is clicked. The parent is responsible for scrolling the matching
   * `BriefingSourceRow` into view + flashing a temporary highlight.
   */
  onJumpToSource: (sourceId: string) => void;
  /**
   * Render-prop slot for the "Recent runs" disclosure. design-tools
   * passes its inline `BriefingRecentRunsPanel`; plan-review passes
   * the portal-ui `BriefingRecentRunsPanel` from this same lib.
   */
  recentRunsSlot?: ReactNode;
  /**
   * Vite-only `import.meta.env.BASE_URL` value supplied by the
   * caller so the "Export PDF" anchor stays anchored to the
   * artifact's path-prefixed proxy mount. Defaults to "/" so
   * tests don't need to fake `import.meta.env`.
   */
  baseUrl?: string;
  /**
   * Optional map keyed by `briefing_sources.id`, supplied by the
   * parent (currently `EngagementDetail`) so each A–G section can
   * render a small amber "N source(s) may be stale" chip when one
   * of the sources cited inside that section was served from the
   * adapter cache and the upstream freshness verdict came back
   * `stale`. When omitted (or no cited source is stale) no
   * annotation is rendered. M2-A (Task #456).
   */
  cacheInfoBySourceId?: ReadonlyMap<
    string,
    {
      upstreamFreshness?: {
        status: "fresh" | "stale" | "unknown";
      } | null;
    }
  >;
}

const BRIEFING_SOURCE_ID_RE =
  /\{\{atom\|briefing-source\|([^|]+)\|[^}]+\}\}/g;

function extractCitedSourceIds(body: string | null): string[] {
  if (!body) return [];
  const ids: string[] = [];
  BRIEFING_SOURCE_ID_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BRIEFING_SOURCE_ID_RE.exec(body)) !== null) {
    ids.push(m[1]);
  }
  return ids;
}

export function BriefingNarrativePanel({
  engagementId,
  narrative,
  sourceCount,
  sources,
  onJumpToSource,
  recentRunsSlot = null,
  baseUrl = "/",
  cacheInfoBySourceId,
}: BriefingNarrativePanelProps) {
  const queryClient = useQueryClient();

  const [expanded, setExpanded] = useState(() => defaultExpansion(narrative));
  const lastNarrativeKey = useRef<string | null>(null);
  const narrativeKey = narrative?.generatedAt ?? null;
  useEffect(() => {
    if (lastNarrativeKey.current !== narrativeKey) {
      lastNarrativeKey.current = narrativeKey;
      setExpanded(defaultExpansion(narrative));
    }
  }, [narrative, narrativeKey]);

  const [watching, setWatching] = useState(true);
  const statusQuery = useGetEngagementBriefingGenerationStatus(engagementId, {
    query: {
      queryKey: getGetEngagementBriefingGenerationStatusQueryKey(engagementId),
      refetchInterval: watching ? 2000 : false,
      refetchOnWindowFocus: false,
    },
  });
  const statusState = statusQuery.data?.state ?? "idle";
  const isPending = statusState === "pending";

  const lastStateRef = useRef<typeof statusState>(statusState);
  useEffect(() => {
    const prev = lastStateRef.current;
    if (
      prev === "pending" &&
      (statusState === "completed" || statusState === "failed")
    ) {
      void queryClient.invalidateQueries({
        queryKey: getGetEngagementBriefingQueryKey(engagementId),
      });
      void queryClient.invalidateQueries({
        queryKey:
          getListEngagementBriefingGenerationRunsQueryKey(engagementId),
      });
      setWatching(false);
    }
    if (statusState !== "pending" && watching && prev !== "pending") {
      setWatching(false);
    }
    lastStateRef.current = statusState;
  }, [statusState, queryClient, engagementId, watching]);

  const generateMutation = useGenerateEngagementBriefing({
    mutation: {
      onSuccess: () => {
        setWatching(true);
        void queryClient.invalidateQueries({
          queryKey:
            getGetEngagementBriefingGenerationStatusQueryKey(engagementId),
        });
        void queryClient.invalidateQueries({
          queryKey:
            getListEngagementBriefingGenerationRunsQueryKey(engagementId),
        });
      },
    },
  });

  const hasNarrative = !!narrative && !!narrative.generatedAt;
  const noSources = sourceCount === 0;
  const buttonDisabled = noSources || isPending || generateMutation.isPending;

  const annotationRunsQuery = useListEngagementBriefingGenerationRuns(
    engagementId,
    {
      query: {
        queryKey:
          getListEngagementBriefingGenerationRunsQueryKey(engagementId),
        enabled: narrative?.generationId != null,
        refetchOnWindowFocus: false,
      },
    },
  );
  const producingRunPruned = useMemo(() => {
    const id = narrative?.generationId ?? null;
    if (id === null) return false;
    if (!annotationRunsQuery.data) return false;
    return !annotationRunsQuery.data.runs.some(
      (r: { generationId: string }) => r.generationId === id,
    );
  }, [narrative?.generationId, annotationRunsQuery.data]);
  const buttonLabel = hasNarrative ? "Regenerate Briefing" : "Generate Briefing";
  const tooltip = noSources
    ? "Upload a layer or run an adapter first — the engine has nothing to cite."
    : isPending
      ? "Generation in progress…"
      : hasNarrative
        ? "Re-run the engine. The current narrative is preserved as the prior version."
        : "Synthesize a seven-section A–G briefing from the cited sources.";

  const generatedByLabel = formatBriefingActor(narrative?.generatedBy ?? null);
  const generatedAtLabel = narrative?.generatedAt
    ? new Date(narrative.generatedAt).toLocaleString()
    : null;

  const invalidCount =
    statusQuery.data?.state === "completed"
      ? (statusQuery.data.invalidCitationCount ?? 0)
      : 0;
  const invalidTokens =
    statusQuery.data?.state === "completed"
      ? (statusQuery.data.invalidCitations ?? [])
      : [];
  const failureMessage =
    statusQuery.data?.state === "failed" ? statusQuery.data.error : null;

  const knownSourceIds = useMemo(
    () => new Set(sources.map((s) => s.id)),
    [sources],
  );

  // Task #468 — collect every cited source id (across all A–G
  // sections) whose `cacheInfoBySourceId` entry came back with a
  // `stale` upstream-freshness verdict so we can pass them through
  // to the PDF export route as a comma-separated `staleSourceIds`
  // query param. The route forwards them to the renderer which
  // stamps the same "N source(s) may be stale" annotation the
  // on-screen amber chip uses (M2-A, Task #456). Empty set → no
  // query param at all so the export URL stays wire-identical to
  // the pre-Task #468 anchor for the fresh / unknown / non-cached
  // case.
  const exportPdfStaleQuery = useMemo(() => {
    if (!cacheInfoBySourceId || cacheInfoBySourceId.size === 0) return "";
    const stale: string[] = [];
    for (const [id, info] of cacheInfoBySourceId.entries()) {
      if (info.upstreamFreshness?.status === "stale") stale.push(id);
    }
    if (stale.length === 0) return "";
    return `?staleSourceIds=${stale.map(encodeURIComponent).join(",")}`;
  }, [cacheInfoBySourceId]);

  return (
    <div
      data-testid="briefing-narrative-panel"
      className="sc-card"
      style={{
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div>
          <div className="sc-medium">Site briefing (A–G)</div>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              marginTop: 2,
            }}
          >
            Synthesized by the briefing engine from the {sourceCount}{" "}
            cited source{sourceCount === 1 ? "" : "s"} above.
            {generatedAtLabel && (
              <>
                {" "}
                Last generated {generatedAtLabel}
                {generatedByLabel ? ` by ${generatedByLabel}` : ""}.
              </>
            )}
            {producingRunPruned && (
              <>
                {" "}
                <span
                  data-testid="briefing-narrative-producing-run-pruned"
                  style={{
                    fontSize: 11,
                    padding: "1px 6px",
                    borderRadius: 4,
                    background: "var(--warning-dim)",
                    color: "var(--warning-text)",
                    marginLeft: 2,
                    whiteSpace: "nowrap",
                  }}
                  title="The briefing-generation job that produced this narrative is no longer retained in the audit history."
                >
                  producing run pruned from history
                </span>
              </>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            type="button"
            className="sc-btn sc-btn-primary"
            onClick={() =>
              generateMutation.mutate({
                id: engagementId,
                data: { regenerate: hasNarrative },
              })
            }
            disabled={buttonDisabled}
            title={tooltip}
            aria-disabled={buttonDisabled}
            data-testid="briefing-generate-button"
          >
            {isPending ? "Generating…" : buttonLabel}
          </button>
          <a
            className="sc-btn sc-btn-ghost"
            href={
              hasNarrative
                ? `${baseUrl}api/engagements/${engagementId}/briefing/export.pdf${exportPdfStaleQuery}`
                : undefined
            }
            target="_blank"
            rel="noopener noreferrer"
            aria-disabled={!hasNarrative}
            title={
              hasNarrative
                ? "Render the current A–G briefing as a stakeholder PDF (opens in a new tab)."
                : "Generate the briefing first — there's nothing to export yet."
            }
            data-testid="briefing-export-pdf-button"
            style={
              hasNarrative
                ? undefined
                : {
                    pointerEvents: "none",
                    opacity: 0.5,
                    cursor: "not-allowed",
                  }
            }
            onClick={(e) => {
              if (!hasNarrative) e.preventDefault();
            }}
          >
            Export PDF
          </a>
        </div>
      </div>

      {sources.length === 0 && !hasNarrative && (
        <div
          className="sc-prose"
          style={{
            opacity: 0.7,
            fontSize: 13,
            padding: 12,
            border: "1px dashed var(--border-subtle)",
            borderRadius: 6,
          }}
          data-testid="briefing-narrative-empty"
        >
          The briefing engine cites the sources listed above. Upload a layer
          (or wait for a federal-data adapter run) before generating.
        </div>
      )}

      {failureMessage && (
        <div
          role="alert"
          data-testid="briefing-generation-error"
          style={{
            fontSize: 12,
            color: "var(--danger-text)",
            background: "var(--danger-dim)",
            padding: 8,
            borderRadius: 4,
          }}
        >
          Briefing generation failed: {failureMessage}
        </div>
      )}

      {invalidCount > 0 && (
        <div
          role="status"
          data-testid="briefing-invalid-citations-warning"
          style={{
            fontSize: 12,
            color: "var(--warning-text)",
            background: "var(--warning-dim)",
            padding: 8,
            borderRadius: 4,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div>
            {invalidCount} citation{invalidCount === 1 ? "" : "s"} pointed at
            unknown sources and were stripped from the narrative.
          </div>
          {invalidTokens.length > 0 && (
            <div
              data-testid="briefing-invalid-citations-list"
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 4,
              }}
            >
              {invalidTokens.map((token, idx) => (
                <BriefingInvalidCitationPill
                  key={`invalid-${idx}-${token}`}
                  token={token}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {recentRunsSlot}

      {hasNarrative && (
        <div
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
          data-testid="briefing-narrative-sections"
        >
          {SECTION_ORDER.map(({ key, label, blurb }) => {
            const body = pickSection(narrative, key);
            const isOpen = expanded[key];
            const isEmpty = !body || body.trim().length === 0;
            const citedIds = extractCitedSourceIds(body);
            const staleSourceIds = cacheInfoBySourceId
              ? Array.from(new Set(citedIds)).filter(
                  (id) =>
                    cacheInfoBySourceId.get(id)?.upstreamFreshness?.status ===
                    "stale",
                )
              : [];
            const staleCount = staleSourceIds.length;
            return (
              <div
                key={key}
                className="sc-card"
                data-testid={`briefing-section-${key}`}
                style={{
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 6,
                  background: "var(--surface-1, transparent)",
                }}
              >
                <button
                  type="button"
                  onClick={() =>
                    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))
                  }
                  aria-expanded={isOpen}
                  aria-controls={`briefing-section-body-${key}`}
                  data-testid={`briefing-section-toggle-${key}`}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "10px 12px",
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        flexWrap: "wrap",
                      }}
                    >
                      {label}
                      {staleCount > 0 && (
                        <span
                          data-testid={`briefing-section-stale-${key}`}
                          title={
                            "One or more cited sources were served from the adapter cache and the upstream feed has likely moved. Re-run the adapters to refresh."
                          }
                          style={{
                            fontSize: 11,
                            padding: "1px 6px",
                            borderRadius: 4,
                            background: "var(--warning-dim)",
                            color: "var(--warning-text)",
                            fontWeight: 500,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {staleCount} source
                          {staleCount === 1 ? "" : "s"} may be stale
                        </span>
                      )}
                    </span>
                    <span
                      style={{ fontSize: 11, color: "var(--text-muted)" }}
                    >
                      {blurb}
                    </span>
                  </div>
                  <span
                    aria-hidden
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                      marginLeft: 12,
                    }}
                  >
                    {isOpen ? "▾" : "▸"}
                  </span>
                </button>
                {isOpen && (
                  <div
                    id={`briefing-section-body-${key}`}
                    data-testid={`briefing-section-body-${key}`}
                    className="sc-prose"
                    style={{
                      fontSize: 13,
                      padding: "0 12px 12px 12px",
                      lineHeight: 1.5,
                      color: isEmpty ? "var(--text-muted)" : undefined,
                      fontStyle: isEmpty ? "italic" : undefined,
                    }}
                  >
                    {isEmpty ? (
                      <span data-testid={`briefing-section-pending-${key}`}>
                        Section pending — re-run to refresh.
                      </span>
                    ) : (
                      renderBriefingMarkdown(
                        body!,
                        knownSourceIds,
                        onJumpToSource,
                      )
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
