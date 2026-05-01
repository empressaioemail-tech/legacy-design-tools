import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetEngagement,
  useGetEngagementBriefing,
  useGetSnapshot,
  useListEngagementBriefingSources,
  useListEngagementSubmissions,
  useRestoreEngagementBriefingSource,
  useRetryBriefingSourceConversion,
  useUpdateEngagement,
  getGetEngagementBriefingQueryKey,
  getGetEngagementQueryKey,
  getGetSnapshotQueryKey,
  getListEngagementBriefingSourcesQueryKey,
  getListEngagementsQueryKey,
  getListEngagementSubmissionsQueryKey,
  type EngagementBriefingSource,
  type EngagementDetail as EngagementDetailType,
  type EngagementSubmissionSummary,
  type SubmissionReceipt,
  type SubmissionResponse,
  type SubmissionStatus,
} from "@workspace/api-client-react";
import { SiteMap } from "@workspace/site-context/client";
import type { SheetSummary } from "@workspace/api-client-react";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { AppShell } from "../components/AppShell";
import { BriefingSourceUploadModal } from "../components/BriefingSourceUploadModal";
import { SiteContextViewer } from "../components/SiteContextViewer";
import { ClaudeChat } from "../components/ClaudeChat";
import { EngagementDetailsModal } from "../components/EngagementDetailsModal";
import { RecordSubmissionResponseDialog } from "../components/RecordSubmissionResponseDialog";
import { RevitBinding } from "../components/RevitBinding";
import { SheetGrid } from "../components/SheetGrid";
import { SubmissionDetailModal } from "../components/SubmissionDetailModal";
import {
  ReviewerComment,
  SubmissionRecordedBanner,
  SubmitToJurisdictionDialog,
} from "@workspace/portal-ui";
import { useEngagementsStore } from "../store/engagements";
import { useSidebarState } from "@workspace/portal-ui";
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

const STATUS_ACCENT: Record<string, { bg: string; color: string }> = {
  active: { bg: "rgba(0,180,216,0.15)", color: "var(--cyan)" },
  on_hold: { bg: "rgba(245,158,11,0.18)", color: "#f59e0b" },
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
                <div>Add an address to see this project on a map.</div>
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

        <div className="sc-card flex flex-col">
          <div className="sc-card-header">
            <span className="sc-label">PARCEL & ZONING</span>
          </div>
          <div className="p-4">
            <div className="sc-prose opacity-70" style={{ fontSize: 12.5 }}>
              Coming soon — automatic parcel boundaries and zoning summaries
              will appear here once we integrate county GIS.
            </div>
          </div>
        </div>
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
              style={{ background: "#ef4444" }}
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
 * Format a `byteSize` int as a compact human label. Mirrors the inline
 * formatter in the upload modal — extracted here so the sources list
 * and the modal pre-submit preview stay consistent.
 */
function formatByteSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/**
 * Render one current briefing source as a card row. The presentation
 * is intentionally producer-agnostic — both `manual-upload` and
 * `federal-adapter` rows route through this component, with the
 * `sourceKind` badge being the only visible difference.
 *
 * The "View history" affordance lazily fetches the per-layer history
 * via `GET /briefing/sources?layerKind=...&includeSuperseded=true` so
 * the briefing read is not bloated with superseded rows by default,
 * and so reading history is a discoverable, opt-in interaction. The
 * fetch is gated on `expanded` so unrelated rows do not pay for it.
 */
/**
 * Visual styling per `conversionStatus` value, kept inline so the row
 * does not depend on the design-system pill styles changing under it.
 * The four DA-MV-1 statuses come straight from
 * `BriefingSourceConversionStatus`; QGIS rows have a `null` status and
 * skip the pill entirely.
 */
const CONVERSION_STATUS_STYLE: Record<
  "pending" | "converting" | "ready" | "failed" | "dxf-only",
  { label: string; bg: string; fg: string }
> = {
  pending: {
    label: "Conversion pending",
    bg: "var(--info-dim)",
    fg: "var(--info-text)",
  },
  converting: {
    label: "Converting…",
    bg: "var(--info-dim)",
    fg: "var(--info-text)",
  },
  ready: {
    label: "3D ready",
    bg: "var(--success-dim)",
    fg: "var(--success-text)",
  },
  failed: {
    label: "Conversion failed",
    bg: "var(--danger-dim)",
    fg: "var(--danger-text)",
  },
  // `dxf-only` rows have a stored DXF but no glb (e.g. an imported
  // legacy row). The viewer skips them; the pill just acknowledges
  // they exist so the architect knows why no 3D mesh shows up.
  "dxf-only": {
    label: "DXF only",
    bg: "var(--neutral-dim, var(--info-dim))",
    fg: "var(--text-muted)",
  },
};

function BriefingSourceRow({
  engagementId,
  source,
}: {
  engagementId: string;
  source: EngagementBriefingSource;
}) {
  const isManual = source.sourceKind === "manual-upload";
  const [expanded, setExpanded] = useState(false);
  const queryClient = useQueryClient();
  // Retry mutation re-runs the converter on an existing DXF row. The
  // route returns the updated source; on success we invalidate the
  // briefing read so the row re-renders with the new status (and the
  // 3D viewer picks the freshly-written glb on its next fetch).
  const retryMutation = useRetryBriefingSourceConversion({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: getGetEngagementBriefingQueryKey(engagementId),
        });
      },
    },
  });
  const conversionStatus = source.conversionStatus;
  const conversionStyle = conversionStatus
    ? CONVERSION_STATUS_STYLE[conversionStatus]
    : null;
  return (
    <div
      className="sc-card"
      style={{
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
      data-testid={`briefing-source-${source.id}`}
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
            {isManual ? "Manual upload" : "Federal adapter"}
          </span>
        </div>
      </div>
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
        </button>
      </div>
      {expanded && (
        <BriefingSourceHistoryPanel
          engagementId={engagementId}
          layerKind={source.layerKind}
          currentSourceId={source.id}
          panelId={`briefing-source-history-${source.id}`}
        />
      )}
    </div>
  );
}

/**
 * Lazily-loaded per-layer history list rendered beneath a current
 * source row. Fetches with `includeSuperseded=true` and filters the
 * current row out client-side so only prior versions show in the
 * collapsible panel. Each prior version exposes a "Restore this
 * version" action that POSTs to the restore endpoint and invalidates
 * both the briefing read (so the SiteContextTab re-renders the new
 * current row) and the history list (so the panel reflects the new
 * supersession state without a full page reload).
 */
function BriefingSourceHistoryPanel({
  engagementId,
  layerKind,
  currentSourceId,
  panelId,
}: {
  engagementId: string;
  layerKind: string;
  currentSourceId: string;
  panelId: string;
}) {
  const queryClient = useQueryClient();
  const historyQuery = useListEngagementBriefingSources(engagementId, {
    layerKind,
    includeSuperseded: true,
  });
  const restoreMutation = useRestoreEngagementBriefingSource({
    mutation: {
      onSuccess: async () => {
        // Refresh both surfaces: the briefing read (which drives the
        // current-source list above) and the per-layer history (this
        // panel) so the next tick reflects the new supersession state
        // without an extra reload.
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

  const priorVersions = useMemo(
    () =>
      (historyQuery.data?.sources ?? []).filter(
        (s) => s.id !== currentSourceId,
      ),
    [historyQuery.data, currentSourceId],
  );

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
            No prior versions of this layer.
          </div>
        )}
      {priorVersions.map((prior) => (
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
            {prior.uploadOriginalFilename ?? "(no filename)"}
            {prior.uploadByteSize !== null && (
              <span style={{ color: "var(--text-muted)" }}>
                {" · "}
                {formatByteSize(prior.uploadByteSize)}
              </span>
            )}
          </div>
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
          <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
            Snapshot{" "}
            {new Date(prior.snapshotDate).toLocaleDateString()} · added{" "}
            {relativeTime(prior.createdAt)}
            {prior.supersededAt && (
              <>
                {" · superseded "}
                {relativeTime(prior.supersededAt)}
              </>
            )}
          </div>
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
        </div>
      ))}
      {restoreMutation.isError && (
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
function SiteContextTab({ engagementId }: { engagementId: string }) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const briefingQuery = useGetEngagementBriefing(engagementId);

  const sources = briefingQuery.data?.briefing?.sources ?? [];
  const existingLayerKinds = useMemo(
    () => sources.map((s) => s.layerKind),
    [sources],
  );

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
            Manually-uploaded QGIS layers and (soon) federal-data overlays
            cited by the engagement's parcel briefing. Re-uploading a layer
            supersedes the prior source while keeping it on the timeline.
          </div>
        </div>
        <button
          type="button"
          className="sc-btn sc-btn-primary"
          onClick={() => setUploadOpen(true)}
          data-testid="briefing-source-upload-button"
        >
          Upload site context source
        </button>
      </div>

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
            gap: 8,
          }}
          data-testid="briefing-sources-list"
        >
          {sources.map((source) => (
            <BriefingSourceRow
              key={source.id}
              engagementId={engagementId}
              source={source}
            />
          ))}
        </div>
      )}

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
                ? "rgba(0,180,216,0.55)"
                : "var(--border-default)",
              background: isActive
                ? "rgba(0,180,216,0.15)"
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
          <SiteContextTab engagementId={engagement.id} />
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
