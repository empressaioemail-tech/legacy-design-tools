import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGenerateEngagementLayers,
  useGetBimModelRefresh,
  useGetEngagement,
  useGetEngagementBimModel,
  useGetEngagementBriefing,
  useGetSnapshot,
  useListEngagementBriefingGenerationRuns,
  useListEngagementSubmissions,
  usePushEngagementBimModel,
  useResolveBimModelDivergence,
  useUpdateEngagement,
  getGetBimModelRefreshQueryKey,
  getGetEngagementBimModelQueryKey,
  getGetEngagementBriefingQueryKey,
  getGetEngagementQueryKey,
  getGetSnapshotQueryKey,
  getListBimModelDivergencesQueryKey,
  getListEngagementBriefingGenerationRunsQueryKey,
  getListEngagementsQueryKey,
  getListEngagementSubmissionsQueryKey,
  type BimModelDivergenceListEntry,
  type BriefingGenerationRun,
  type EngagementBriefingNarrative,
  type EngagementBriefingSource,
  type EngagementDetail as EngagementDetailType,
  type EngagementSubmissionSummary,
  type GenerateLayersOutcome,
  type SubmissionReceipt,
  type SubmissionResponse,
  type SubmissionStatus,
} from "@workspace/api-client-react";
import { SiteMap } from "@workspace/site-context/client";
// Task #303 B.5 / Task #314 — the per-section word-level diff that
// powers the prior-narrative panel was extracted into
// `@workspace/briefing-diff` so the Plan Review reviewer view can
// render the same diff without copy-pasting the LCS routine. Both
// artifacts cannot import each other, so the helper has to live in
// a shared lib if both are to use it.
// Task #355 — the prior-narrative title row, "Generated <when> by
// <actor>" meta line, and "Copy plain text" button (with its 2 s
// "Copied!" confirmation) live in this shared lib so the testids,
// copy payload shape, and revert timing stay byte-identical with
// the Plan Review surface without copy-pasting two parallel JSX
// subtrees.
//
// Task #373 — the seven-section A–G tuple and the `pickSection`
// column-router that both surfaces walk when laying out the
// per-section diff also live in the same lib so the labels and
// ordering can never disagree across the two consumers. (Task #316
// moved the main narrative cards — and the blurb copy — into the
// shared `BriefingNarrativePanel` in `@workspace/portal-ui`, so the
// blurbs no longer live on this surface.)
//
// Task #374 — the seven A–G word-level diff rows that sit directly
// underneath that header are now shipped from the same lib as
// `<BriefingPriorNarrativeDiff />`, lifting the last ~140 lines of
// byte-identical JSX that used to sit inline below the header here
// and on the Plan Review surface. The lib owns the testid contract
// (`briefing-run-prior-section-*`) and the strikethrough/underline
// token styling so a tweak on one surface can no longer surface
// only as a mirror-test failure on the other.
import {
  BriefingPriorNarrativeDiff,
  BriefingPriorSnapshotHeader,
} from "@workspace/briefing-prior-snapshot";
import {
  FEDERAL_PILOT_LAYER_KINDS,
  PILOT_JURISDICTION_COVERAGE,
  PILOT_JURISDICTIONS,
  filterApplicableAdapters,
  noApplicableAdaptersMessage,
  resolveJurisdiction,
  type AdapterContext,
} from "@workspace/adapters";
import type { SheetSummary } from "@workspace/api-client-react";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { AppShell } from "../components/AppShell";
import { BriefingSourceUploadModal } from "../components/BriefingSourceUploadModal";
import { ClaudeChat } from "../components/ClaudeChat";
import { EngagementDetailsModal } from "../components/EngagementDetailsModal";
import { RecordSubmissionResponseDialog } from "../components/RecordSubmissionResponseDialog";
import { RevitBinding } from "../components/RevitBinding";
import { SheetGrid } from "../components/SheetGrid";
import { SubmissionDetailModal } from "../components/SubmissionDetailModal";
import { ReviewerRequestsStrip } from "../components/ReviewerRequestsStrip";
import {
  BriefingDivergenceDetailDialog,
  BriefingDivergenceRow as PortalBriefingDivergenceRow,
  BriefingDivergencesPanel as PortalBriefingDivergencesPanel,
  ParcelZoningCard,
  ReviewerComment,
  SiteContextViewer,
  SubmissionRecordedBanner,
  SubmitToJurisdictionDialog,
  formatRelativeMaterializedAt,
  useSidebarState,
  // Task #316 — per-source briefing row, per-layer history panel,
  // and A–G narrative card extracted to portal-ui so plan-review
  // reviewers see the same provenance / divergence pills / prior-run
  // comparison disclosure the architect sees here. Task #391 dropped
  // the compatibility re-exports for the row, history panel,
  // narrative panel, and three history-tier symbols once their
  // legacy `__tests__/BriefingSourceRow.test.tsx` was migrated into
  // the portal-ui spec files; the imports below are now scoped to
  // the symbols this surface still consumes internally.
  BriefingSourceRow,
  BriefingNarrativePanel as SharedBriefingNarrativePanel,
  extractAdapterKeyFromProvider,
} from "@workspace/portal-ui";
import { useEngagementsStore } from "../store/engagements";
import { relativeTime } from "../lib/relativeTime";
import {
  BACKFILL_FILTER_QUERY_PARAM,
  backfillAnnotation,
  formatBackfillTally,
  matchesBackfillFilter,
  parseBackfillFilter,
  summarizeBackfillTallies,
  type BackfillFilter,
} from "../lib/submissionBackfill";
import { scrollToBriefingSource } from "@workspace/portal-ui";

const STATUS_ACCENT: Record<string, { bg: string; color: string }> = {
  active: { bg: "var(--cyan-accent-bg)", color: "var(--cyan)" },
  on_hold: { bg: "var(--warning-dim)", color: "var(--warning)" },
  archived: { bg: "var(--bg-input)", color: "var(--text-muted)" },
};

const PROJECT_TYPE_LABEL: Record<string, string> = {
  new_build: "New build",
  renovation: "Renovation",
  addition: "Addition",
  tenant_improvement: "Tenant improvement",
  other: "Other",
};

function StatusPill({ status }: { status: string }) {
  const accent = STATUS_ACCENT[status] ?? STATUS_ACCENT.active;
  return (
    <span
      className="sc-pill"
      style={{
        background: accent.bg,
        color: accent.color,
        textTransform: "uppercase",
        fontSize: 11,
        letterSpacing: "0.05em",
        padding: "3px 8px",
        borderRadius: 4,
      }}
    >
      {status.replace("_", " ")}
    </span>
  );
}

function KpiTile({
  label,
  value,
  footnote,
}: {
  label: string;
  value: number | string | null | undefined;
  footnote?: string;
}) {
  // testid is keyed on a normalized lowercase label so e2e tests
  // (`engagement-snapshot-timeline.spec.ts`) can target individual
  // tiles without relying on visible text or DOM order.
  const testId = `engagement-kpi-${label.toLowerCase()}`;
  return (
    <div className="sc-card p-4" data-testid={testId}>
      <div className="sc-label">{label}</div>
      <div className="sc-kpi-md mt-2" data-testid={`${testId}-value`}>
        {value ?? "—"}
      </div>
      {footnote && <div className="sc-meta mt-1 opacity-70">{footnote}</div>}
    </div>
  );
}

type TabId =
  | "snapshots"
  | "sheets"
  | "site"
  | "site-context"
  | "submissions"
  | "settings";

/**
 * Read the active tab from `?tab=…` on the current URL. Mirrors the
 * URL-state convention DevAtoms.tsx and DevAtomsProbe.tsx already use:
 * `URLSearchParams` over `window.location.search`, with a strict
 * allow-list so a stale or hand-edited link can't push the page into
 * an unknown tab. SSR-safe: returns the default when `window` is
 * undefined.
 *
 * The default is `snapshots` (the page's "home" tab); a missing or
 * unknown `tab` param resolves to that, so a bookmark of the bare
 * engagement URL keeps working.
 */
function readTabFromUrl(): TabId {
  if (typeof window === "undefined") return "snapshots";
  const raw = new URLSearchParams(window.location.search).get("tab");
  if (
    raw === "snapshots" ||
    raw === "sheets" ||
    raw === "site" ||
    raw === "site-context" ||
    raw === "submissions" ||
    raw === "settings"
  ) {
    return raw;
  }
  return "snapshots";
}

/**
 * Write the active tab back to the URL using `replaceState`. Matches
 * the convention DevAtoms.tsx documents at length: tab switches are
 * navigation-cheap (no real route change), so polluting the
 * back-button history with one entry per click is the wrong shape —
 * `replaceState` keeps the URL deep-linkable without making "back"
 * cycle through every tab the user touched.
 *
 * The default tab (`snapshots`) is encoded by *removing* `?tab=…`
 * rather than writing `?tab=snapshots`, so the canonical URL stays
 * the bare engagement URL when the user is on the default view.
 */
function writeTabToUrl(next: TabId): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (next === "snapshots") {
    url.searchParams.delete("tab");
  } else {
    url.searchParams.set("tab", next);
  }
  window.history.replaceState(null, "", url.toString());
}

/**
 * Read the backfill filter (Task #124) from the URL. Reuses the
 * same SSR-safe + allow-list pattern as `readTabFromUrl` so a stale
 * or hand-edited link can't push the timeline into an undefined
 * filter state. Defaults to `"all"` when the param is missing.
 */
function readBackfillFilterFromUrl(): BackfillFilter {
  if (typeof window === "undefined") return "all";
  const raw = new URLSearchParams(window.location.search).get(
    BACKFILL_FILTER_QUERY_PARAM,
  );
  return parseBackfillFilter(raw);
}

/**
 * Mirror the active backfill filter back into the URL via
 * `replaceState`, matching the tab-state convention above. The
 * default (`"all"`) is encoded by *removing* the param so the
 * canonical engagement URL stays clean when no filter is applied.
 */
function writeBackfillFilterToUrl(next: BackfillFilter): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (next === "all") {
    url.searchParams.delete(BACKFILL_FILTER_QUERY_PARAM);
  } else {
    url.searchParams.set(BACKFILL_FILTER_QUERY_PARAM, next);
  }
  window.history.replaceState(null, "", url.toString());
}

/**
 * Recent-runs disclosure URL state (Task #275).
 *
 * Task #262 added the All / Failed / Has invalid citations filter on
 * top of the recent-runs disclosure, but the active filter (and the
 * disclosure's open/closed state) only lived in component state.
 * Mirroring the URL-share pattern the tab + backfill filter use lets
 * an auditor drop a link in a Slack thread that lands a teammate on
 * the same filtered view, with the disclosure already expanded.
 *
 * Two params are reflected in the URL:
 *   - `recentRunsFilter=failed|invalid` — the active filter chip.
 *     Omitted when the default ("all") is active so the canonical
 *     URL stays bare.
 *   - `recentRunsOpen=1` — the disclosure's open state. Omitted when
 *     collapsed (the default), again to keep the canonical URL bare.
 *
 * Both helpers are SSR-safe and the read uses an allow-list so a
 * stale or hand-edited link can't push the panel into an undefined
 * filter state.
 */
const RECENT_RUNS_FILTER_QUERY_PARAM = "recentRunsFilter";
const RECENT_RUNS_OPEN_QUERY_PARAM = "recentRunsOpen";

type RecentRunsFilter = "all" | "failed" | "invalid";

function readRecentRunsFilterFromUrl(): RecentRunsFilter {
  if (typeof window === "undefined") return "all";
  const raw = new URLSearchParams(window.location.search).get(
    RECENT_RUNS_FILTER_QUERY_PARAM,
  );
  if (raw === "failed" || raw === "invalid") return raw;
  return "all";
}

function writeRecentRunsFilterToUrl(next: RecentRunsFilter): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (next === "all") {
    url.searchParams.delete(RECENT_RUNS_FILTER_QUERY_PARAM);
  } else {
    url.searchParams.set(RECENT_RUNS_FILTER_QUERY_PARAM, next);
  }
  window.history.replaceState(null, "", url.toString());
}

function readRecentRunsOpenFromUrl(): boolean {
  if (typeof window === "undefined") return false;
  const raw = new URLSearchParams(window.location.search).get(
    RECENT_RUNS_OPEN_QUERY_PARAM,
  );
  return raw === "1";
}

function writeRecentRunsOpenToUrl(next: boolean): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (next) {
    url.searchParams.set(RECENT_RUNS_OPEN_QUERY_PARAM, "1");
  } else {
    url.searchParams.delete(RECENT_RUNS_OPEN_QUERY_PARAM);
  }
  window.history.replaceState(null, "", url.toString());
}

function TabBar({
  active,
  onChange,
}: {
  active: TabId;
  onChange: (id: TabId) => void;
}) {
  const tabs: Array<{ id: TabId; label: string }> = [
    { id: "snapshots", label: "Snapshots" },
    { id: "sheets", label: "Sheets" },
    { id: "site", label: "Site" },
    { id: "site-context", label: "Site context" },
    { id: "submissions", label: "Submissions" },
    { id: "settings", label: "Settings" },
  ];
  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        borderBottom: "1px solid var(--border-default)",
      }}
    >
      {tabs.map((t) => {
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className="sc-tab"
            style={{
              padding: "8px 14px",
              background: "transparent",
              border: "none",
              borderBottom: isActive
                ? "2px solid var(--cyan)"
                : "2px solid transparent",
              color: isActive
                ? "var(--text-primary)"
                : "var(--text-secondary)",
              fontFamily: "Inter, sans-serif",
              fontSize: 12,
              cursor: "pointer",
              transition: "color 0.12s, border-color 0.12s",
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function KvGrid({
  rows,
}: {
  rows: Array<{ label: string; value: React.ReactNode }>;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(140px, 1fr) 2fr",
        gap: "6px 12px",
        fontSize: 12,
      }}
    >
      {rows.map((r, i) => (
        <div key={i} style={{ display: "contents" }}>
          <div
            className="sc-data-label"
            style={{ color: "var(--text-secondary)" }}
          >
            {r.label}
          </div>
          <div style={{ color: "var(--text-primary)" }}>{r.value}</div>
        </div>
      ))}
    </div>
  );
}

function SiteTab({
  engagement,
  onAddAddress,
}: {
  engagement: EngagementDetailType;
  onAddAddress: () => void;
}) {
  const site = engagement.site;
  const geocode = site?.geocode ?? null;

  // Task #424 — pull the parcel briefing so the Parcel & Zoning card
  // can surface real data (parcel id, zoning, overlays, provenance)
  // instead of the long-standing "Coming soon" placeholder. Driven
  // off the same hook used elsewhere on the page so the cache stays
  // shared with the Site Context tab.
  const briefingQuery = useGetEngagementBriefing(engagement.id, {
    query: {
      queryKey: getGetEngagementBriefingQueryKey(engagement.id),
      enabled: !!engagement.id,
    },
  });
  const briefing = briefingQuery.data?.briefing ?? null;

  const locationRows: Array<{ label: string; value: React.ReactNode }> = [
    { label: "Address", value: site?.address ?? "—" },
    {
      label: "Coordinates",
      value: geocode
        ? `${geocode.latitude.toFixed(5)}, ${geocode.longitude.toFixed(5)}`
        : "—",
    },
    {
      label: "Jurisdiction",
      value: geocode
        ? [geocode.jurisdictionCity, geocode.jurisdictionState]
            .filter(Boolean)
            .join(", ") || "—"
        : "—",
    },
    {
      label: "Geocoded",
      value: geocode ? relativeTime(geocode.geocodedAt) : "Not yet",
    },
  ];

  const projectRows: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: "Project type",
      value: site?.projectType
        ? (PROJECT_TYPE_LABEL[site.projectType] ?? site.projectType)
        : "—",
    },
    { label: "Zoning code", value: site?.zoningCode ?? "—" },
    {
      label: "Lot area",
      value:
        site?.lotAreaSqft !== null && site?.lotAreaSqft !== undefined
          ? `${site.lotAreaSqft.toLocaleString()} sq ft`
          : "—",
    },
    {
      label: "Project status",
      value: <StatusPill status={engagement.status} />,
    },
  ];

  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <div className="flex flex-col gap-4">
        <div className="sc-card flex flex-col">
          <div className="sc-card-header">
            <span className="sc-label">LOCATION</span>
          </div>
          <div className="p-3">
            {geocode ? (
              <SiteMap
                latitude={geocode.latitude}
                longitude={geocode.longitude}
                addressLabel={site?.address ?? undefined}
                height={280}
              />
            ) : (
              <div
                className="sc-prose"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 12,
                  height: 200,
                  textAlign: "center",
                  opacity: 0.8,
                }}
              >
                <div>Add an address to plot this project on the map.</div>
                <button className="sc-btn-primary" onClick={onAddAddress}>
                  Add address
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="sc-card p-4">
          <KvGrid rows={locationRows} />
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div className="sc-card flex flex-col">
          <div className="sc-card-header">
            <span className="sc-label">PROJECT</span>
          </div>
          <div className="p-4">
            <KvGrid rows={projectRows} />
          </div>
        </div>

        <ParcelZoningCard
          hasGeocode={!!geocode}
          zoningCodeFromSite={site?.zoningCode ?? null}
          lotAreaSqftFromSite={site?.lotAreaSqft ?? null}
          briefing={briefing}
          siteContextHref={`/engagements/${engagement.id}?tab=site-context`}
        />
      </div>
    </div>
  );
}

function SettingsTab({
  engagement,
  onEdit,
}: {
  engagement: EngagementDetailType;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const archive = useUpdateEngagement({
    mutation: {
      onSuccess: async () => {
        await qc.invalidateQueries({
          queryKey: getGetEngagementQueryKey(engagement.id),
        });
        await qc.invalidateQueries({
          queryKey: getListEngagementsQueryKey(),
        });
        setConfirming(false);
      },
    },
  });
  const isArchived = engagement.status === "archived";

  return (
    <div className="flex flex-col gap-6">
      <div className="sc-card p-4 flex items-center justify-between">
        <div>
          <div className="sc-label" style={{ marginBottom: 4 }}>
            DETAILS
          </div>
          <div className="sc-meta opacity-70">
            Update name, address, project type, zoning, lot area, and status.
          </div>
        </div>
        <button className="sc-btn-primary" onClick={onEdit}>
          Edit details
        </button>
      </div>

      <RevitBinding
        revitCentralGuid={engagement.revitCentralGuid}
        revitDocumentPath={engagement.revitDocumentPath}
      />

      <div
        style={{
          borderTop: "1px solid var(--border-default)",
          paddingTop: 16,
          color: "var(--text-secondary)",
        }}
      >
        <div className="sc-label" style={{ marginBottom: 8 }}>
          DANGER ZONE
        </div>
        {!confirming ? (
          <button
            className="sc-btn-ghost"
            disabled={isArchived || archive.isPending}
            onClick={() => setConfirming(true)}
            style={{
              color: isArchived ? "var(--text-muted)" : "#ef4444",
              borderColor: isArchived
                ? "var(--border-default)"
                : "rgba(239,68,68,0.4)",
            }}
          >
            {isArchived ? "Already archived" : "Archive engagement"}
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="sc-meta">
              Archive {engagement.name}? You can change it back later.
            </span>
            <button
              className="sc-btn-ghost"
              onClick={() => setConfirming(false)}
              disabled={archive.isPending}
            >
              Cancel
            </button>
            <button
              className="sc-btn-primary"
              disabled={archive.isPending}
              onClick={() =>
                archive.mutate({
                  id: engagement.id,
                  data: { status: "archived" },
                })
              }
              style={{ background: "var(--danger)" }}
            >
              {archive.isPending ? "Archiving…" : "Confirm archive"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}


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
/**
 * "x ago" label for the {@link GenerateLayersSummaryBanner} top-of-list
 * summary banner. Mirrors the row-level cache pill's clamping rules
 * (future timestamps collapse to "just now" so client/server clock
 * skew never reads as a confusing negative) but uses long-form
 * units ("12 minutes ago", "2 hours ago") because the banner sits
 * in a sentence — "Last run 12 minutes ago — …" — instead of the
 * tight pill the row-level helper feeds.
 */
function formatRunAgeLabel(at: Date): string {
  const diffMs = Date.now() - at.getTime();
  if (diffMs < 60_000) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/**
 * Task #229 — top-of-list summary banner for the most recent
 * Generate Layers run. Surfaces three things in one line so an
 * architect can answer at a glance:
 *
 *   - When the last run resolved on the client ("Last run
 *     12 minutes ago" via {@link formatRunAgeLabel}).
 *   - How many of the run's persisted layers came from the
 *     federal-adapter response cache vs. a live upstream
 *     fetch ("4 of 5 layers served from cache"). Only
 *     `status=ok` outcomes count as "layers" — `failed` and
 *     `no-coverage` are excluded from both numerator and
 *     denominator so the ratio always reads against actual
 *     persisted rows.
 *   - A "Force refresh" CTA wired to the same forceRefresh
 *     mutation the controls header already exposes.
 *
 * Hides itself entirely when there are no outcomes yet so a
 * first-time visitor isn't confused by an empty placeholder.
 * Exported so the SiteContextTab unit test can render it in
 * isolation against a fixture outcomes array.
 */
export function GenerateLayersSummaryBanner({
  outcomes,
  lastRunAt,
  isRefreshing,
  onForceRefresh,
}: {
  outcomes: GenerateLayersOutcome[];
  lastRunAt: Date | null;
  isRefreshing: boolean;
  onForceRefresh: () => void;
}) {
  if (lastRunAt === null || outcomes.length === 0) return null;

  const layerCount = outcomes.filter((o) => o.status === "ok").length;
  const cachedCount = outcomes.filter(
    (o) => o.status === "ok" && o.fromCache,
  ).length;
  const ageLabel = formatRunAgeLabel(lastRunAt);

  return (
    <div
      data-testid="generate-layers-summary-banner"
      role="status"
      style={{
        fontSize: 12,
        color: "var(--text-secondary)",
        background: "var(--info-dim)",
        padding: "8px 12px",
        borderRadius: 4,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <div
        data-testid="generate-layers-summary-banner-text"
        style={{ display: "flex", flexWrap: "wrap", gap: 6 }}
      >
        <span style={{ fontWeight: 600 }}>Last run {ageLabel}</span>
        {layerCount > 0 && (
          <span data-testid="generate-layers-summary-banner-cache-count">
            — {cachedCount} of {layerCount}{" "}
            {layerCount === 1 ? "layer" : "layers"} served from cache.
          </span>
        )}
      </div>
      <button
        type="button"
        className="sc-btn-link"
        onClick={onForceRefresh}
        disabled={isRefreshing}
        data-testid="generate-layers-summary-banner-force-refresh"
        title="Re-run every adapter live, bypassing the federal-adapter response cache for this one run."
        style={{
          fontSize: 12,
          color: "var(--text-link, var(--cyan, #06b6d4))",
          background: "transparent",
          border: "none",
          padding: "2px 4px",
          cursor: isRefreshing ? "not-allowed" : "pointer",
          textDecoration: "underline",
          opacity: isRefreshing ? 0.5 : 1,
          flexShrink: 0,
        }}
      >
        Force refresh
      </button>
    </div>
  );
}

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
 * --- DA-PI-3 Site Context narrative panel ---
 *
 * Renders the seven-section A–G briefing the engine produces under
 * the briefing sources list inside SiteContextTab. The panel handles
 * three concerns:
 *
 *   1. Surfaces the persisted narrative as a stack of expandable
 *      cards, one per section. Defaults follow the DA-PI-3 spec —
 *      A is always expanded; B and E are expanded only when their
 *      body is non-empty; C/D/F/G are collapsed by default. The user
 *      can toggle any card.
 *
 *   2. Provides the kickoff button — "Generate Briefing" when no
 *      narrative is on file, "Regenerate" once one exists. The button
 *      is disabled when there are no sources (the canonical tooltip
 *      explains why) and when a generation is in flight.
 *
 *   3. Polls the status endpoint every ~2s while a generation is
 *      pending, and on the `pending → completed | failed` edge it
 *      re-fetches the briefing read so the cards re-render with the
 *      freshly persisted sections.
 *
 * Citation tokens are kept verbatim in the rendered text — DA-PI-4
 * resolves them into clickable inline pills; until that ships the
 * tokens read as inline annotations so the architect can see what the
 * engine cited.
 */
/**
 * Human-readable label for one {@link BriefingGenerationRun}'s state.
 * Pinned to the wire enum so a forward-compat value falls back to the
 * raw slug rather than rendering blank — same defensive shape the
 * SubmissionStatusBadge in plan-review uses.
 */
const BRIEFING_RUN_STATE_LABELS: Record<
  BriefingGenerationRun["state"],
  string
> = {
  pending: "Running",
  completed: "Completed",
  failed: "Failed",
};

const BRIEFING_RUN_STATE_COLORS: Record<
  BriefingGenerationRun["state"],
  { bg: string; fg: string }
> = {
  pending: { bg: "var(--info-dim)", fg: "var(--info-text)" },
  completed: { bg: "var(--success-dim)", fg: "var(--success-text)" },
  failed: { bg: "var(--danger-dim)", fg: "var(--danger-text)" },
};

function BriefingRunStateBadge({
  state,
}: {
  state: BriefingGenerationRun["state"];
}) {
  const label = BRIEFING_RUN_STATE_LABELS[state] ?? state;
  const palette =
    BRIEFING_RUN_STATE_COLORS[state] ?? BRIEFING_RUN_STATE_COLORS.pending;
  return (
    <span
      data-testid={`briefing-run-state-badge-${state}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 6px",
        borderRadius: 4,
        background: palette.bg,
        color: palette.fg,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.2,
        textTransform: "uppercase",
        lineHeight: 1.4,
      }}
    >
      {label}
    </span>
  );
}

/**
 * Recent runs disclosure for the briefing tab — Task #230.
 *
 * Surfaces the most recent N briefing-generation attempts the
 * sweep retains (default 5, see
 * `briefingGenerationJobsSweep#DEFAULT_KEEP_PER_ENGAGEMENT`) so
 * an auditor can compare "the run before the bad one" without
 * SSHing into the database. Collapsed by default — the running
 * narrative above is what the auditor lands on, and the prior
 * attempts are an investigation aid, not a primary read.
 *
 * Each row renders the attempt's outcome (state + timestamp). The
 * row expands to surface its `error` (failed branch) or
 * `invalidCitationCount` (completed branch) inline so the
 * comparison window is one click away — clicking a past run
 * doesn't open a modal or navigate away from the briefing the
 * auditor is currently inspecting.
 *
 * The list re-fetches when the parent invalidates its query key,
 * which the parent (`BriefingNarrativePanel`) wires up on
 * generation kickoff and on the pending → terminal transition.
 */
function BriefingRecentRunsPanel({
  engagementId,
  narrativeGenerationId,
  narrativeIsLoaded,
  currentNarrative,
}: {
  engagementId: string;
  /**
   * Task #281 — id of the `briefing_generation_jobs` row that produced
   * the narrative currently rendered in the parent
   * `BriefingNarrativePanel`, or `null` when no producing run is on
   * file (the engine has never run for this engagement, the very
   * first generation is still pending, the producing job was
   * already pruned out of the keep window, or the row pre-dates
   * the column and the post-merge backfill didn't have a matching
   * job to attribute to). The panel marks the row whose
   * `generationId` equals this value with the "Current" pill —
   * direct id equality, no timestamp inference — so the badge stays
   * exact even when two completions race, the runs route paginates,
   * or a backfill writes sections without inserting a job row.
   * When this is `null` no row is marked, so a brand-new engagement
   * (or one whose producing job has aged out) doesn't sport a
   * misleading "Current" pill on an unrelated row.
   */
  narrativeGenerationId: string | null;
  /**
   * Task #301 — `true` when the briefing query has resolved a
   * non-null `narrative` payload (i.e. there are A–G section
   * bodies on screen above the disclosure), independent of whether
   * the producing job's id is still on file. Combined with a null
   * `narrativeGenerationId` this means: the auditor is looking at
   * a real narrative whose producing run has aged out of the
   * keep-N retention window (or pre-dates the `generation_id`
   * column and the post-merge backfill couldn't attribute it).
   * In that combination the panel renders a one-line caption
   * explaining why no row is marked Current, so the missing pill
   * doesn't read as "the disclosure is broken." When the
   * narrative itself is null (engine has never run for this
   * engagement, or the very first generation is still pending)
   * no caption renders — the absence of a Current pill is
   * already self-explanatory.
   */
  narrativeIsLoaded: boolean;
  /**
   * Task #303 B.5 — the narrative *currently* on screen in the
   * parent panel. The prior-narrative block diffs each A–G section
   * against the matching section in this value so the auditor can
   * see, word by word, what the most recent regeneration removed
   * and added relative to the snapshot the briefing was holding
   * before. When `null` (no narrative on file yet) the diff
   * collapses to "every prior token is unchanged", which renders
   * the prior body verbatim — the safe degenerate case.
   */
  currentNarrative: EngagementBriefingNarrative | null;
}) {
  // Task #275 — both the open/closed state of the disclosure and the
  // active filter are mirrored to the URL so an auditor who finds a
  // suspicious failed-then-rerun pattern can drop a link in a Slack
  // thread that lands a teammate on the same filtered, already-open
  // view. The setters below sync to `replaceState` on every change to
  // avoid polluting back-button history with one entry per click.
  // (`RecentRunsFilter` is declared next to the URL helpers at the
  // top of the file so the helpers can reference it.)
  const [open, setOpenState] = useState<boolean>(() =>
    readRecentRunsOpenFromUrl(),
  );
  const setOpen = (next: boolean): void => {
    setOpenState(next);
    writeRecentRunsOpenToUrl(next);
  };
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  // Task #355 — the title row, the meta line, and the
  // "Copy plain text" button (the latter delegating to the
  // Task #350 `<CopyPlainTextButton />` in `@workspace/portal-ui`
  // for the discriminated success / error pill state, the ~2 s
  // revert timer, the unmount cleanup, and the
  // `briefing-run-prior-narrative-copy-*` testids) now live in
  // the shared `<BriefingPriorSnapshotHeader />` from
  // `@workspace/briefing-prior-snapshot`. The two surfaces
  // consume one implementation so the JSX, testids, friendly
  // actor rewrite, and copy-button timing can never drift.
  // Task #262 — auditors comparing the failed-then-rerun pattern on a
  // noisy engagement need a way to slice the retained list down to the
  // suspicious rows. The filter is purely client-side (the route
  // contract is unchanged) and "All" is the default so the disclosure
  // still opens onto the full history.
  const [filter, setFilterState] = useState<RecentRunsFilter>(() =>
    readRecentRunsFilterFromUrl(),
  );
  const setFilter = (next: RecentRunsFilter): void => {
    setFilterState(next);
    writeRecentRunsFilterToUrl(next);
  };
  // Only fetch when the disclosure is open. The status poll above
  // already drives the at-a-glance "what is the latest run doing?"
  // story — this list is the deeper comparison view, so it can stay
  // dormant until the auditor explicitly asks for it. Saves one
  // extra round trip on every page load for a feature most users
  // will not open every visit.
  const runsQuery = useListEngagementBriefingGenerationRuns(engagementId, {
    query: {
      queryKey: getListEngagementBriefingGenerationRunsQueryKey(engagementId),
      enabled: open,
      refetchOnWindowFocus: false,
    },
  });
  const runs = runsQuery.data?.runs ?? [];
  // Task #280 — the wire envelope also carries the section_a..g
  // backup the briefing held *before* its current narrative was
  // written. There's at most one (the briefing row only retains
  // one snapshot — older runs have already been overwritten by
  // newer regenerations) so we resolve the producing row by
  // matching its [startedAt, completedAt] interval against the
  // backup's `generatedAt` timestamp, mirroring the Current-pill
  // logic below. Older rows whose backups were already overwritten
  // simply don't match and fall through to the existing details.
  const priorNarrative = runsQuery.data?.priorNarrative ?? null;
  const count = runs.length;
  type RecentRun = (typeof runs)[number];
  // Task #276 — pre-compute the per-bucket tallies so each filter chip
  // can render a count alongside its label. Surfacing the count means
  // an auditor can see at a glance whether the comparison-of-attempts
  // story is even worth opening, instead of clicking each chip just
  // to discover the empty-state copy. The buckets stay in sync with
  // the predicate below by using the same conditions.
  const failedCount = runs.filter(
    (run: RecentRun) => run.state === "failed",
  ).length;
  const invalidCount = runs.filter(
    (run: RecentRun) =>
      run.state === "completed" && (run.invalidCitationCount ?? 0) > 0,
  ).length;
  const filterCounts: Record<RecentRunsFilter, number> = {
    all: count,
    failed: failedCount,
    invalid: invalidCount,
  };
  const visibleRuns = runs.filter((run: RecentRun) => {
    if (filter === "failed") return run.state === "failed";
    if (filter === "invalid") {
      return (
        run.state === "completed" && (run.invalidCitationCount ?? 0) > 0
      );
    }
    return true;
  });
  const visibleCount = visibleRuns.length;
  // Task #281 — match the on-screen narrative to its producing
  // row by direct id equality. The server stamps the producing
  // job's id onto `parcel_briefings.generation_id` inside the
  // same transaction that overwrites the section columns, so
  // the briefing's `narrative.generationId` *is* the row that
  // produced what's on screen — no timestamp window inference
  // required. We still confirm the matching id is actually
  // present in the runs list (the producing job may have aged
  // out of the keep window between the briefing fetch and the
  // runs fetch, in which case no row should be marked) and we
  // search the full `runs` list rather than `visibleRuns` so
  // the Task #262 filter cannot accidentally suppress the pill
  // when the producing row is filtered out of view. When
  // `narrativeGenerationId` is null (legacy unbackfilled row,
  // pruned producing job, or no generation has ever run on
  // this briefing) we honestly mark nothing instead of
  // mislabelling an unrelated row.
  const currentGenerationId = useMemo<string | null>(() => {
    if (narrativeGenerationId === null) return null;
    for (const run of runs as RecentRun[]) {
      if (run.generationId === narrativeGenerationId) {
        return run.generationId;
      }
    }
    return null;
  }, [narrativeGenerationId, runs]);

  // Task #280 — same interval-match shape as Current, but against
  // the prior narrative's `generatedAt`. Resolves to the
  // generationId of the row that produced the body now living in
  // `prior_section_*` (i.e. the run *before* the one whose output
  // is currently on screen). Older rows in the list whose backups
  // have already been overwritten will not match — the briefing
  // row only retains one snapshot — so they fall through to the
  // existing details branch with no prior body to render. A
  // missing or unparseable timestamp resolves to null so we
  // never pick an arbitrary row.
  //
  // Task #313 — legacy backups can carry `generatedBy` without a
  // `generatedAt` (per-row provenance was added after the section
  // backup columns on some installs). Without a fallback, the
  // entire prior block is suppressed even though we have the
  // actor on file, costing auditors useful "who regenerated this
  // last" provenance on older engagements. When `generatedAt` is
  // null but `generatedBy` is set, attach the prior body to the
  // most recent completed run that pre-dates the current
  // narrative — the meta line will gracefully render just the
  // "by …" half (the existing presence check on each half
  // already handles that, so we never fabricate a date).
  const priorGenerationId = useMemo<string | null>(() => {
    if (!priorNarrative) return null;
    if (priorNarrative.generatedAt !== null) {
      // The orval/zod codegen coerces `generatedAt` to `Date`, but
      // tests + the runtime queryFn pass through ISO strings, so
      // normalize via `new Date(...)` which accepts both shapes
      // and yields `NaN` on garbage.
      const stampedMs = new Date(
        priorNarrative.generatedAt as Date | string,
      ).getTime();
      if (Number.isNaN(stampedMs)) return null;
      for (const run of runs as RecentRun[]) {
        if (run.state !== "completed") continue;
        if (run.completedAt === null) continue;
        const startedMs = Date.parse(String(run.startedAt));
        const completedMs = Date.parse(String(run.completedAt));
        if (Number.isNaN(startedMs) || Number.isNaN(completedMs)) continue;
        if (stampedMs >= startedMs && stampedMs <= completedMs) {
          return run.generationId;
        }
      }
      return null;
    }
    // Fallback path — `generatedAt` is null. Only attempt the
    // actor-only fallback when we actually have an actor to
    // surface; otherwise we'd be picking a row purely to render
    // an empty meta line, which is exactly the noise the
    // interval matcher exists to avoid.
    if (priorNarrative.generatedBy === null) return null;
    // Bound the search to runs that pre-date whatever produced the
    // current narrative. When the current run is in the retained
    // window we can use its `startedAt` as a hard boundary; when
    // it isn't (pruned by the keep-N sweep) we fall back to "most
    // recent completed run on file", since the prior body is by
    // definition not the current narrative and any earlier
    // completed run is a better answer than suppressing the
    // block entirely.
    let boundaryMs: number | null = null;
    if (currentGenerationId !== null) {
      for (const run of runs as RecentRun[]) {
        if (run.generationId === currentGenerationId) {
          const startedMs = Date.parse(String(run.startedAt));
          if (!Number.isNaN(startedMs)) boundaryMs = startedMs;
          break;
        }
      }
    }
    // The runs list arrives newest-first, so the first eligible
    // completed row is the most recent one that pre-dates the
    // current narrative.
    for (const run of runs as RecentRun[]) {
      if (run.state !== "completed") continue;
      if (run.generationId === currentGenerationId) continue;
      if (boundaryMs !== null) {
        const startedMs = Date.parse(String(run.startedAt));
        if (Number.isNaN(startedMs)) continue;
        if (startedMs >= boundaryMs) continue;
      }
      return run.generationId;
    }
    return null;
  }, [priorNarrative, runs, currentGenerationId]);

  return (
    <div
      data-testid="briefing-recent-runs"
      style={{
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        background: "var(--surface-1, transparent)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="briefing-recent-runs-body"
        data-testid="briefing-recent-runs-toggle"
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600 }}>Recent runs</span>
        <span
          aria-hidden
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            marginLeft: 12,
          }}
        >
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div
          id="briefing-recent-runs-body"
          data-testid="briefing-recent-runs-body"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            padding: "0 12px 12px 12px",
          }}
        >
          {/*
            Task #301 — when the narrative is on screen but the
            producing job's id is no longer on file (the run aged
            out of the keep-N sweep window, or the row pre-dates
            the `generation_id` column), no row in the list below
            can carry the "Current" pill. Without a signal, the
            missing pill reads as "the disclosure is broken." A
            one-line caption above the list closes that loop
            without changing any other behavior. Suppressed when
            the narrative itself is null (no producing run has
            ever been stamped) — the absence of a Current pill is
            already self-explanatory in that case.
          */}
          {narrativeIsLoaded && narrativeGenerationId === null && (
            <div
              data-testid="briefing-recent-runs-pruned-caption"
              style={{
                fontSize: 12,
                color: "var(--text-muted)",
                paddingBottom: 4,
              }}
            >
              The run that produced this narrative is no longer in
              the retained window.
            </div>
          )}
          {runsQuery.isLoading && (
            <div
              data-testid="briefing-recent-runs-loading"
              style={{ fontSize: 12, color: "var(--text-muted)" }}
            >
              Loading recent runs…
            </div>
          )}
          {runsQuery.isError && !runsQuery.isLoading && (
            <div
              role="alert"
              data-testid="briefing-recent-runs-error"
              style={{ fontSize: 12, color: "var(--danger-text)" }}
            >
              Couldn't load recent runs. Try again.
            </div>
          )}
          {!runsQuery.isLoading && !runsQuery.isError && count === 0 && (
            <div
              data-testid="briefing-recent-runs-empty"
              style={{ fontSize: 12, color: "var(--text-muted)" }}
            >
              No briefing generations have run yet for this engagement.
            </div>
          )}
          {!runsQuery.isLoading && !runsQuery.isError && count > 0 && (
            <div
              role="group"
              aria-label="Filter recent runs"
              data-testid="briefing-recent-runs-filter"
              style={{
                display: "flex",
                gap: 4,
                paddingBottom: 4,
              }}
            >
              {(
                [
                  { key: "all", label: "All" },
                  { key: "failed", label: "Failed" },
                  { key: "invalid", label: "Has invalid citations" },
                ] as const
              ).map((opt) => {
                const active = filter === opt.key;
                const bucketCount = filterCounts[opt.key];
                return (
                  <button
                    key={opt.key}
                    type="button"
                    aria-pressed={active}
                    data-testid={`briefing-recent-runs-filter-${opt.key}`}
                    onClick={() => {
                      setFilter(opt.key);
                      // Collapse any expanded row that the new filter
                      // would hide so the disclosure doesn't keep an
                      // off-screen detail block "open" in state.
                      setExpandedRunId(null);
                    }}
                    style={{
                      fontSize: 11,
                      padding: "2px 8px",
                      borderRadius: 999,
                      border: "1px solid var(--border-subtle)",
                      background: active
                        ? "var(--surface-2, var(--accent-subtle, #eef))"
                        : "transparent",
                      color: active
                        ? "var(--text-default)"
                        : "var(--text-muted)",
                      cursor: "pointer",
                    }}
                  >
                    {opt.label}{" "}
                    {/*
                      Task #276 — render the matching-run count next to
                      each chip's label so an auditor can see at a glance
                      whether narrowing to that bucket would surface
                      anything (e.g. "Failed (0)" warns the auditor not
                      to bother clicking through to the empty-state).
                      The count tracks the same predicate the active
                      filter applies, so the displayed number always
                      matches the row count the auditor would see.
                    */}
                    <span
                      data-testid={`briefing-recent-runs-filter-${opt.key}-count`}
                      style={{ opacity: 0.7 }}
                    >
                      ({bucketCount})
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {count > 0 && visibleCount === 0 && (
            <div
              data-testid="briefing-recent-runs-filter-empty"
              style={{ fontSize: 12, color: "var(--text-muted)" }}
            >
              No runs match this filter.
            </div>
          )}
          {visibleCount > 0 && (
            <ul
              data-testid="briefing-recent-runs-list"
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              {visibleRuns.map((run) => {
                const isExpanded = expandedRunId === run.generationId;
                const isCurrent = run.generationId === currentGenerationId;
                // Task #280 — only the row whose interval contains
                // the prior backup's `generatedAt` gets the inline
                // prior body. Older rows (whose backups have already
                // been overwritten by newer regenerations) fall
                // through to the existing details branch with no
                // prior section block — the briefing row only
                // retains one snapshot, so we can't honestly surface
                // anything for them.
                const isPriorRow =
                  priorGenerationId !== null &&
                  run.generationId === priorGenerationId;
                const startedLabel = new Date(run.startedAt).toLocaleString();
                const detailAvailable =
                  (run.state === "failed" && !!run.error) ||
                  (run.state === "completed" &&
                    (run.invalidCitationCount ?? 0) > 0);
                return (
                  <li
                    key={run.generationId}
                    data-testid={`briefing-run-${run.generationId}`}
                    aria-current={isCurrent ? "true" : undefined}
                    style={{
                      // Task #263 — subtly highlight the row whose
                      // generation produced the narrative on screen
                      // so the comparison story ("here's what's on
                      // screen, and here's what was on screen
                      // before it") reads end-to-end. Use the same
                      // info accent the success badges already use
                      // so the highlight is visible without
                      // shouting; the explicit "Current" pill in
                      // the row header carries the meaning.
                      border: isCurrent
                        ? "1px solid var(--info-text)"
                        : "1px solid var(--border-subtle)",
                      borderRadius: 4,
                      background: isCurrent
                        ? "var(--info-dim)"
                        : "transparent",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedRunId((prev) =>
                          prev === run.generationId ? null : run.generationId,
                        )
                      }
                      aria-expanded={isExpanded}
                      data-testid={`briefing-run-toggle-${run.generationId}`}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 8px",
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 12,
                      }}
                    >
                      <BriefingRunStateBadge state={run.state} />
                      {isCurrent && (
                        <span
                          data-testid={`briefing-run-current-pill-${run.generationId}`}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            padding: "1px 6px",
                            borderRadius: 4,
                            background: "var(--info-text)",
                            color: "var(--bg-input, #fff)",
                            fontSize: 10,
                            fontWeight: 600,
                            letterSpacing: 0.2,
                            textTransform: "uppercase",
                            lineHeight: 1.4,
                          }}
                        >
                          Current
                        </span>
                      )}
                      {isPriorRow && (
                        // Task #280 — flag the row that produced
                        // what was on screen *before* the Current
                        // narrative so the side-by-side comparison
                        // story reads end-to-end. Same shape as
                        // the Current pill but in a muted accent
                        // so it never competes visually with
                        // "what is on screen right now".
                        <span
                          data-testid={`briefing-run-prior-pill-${run.generationId}`}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            padding: "1px 6px",
                            borderRadius: 4,
                            background: "var(--surface-2, var(--border-subtle))",
                            color: "var(--text-muted)",
                            fontSize: 10,
                            fontWeight: 600,
                            letterSpacing: 0.2,
                            textTransform: "uppercase",
                            lineHeight: 1.4,
                          }}
                        >
                          Prior
                        </span>
                      )}
                      <span style={{ flex: 1, color: "var(--text-default)" }}>
                        {startedLabel}
                      </span>
                      {run.state === "completed" &&
                        (run.invalidCitationCount ?? 0) > 0 && (
                          <span
                            data-testid={`briefing-run-invalid-count-${run.generationId}`}
                            style={{
                              fontSize: 11,
                              color: "var(--warning-text)",
                            }}
                          >
                            {run.invalidCitationCount} invalid citation
                            {run.invalidCitationCount === 1 ? "" : "s"}
                          </span>
                        )}
                      <span
                        aria-hidden
                        style={{ fontSize: 11, color: "var(--text-muted)" }}
                      >
                        {isExpanded ? "▾" : "▸"}
                      </span>
                    </button>
                    {isExpanded && (
                      <div
                        data-testid={`briefing-run-details-${run.generationId}`}
                        style={{
                          padding: "0 8px 8px 8px",
                          fontSize: 12,
                          color: "var(--text-muted)",
                          display: "flex",
                          flexDirection: "column",
                          gap: 2,
                        }}
                      >
                        <div>
                          Started: {new Date(run.startedAt).toLocaleString()}
                        </div>
                        <div>
                          Completed:{" "}
                          {run.completedAt
                            ? new Date(run.completedAt).toLocaleString()
                            : "—"}
                        </div>
                        {run.state === "failed" && (
                          <div
                            data-testid={`briefing-run-error-${run.generationId}`}
                            style={{ color: "var(--danger-text)" }}
                          >
                            Error: {run.error ?? "Unknown error"}
                          </div>
                        )}
                        {run.state === "completed" && (
                          <div
                            data-testid={`briefing-run-invalid-detail-${run.generationId}`}
                          >
                            Invalid citations:{" "}
                            {run.invalidCitationCount ?? 0}
                          </div>
                        )}
                        {!detailAvailable && run.state === "pending" && (
                          <div>Generation in progress…</div>
                        )}
                        {isPriorRow && priorNarrative && (
                          // Task #280 — render the seven A–G section
                          // bodies the briefing held *before* its
                          // current narrative was written. Only
                          // mounted on the Prior row (the one whose
                          // [startedAt, completedAt] interval
                          // contains the backup's `generatedAt`),
                          // so older rows whose backups have already
                          // been overwritten don't get a misleading
                          // "this is the prior body" block. The
                          // Current row never reaches this branch
                          // either — its narrative is already
                          // rendered above the disclosure, so
                          // duplicating it here would be noise.
                          //
                          // Task #355 — the title row, "Generated
                          // <when> by <actor>" meta line, and "Copy
                          // plain text" button (with its 2 s
                          // "Copied!" confirmation) live in
                          // `@workspace/briefing-prior-snapshot` so
                          // the testids, copy payload shape, and
                          // revert timing stay byte-identical with
                          // the Plan Review surface without copy-
                          // pasting two parallel JSX subtrees. The
                          // per-section diff below is panel-render-
                          // specific and stays inline.
                          //
                          // Task #303 B.5 — per-section word-level
                          // diff vs the current narrative, rendered
                          // with strikethrough for tokens the new
                          // run dropped and underline for tokens
                          // it inserted. When the section is
                          // identical the renderer falls through
                          // to a "(unchanged)" pill so the
                          // auditor isn't asked to re-read
                          // identical paragraphs.
                          <div
                            data-testid={`briefing-run-prior-narrative-${run.generationId}`}
                            style={{
                              marginTop: 6,
                              display: "flex",
                              flexDirection: "column",
                              gap: 4,
                              borderTop: "1px solid var(--border-subtle)",
                              paddingTop: 6,
                            }}
                          >
                            <BriefingPriorSnapshotHeader
                              runGenerationId={run.generationId}
                              priorNarrative={priorNarrative}
                            />
                            <BriefingPriorNarrativeDiff
                              runGenerationId={run.generationId}
                              priorNarrative={priorNarrative}
                              currentNarrative={currentNarrative}
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function SiteContextTab({
  engagement,
}: {
  engagement: EngagementDetailType;
}) {
  const engagementId = engagement.id;
  const [uploadOpen, setUploadOpen] = useState(false);
  const briefingQuery = useGetEngagementBriefing(engagementId);
  const queryClient = useQueryClient();

  // Pre-flight pilot eligibility from the cached engagement record
  // (Task #189). Today the architect has to click "Generate Layers"
  // before the empty-pilot 422 reveals that the jurisdiction is not
  // in the pilot — which costs them an avoidable round-trip and a
  // confusing "loading…" pulse on every out-of-pilot project.
  //
  // The same `appliesTo` gate the server runs is exposed by
  // `@workspace/adapters/eligibility` so the FE pre-flight cannot
  // disagree with the server's 422 — adding a new pilot jurisdiction
  // flips both surfaces from a single registry edit. The resolver
  // accepts the same site-context columns the server route reads, so
  // an engagement that resolves to "out of pilot" here resolves the
  // same on POST.
  //
  // We deliberately do NOT pre-flight while the engagement is still
  // loading; the parent's react-query hook resolves before
  // SiteContextTab is mounted (the parent gates the whole subtree on
  // `engagement` being defined), so by the time we read the columns
  // here they have their final values.
  const eligibility = useMemo(() => {
    const geocode = engagement.site?.geocode ?? null;
    const jurisdiction = resolveJurisdiction({
      jurisdictionCity: geocode?.jurisdictionCity ?? null,
      jurisdictionState: geocode?.jurisdictionState ?? null,
      jurisdiction: engagement.jurisdiction ?? null,
      address: engagement.address ?? null,
    });
    // Build the same context shape the server constructs in
    // `generateLayers.ts` — `appliesTo` only consults
    // `ctx.jurisdiction` today but mirroring the parcel field keeps
    // a future appliesTo that wants coords from silently mis-gating
    // (NaN coords match the route's "no geocode" branch exactly).
    const lat = geocode?.latitude ?? NaN;
    const lng = geocode?.longitude ?? NaN;
    const ctx: AdapterContext = {
      parcel: { latitude: lat, longitude: lng },
      jurisdiction,
    };
    const applicable = filterApplicableAdapters(ctx);
    return {
      isInPilot: applicable.length > 0,
      // Pre-computed message reuses the same helper the server's 422
      // envelope uses, so the proactive banner reads identically to
      // the post-click banner an architect on a half-resolved
      // engagement might still see if the address-level resolver
      // ever produces a different verdict than the column-level one.
      message: noApplicableAdaptersMessage(jurisdiction),
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
  const existingLayerKinds = useMemo(
    () => sources.map((s) => s.layerKind),
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
          <button
            type="button"
            className="sc-btn"
            onClick={() => generateMutation.mutate({ id: engagementId })}
            // Out-of-pilot engagements pre-empt the click entirely
            // (Task #189). The pre-flight already knows the server
            // would 422, so disabling the button removes the wasted
            // round-trip and the tooltip explains the dead-end
            // before the architect hovers over the banner below.
            disabled={generateMutation.isPending || !eligibility.isInPilot}
            data-testid="generate-layers-button"
            title={
              eligibility.isInPilot
                ? "Run every applicable federal/state/local adapter and persist the results as briefing sources."
                : eligibility.message
            }
          >
            {generateMutation.isPending ? "Generating…" : "Generate Layers"}
          </button>
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
            onClick={() =>
              generateMutation.mutate({
                id: engagementId,
                params: { forceRefresh: true },
              })
            }
            disabled={generateMutation.isPending}
            data-testid="generate-layers-force-refresh-button"
            title="Re-run every adapter live, bypassing the federal-adapter response cache for this one run."
            style={{
              fontSize: 12,
              color: "var(--text-link, var(--cyan, #06b6d4))",
              background: "transparent",
              border: "none",
              padding: "2px 4px",
              cursor: generateMutation.isPending ? "not-allowed" : "pointer",
              textDecoration: "underline",
              opacity: generateMutation.isPending ? 0.5 : 1,
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

        Task #189 additionally pulls the empty-pilot banner forward
        to pre-flight render via `eligibility.isInPilot`, so on a
        non-pilot project the disclosure here and the actionable
        banner below are *both* visible without the architect ever
        clicking Generate Layers.
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

      {!eligibility.isInPilot ||
      lastGenerateErrorSlug === "no_applicable_adapters" ? (
        // Distinct empty-pilot-jurisdiction banner. Originally this
        // branch only fired after the server's 422 round-trip
        // (Task #177); Task #189 pulls the same gate forward to
        // pre-flight render so an architect on a non-pilot project
        // sees the actionable upload-CTA before ever clicking
        // Generate Layers. The empty-pilot eligibility check shares
        // its `appliesTo` source-of-truth with `generateLayers.ts`
        // through `@workspace/adapters/eligibility`, so the FE pre-
        // flight cannot disagree with the server's 422 envelope.
        // The proactive path uses the locally-computed
        // `eligibility.message`; the post-error path prefers the
        // server-supplied `lastGenerateError` so a future server
        // tweak that wants to embed a richer hint (e.g. naming the
        // adapter set the missing jurisdiction would unlock) flows
        // through.
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
              No adapters configured for this jurisdiction yet
            </div>
            <div
              data-testid="generate-layers-no-adapters-message"
              style={{ color: "var(--text-secondary)" }}
            >
              {lastGenerateError ?? eligibility.message}
            </div>
            {/*
              Task #188 — surface the actual pilot list inline so an
              architect on a non-pilot project knows the dead-end is
              systemic (the Generate Layers run only covers the three
              jurisdictions below) rather than specific to their
              current engagement. The list is sourced from
              `@workspace/adapters` so the visible set tracks the
              server's `appliesTo` gate without a separate manual
              copy here.
            */}
            <div
              data-testid="generate-layers-no-adapters-supported"
              style={{ color: "var(--text-secondary)" }}
            >
              <span style={{ fontWeight: 600 }}>Currently supported:</span>{" "}
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
            }}
          >
            {lastGenerateError}
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
        <div
          data-testid="site-context-map-placeholder"
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
          Map view ships in DA-PI-2.
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            minHeight: 320,
            flex: 1,
          }}
        >
          <SiteContextViewer sources={sources} />
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

/**
 * DA-PI-5 / Spec 53 §3 — the "Push to Revit" affordance the
 * Site Context tab renders below the briefing-sources list.
 *
 * Surfaces three statuses driven by the `bim_models` row's
 * `materializedAt` vs the active briefing's `updatedAt` (computed
 * server-side and returned in `refreshStatus`):
 *
 *   - `not-pushed`  — neutral "Push to Revit" affordance. The first
 *     click creates the bim-model row.
 *   - `current`     — green "Materialized at <ts>" pill. The CTA
 *     becomes "Push again to Revit" so the architect can force a
 *     re-materialization (e.g. after deleting and re-uploading a
 *     QGIS layer that did not bump the briefing version yet).
 *   - `stale`       — amber "Briefing has changed since last push"
 *     warning. The CTA becomes the primary "Re-push to Revit"
 *     action.
 *
 * Disabled with a hint when no parcel briefing exists yet (the
 * server refuses the push without an active briefing — surfacing
 * the disabled state up front avoids the round-trip).
 */
export function PushToRevitAffordance({
  engagementId,
  hasBriefing,
}: {
  engagementId: string;
  hasBriefing: boolean;
}) {
  const queryClient = useQueryClient();
  const bimModelQuery = useGetEngagementBimModel(engagementId);
  const bimModelId = bimModelQuery.data?.bimModel?.id ?? null;
  // The `/refresh` route is the live source of truth — `/bim-model`
  // returns the row at fetch time, but the status / element-diff
  // payload the C# add-in uses to plan its next sync only ships from
  // `/refresh`. Mirroring that shape here keeps the affordance and
  // the add-in consistent (so an operator can read off "v3, 2 added,
  // 1 modified" and trust it matches what Revit will see).
  const refreshQuery = useGetBimModelRefresh(bimModelId ?? "", {
    query: {
      enabled: bimModelId !== null,
      queryKey: getGetBimModelRefreshQueryKey(bimModelId ?? ""),
    },
  });
  const pushMutation = usePushEngagementBimModel({
    mutation: {
      onSuccess: () => {
        // Re-fetch so the status pill flips from `not-pushed` /
        // `stale` to `current` and `materializedAt` updates without
        // an out-of-band poll. Also invalidate `/refresh` so the
        // diff counters reset to zero unchanged-only after a push.
        void queryClient.invalidateQueries({
          queryKey: getGetEngagementBimModelQueryKey(engagementId),
        });
        if (bimModelId !== null) {
          void queryClient.invalidateQueries({
            queryKey: getGetBimModelRefreshQueryKey(bimModelId),
          });
          // The divergence list lives on the same Site Context tab —
          // a re-push usually means the architect has just reconciled
          // their overrides, so closing the loop with a fresh fetch
          // keeps the panel honest. The route is cheap (single
          // indexed select) so an unconditional invalidation here is
          // simpler than threading the prior refreshStatus through.
          void queryClient.invalidateQueries({
            queryKey: getListBimModelDivergencesQueryKey(bimModelId),
          });
        }
      },
    },
  });

  // Prefer the refresh payload when available — it's the canonical
  // shape the add-in consumes — and fall back to the bim-model row
  // for the not-pushed / first-render case.
  const refreshStatus =
    refreshQuery.data?.refreshStatus ??
    bimModelQuery.data?.bimModel?.refreshStatus ??
    "not-pushed";
  const materializedAt =
    refreshQuery.data?.materializedAt ??
    bimModelQuery.data?.bimModel?.materializedAt ??
    null;
  const briefingVersion =
    refreshQuery.data?.briefingVersion ??
    bimModelQuery.data?.bimModel?.briefingVersion ??
    null;
  const diff = refreshQuery.data?.diff ?? null;

  const statusPalette = (() => {
    if (refreshStatus === "current") {
      return {
        bg: "var(--success-dim)",
        fg: "var(--success-text)",
        label: "Current",
      };
    }
    if (refreshStatus === "stale") {
      return {
        bg: "var(--warning-dim)",
        fg: "var(--warning-text)",
        label: "Stale",
      };
    }
    return {
      bg: "var(--info-dim)",
      fg: "var(--info-text)",
      label: "Not pushed",
    };
  })();

  const ctaLabel = (() => {
    if (refreshStatus === "stale") return "Re-push to Revit";
    if (refreshStatus === "current") return "Push again to Revit";
    return "Push to Revit";
  })();

  const explainer = (() => {
    if (!hasBriefing) {
      return "Upload a briefing source first — the briefing is what gets materialized.";
    }
    if (refreshStatus === "current" && materializedAt) {
      // Mirrors the relative-timestamp pattern used by the briefing
      // source rows above; a full ISO is shown in the title attribute
      // so an operator can hover for the precise instant. The "against
      // briefing v<n>" tail is the wording the code review asked for —
      // it lets an operator reading this card cross-reference the
      // materialization with the briefing version the C# add-in is
      // working against without opening DevTools.
      const versionTail =
        briefingVersion !== null ? ` against briefing v${briefingVersion}` : "";
      return `Materialized at ${formatRelativeMaterializedAt(materializedAt)}${versionTail}.`;
    }
    if (refreshStatus === "stale") {
      // Surface the per-element delta returned by `/refresh` so the
      // operator knows roughly how big the re-push will be before
      // they click. `addedCount + modifiedCount` matches what the
      // add-in will report once the architect re-runs the sync.
      const changes = diff
        ? ` (${diff.addedCount} added, ${diff.modifiedCount} modified)`
        : "";
      const tail =
        materializedAt && briefingVersion !== null
          ? ` Last materialized at ${formatRelativeMaterializedAt(
              materializedAt,
            )} against briefing v${briefingVersion}.`
          : "";
      return `The briefing has changed since the last push${changes}. Re-push to refresh the architect's Revit model.${tail}`;
    }
    return "Materializes the engagement's briefing into the architect's active Revit model.";
  })();

  const disabled =
    !hasBriefing || pushMutation.isPending || bimModelQuery.isLoading;

  return (
    <div
      className="sc-card"
      data-testid="push-to-revit-affordance"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 12,
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
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
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <div className="sc-medium">Push to Revit</div>
            <span
              data-testid="push-to-revit-status-badge"
              data-status={refreshStatus}
              title={
                materializedAt
                  ? new Date(materializedAt).toISOString()
                  : undefined
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "2px 8px",
                borderRadius: 999,
                background: statusPalette.bg,
                color: statusPalette.fg,
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: 0.2,
                textTransform: "uppercase",
                lineHeight: 1.4,
              }}
            >
              {statusPalette.label}
            </span>
          </div>
          <div
            style={{ fontSize: 12, color: "var(--text-muted)" }}
            data-testid="push-to-revit-explainer"
          >
            {explainer}
          </div>
        </div>
        <button
          type="button"
          className="sc-btn sc-btn-primary"
          disabled={disabled}
          onClick={() =>
            pushMutation.mutate({ id: engagementId, data: {} })
          }
          data-testid="push-to-revit-button"
          style={{ opacity: disabled ? 0.6 : 1 }}
        >
          {pushMutation.isPending ? "Pushing…" : ctaLabel}
        </button>
      </div>
      {pushMutation.isError && (
        <div
          role="alert"
          data-testid="push-to-revit-error"
          style={{
            fontSize: 12,
            color: "var(--danger-text)",
            background: "var(--danger-dim)",
            padding: 8,
            borderRadius: 4,
          }}
        >
          Failed to push to Revit. Try again in a moment.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
  // Briefing-divergences UI — DA-PI-5 / Spec 51a §2.2
  // ---------------------------------------------------------------------------
  // The presentational primitives (helpers, ResolvedByChip, the row /
  // group / panel components) live in @workspace/portal-ui as of Wave 2
  // Sprint B (Task #306) so the architect surface here and the read-
  // only reviewer surface in plan-review render the same recorded-
  // override audit trail without a copy/paste fork. The portal-ui
  // imports are pulled in at the top of this file alongside the other
  // shared symbols.
  //
  // design-tools owns the *architect-only* concerns layered on top:
  // the Resolve mutation + cache invalidation, surfaced as the
  // row's right-aligned action slot.

  /**
   * Architect-side wrapper around the presentational
   * {@link PortalBriefingDivergenceRow} from portal-ui. Supplies the
   * Resolve button (when the row is still Open), a "View details"
   * button that opens the per-divergence drill-in dialog (Task #320),
   * and the resolve-error toast — the three pieces that diverge from
   * the read-only reviewer surface in plan-review.
   *
   * Uses `row.bimModelId` directly for the mutation + cache key so
   * the wrapper stays pure (no engagement-id prop drilling) and a
   * row's bim-model scope is always the source of truth.
   *
   * `onViewDetails` is hoisted to the parent panel so a single
   * dialog can be rendered alongside the list (mirrors the plan-
   * review pattern in `BimModelTab.tsx`) instead of mounting one
   * dialog per row.
   */
  function ArchitectBriefingDivergenceRow({
    row,
    onViewDetails,
  }: {
    row: BimModelDivergenceListEntry;
    onViewDetails: (row: BimModelDivergenceListEntry) => void;
  }) {
    const queryClient = useQueryClient();
    const isResolved = row.resolvedAt != null;
    const resolveMutation = useResolveBimModelDivergence({
      mutation: {
        onSuccess: () => {
          // Invalidate the *list* query so the row physically moves
          // from Open into Resolved without splicing the cache by hand.
          void queryClient.invalidateQueries({
            queryKey: getListBimModelDivergencesQueryKey(row.bimModelId),
          });
        },
      },
    });
    const viewDetailsButton = (
      <button
        type="button"
        data-testid="briefing-divergences-view-details-button"
        data-divergence-id={row.id}
        onClick={() => onViewDetails(row)}
        style={{
          all: "unset",
          cursor: "pointer",
          padding: "3px 10px",
          borderRadius: 4,
          fontSize: 11,
          fontWeight: 600,
          background: "var(--bg-default)",
          color: "var(--text-default)",
          border: "1px solid var(--border-default)",
        }}
      >
        View details
      </button>
    );
    return (
      <PortalBriefingDivergenceRow
        row={row}
        rightSlot={
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {viewDetailsButton}
            {!isResolved && (
              <button
                type="button"
                data-testid="briefing-divergences-resolve-button"
                disabled={resolveMutation.isPending}
                onClick={() =>
                  resolveMutation.mutate({
                    id: row.bimModelId,
                    divergenceId: row.id,
                  })
                }
                style={{
                  all: "unset",
                  cursor: resolveMutation.isPending ? "wait" : "pointer",
                  padding: "3px 10px",
                  borderRadius: 4,
                  fontSize: 11,
                  fontWeight: 600,
                  background: "var(--bg-default)",
                  color: "var(--text-default)",
                  border: "1px solid var(--border-default)",
                  opacity: resolveMutation.isPending ? 0.6 : 1,
                }}
              >
                {resolveMutation.isPending ? "Resolving…" : "Resolve"}
              </button>
            )}
          </div>
        }
        errorSlot={
          resolveMutation.isError ? (
            <div
              role="alert"
              data-testid="briefing-divergences-resolve-error"
              style={{
                fontSize: 11,
                color: "var(--danger-text)",
              }}
            >
              Couldn't mark as resolved. Try again in a moment.
            </div>
          ) : null
        }
      />
    );
  }

  /**
   * Architect-flavored wrapper around the shared
   * {@link PortalBriefingDivergencesPanel} from portal-ui. Wires the
   * panel's per-row render slot to {@link ArchitectBriefingDivergenceRow}
   * so each Open row gets a Resolve button, and owns the
   * `activeDivergence` state that drives the shared
   * {@link BriefingDivergenceDetailDialog} drill-in (Task #320) so
   * architects can inspect a recorded override before resolving
   * without leaving the engagement page. Keeps the architect-facing
   * panel header copy unchanged. Re-exported so existing tests
   * (`artifacts/design-tools/src/pages/__tests__/BriefingDivergencesPanel.test.tsx`)
   * keep importing `BriefingDivergencesPanel` from this module.
   */
  export function BriefingDivergencesPanel({
    engagementId,
  }: {
    engagementId: string;
  }) {
    const [activeDivergence, setActiveDivergence] =
      useState<BimModelDivergenceListEntry | null>(null);
    return (
      <>
        <PortalBriefingDivergencesPanel
          engagementId={engagementId}
          renderRow={(row) => (
            <ArchitectBriefingDivergenceRow
              key={row.id}
              row={row}
              onViewDetails={setActiveDivergence}
            />
          )}
        />
        <BriefingDivergenceDetailDialog
          divergence={activeDivergence}
          onClose={() => setActiveDivergence(null)}
        />
      </>
    );
  }
  

/**
 * Human-readable label for each {@link SubmissionStatus}. Kept in
 * lock-step with the matching map in
 * `artifacts/plan-review/src/pages/EngagementDetail.tsx` so the two
 * surfaces render identical badge text.
 */
const SUBMISSION_STATUS_LABELS: Record<SubmissionStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  corrections_requested: "Corrections requested",
  rejected: "Rejected",
};

/**
 * Per-status badge palette, keyed off the shared SmartCity theme
 * tokens (see `lib/portal-ui/src/styles/smartcity-themes.css`) so the
 * pill picks up the correct dark/light contrast automatically and
 * mirrors the plan-review engagement page's reviewer badge.
 */
const SUBMISSION_STATUS_COLORS: Record<
  SubmissionStatus,
  { bg: string; fg: string }
> = {
  pending: { bg: "var(--info-dim)", fg: "var(--info-text)" },
  approved: { bg: "var(--success-dim)", fg: "var(--success-text)" },
  corrections_requested: {
    bg: "var(--warning-dim)",
    fg: "var(--warning-text)",
  },
  rejected: { bg: "var(--danger-dim)", fg: "var(--danger-text)" },
};

function SubmissionStatusBadge({ status }: { status: SubmissionStatus }) {
  // Defensive narrowing: a forward-compat status value the FE has not
  // shipped a label for yet falls back to the raw enum string so the
  // UI degrades gracefully instead of rendering an empty pill.
  const label = SUBMISSION_STATUS_LABELS[status] ?? status;
  const palette =
    SUBMISSION_STATUS_COLORS[status] ?? SUBMISSION_STATUS_COLORS.pending;
  return (
    <span
      data-testid={`submission-status-badge-${status}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: 999,
        background: palette.bg,
        color: palette.fg,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.2,
        textTransform: "uppercase",
        lineHeight: 1.4,
      }}
    >
      {label}
    </span>
  );
}

/**
 * Submissions tab — surfaces the engagement's prior plan-review
 * submissions (Task #75) and lets a reviewer record the
 * jurisdiction's reply against any row (Task #85).
 *
 * Reads from `GET /api/engagements/:id/submissions` (newest-first)
 * and renders each row with the captured jurisdiction label, the
 * submitted-at relative timestamp, the response status badge, the
 * optional reviewer comment + responded-at timestamp, and the
 * original outbound note. The visual layout mirrors `SubmissionRow`
 * in `artifacts/plan-review/src/pages/EngagementDetail.tsx` so the
 * two surfaces stay consistent. Each row carries a "Record response"
 * action that opens `RecordSubmissionResponseDialog`.
 *
 * `EngagementSubmissionSummary` now carries `status`,
 * `reviewerComment`, and `respondedAt` directly (Task #102's sister
 * task on the API side already shipped). We still keep a local map
 * of just-recorded responses keyed by submission id so the row
 * reflects a freshly-saved reply *before* the listing query
 * refetches; the resolver below prefers the local mirror when
 * present and falls through to the row payload otherwise.
 *
 * Pagination is still a follow-up: engagements typically accumulate
 * a handful of packages, so a bare array is fine for now.
 */
/**
 * Pill control for the engagement-timeline backfill filter (Task
 * #124). Renders the three modes — All / Backfilled / Live — as a
 * radiogroup so screen readers announce the selection model
 * correctly. Visual styling intentionally mirrors the chips already
 * used elsewhere in the design-tools UI (small, rounded, cyan when
 * selected) so the affordance reads as familiar at a glance.
 */
function BackfillFilterChips({
  value,
  onChange,
}: {
  value: BackfillFilter;
  onChange: (next: BackfillFilter) => void;
}) {
  const options: Array<{ id: BackfillFilter; label: string }> = [
    { id: "all", label: "All" },
    { id: "backfilled", label: "Backfilled" },
    { id: "live", label: "Live" },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Filter replies by backfill"
      data-testid="submissions-backfill-filter"
      style={{ display: "inline-flex", gap: 4 }}
    >
      {options.map((opt) => {
        const isActive = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={isActive}
            data-testid={`submissions-backfill-filter-${opt.id}`}
            onClick={() => onChange(opt.id)}
            style={{
              padding: "2px 10px",
              borderRadius: 999,
              fontSize: 11,
              fontFamily: "Inter, sans-serif",
              letterSpacing: 0.2,
              cursor: "pointer",
              border: "1px solid",
              borderColor: isActive
                ? "var(--cyan-accent-border)"
                : "var(--border-default)",
              background: isActive
                ? "var(--cyan-accent-bg)"
                : "transparent",
              color: isActive ? "var(--cyan)" : "var(--text-secondary)",
              transition: "color 0.12s, background 0.12s, border-color 0.12s",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function SubmissionsTab({
  engagementId,
  backfillFilter,
  onBackfillFilterChange,
  onOpenSubmission,
}: {
  engagementId: string;
  /**
   * Active backfill filter (Task #124). Lifted to the parent page so
   * the URL param survives tab switches and the chip selection
   * round-trips through `?reply=…` deep links.
   */
  backfillFilter: BackfillFilter;
  onBackfillFilterChange: (next: BackfillFilter) => void;
  /**
   * Open the per-submission detail modal. Lifted to the parent so the
   * modal lives once per engagement page (rather than once per row)
   * and the active selection survives a tab switch.
   */
  onOpenSubmission: (submissionId: string) => void;
}) {
  const { data: submissions, isLoading } = useListEngagementSubmissions(
    engagementId,
    {
      query: {
        enabled: !!engagementId,
        queryKey: getListEngagementSubmissionsQueryKey(engagementId),
      },
    },
  );

  // `responseDialogFor` holds the submission id whose response form
  // is currently open (null when no dialog is mounted). Stored as the
  // id rather than the row so a refetch that reorders the list still
  // resolves the dialog target by id.
  const [responseDialogFor, setResponseDialogFor] = useState<string | null>(
    null,
  );
  // Local mirror of just-recorded responses, keyed by submission id.
  // See the doc comment above for why this is here and when it
  // becomes removable.
  const [recordedResponses, setRecordedResponses] = useState<
    Record<string, SubmissionResponse>
  >({});

  // Reset the local mirror whenever the engagement changes so a
  // recorded response on engagement A doesn't carry over into a row
  // on engagement B that happens to share an id (it can't in
  // practice — submission ids are uuids — but the cleanup keeps the
  // map bounded for long-lived sessions).
  useEffect(() => {
    setRecordedResponses({});
    setResponseDialogFor(null);
  }, [engagementId]);

  // Reconcile the local mirror against the listing query: once the
  // server-side row reflects the recorded response (status + comment
  // + respondedAt all agree), drop the local entry so an out-of-band
  // edit on another tab doesn't get permanently shadowed by a stale
  // optimistic value. Done in a layout-style effect so the prune
  // happens before paint and avoids a no-op re-render.
  useEffect(() => {
    if (!submissions) return;
    setRecordedResponses((prev) => {
      const ids = Object.keys(prev);
      if (ids.length === 0) return prev;
      let changed = false;
      const next = { ...prev };
      for (const id of ids) {
        const local = prev[id];
        const row = submissions.find((s) => s.id === id);
        if (
          row &&
          row.status === local.status &&
          row.reviewerComment === local.reviewerComment &&
          row.respondedAt === local.respondedAt
        ) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [submissions]);

  const dialogTarget =
    responseDialogFor && submissions
      ? (submissions.find((s) => s.id === responseDialogFor) ?? null)
      : null;

  // Resolve the timeline rows once: local optimistic mirror wins
  // over the listing query so a freshly-recorded reply is bucketed
  // by its new state, not the stale "pending" snapshot the server
  // still returns until the next refetch. Both the chip filter
  // (Task #124) and the live/backfilled/pending tally line above
  // the timeline (Task #136) consume this same resolved view, so
  // they can never disagree.
  const resolvedSubmissions = useMemo(() => {
    if (!submissions) return [];
    return submissions.map((s) => {
      const local = recordedResponses[s.id] ?? null;
      return {
        row: s,
        respondedAt: local?.respondedAt ?? s.respondedAt,
        responseRecordedAt:
          local?.responseRecordedAt ?? s.responseRecordedAt,
      };
    });
  }, [submissions, recordedResponses]);

  const visibleSubmissions = useMemo(
    () =>
      resolvedSubmissions
        .filter((r) =>
          matchesBackfillFilter(
            backfillFilter,
            r.respondedAt,
            r.responseRecordedAt,
          ),
        )
        .map((r) => r.row),
    [resolvedSubmissions, backfillFilter],
  );

  // Header tally — driven off the same resolved view so optimistic
  // recordings move out of the "pending" bucket the moment the user
  // submits the dialog, mirroring the chip filter's behaviour.
  const submissionTallies = useMemo(
    () => summarizeBackfillTallies(resolvedSubmissions),
    [resolvedSubmissions],
  );

  if (isLoading) {
    return (
      <div
        className="sc-card p-6 text-center"
        data-testid="submissions-loading"
      >
        <div className="sc-body opacity-60">Loading submissions…</div>
      </div>
    );
  }

  if (!submissions || submissions.length === 0) {
    return (
      <div
        className="sc-card p-6 text-center"
        data-testid="submissions-empty"
      >
        <div className="sc-prose opacity-70" style={{ maxWidth: 480 }}>
          No submissions yet. Once you click <strong>Submit to
          jurisdiction</strong> above, the package will appear here.
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="sc-card flex flex-col" data-testid="submissions-list">
        <div className="sc-card-header sc-row-sb">
          <div
            style={{ display: "flex", flexDirection: "column", gap: 4 }}
          >
            <span className="sc-label">PAST SUBMISSIONS</span>
            {/*
              Compact "live · backfilled · pending" tally (Task #136).
              Lets auditors gauge whether a deeper review is warranted
              without having to click through each chip — the counts
              are a partition of the engagement's full timeline and
              react to optimistic local updates the same way the
              chip filter does (both consume `resolvedSubmissions`).
            */}
            <span
              className="sc-meta"
              data-testid="submissions-tally"
              style={{ opacity: 0.7 }}
            >
              {formatBackfillTally(submissionTallies)}
            </span>
          </div>
          <div
            style={{ display: "flex", alignItems: "center", gap: 12 }}
          >
            <BackfillFilterChips
              value={backfillFilter}
              onChange={onBackfillFilterChange}
            />
            <span className="sc-meta" data-testid="submissions-count">
              {backfillFilter === "all"
                ? `${submissions.length} total`
                : `${visibleSubmissions.length} of ${submissions.length}`}
            </span>
          </div>
        </div>
        <div className="flex flex-col">
          {visibleSubmissions.length === 0 && (
            <div
              className="p-6 text-center"
              data-testid="submissions-filter-empty"
            >
              <div className="sc-prose opacity-70" style={{ maxWidth: 420, margin: "0 auto" }}>
                No {backfillFilter === "backfilled" ? "backfilled" : "live"}{" "}
                replies match this filter.
              </div>
            </div>
          )}
          {visibleSubmissions.map((s: EngagementSubmissionSummary) => {
            // The OpenAPI contract guarantees `status` is always
            // present on the row; reviewer comment, respondedAt, and
            // responseRecordedAt remain optional. We still consult the
            // local mirror so a just-recorded reply renders
            // immediately, before the listing query refetches.
            const localResponse = recordedResponses[s.id] ?? null;
            const status: SubmissionStatus =
              localResponse?.status ?? s.status;
            const reviewerComment: string | null =
              localResponse?.reviewerComment ?? s.reviewerComment;
            const respondedAt: string | null =
              localResponse?.respondedAt ?? s.respondedAt;
            // `responseRecordedAt` is the wall-clock instant the
            // server stamped this reply (Task #106). Pair it with
            // `respondedAt` to surface a "backfilled on" annotation
            // when the user-picked reply date is meaningfully earlier
            // than the recording event.
            const responseRecordedAt: string | null =
              localResponse?.responseRecordedAt ?? s.responseRecordedAt;
            const backfillNote = backfillAnnotation(
              respondedAt,
              responseRecordedAt,
            );
            const hasResponse = status !== "pending" && respondedAt != null;
            return (
              // Row container is a `<div role="button">` rather than a
              // `<button>` because the row hosts an inner "Record
              // response" `<button>` (Task #85) and HTML disallows
              // nested interactive buttons. Clicking the row opens the
              // per-submission detail modal (Task #84); the inner
              // button stops propagation so its own action runs without
              // also opening the modal.
              <div
                key={s.id}
                className="sc-card-row sc-card-clickable"
                data-testid={`submission-row-${s.id}`}
                role="button"
                tabIndex={0}
                onClick={() => onOpenSubmission(s.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpenSubmission(s.id);
                  }
                }}
                aria-label={`Open submission to ${
                  s.jurisdiction ?? "jurisdiction not recorded"
                }`}
                style={{
                  padding: "12px 16px",
                  borderBottom: "1px solid var(--border-default)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  cursor: "pointer",
                }}
              >
                <div
                  className="sc-row-sb"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    <span
                      className="sc-medium"
                      style={{
                        color: "var(--text-primary)",
                        fontSize: 13,
                      }}
                    >
                      {s.jurisdiction ?? "Jurisdiction not recorded"}
                    </span>
                    <span
                      data-testid={`submission-status-${s.id}`}
                      style={{ display: "inline-flex" }}
                    >
                      <SubmissionStatusBadge status={status} />
                    </span>
                    <span
                      className="sc-meta"
                      title={new Date(s.submittedAt).toLocaleString()}
                      style={{
                        color: "var(--text-secondary)",
                        fontSize: 11,
                      }}
                    >
                      {relativeTime(s.submittedAt)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="sc-btn-ghost"
                    onClick={(e) => {
                      // Prevent the row click from also opening the
                      // detail modal — this button has its own action.
                      e.stopPropagation();
                      setResponseDialogFor(s.id);
                    }}
                    data-testid={`submission-record-response-${s.id}`}
                    style={{ padding: "2px 10px", fontSize: 12 }}
                  >
                    {status === "pending"
                      ? "Record response"
                      : "Update response"}
                  </button>
                </div>
                {hasResponse && (
                  <div
                    data-testid={`submission-response-${s.id}`}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                    }}
                  >
                    {reviewerComment && (
                      <ReviewerComment
                        submissionId={s.id}
                        comment={reviewerComment}
                      />
                    )}
                    <span
                      className="sc-meta"
                      data-testid={`submission-responded-at-${s.id}`}
                      title={new Date(respondedAt!).toLocaleString()}
                      style={{
                        color: "var(--text-secondary)",
                        fontSize: 11,
                      }}
                    >
                      Responded {relativeTime(respondedAt)}
                    </span>
                    {backfillNote && (
                      <span
                        className="sc-meta"
                        data-testid={`submission-backfill-${s.id}`}
                        title={
                          responseRecordedAt
                            ? new Date(responseRecordedAt).toLocaleString()
                            : undefined
                        }
                        style={{
                          color: "var(--text-secondary)",
                          fontSize: 11,
                          fontStyle: "italic",
                        }}
                      >
                        {backfillNote}
                      </span>
                    )}
                  </div>
                )}
                {s.note && (
                  <div
                    className="sc-body"
                    data-testid={`submission-note-${s.id}`}
                    style={{
                      color: "var(--text-secondary)",
                      fontSize: 12,
                      whiteSpace: "pre-wrap",
                      // The list note is intentionally clamped — the
                      // full note is available in the per-submission
                      // detail modal that opens on click.
                      display: "-webkit-box",
                      WebkitBoxOrient: "vertical",
                      WebkitLineClamp: 2,
                      overflow: "hidden",
                    }}
                  >
                    {s.note}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {dialogTarget && (
        <RecordSubmissionResponseDialog
          engagementId={engagementId}
          submissionId={dialogTarget.id}
          jurisdiction={dialogTarget.jurisdiction}
          // Pass the row's `submittedAt` so the dialog can mirror the
          // server's lower-bound guard (Task #119) and surface the
          // problem inline before the request goes out.
          submittedAt={dialogTarget.submittedAt}
          isOpen={true}
          onClose={() => setResponseDialogFor(null)}
          onRecorded={(response) => {
            setRecordedResponses((prev) => ({
              ...prev,
              [response.id]: response,
            }));
          }}
        />
      )}
    </>
  );
}

export function EngagementDetail() {
  const params = useParams();
  const id = params.id as string;
  const [jsonExpanded, setJsonExpanded] = useState(true);
  // Initialize tab from `?tab=…` so deep links land on the right tab
  // without a flicker. Sync on every change via `setTabAndSyncUrl`
  // (defined below) — we deliberately do NOT subscribe to `popstate`,
  // matching DevAtoms.tsx's exploratory-page convention. If a future
  // sprint needs back-button-aware tabs, it can wrap this state in a
  // `useSyncExternalStore` against `popstate`.
  const [tab, setTabState] = useState<TabId>(() => readTabFromUrl());
  const setTab = (next: TabId): void => {
    setTabState(next);
    writeTabToUrl(next);
  };
  // Backfill filter (Task #124) for the engagement timeline of past
  // submissions. Lifted to the page so the URL param survives tab
  // switches and so the same setter pattern as `tab` keeps the URL
  // and React state in lock-step on every change.
  const [backfillFilter, setBackfillFilterState] = useState<BackfillFilter>(
    () => readBackfillFilterFromUrl(),
  );
  const setBackfillFilter = (next: BackfillFilter): void => {
    setBackfillFilterState(next);
    writeBackfillFilterToUrl(next);
  };
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"intake" | "edit">("edit");
  const [submitOpen, setSubmitOpen] = useState(false);
  // Last successful jurisdiction submission, surfaced as a non-blocking
  // confirmation banner above the engagement header. We keep the full
  // receipt (not just `submittedAt`) so a future "View on timeline"
  // affordance can deep-link by `submissionId` without another round trip.
  // The jurisdiction string is snapshotted alongside the receipt so the
  // banner copy reflects what the user actually submitted to even if a
  // background refetch updates `engagement.jurisdiction` between submit
  // and dismiss — mirroring the pattern Plan Review uses.
  const [lastSubmission, setLastSubmission] = useState<{
    receipt: SubmissionReceipt;
    jurisdiction: string | null;
  } | null>(null);
  // Currently-open submission detail modal (Task #84). `null` ==
  // closed; a string is the submission id whose ContextSummary the
  // modal should fetch. Lifted to the page so the same modal instance
  // serves the Submissions tab today and any other surface (chat
  // inline reference, banner deep-link) that wants to open the same
  // detail view tomorrow.
  const [openSubmissionId, setOpenSubmissionId] = useState<string | null>(
    null,
  );
  // Auto-dismiss the banner after 8s so it stays out of the way once
  // the user has seen it. The dialog itself already closed on success,
  // so the banner is the only remaining post-submit affordance. Within
  // an 8s window the relative-time label is always "just now", so no
  // tick interval is needed to keep it fresh.
  useEffect(() => {
    if (!lastSubmission) return;
    const dismiss = window.setTimeout(() => {
      setLastSubmission(null);
    }, 8_000);
    return () => {
      window.clearTimeout(dismiss);
    };
  }, [lastSubmission]);

  const { data: engagement } = useGetEngagement(id, {
    query: {
      enabled: !!id,
      queryKey: getGetEngagementQueryKey(id),
      refetchInterval: 5000,
    },
  });

  const selectedSnapshotIdByEngagement = useEngagementsStore(
    (s) => s.selectedSnapshotIdByEngagement,
  );
  const selectSnapshot = useEngagementsStore((s) => s.selectSnapshot);
  const attachSheet = useEngagementsStore((s) => s.attachSheet);
  const setPendingChatInput = useEngagementsStore(
    (s) => s.setPendingChatInput,
  );
  const rightCollapsed = useSidebarState((s) => s.rightCollapsed);
  const toggleRight = useSidebarState((s) => s.toggleRight);

  const handleAskClaudeAboutSheet = (sheet: SheetSummary) => {
    attachSheet(id, sheet);
    setPendingChatInput(
      id,
      `What is shown on sheet ${sheet.sheetNumber} (${sheet.sheetName})?`,
    );
    if (rightCollapsed) toggleRight();
  };

  const explicitlySelected = selectedSnapshotIdByEngagement[id] ?? null;
  const defaultSelected = engagement?.snapshots?.[0]?.id ?? null;
  const selectedSnapshotId = explicitlySelected ?? defaultSelected;

  // Auto-pin most-recent on first load so manual selection sticks
  useEffect(() => {
    if (
      explicitlySelected === null &&
      defaultSelected &&
      !(id in selectedSnapshotIdByEngagement)
    ) {
      selectSnapshot(id, defaultSelected);
    }
  }, [
    id,
    defaultSelected,
    explicitlySelected,
    selectedSnapshotIdByEngagement,
    selectSnapshot,
  ]);

  // Intake mode: open modal automatically the first time we see an
  // engagement without an address, unless the user has dismissed it.
  // We use a ref so we don't keep re-opening it after the user closes
  // the modal (e.g. via Save in edit mode while the engagement query
  // hasn't refetched yet).
  const intakeStorageKey = useMemo(
    () => (id ? `engagement-intake-skipped:${id}` : ""),
    [id],
  );
  const intakeShownForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!engagement || !intakeStorageKey) return;
    if (engagement.address && engagement.address.trim().length > 0) return;
    if (intakeShownForRef.current === engagement.id) return;
    try {
      if (localStorage.getItem(intakeStorageKey)) return;
    } catch {
      /* ignore */
    }
    intakeShownForRef.current = engagement.id;
    setModalMode("intake");
    setModalOpen(true);
  }, [engagement, intakeStorageKey]);

  const { data: snapshotDetail } = useGetSnapshot(selectedSnapshotId ?? "", {
    query: {
      enabled: !!selectedSnapshotId,
      queryKey: getGetSnapshotQueryKey(selectedSnapshotId ?? ""),
    },
  });

  if (!engagement) {
    return (
      <AppShell title="Loading…">
        <div className="sc-prose opacity-60">Loading engagement…</div>
      </AppShell>
    );
  }

  const snapshots = engagement.snapshots ?? [];
  const hasSnapshots = snapshots.length > 0;
  const captured = snapshotDetail
    ? `from snapshot ${relativeTime(snapshotDetail.receivedAt)}`
    : undefined;

  const openEdit = () => {
    setModalMode("edit");
    setModalOpen(true);
  };

  const handleIntakeSkip = () => {
    try {
      localStorage.setItem(intakeStorageKey, "1");
    } catch {
      /* ignore */
    }
  };

  // Whenever the modal closes after intake mode (whether saved, skipped, or
  // dismissed), record that we've handled intake so a page refresh doesn't
  // re-prompt. The Skip button does this immediately; for Save & continue
  // we set the same key here so the prompt is always one-shot per browser.
  const handleModalClose = () => {
    if (modalMode === "intake") {
      try {
        localStorage.setItem(intakeStorageKey, "1");
      } catch {
        /* ignore */
      }
    }
    setModalOpen(false);
  };

  return (
    <AppShell
      title={engagement.name}
      rightPanel={
        <ClaudeChat
          engagementId={id}
          hasSnapshots={hasSnapshots}
          snapshots={snapshots}
        />
      }
    >
      <div className="flex flex-col gap-5 h-full">
        {lastSubmission && (
          <SubmissionRecordedBanner
            submittedAt={lastSubmission.receipt.submittedAt}
            jurisdiction={lastSubmission.jurisdiction}
            onDismiss={() => setLastSubmission(null)}
          />
        )}
        <div className="flex items-center justify-between flex-shrink-0">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-3">
              <h2 className="text-[22px] m-0">{engagement.name}</h2>
              <StatusPill status={engagement.status} />
            </div>
            <div className="sc-meta opacity-70">
              {engagement.address ?? "No address set"}
              {engagement.jurisdiction ? ` · ${engagement.jurisdiction}` : ""}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/" className="sc-btn-ghost">
              ← Projects
            </Link>
            <button className="sc-btn-ghost" onClick={openEdit}>
              Edit details
            </button>
            <button
              type="button"
              className="sc-btn-primary"
              onClick={() => setSubmitOpen(true)}
              data-testid="submit-jurisdiction-trigger"
            >
              Submit to jurisdiction
            </button>
          </div>
        </div>

        {/*
          Wave 2 Sprint D / V1-2 — architect-side queue of pending
          reviewer-requests on this engagement. Mounted above TabBar
          so the queue is visible regardless of which tab is active.
          The component is self-hiding when the queue is empty.
        */}
        <ReviewerRequestsStrip engagementId={id} />

        <TabBar active={tab} onChange={setTab} />

        {tab === "snapshots" && (
          <>
            <div className="grid grid-cols-4 gap-3">
              <KpiTile
                label="SHEETS"
                value={snapshotDetail?.sheetCount}
                footnote={captured}
              />
              <KpiTile
                label="ROOMS"
                value={snapshotDetail?.roomCount}
                footnote={captured}
              />
              <KpiTile
                label="LEVELS"
                value={snapshotDetail?.levelCount}
                footnote={captured}
              />
              <KpiTile
                label="WALLS"
                value={snapshotDetail?.wallCount}
                footnote={captured}
              />
            </div>

            <div className="grid lg:grid-cols-3 gap-4 flex-1 min-h-0">
              <div className="sc-card flex flex-col col-span-1 min-h-0">
                <div className="sc-card-header sc-row-sb">
                  <span className="sc-label">SNAPSHOTS</span>
                  <span className="sc-meta">{snapshots.length}</span>
                </div>
                <div
                  className="flex-1 overflow-y-auto sc-scroll"
                  data-testid="engagement-snapshot-timeline"
                >
                  {!hasSnapshots ? (
                    <div className="p-4 sc-body text-center opacity-70">
                      No snapshots yet. Send one from Revit.
                    </div>
                  ) : (
                    snapshots.map((s) => {
                      const isSelected = s.id === selectedSnapshotId;
                      return (
                        <div
                          key={s.id}
                          data-testid={`snapshot-row-${s.id}`}
                          data-selected={isSelected ? "true" : "false"}
                          className={`sc-card-row sc-card-clickable flex flex-col ${
                            isSelected ? "sc-accent-cyan" : ""
                          }`}
                          style={{
                            background: isSelected
                              ? "var(--bg-highlight)"
                              : undefined,
                          }}
                          onClick={() => selectSnapshot(id, s.id)}
                        >
                          <div className="sc-medium">
                            {relativeTime(s.receivedAt)}
                          </div>
                          <div className="sc-meta mt-1">
                            {s.sheetCount ?? "—"}sh · {s.roomCount ?? "—"}rm ·{" "}
                            {s.levelCount ?? "—"}lv · {s.wallCount ?? "—"}w
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              <div className="col-span-2 min-h-0">
                {!hasSnapshots ? (
                  <div className="sc-card p-8 h-full flex items-center justify-center">
                    <div className="sc-prose text-center opacity-70">
                      No snapshots yet. Send one from Revit.
                    </div>
                  </div>
                ) : !snapshotDetail ? (
                  <div className="sc-card p-8 h-full flex items-center justify-center">
                    <div className="sc-prose opacity-60">Loading snapshot…</div>
                  </div>
                ) : (
                  <div className="sc-card flex flex-col h-full">
                    <div className="sc-card-header sc-row-sb">
                      <span className="sc-label">RAW JSON</span>
                      <button
                        className="sc-btn-sm"
                        onClick={() => setJsonExpanded(!jsonExpanded)}
                      >
                        {jsonExpanded ? "Collapse" : "Expand"}
                      </button>
                    </div>
                    {jsonExpanded && (
                      <div
                        className="flex-1 overflow-hidden"
                        style={{
                          borderTop: "1px solid var(--border-default)",
                        }}
                      >
                        <pre
                          className="sc-mono-sm sc-scroll m-0"
                          style={{
                            background: "var(--bg-input)",
                            padding: 12,
                            maxHeight: 600,
                            overflow: "auto",
                            whiteSpace: "pre-wrap",
                            wordWrap: "break-word",
                          }}
                        >
                          {JSON.stringify(snapshotDetail.payload, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {tab === "sheets" && (
          <SheetGrid
            snapshotId={selectedSnapshotId}
            onAskClaude={handleAskClaudeAboutSheet}
          />
        )}

        {tab === "site" && (
          <SiteTab engagement={engagement} onAddAddress={openEdit} />
        )}

        {tab === "site-context" && (
          <SiteContextTab engagement={engagement} />
        )}

        {tab === "submissions" && (
          <SubmissionsTab
            engagementId={engagement.id}
            backfillFilter={backfillFilter}
            onBackfillFilterChange={setBackfillFilter}
            onOpenSubmission={(sid) => setOpenSubmissionId(sid)}
          />
        )}

        {tab === "settings" && (
          <SettingsTab engagement={engagement} onEdit={openEdit} />
        )}
      </div>

      <EngagementDetailsModal
        engagement={engagement}
        isOpen={modalOpen}
        onClose={handleModalClose}
        mode={modalMode}
        onSkip={handleIntakeSkip}
      />

      <SubmitToJurisdictionDialog
        engagementId={engagement.id}
        engagementName={engagement.name}
        jurisdiction={engagement.jurisdiction}
        isOpen={submitOpen}
        onClose={() => setSubmitOpen(false)}
        onSubmitted={(receipt) =>
          setLastSubmission({
            receipt,
            jurisdiction: engagement.jurisdiction,
          })
        }
      />

      <SubmissionDetailModal
        submissionId={openSubmissionId}
        engagementId={engagement.id}
        onClose={() => setOpenSubmissionId(null)}
      />
    </AppShell>
  );
}
