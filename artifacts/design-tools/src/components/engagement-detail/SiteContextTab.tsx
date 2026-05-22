import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGenerateEngagementBriefing,
  useGenerateEngagementLayers,
  useGetEngagementBriefing,
  useGetEngagementBriefingGenerationStatus,
  getGetEngagementBriefingQueryKey,
  getGetEngagementBriefingGenerationStatusQueryKey,
  getListEngagementBriefingGenerationRunsQueryKey,
  type EngagementBriefingSource,
  type EngagementDetail as EngagementDetailType,
  type GenerateLayersOutcome,
} from "@workspace/api-client-react";
import { SiteMap } from "@workspace/site-context/client";
import { extractBriefingSourceOverlays } from "@workspace/site-context/client";
import {
  FEDERAL_PILOT_LAYER_KINDS,
  PILOT_JURISDICTION_COVERAGE,
  PILOT_JURISDICTIONS,
  filterApplicableAdapters,
  noApplicableAdaptersMessage,
  resolveJurisdiction,
  type AdapterContext,
} from "@workspace/adapters";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import {
  BriefingSourceRow,
  BriefingNarrativePanel as SharedBriefingNarrativePanel,
  extractAdapterKeyFromProvider,
  SiteContextViewer,
  scrollToBriefingSource,
} from "@workspace/portal-ui";
import { BriefingSourceUploadModal } from "../BriefingSourceUploadModal";
import { BriefingRecentRunsPanel } from "./BriefingRecentRunsPanel";
import { BriefingDivergencesPanel, PushToRevitAffordance } from "./PushToRevitAffordance";
import { GenerateLayersSummaryBanner } from "./GenerateLayersSummaryBanner";

/**
 * Tier of a briefing source for the Site Context group headings (DA-PI-4).
 * Derived from `sourceKind`:
 *   - `manual-upload` → grouped under `manual` (architect-uploaded
 *     overlay, the DA-PI-1B path).
 *   - `federal-adapter` → `federal` (DA-PI-2 placeholder).
 *   - `state-adapter`   → `state`   (UGRC, INSIDE Idaho, TCEQ).
 *   - `local-adapter`   → `local`   (county GIS).
 *
 * The function returns `manual` for any unrecognized kind so a
 * future enum value can ship without crashing the UI before this
 * map is updated.
 */
function tierForSource(
  kind: EngagementBriefingSource["sourceKind"],
): "federal" | "state" | "local" | "manual" {
  if (kind === "federal-adapter") return "federal";
  if (kind === "state-adapter") return "state";
  if (kind === "local-adapter") return "local";
  return "manual";
}

const TIER_LABELS: Record<
  "federal" | "state" | "local" | "manual",
  string
> = {
  federal: "Federal layers",
  state: "State layers",
  local: "Local layers",
  manual: "Manually uploaded",
};

const TIER_DESCRIPTIONS: Record<
  "federal" | "state" | "local" | "manual",
  string
> = {
  federal:
    "FEMA flood zones, USGS NED elevation, EPA EJScreen demographics, and FCC broadband availability.",
  state:
    "State-tier sources (UGRC for Utah, INSIDE Idaho for Idaho, TCEQ for Texas).",
  local:
    "County / city GIS sources (parcels, zoning, roads, floodplain) for the parcel's local jurisdiction.",
  manual:
    "Architect-uploaded QGIS overlays. Re-uploading a layer supersedes the prior source while keeping it on the timeline.",
};

const TIER_ORDER: Array<"federal" | "state" | "local" | "manual"> = [
  "federal",
  "state",
  "local",
  "manual",
];

/**
 * Site context tab — DA-PI-1B manual-QGIS upload path.
 *
 * Renders the engagement's current (non-superseded) briefing sources
 * and exposes the "Upload QGIS layer" button that opens
 * {@link BriefingSourceUploadModal}. The four parcel-intelligence
 * atoms (parcel-briefing, intent, briefing-source, neighboring-
 * context) are still shape-only — the briefing engine that resolves
 * them lands in DA-PI-3 — but this sprint wires the source-list +
 * upload UI so federal-data adapters (DA-PI-2) and the briefing
 * engine (DA-PI-3) plug into a tab that is already shipping.
 */
export function SiteContextTab({
  engagement,
  selectedElementRef,
  onClearSelectedElement,
  buildingGlbUrl,
  showBuilding,
  onToggleShowBuilding,
}: {
  engagement: EngagementDetailType;
  /** CAD element ref deep-linked from the Findings tab. */
  selectedElementRef?: string | null;
  /** Clear handler for the selected-element badge. */
  onClearSelectedElement?: () => void;
  /** Engagement BIM model GLB for the optional "Show building"
   * massing overlay on the 3D sub-tab. */
  buildingGlbUrl?: string | null;
  showBuilding?: boolean;
  onToggleShowBuilding?: (next: boolean) => void;
}) {
  const engagementId = engagement.id;
  const [uploadOpen, setUploadOpen] = useState(false);
  const briefingQuery = useGetEngagementBriefing(engagementId);
  const queryClient = useQueryClient();

  // Pre-flight adapter eligibility from the cached engagement record.
  // PL-04 reshaped the gate: federal adapters now apply to any
  // geocoded engagement, so "can the architect run Generate Layers"
  // collapses to "is the parcel geocoded." The variant discriminates
  // three banner states the Site Context tab needs to render:
  //
  //   - missing-geocode: no lat/lng → no adapter can run; the button
  //     is disabled and the banner asks for an address.
  //   - federal-only: geocoded but no state/local pilot for this
  //     parcel — the button runs the federal four and the banner
  //     surfaces partial-coverage copy with the supported pilots.
  //   - full-coverage: geocoded and a state/local pilot is wired —
  //     no banner; the existing happy path.
  //
  // The same `appliesTo` gate the server runs is exposed by
  // `@workspace/adapters/eligibility` so the FE pre-flight cannot
  // disagree with the server's 422 — adding a new pilot jurisdiction
  // flips both surfaces from a single registry edit. We deliberately
  // do NOT pre-flight while the engagement is still loading; the
  // parent's react-query hook resolves before SiteContextTab is
  // mounted, so by the time we read the columns here they have their
  // final values.
  const eligibility = useMemo(() => {
    const geocode = engagement.site?.geocode ?? null;
    const jurisdiction = resolveJurisdiction({
      jurisdictionCity: geocode?.jurisdictionCity ?? null,
      jurisdictionState: geocode?.jurisdictionState ?? null,
      jurisdiction: engagement.jurisdiction ?? null,
      address: engagement.address ?? null,
    });
    const lat = geocode?.latitude ?? NaN;
    const lng = geocode?.longitude ?? NaN;
    const hasGeocode = Number.isFinite(lat) && Number.isFinite(lng);
    const ctx: AdapterContext = {
      parcel: { latitude: lat, longitude: lng },
      jurisdiction,
    };
    const applicable = filterApplicableAdapters(ctx);
    const hasStateOrLocalCoverage = applicable.some(
      (a) => a.tier === "state" || a.tier === "local",
    );
    const variant: "missing-geocode" | "federal-only" | "full-coverage" =
      !hasGeocode
        ? "missing-geocode"
        : hasStateOrLocalCoverage
          ? "full-coverage"
          : "federal-only";
    return {
      canGenerate: applicable.length > 0,
      variant,
      jurisdiction,
      hasGeocode,
      message: noApplicableAdaptersMessage({ jurisdiction, hasGeocode }),
    };
  }, [
    engagement.address,
    engagement.jurisdiction,
    engagement.site?.geocode,
  ]);

  // DA-PI-4 — unified Generate Layers run. Successful outcomes are
  // committed as fresh `briefing_sources` rows on the server, so
  // after the mutation resolves we refetch the briefing to pick
  // them up (the mutation also returns the post-run briefing inline,
  // but the cached query is what every other surface in this page
  // reads from). Per-adapter outcomes are kept in local state so the
  // UI can render OK / failed / no-coverage badges next to each
  // adapter row until the next run.
  const generateMutation = useGenerateEngagementLayers({
    mutation: {
      onSuccess: async (data) => {
        setLastOutcomes(data.outcomes);
        // Task #229 — capture the wall-clock instant the run
        // resolved so the summary banner can render "Last run X
        // ago". The runner doesn't return a server-side
        // completion timestamp on the response envelope, so we
        // pin the moment the client observed the success
        // instead. Re-set on every success (including a
        // Force-refresh re-run) so the banner always reflects
        // the *most recent* run rather than the first.
        setLastRunAt(new Date());
        setLastGenerateError(null);
        setLastGenerateErrorSlug(null);
        await queryClient.invalidateQueries({
          queryKey: getGetEngagementBriefingQueryKey(engagementId),
        });
      },
      onError: (err) => {
        // `customFetch` throws an `ApiError` whose `.data` is the
        // parsed `ErrorResponse` body (`{ error, message }`). Pull
        // the slug separately so the render branch can detect the
        // `no_applicable_adapters` 422 envelope and show a
        // jurisdiction-specific empty state with an upload CTA,
        // instead of dumping the raw slug into the generic banner
        // (Task #177). We additionally require `status === 422`
        // before treating the slug as the empty-pilot signal — the
        // route's contract pairs the slug with a 422 specifically,
        // and matching both keys means a hypothetical future
        // failure that happens to share the slug at a different
        // status (e.g. a 500 wrapping the same string) cannot
        // accidentally re-style as an actionable empty-pilot
        // prompt. For every other failure we fall through to the
        // message string the server returned (or the Error's own
        // `.message` as a last resort) so an upstream timeout
        // still reads naturally.
        const apiErr = err as
          | {
              status?: number;
              data?: { error?: string; message?: string } | null;
            }
          | undefined;
        const data = apiErr?.data;
        const slug = data?.error ?? null;
        const isEmptyPilot =
          apiErr?.status === 422 && slug === "no_applicable_adapters";
        const message =
          data?.message ??
          (err as { message?: string } | undefined)?.message ??
          slug ??
          "Failed to generate layers.";
        setLastOutcomes([]);
        setLastGenerateError(message);
        setLastGenerateErrorSlug(isEmptyPilot ? slug : null);
      },
    },
  });
  // Poll briefing-generation status so the auto-triggered run is
  // visible as it progresses. Mirrors BriefingNarrativePanel's cadence.
  const [watchingBriefingStatus, setWatchingBriefingStatus] = useState(true);
  const regenerateBriefingMutation = useGenerateEngagementBriefing({
    mutation: {
      onSuccess: () => {
        setWatchingBriefingStatus(true);
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
  const briefingStatusQuery = useGetEngagementBriefingGenerationStatus(
    engagementId,
    {
      query: {
        queryKey:
          getGetEngagementBriefingGenerationStatusQueryKey(engagementId),
        refetchInterval: watchingBriefingStatus ? 2000 : false,
        refetchOnWindowFocus: false,
      },
    },
  );
  // `state === null` ⇒ first request has not settled yet; keep polling.
  // Treating undefined data as a terminal state would disarm the poll
  // before the initial response lands.
  const briefingStatusState = briefingStatusQuery.data?.state ?? null;
  // While the very first /briefing/status response is in flight we
  // also treat the page as "a job may be running" so the idle button
  // is suppressed and the loading affordance stands in for it. This
  // closes the brief window where an in-flight auto-trigger would
  // otherwise paint a clickable Generate Layers CTA.
  const isBriefingStatusUnknown =
    briefingStatusState === null && briefingStatusQuery.isLoading;
  const isBriefingJobPending = briefingStatusState === "pending";
  const showBriefingProgress =
    isBriefingJobPending || isBriefingStatusUnknown;
  const briefingJobError =
    briefingStatusState === "failed"
      ? (briefingStatusQuery.data?.error ?? "Briefing generation failed.")
      : null;
  const lastBriefingStatusRef = useRef<
    "pending" | "completed" | "failed" | "idle" | null
  >(briefingStatusState);
  useEffect(() => {
    const prev = lastBriefingStatusRef.current;
    if (
      prev === "pending" &&
      (briefingStatusState === "completed" || briefingStatusState === "failed")
    ) {
      void queryClient.invalidateQueries({
        queryKey: getGetEngagementBriefingQueryKey(engagementId),
      });
      void queryClient.invalidateQueries({
        queryKey:
          getListEngagementBriefingGenerationRunsQueryKey(engagementId),
      });
      setWatchingBriefingStatus(false);
    }
    if (
      briefingStatusState !== null &&
      briefingStatusState !== "pending" &&
      watchingBriefingStatus &&
      prev !== "pending"
    ) {
      setWatchingBriefingStatus(false);
    }
    lastBriefingStatusRef.current = briefingStatusState;
  }, [briefingStatusState, queryClient, engagementId, watchingBriefingStatus]);

  const [lastOutcomes, setLastOutcomes] = useState<GenerateLayersOutcome[]>([]);
  // Task #229 — wall-clock instant the most recent Generate Layers
  // run resolved on the client. `null` until the first successful
  // run, which is what `GenerateLayersSummaryBanner` keys off of to
  // hide itself on the initial page load (per the task's "no
  // outcomes yet" hide rule).
  const [lastRunAt, setLastRunAt] = useState<Date | null>(null);
  const [lastGenerateError, setLastGenerateError] = useState<string | null>(
    null,
  );
  // Tracked alongside the human-readable message so the render
  // branch can pick the empty-pilot-jurisdiction CTA banner when
  // the server returns the `no_applicable_adapters` 422 envelope
  // (Task #177).
  const [lastGenerateErrorSlug, setLastGenerateErrorSlug] = useState<
    string | null
  >(null);
  // Task #228 — tracks which adapterKey, if any, the architect just
  // clicked "Refresh this layer" for. Cleared on settle (success or
  // error) so the per-row spinner only shows on the row that
  // actually triggered the run, not on every other federal-adapter
  // row in the list.
  const [refreshingAdapterKey, setRefreshingAdapterKey] = useState<
    string | null
  >(null);
  // Task #255 — tracks the most recent per-adapter rerun failure so
  // the paired stale-badge "Re-run" button can render an inline
  // error string under the badge. Cleared whenever a new rerun is
  // started (so the prior message doesn't linger under the spinner)
  // or whenever a rerun for a *different* adapter takes its place.
  // We store both the key and the message so the badge can guard the
  // error display on `error.adapterKey === thisRowAdapterKey` —
  // otherwise an unrelated full-run failure could leak into a
  // bystander row's footer.
  const [lastRerunError, setLastRerunError] = useState<{
    adapterKey: string;
    message: string;
  } | null>(null);
  // Task #271 — sibling of `lastRerunError`: tracks the most recent
  // per-adapter rerun *success* so the targeted row's
  // `ProvenanceFooter` can render a transient "Refreshed just now"
  // pill confirming the click took effect. We store both the key and
  // the resolution timestamp so (a) the row can pin the affordance
  // to the specific adapterKey it owns (no flashing on bystander
  // rows) and (b) `BriefingSourceDetails` can re-key its CSS-animated
  // node off `at` to restart the fade if a second rerun lands within
  // the same window. The auto-clear effect below resets this back to
  // `null` after ~4s so the pill fades out gracefully.
  const [lastRerunSuccessAt, setLastRerunSuccessAt] = useState<{
    adapterKey: string;
    at: number;
  } | null>(null);
  // Task #271 — auto-clear the success pill after the affordance
  // window. We pin the cleared state to the same `at` we set so a
  // second rerun arriving inside the window (and stamping a fresh
  // `at`) doesn't get clobbered by the prior timer's fire — the
  // updater bails when `curr.at` no longer matches.
  useEffect(() => {
    if (lastRerunSuccessAt === null) return;
    const stamped = lastRerunSuccessAt.at;
    const handle = setTimeout(() => {
      setLastRerunSuccessAt((curr) => (curr?.at === stamped ? null : curr));
    }, 4000);
    return () => clearTimeout(handle);
  }, [lastRerunSuccessAt]);
  const handleRefreshLayer = useCallback(
    (adapterKey: string) => {
      // Don't fire a second single-layer mutation while one is in
      // flight — the runner doesn't serialize per-row clicks for us
      // and concurrent supersessions for the same layerKind would
      // race against each other.
      if (generateMutation.isPending) return;
      setRefreshingAdapterKey(adapterKey);
      // Clear any prior per-adapter error so the spinner isn't
      // stacked on top of a stale failure message.
      setLastRerunError(null);
      // Task #271 — clear any prior success pill at click time too,
      // so a second click on the same (or sibling) row doesn't
      // visually advertise the *previous* run's success while the
      // new one is still in flight.
      setLastRerunSuccessAt(null);
      generateMutation.mutate(
        {
          id: engagementId,
          // Bypass the cache too — the whole point of "Refresh this
          // layer" is to confirm the upstream feed hasn't moved.
          // Without forceRefresh a recent cache hit would replay the
          // same payload and the architect would think nothing
          // changed.
          params: { adapterKey, forceRefresh: true },
        },
        {
          onSuccess: async () => {
            // Task #255 — the page-level mutation onSuccess already
            // invalidates the briefing query, but the per-row history
            // hint (`useListEngagementBriefingSources`) is keyed
            // independently and would otherwise still show the prior
            // count after a single-layer rerun supersedes a row.
            // Invalidate by URL prefix so every variant of the list
            // (per-layerKind, includeSuperseded on/off) refetches.
            await queryClient.invalidateQueries({
              queryKey: [
                `/api/engagements/${engagementId}/briefing/sources`,
              ],
            });
            // Task #271 — stamp a per-adapter success record after
            // the invalidation kicks off so the targeted row's
            // `ProvenanceFooter` can render the "Refreshed just now"
            // pill. Keyed by adapterKey so a re-mount of the new
            // (superseded) row picks the same affordance up — the
            // new `source.id` differs but the adapterKey is stable.
            setLastRerunSuccessAt({ adapterKey, at: Date.now() });
          },
          onError: (err) => {
            const apiErr = err as
              | {
                  status?: number;
                  data?: { error?: string; message?: string } | null;
                }
              | undefined;
            const message =
              apiErr?.data?.message ??
              apiErr?.data?.error ??
              (err as { message?: string } | undefined)?.message ??
              "Re-run failed.";
            setLastRerunError({ adapterKey, message });
          },
          onSettled: () => {
            setRefreshingAdapterKey((curr) =>
              curr === adapterKey ? null : curr,
            );
          },
        },
      );
    },
    [engagementId, generateMutation, queryClient],
  );

  const sources = briefingQuery.data?.briefing?.sources ?? [];
  const narrative = briefingQuery.data?.briefing?.narrative ?? null;
  // Map sub-tab inputs hoisted so the overlay memo isn't gated by
  // `subTab === "map"` (rules of hooks).
  const mapGeocode = engagement.site?.geocode ?? null;
  const mapOverlays = useMemo(
    () => extractBriefingSourceOverlays(sources),
    [sources],
  );
  // M-A5: pair each layerKind with its producer adapter key for the
  // upload modal's supersede chip. Manual rows use the conventional
  // `manual-qgis-import` key; adapter rows expose the key embedded in
  // `provider` (`<adapterKey> (cached <n>h ago)`), falling back to
  // `sourceKind` when the provider tail is absent.
  const existingLayerKinds = useMemo(
    () =>
      sources.map((s) => ({
        layerKind: s.layerKind,
        adapterKey:
          s.sourceKind === "manual-upload"
            ? "manual-qgis-import"
            : extractAdapterKeyFromProvider(s.provider) ?? s.sourceKind,
      })),
    [sources],
  );

  // Task #204 — index the most recent run's outcomes by the
  // `briefing_sources.id` they wrote so each row can render a
  // "cached <n>h ago" pill when the runner served it from the
  // adapter response cache. We only retain `fromCache=true` outcomes
  // with a non-null `sourceId` (the row was actually persisted) so
  // there's no entry at all for fresh-live or no-coverage outcomes —
  // the row component renders nothing in that case.
  //
  // Task #227 extension: when the runner attached an
  // `upstreamFreshness` verdict (only on cache hits whose adapter
  // implements `getUpstreamFreshness()`), pass it through too so the
  // row can flip the pill to a "cache may be stale" warning when the
  // upstream feed has likely moved.
  const cacheInfoBySourceId = useMemo(() => {
    const map = new Map<
      string,
      {
        fromCache: boolean;
        cachedAt: string | null;
        upstreamFreshness: {
          status: "fresh" | "stale" | "unknown";
          reason: string | null;
        } | null;
      }
    >();
    for (const o of lastOutcomes) {
      if (o.fromCache && o.sourceId) {
        map.set(o.sourceId, {
          fromCache: true,
          cachedAt: o.cachedAt ?? null,
          upstreamFreshness: o.upstreamFreshness
            ? {
                status: o.upstreamFreshness.status,
                reason: o.upstreamFreshness.reason ?? null,
              }
            : null,
        });
      }
    }
    return map;
  }, [lastOutcomes]);

  // Bucket sources by tier (DA-PI-4). Manual-upload rows land in
  // their own tier so the "manually uploaded" set stays distinct
  // from the auto-fetched federal/state/local rows. Each bucket
  // preserves the newest-first order from the briefing read.
  const sourcesByTier = useMemo(() => {
    const acc: Record<
      "federal" | "state" | "local" | "manual",
      EngagementBriefingSource[]
    > = { federal: [], state: [], local: [], manual: [] };
    for (const s of sources) acc[tierForSource(s.sourceKind)].push(s);
    return acc;
  }, [sources]);

  // Sub-tab toggle (DA-MV-1, Spec 52 §2). The viewer is the primary
  // surface for an engagement that already has converted DXF
  // geometry, so we default the sub-tab to "3d" once any source has
  // reached `ready`. Until then the toggle stays on "map" so the
  // legacy 2D-overlay placeholder is what the architect sees first.
  // The default is computed from the latest briefing read; once the
  // user has manually flipped the toggle we leave their choice
  // alone (initial-state-only).
  const hasReadyDxf = sources.some((s) => s.conversionStatus === "ready");
  const defaultSubTab: "map" | "3d" = hasReadyDxf ? "3d" : "map";
  const [subTab, setSubTab] = useState<"map" | "3d">(defaultSubTab);
  // If the briefing read finishes after the initial render and the
  // user has not yet toggled, snap to the data-driven default. Once
  // the user has interacted, `userPickedRef` blocks further auto-
  // adjustments so a converter completing mid-session does not yank
  // the viewer out from under them.
  const userPickedRef = useRef(false);
  useEffect(() => {
    if (!userPickedRef.current && hasReadyDxf && subTab !== "3d") {
      setSubTab("3d");
    }
  }, [hasReadyDxf, subTab]);

  // Citation-pill jump target highlight state (Task #176). When a
  // user clicks an inline citation pill in the narrative, we scroll
  // the matching `BriefingSourceRow` into view and flash the row's
  // border for ~1.6s so the architect's eye lands on the right card.
  // The highlight is React state (not DOM mutation) so it survives
  // re-renders and tests can assert on it.
  const [highlightedSourceId, setHighlightedSourceId] = useState<
    string | null
  >(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, []);
  const handleJumpToSource = (sourceId: string) => {
    setHighlightedSourceId(sourceId);
    // Defer the scroll one frame so React commits the highlight
    // first — the row's style change is what we want the user to
    // see *as* the page snaps to it.
    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => {
        scrollToBriefingSource(sourceId);
      });
    } else {
      scrollToBriefingSource(sourceId);
    }
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedSourceId((curr) => (curr === sourceId ? null : curr));
    }, 1600);
  };

  return (
    <div className="sc-card p-6 flex flex-col gap-4 flex-1">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div>
          <div className="sc-medium">Briefing sources</div>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              marginTop: 2,
            }}
          >
            Federal, state, and local overlays cited by the engagement's
            parcel briefing — fetched automatically by the Generate Layers
            run, plus any architect-uploaded QGIS overlays. Re-running or
            re-uploading a layer supersedes the prior source while keeping
            it on the timeline.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {showBriefingProgress ? (
            <span
              data-testid="briefing-generation-progress"
              role="status"
              aria-live="polite"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 13,
                color: "var(--text-muted)",
                padding: "6px 10px",
              }}
              title="The briefing engine is generating Site Context for this engagement."
            >
              <span
                aria-hidden="true"
                data-testid="briefing-generation-progress-spinner"
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  border: "1.5px solid currentColor",
                  borderRightColor: "transparent",
                  display: "inline-block",
                  animation:
                    "sc-briefing-generation-spin 0.8s linear infinite",
                }}
              />
              <span>Site Context loading…</span>
              <style>{`@keyframes sc-briefing-generation-spin { to { transform: rotate(360deg); } }`}</style>
            </span>
          ) : briefingJobError ? (
            <span
              data-testid="briefing-generation-error"
              role="alert"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                color: "var(--danger-text, #b91c1c)",
                background: "var(--danger-dim, #fef2f2)",
                border: "1px solid var(--danger-border, #fecaca)",
                borderRadius: 4,
                padding: "4px 8px",
              }}
            >
              <span data-testid="briefing-generation-error-message">
                Site Context failed to load: {briefingJobError}
              </span>
              <button
                type="button"
                className="sc-btn-link"
                data-testid="briefing-generation-error-retry"
                onClick={() => {
                  // Retry the briefing-generation job itself (not the
                  // layers run). removeQueries on the cached status so
                  // the stale terminal-failed value can't disarm the
                  // watcher before the next status fetch lands.
                  setWatchingBriefingStatus(true);
                  queryClient.removeQueries({
                    queryKey:
                      getGetEngagementBriefingGenerationStatusQueryKey(
                        engagementId,
                      ),
                  });
                  regenerateBriefingMutation.mutate({
                    id: engagementId,
                    data: { regenerate: true },
                  });
                }}
                disabled={regenerateBriefingMutation.isPending}
                style={{
                  fontSize: 12,
                  background: "transparent",
                  border: "none",
                  color: "inherit",
                  textDecoration: "underline",
                  cursor: regenerateBriefingMutation.isPending
                    ? "not-allowed"
                    : "pointer",
                  padding: 0,
                }}
              >
                Retry
              </button>
            </span>
          ) : null}
          {!showBriefingProgress && (
            <button
              type="button"
              className="sc-btn"
              onClick={() => {
                setWatchingBriefingStatus(true);
                queryClient.removeQueries({
                  queryKey:
                    getGetEngagementBriefingGenerationStatusQueryKey(
                      engagementId,
                    ),
                });
                generateMutation.mutate({ id: engagementId });
              }}
              // PL-04: the button is enabled whenever any adapter can
              // run. Federal adapters now apply to any geocoded
              // engagement, so disabling only fires for the genuine
              // dead-end case (no lat/lng). The tooltip flexes between
              // the full-coverage happy-path copy and the partial /
              // missing-geocode notices the banner below also surfaces.
              disabled={generateMutation.isPending || !eligibility.canGenerate}
              data-testid="generate-layers-button"
              title={
                eligibility.variant === "full-coverage"
                  ? "Run every applicable federal/state/local adapter and persist the results as briefing sources."
                  : eligibility.variant === "federal-only"
                    ? "Run the federal adapters (FEMA, USGS, EPA, FCC). State/local layers are not yet wired for this jurisdiction."
                    : eligibility.message
              }
            >
              {generateMutation.isPending ? "Generating…" : "Generate Layers"}
            </button>
          )}
          {/*
           * Task #204 — "Force refresh" runs the same Generate Layers
           * mutation but with `?forceRefresh=true`, which makes the
           * runner bypass the federal-adapter response cache for this
           * one run (the result still gets cached for the *next*
           * run). Rendered as a link rather than a primary button so
           * it sits alongside Generate Layers without competing with
           * the upload-source CTA.
           */}
          <button
            type="button"
            className="sc-btn-link"
            onClick={() => {
              setWatchingBriefingStatus(true);
              queryClient.removeQueries({
                queryKey:
                  getGetEngagementBriefingGenerationStatusQueryKey(
                    engagementId,
                  ),
              });
              generateMutation.mutate({
                id: engagementId,
                params: { forceRefresh: true },
              });
            }}
            disabled={generateMutation.isPending || showBriefingProgress}
            data-testid="generate-layers-force-refresh-button"
            title={
              showBriefingProgress
                ? "Site Context is currently loading — Force refresh will be available once it completes."
                : "Re-run every adapter live, bypassing the federal-adapter response cache for this one run."
            }
            style={{
              fontSize: 12,
              color: "var(--text-link, var(--cyan, #06b6d4))",
              background: "transparent",
              border: "none",
              padding: "2px 4px",
              cursor:
                generateMutation.isPending || showBriefingProgress
                  ? "not-allowed"
                  : "pointer",
              textDecoration: "underline",
              opacity:
                generateMutation.isPending || showBriefingProgress ? 0.5 : 1,
            }}
          >
            Force refresh
          </button>
          <button
            type="button"
            className="sc-btn sc-btn-primary"
            onClick={() => setUploadOpen(true)}
            data-testid="briefing-source-upload-button"
          >
            Upload site context source
          </button>
        </div>
      </div>

      {/*
        Task #232 — surface the supported pilot jurisdictions *before*
        any Generate Layers click. Task #188 already lists the pilot
        set inside the empty-pilot banner, but that banner only renders
        after a click + 422 round-trip on out-of-pilot projects, so an
        architect scoping a Boulder CO project still hits a dead-end
        before discovering the supported set is systemically narrow.
        Rendering the list as an unobtrusive disclosure under the
        action row lets the architect spot the dead-end up front.

        The list is sourced from the same `PILOT_JURISDICTIONS`
        registry the empty-pilot banner consumes (and that the
        server's `appliesTo` gate filters on), so the pre-click
        and post-click surfaces cannot drift from each other or
        from the route. The disclosure stays mounted regardless of
        whether the empty-pilot banner is up — an architect on a
        non-pilot project sees both surfaces (banner with the
        actionable upload CTA, disclosure as the always-on
        reference) without one hiding the other.

        PL-04 made the banner more nuanced: missing-geocode and
        federal-only variants are pre-flight rendered alongside this
        disclosure so the architect sees both the supported pilots
        and the actionable next step without ever clicking Generate
        Layers.
      */}
      <details
        data-testid="generate-layers-supported-jurisdictions"
        style={{
          fontSize: 12,
          color: "var(--text-muted)",
          marginTop: -4,
        }}
      >
        <summary
          data-testid="generate-layers-supported-jurisdictions-summary"
          style={{ cursor: "pointer", userSelect: "none" }}
        >
          Supported jurisdictions ({PILOT_JURISDICTIONS.length})
        </summary>
        {/*
          Task #253 — surface what Generate Layers will *fetch* for each
          pilot jurisdiction, not just the jurisdiction names. An
          architect scoping a Bastrop project should not have to click
          Generate Layers and read the per-adapter outcome panel to
          discover the run produces "state parcels + county zoning +
          floodplain". The per-jurisdiction breakdown is derived from
          {@link PILOT_JURISDICTION_COVERAGE} so adding a new state or
          local adapter to `ALL_ADAPTERS` automatically extends the
          visible coverage with no FE change required.

          Federal adapters ungate (they fire for every jurisdiction)
          so they're surfaced once via {@link FEDERAL_PILOT_LAYER_KINDS}
          rather than repeated under every row, keeping the
          per-jurisdiction view focused on what actually varies.
        */}
        <div
          data-testid="generate-layers-supported-jurisdictions-list"
          style={{
            marginTop: 6,
            color: "var(--text-secondary)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div>
            Generate Layers currently runs against:{" "}
            {PILOT_JURISDICTIONS.map((j) => j.label).join(" • ")}. Projects
            outside this set need a manual QGIS overlay upload to seed the
            briefing.
          </div>
          {FEDERAL_PILOT_LAYER_KINDS.length > 0 && (
            <div
              data-testid="generate-layers-supported-jurisdictions-federal"
              style={{ color: "var(--text-secondary)" }}
            >
              <span style={{ fontWeight: 600 }}>
                Always-on federal layers:
              </span>{" "}
              {FEDERAL_PILOT_LAYER_KINDS.join(", ")}
            </div>
          )}
          <ul
            data-testid="generate-layers-supported-jurisdictions-coverage"
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {PILOT_JURISDICTION_COVERAGE.map((cov) => (
              <li
                key={cov.localKey}
                data-testid={`generate-layers-supported-coverage-${cov.localKey}`}
                style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
              >
                <span style={{ fontWeight: 600 }}>{cov.shortLabel}:</span>
                <span>
                  {cov.layers.length === 0
                    ? "No state or local adapters yet"
                    : cov.layers.map((l) => l.layerKind).join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </details>

      {eligibility.variant === "missing-geocode" ||
      lastGenerateErrorSlug === "no_applicable_adapters" ? (
        // Missing-geocode banner: no lat/lng → no adapter (federal or
        // otherwise) can run. The architect's actionable next step is
        // to add an address to the engagement so the geocoder fills
        // in coordinates. The post-error path also lands here so a
        // server-side 422 (rare under PL-04 — should require non-US
        // coords) reads naturally.
        <div
          role="status"
          data-testid="generate-layers-no-adapters-banner"
          style={{
            fontSize: 12,
            color: "var(--info-text)",
            background: "var(--info-dim)",
            padding: 12,
            borderRadius: 4,
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontWeight: 600 }}>
              No adapters configured for this engagement yet
            </div>
            <div
              data-testid="generate-layers-no-adapters-message"
              style={{ color: "var(--text-secondary)" }}
            >
              {lastGenerateError ?? eligibility.message}
            </div>
            <div
              data-testid="generate-layers-no-adapters-supported"
              style={{ color: "var(--text-secondary)" }}
            >
              <span style={{ fontWeight: 600 }}>
                Currently supported state/local pilots:
              </span>{" "}
              {PILOT_JURISDICTIONS.map((j) => j.label).join(" • ")}
            </div>
            <div style={{ color: "var(--text-secondary)" }}>
              Upload a QGIS overlay below to seed the briefing manually.
            </div>
          </div>
          <button
            type="button"
            className="sc-btn sc-btn-primary"
            data-testid="generate-layers-no-adapters-upload"
            onClick={() => setUploadOpen(true)}
            style={{ flexShrink: 0 }}
          >
            Upload site context source
          </button>
        </div>
      ) : eligibility.variant === "federal-only" ? (
        // Partial-coverage banner: federal adapters will load (FEMA
        // flood, USGS topo, EPA EJSCREEN, FCC broadband) but no
        // state/local pilot is wired for this parcel yet. The button
        // remains enabled — clicking it runs the federal four — and
        // the supported-pilots list keeps the dead-end systemic
        // rather than specific to this engagement.
        <div
          role="status"
          data-testid="generate-layers-federal-only-banner"
          style={{
            fontSize: 12,
            color: "var(--info-text)",
            background: "var(--info-dim)",
            padding: 12,
            borderRadius: 4,
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontWeight: 600 }}>
              Federal layers will load — state/local pending
            </div>
            <div
              data-testid="generate-layers-federal-only-message"
              style={{ color: "var(--text-secondary)" }}
            >
              Federal adapters (FEMA flood, USGS topo, EPA EJSCREEN, FCC
              broadband) will fetch for this parcel. No state/local adapter for
              this jurisdiction yet — upload a QGIS overlay or wait for adapter
              support.
            </div>
            <div
              data-testid="generate-layers-federal-only-supported"
              style={{ color: "var(--text-secondary)" }}
            >
              <span style={{ fontWeight: 600 }}>
                Currently supported state/local pilots:
              </span>{" "}
              {PILOT_JURISDICTIONS.map((j) => j.label).join(" • ")}
            </div>
          </div>
          <button
            type="button"
            className="sc-btn sc-btn-primary"
            data-testid="generate-layers-federal-only-upload"
            onClick={() => setUploadOpen(true)}
            style={{ flexShrink: 0 }}
          >
            Upload site context source
          </button>
        </div>
      ) : (
        lastGenerateError && (
          <div
            role="alert"
            data-testid="generate-layers-error"
            style={{
              fontSize: 12,
              color: "var(--danger-text)",
              background: "var(--danger-dim)",
              padding: 8,
              borderRadius: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span>{lastGenerateError}</span>
            <button
              type="button"
              className="sc-btn"
              data-testid="generate-layers-retry-button"
              onClick={() => generateMutation.mutate({ id: engagementId })}
              disabled={generateMutation.isPending}
              style={{ flexShrink: 0 }}
            >
              {generateMutation.isPending ? "Retrying…" : "Retry"}
            </button>
          </div>
        )
      )}

      <GenerateLayersSummaryBanner
        outcomes={lastOutcomes}
        lastRunAt={lastRunAt}
        isRefreshing={generateMutation.isPending}
        onForceRefresh={() =>
          generateMutation.mutate({
            id: engagementId,
            params: { forceRefresh: true },
          })
        }
      />

      {lastOutcomes.length > 0 && (
        <div
          data-testid="generate-layers-outcomes"
          style={{
            fontSize: 12,
            color: "var(--text-secondary)",
            background: "var(--surface-2, var(--info-dim))",
            padding: 8,
            borderRadius: 4,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div style={{ fontWeight: 600 }}>Last Generate Layers run</div>
          {lastOutcomes.map((o) => (
            <div
              key={o.adapterKey}
              data-testid={`generate-layers-outcome-${o.adapterKey}`}
              style={{ display: "flex", gap: 8, alignItems: "baseline" }}
            >
              <span style={{ fontFamily: "monospace" }}>{o.adapterKey}</span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color:
                    o.status === "ok"
                      ? "var(--success-text)"
                      : o.status === "no-coverage"
                        ? "var(--text-muted)"
                        : "var(--danger-text)",
                }}
              >
                {o.status}
              </span>
              {o.error && (
                <span style={{ color: "var(--text-muted)" }}>
                  — {o.error.message}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--text-secondary)",
          }}
        >
          Site context view
        </div>
        <ToggleGroup.Root
          type="single"
          value={subTab}
          aria-label="Site context view"
          onValueChange={(v) => {
            // Radix sends "" when the user clicks the active item; we
            // require a value at all times so ignore empty strings.
            if (v === "map" || v === "3d") {
              userPickedRef.current = true;
              setSubTab(v);
            }
          }}
          data-testid="site-context-subtab-toggle"
          style={{
            display: "inline-flex",
            border: "1px solid var(--border-subtle)",
            borderRadius: 6,
            overflow: "hidden",
          }}
        >
          <ToggleGroup.Item
            value="map"
            data-testid="site-context-subtab-map"
            style={{
              padding: "4px 12px",
              fontSize: 12,
              background:
                subTab === "map" ? "var(--info-dim)" : "transparent",
              color:
                subTab === "map"
                  ? "var(--info-text)"
                  : "var(--text-secondary)",
              border: "none",
              cursor: "pointer",
            }}
          >
            Map view
          </ToggleGroup.Item>
          <ToggleGroup.Item
            value="3d"
            data-testid="site-context-subtab-3d"
            style={{
              padding: "4px 12px",
              fontSize: 12,
              background:
                subTab === "3d" ? "var(--info-dim)" : "transparent",
              color:
                subTab === "3d"
                  ? "var(--info-text)"
                  : "var(--text-secondary)",
              border: "none",
              borderLeft: "1px solid var(--border-subtle)",
              cursor: "pointer",
            }}
          >
            3D view
          </ToggleGroup.Item>
        </ToggleGroup.Root>
      </div>

      {subTab === "map" ? (
        mapGeocode === null ? (
          <div
            data-testid="site-context-map-no-geocode"
            className="sc-card"
            style={{
              padding: 16,
              background: "var(--surface-2, var(--info-dim))",
              color: "var(--text-muted)",
              fontSize: 13,
              textAlign: "center",
              minHeight: 320,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {engagement.address
              ? "This address hasn't been geocoded yet. Run Generate Layers to resolve the parcel map."
              : "Add an address on the Site tab to load the parcel map."}
          </div>
        ) : (
          <div
            data-testid="site-context-map"
            style={{ minHeight: 320, flex: 1 }}
          >
            <SiteMap
              latitude={mapGeocode.latitude}
              longitude={mapGeocode.longitude}
              addressLabel={engagement.address ?? undefined}
              overlays={mapOverlays}
              height={320}
            />
          </div>
        )
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            minHeight: 320,
            flex: 1,
          }}
        >
          <SiteContextViewer
            sources={sources}
            selectedElementRef={selectedElementRef}
            onClearSelectedElement={onClearSelectedElement}
            buildingGlbUrl={buildingGlbUrl}
            showBuilding={showBuilding}
            onToggleShowBuilding={onToggleShowBuilding}
          />
        </div>
      )}

      {briefingQuery.isLoading && (
        <div
          className="sc-prose"
          style={{ opacity: 0.7, fontSize: 13 }}
        >
          Loading briefing sources…
        </div>
      )}

      {briefingQuery.isError && (
        <div
          role="alert"
          style={{
            fontSize: 12,
            color: "var(--danger-text)",
            background: "var(--danger-dim)",
            padding: 8,
            borderRadius: 4,
          }}
        >
          Failed to load briefing sources.
        </div>
      )}

      {!briefingQuery.isLoading &&
        !briefingQuery.isError &&
        sources.length === 0 && (
          <div
            className="sc-prose"
            style={{
              opacity: 0.7,
              fontSize: 13,
              padding: 16,
              border: "1px dashed var(--border-subtle)",
              borderRadius: 6,
            }}
          >
            No briefing sources yet. Upload a QGIS export to attach the first
            cited overlay; the parcel briefing row is created on the first
            upload.
          </div>
        )}

      {sources.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
          data-testid="briefing-sources-list"
        >
          {TIER_ORDER.filter((tier) => sourcesByTier[tier].length > 0).map(
            (tier) => (
              <div
                key={tier}
                data-testid={`briefing-sources-tier-${tier}`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div>
                  <div
                    className="sc-medium"
                    style={{ fontSize: 13 }}
                  >
                    {TIER_LABELS[tier]}{" "}
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--text-muted)",
                        fontWeight: 400,
                      }}
                    >
                      ({sourcesByTier[tier].length})
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                      marginTop: 2,
                    }}
                  >
                    {TIER_DESCRIPTIONS[tier]}
                  </div>
                </div>
                {sourcesByTier[tier].map((source) => {
                  const adapterKey = extractAdapterKeyFromProvider(
                    source.provider,
                  );
                  // Task #255 — only pass the rerun error down to the
                  // row whose adapterKey was actually targeted by the
                  // most recent failed rerun, so a fault on one
                  // federal layer can't leak its message into a
                  // sibling row's footer.
                  const rerunError =
                    lastRerunError !== null &&
                    adapterKey !== null &&
                    lastRerunError.adapterKey === adapterKey
                      ? lastRerunError.message
                      : null;
                  // Task #271 — same per-adapter scoping for the
                  // success pill: only the row whose adapterKey was
                  // actually targeted gets the "Refreshed just now"
                  // affordance. Bystander rows never see the pill.
                  const rerunSuccessAt =
                    lastRerunSuccessAt !== null &&
                    adapterKey !== null &&
                    lastRerunSuccessAt.adapterKey === adapterKey
                      ? lastRerunSuccessAt.at
                      : null;
                  return (
                    <BriefingSourceRow
                      key={source.id}
                      engagementId={engagementId}
                      source={source}
                      isHighlighted={highlightedSourceId === source.id}
                      cacheInfo={cacheInfoBySourceId.get(source.id) ?? null}
                      onRefreshLayer={handleRefreshLayer}
                      isRefreshing={
                        refreshingAdapterKey !== null &&
                        adapterKey === refreshingAdapterKey
                      }
                      rerunStaleAdapterError={rerunError}
                      rerunStaleAdapterSuccessAt={rerunSuccessAt}
                    />
                  );
                })}
              </div>
            ),
          )}
        </div>
      )}

      {/*
        Task #316 — render the shared BriefingNarrativePanel from
        portal-ui and inject the design-tools-specific
        BriefingRecentRunsPanel (which takes
        narrativeGenerationId / narrativeIsLoaded / currentNarrative)
        as a slot. plan-review passes its own slot with the reviewer
        signature. baseUrl keeps the "Export PDF" anchor mounted
        under the artifact's path-prefixed proxy.
      */}
      <SharedBriefingNarrativePanel
        engagementId={engagementId}
        narrative={narrative}
        sourceCount={sources.length}
        sources={sources}
        onJumpToSource={handleJumpToSource}
        baseUrl={import.meta.env.BASE_URL}
        cacheInfoBySourceId={cacheInfoBySourceId}
        recentRunsSlot={
          <BriefingRecentRunsPanel
            engagementId={engagementId}
            narrativeGenerationId={narrative?.generationId ?? null}
            narrativeIsLoaded={narrative !== null}
            currentNarrative={narrative}
          />
        }
      />

      <PushToRevitAffordance
        engagementId={engagementId}
        hasBriefing={Boolean(briefingQuery.data?.briefing)}
      />

      <BriefingDivergencesPanel engagementId={engagementId} />

      <BriefingSourceUploadModal
        engagementId={engagementId}
        isOpen={uploadOpen}
        onClose={() => setUploadOpen(false)}
        existingLayerKinds={existingLayerKinds}
      />
    </div>
  );
}
