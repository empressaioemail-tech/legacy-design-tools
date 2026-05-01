import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGenerateEngagementLayers,
  useGenerateEngagementBriefing,
  useGetBimModelRefresh,
  useGetEngagement,
  useGetEngagementBimModel,
  useGetEngagementBriefing,
  useGetEngagementBriefingGenerationStatus,
  useGetSnapshot,
  useListBimModelDivergences,
  useListEngagementBriefingSources,
  useListEngagementSubmissions,
  usePushEngagementBimModel,
  useRestoreEngagementBriefingSource,
  useRetryBriefingSourceConversion,
  useUpdateEngagement,
  getGetBimModelRefreshQueryKey,
  getGetEngagementBimModelQueryKey,
  getGetEngagementBriefingGenerationStatusQueryKey,
  getGetEngagementBriefingQueryKey,
  getGetEngagementQueryKey,
  getGetSnapshotQueryKey,
  getListBimModelDivergencesQueryKey,
  getListEngagementBriefingSourcesQueryKey,
  getListEngagementsQueryKey,
  getListEngagementSubmissionsQueryKey,
  type BimModelDivergenceListEntry,
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
import {
  diffFederalPayload,
  summarizeFederalPayload,
} from "@workspace/adapters/federal/summaries";
import { summarizeStatePayload } from "@workspace/adapters/state/summaries";
import { summarizeLocalPayload } from "@workspace/adapters/local/summaries";
import type { SheetSummary } from "@workspace/api-client-react";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { AppShell } from "../components/AppShell";
import { BriefingSourceUploadModal } from "../components/BriefingSourceUploadModal";
import { BriefingSourceDetails } from "../components/BriefingSourceDetails";
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
import {
  BriefingInvalidCitationPill,
  renderBriefingBody,
  scrollToBriefingSource,
} from "../components/briefingCitations";

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

/**
 * Visible label for the source-kind pill on a briefing source row.
 * The four enum values map 1:1 to the sourceKind discriminator the
 * adapter / manual-upload writers stamp; falling back to a humanised
 * version of the raw value lets a future enum extension ship without
 * crashing the UI before this map is updated.
 */
const SOURCE_KIND_BADGE_LABEL: Record<
  EngagementBriefingSource["sourceKind"],
  string
> = {
  "manual-upload": "Manual upload",
  "federal-adapter": "Federal adapter",
  "state-adapter": "State adapter",
  "local-adapter": "Local adapter",
};

/**
 * The system actor id `generateLayers.ts` stamps on every adapter-
 * driven `briefing-source.fetched` event. Pinned here so the UI's
 * "by Generate Layers" attribution line matches the audit trail's
 * actor id verbatim — if the route ever renames the actor, the test
 * assertions below pin both surfaces together.
 */
export const BRIEFING_GENERATE_LAYERS_ACTOR_LABEL = "Generate Layers";

function isAdapterSourceKind(
  kind: EngagementBriefingSource["sourceKind"],
): boolean {
  return (
    kind === "federal-adapter" ||
    kind === "state-adapter" ||
    kind === "local-adapter"
  );
}

/**
 * Field names compared between an adapter-driven prior row and the
 * current row to drive the "Changed: …" hint in the history panel.
 * Kept narrow (snapshotDate / provider / note / sourceKind) so the
 * diff is meaningful at a glance for a non-destructive rerun — fields
 * that are bookkeeping (createdAt, supersededAt, supersededById, the
 * row's own id, conversion blob fields, upload byte fields) would
 * always differ and would drown out the signal.
 */
const BRIEFING_DIFF_FIELDS = [
  "snapshotDate",
  "provider",
  "note",
  "sourceKind",
] as const satisfies readonly (keyof EngagementBriefingSource)[];

/**
 * Diff a prior briefing-source row against the current row, returning
 * the names of {@link BRIEFING_DIFF_FIELDS} whose value differs. Used
 * by the history panel to surface a compact "Changed: provider,
 * snapshotDate" hint on adapter-driven prior rows so an architect can
 * see what an adapter rerun actually moved without opening the JSON.
 *
 * Comparison is a strict `!==` over scalar values — the four diffed
 * fields are all `string | null`, so reference identity is sufficient
 * and we avoid a JSON.stringify roundtrip on every render.
 */
export function diffBriefingSourceFields(
  prior: EngagementBriefingSource,
  current: EngagementBriefingSource,
): readonly (typeof BRIEFING_DIFF_FIELDS)[number][] {
  return BRIEFING_DIFF_FIELDS.filter((f) => prior[f] !== current[f]);
}

/**
 * Format one of the {@link BRIEFING_DIFF_FIELDS} values for the
 * inline before → after reveal under the "Changed: …" hint (Task
 * #200). `snapshotDate` is sliced to its `YYYY-MM-DD` head so the
 * reveal stays locale-independent and lines up with how the meta
 * line above renders the same date; the other fields are scalar
 * strings (provider/note are nullable, sourceKind is a literal
 * union) so they pass through verbatim. `null` becomes `(none)`
 * so a "field went from set → unset" rerun is visible at a glance
 * instead of rendering as a blank cell.
 */
export function formatBriefingDiffValue(
  field: (typeof BRIEFING_DIFF_FIELDS)[number],
  value: string | null,
): string {
  if (value === null) return "(none)";
  if (field === "snapshotDate") return value.slice(0, 10);
  return value;
}

export function BriefingSourceRow({
  engagementId,
  source,
  isHighlighted = false,
}: {
  engagementId: string;
  source: EngagementBriefingSource;
  /**
   * When true, render the row with a flashed border so the user can
   * see which source a clicked narrative citation pill landed them
   * on (Task #176). The parent (`SiteContextTab`) owns the timer
   * that toggles this back to false after ~1.6s.
   */
  isHighlighted?: boolean;
}) {
  const isManual = source.sourceKind === "manual-upload";
  const isAdapter = isAdapterSourceKind(source.sourceKind);
  // Adapter rows (federal, state, and local) each carry small
  // structured payloads with one or two reader-friendly readings.
  // We pull a one-line summary for inline display so reviewers see
  // the actual value (e.g. "Flood Zone AE · BFE 425.5 ft", "Zoning
  // R-1 · Single-Family Residential", "In Edwards Aquifer recharge
  // zone") without having to expand "View layer details". Each
  // tier-specific summarizer returns null for layer kinds outside
  // its tier — and for malformed payloads — so we just skip the chip
  // in that case rather than rendering a misleading "—".
  const adapterSummary =
    source.sourceKind === "federal-adapter"
      ? summarizeFederalPayload(source.layerKind, source.payload)
      : source.sourceKind === "state-adapter"
        ? summarizeStatePayload(source.layerKind, source.payload)
        : source.sourceKind === "local-adapter"
          ? summarizeLocalPayload(source.layerKind, source.payload)
          : null;
  const [expanded, setExpanded] = useState(false);
  // Layer-details panel is independent of the history panel; the
  // architect should be able to keep "what does this layer say about
  // my parcel" open while flipping between snapshots.
  const [detailsExpanded, setDetailsExpanded] = useState(false);
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
        // Flashed outline driven by `isHighlighted` (Task #176). We
        // use `outline` (not `border`) so the row's existing card
        // border isn't shifted by the highlight — outline draws
        // outside the box and never reflows the layout. A short CSS
        // transition smooths the appearance/disappearance.
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
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
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
      </div>
      {detailsExpanded && !isManual && (
        <BriefingSourceDetails source={source} />
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
export function BriefingSourceHistoryPanel({
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

  // Tier filter — purely client-side over the rows the existing
  // `useListEngagementBriefingSources` query already returns.
  // Architects investigating "what did the adapter change" vs "when
  // did the manual override happen" can narrow the chronological
  // list to one tier at a time without changing the API contract.
  const [tierFilter, setTierFilter] = useState<
    "all" | "adapter" | "manual"
  >("all");

  // Tracks which adapter prior rows have their "Changed: …" hint
  // expanded into the before → after reveal (Task #200). State lives
  // on the panel (rather than per-row) so it's purely local to this
  // history surface — collapsing the panel via the row toggle drops
  // the whole component and resets the reveal, matching the user's
  // mental model of "open the history, peek at a diff, close".
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
  // The "Changed: …" hint compares each adapter-driven prior row to
  // the current row (the one whose id matches `currentSourceId`).
  // Looking up the current row from the same `includeSuperseded=true`
  // payload keeps the diff purely client-side over data the panel has
  // already fetched — no extra request.
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

  // Per-tier counts surfaced inside each filter pill so an architect
  // can see at a glance how many adapter runs vs. manual overrides
  // are waiting under each tab without flipping through them. Derived
  // from the same client-side `allPriorVersions` list the filter
  // already uses, so the counts stay in sync if the underlying
  // history list invalidates (e.g. after a restore mutation).
  const tierCounts = useMemo(() => {
    let adapter = 0;
    let manual = 0;
    for (const s of allPriorVersions) {
      if (isAdapterSourceKind(s.sourceKind)) adapter += 1;
      else if (s.sourceKind === "manual-upload") manual += 1;
    }
    return { all: allPriorVersions.length, adapter, manual };
  }, [allPriorVersions]);

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
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`briefing-source-history-filter-${opt.value}-${currentSourceId}`}
                onClick={() => setTierFilter(opt.value)}
                style={{
                  background: active
                    ? "var(--info-dim)"
                    : "transparent",
                  color: active
                    ? "var(--info-text)"
                    : "var(--text-secondary)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 999,
                  padding: "1px 8px",
                  cursor: "pointer",
                  fontSize: 11,
                }}
              >
                {opt.label}{" "}
                <span
                  data-testid={`briefing-source-history-filter-${opt.value}-count-${currentSourceId}`}
                  style={{ opacity: 0.8 }}
                >
                  ({count})
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
        // Adapter-driven prior rows do not carry an upload filename
        // (every upload field is null on insert per generateLayers.ts).
        // Show the per-layer key + provider as the headline and stamp
        // the actor line so an architect can see at a glance whether
        // a prior version came from an adapter run or a manual upload.
        // For adapter-driven prior rows, compute which of the diffed
        // fields moved between this rerun and the current row so we
        // can render a compact "Changed: …" hint below the meta line.
        // Manual-upload prior rows skip the hint — the typical reason
        // to look at one is to compare uploaded files, not adapter
        // rerun deltas.
        const changedFields =
          priorIsAdapter && currentSource
            ? diffBriefingSourceFields(prior, currentSource)
            : [];
        // Federal-tier rows carry a structured `payload` blob whose
        // per-key contents (FEMA flood zone, USGS elevation, …) drive
        // the design downstream. The metadata-only diff above misses
        // those moves, so for federal prior rows whose payload `kind`
        // matches the current row we also surface a "Payload changes"
        // subsection inside the reveal (Task #211). State/local rows
        // are skipped — `diffFederalPayload` returns null for any
        // non-federal `layerKind`, so the subsection silently turns
        // off for them. An empty array (kinds match, every value is
        // identical) also suppresses the subsection so we don't show
        // an empty "Payload changes" heading on a true no-op rerun.
        const payloadChanges =
          priorIsAdapter &&
          currentSource &&
          prior.sourceKind === "federal-adapter" &&
          currentSource.sourceKind === "federal-adapter"
            ? diffFederalPayload(
                prior.layerKind,
                prior.payload,
                currentSource.payload,
              )
            : null;
        const hasPayloadChanges =
          payloadChanges !== null && payloadChanges.length > 0;
        // Hint label combines the metadata field names with the
        // payload field labels so a payload-only rerun (snapshotDate
        // unchanged but flood zone moved) still surfaces *something*
        // in the chip rather than silently hiding the reveal trigger.
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
        );
      })}
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

/** Cards default open per the spec: A always, B+E only when non-empty. */
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

function BriefingNarrativePanel({
  engagementId,
  narrative,
  sourceCount,
  sources,
  onJumpToSource,
}: {
  engagementId: string;
  narrative: EngagementBriefingNarrative | null;
  sourceCount: number;
  sources: EngagementBriefingSource[];
  /**
   * Invoked when an inline citation pill in any A–G section card is
   * clicked. The parent (`SiteContextTab`) is responsible for
   * scrolling the matching `BriefingSourceRow` into view + flashing
   * a temporary highlight on it; we route through the parent rather
   * than mutating DOM here so the highlight is React state and not
   * an imperative class toggle (Task #176).
   */
  onJumpToSource: (sourceId: string) => void;
}) {
  const queryClient = useQueryClient();

  // Card expansion state — recomputed only when the narrative
  // identity changes (i.e. a fresh generation finishes), so toggles
  // the user makes during a session are not blown away on
  // component re-render.
  const [expanded, setExpanded] = useState(() => defaultExpansion(narrative));
  const lastNarrativeKey = useRef<string | null>(null);
  const narrativeKey = narrative?.generatedAt ?? null;
  useEffect(() => {
    if (lastNarrativeKey.current !== narrativeKey) {
      lastNarrativeKey.current = narrativeKey;
      setExpanded(defaultExpansion(narrative));
    }
  }, [narrative, narrativeKey]);

  // Status polling — only enabled while a generation is in flight.
  // We start in "watching" mode for two reasons:
  //   (a) a previous render kicked off a generation and the user
  //       reloaded the page — the in-process job map will report
  //       `pending` and we want to keep polling.
  //   (b) a fresh page load with no in-flight job will report `idle`,
  //       which causes the poll to immediately drop back to disabled.
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

  // Edge detector: when the in-flight job transitions out of
  // `pending`, drop polling and re-fetch the briefing read so the
  // sections render. We track the last observed state in a ref so
  // the effect only fires on the actual transition.
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
      setWatching(false);
    }
    if (statusState !== "pending" && watching && prev !== "pending") {
      // Idle on first load or after a completion settled — stop
      // polling until the next kickoff.
      setWatching(false);
    }
    lastStateRef.current = statusState;
  }, [statusState, queryClient, engagementId, watching]);

  const generateMutation = useGenerateEngagementBriefing({
    mutation: {
      onSuccess: () => {
        // Kicking off — re-arm polling and warm the status cache.
        setWatching(true);
        void queryClient.invalidateQueries({
          queryKey:
            getGetEngagementBriefingGenerationStatusQueryKey(engagementId),
        });
      },
    },
  });

  const hasNarrative = !!narrative && !!narrative.generatedAt;
  const noSources = sourceCount === 0;
  const buttonDisabled = noSources || isPending || generateMutation.isPending;
  const buttonLabel = hasNarrative ? "Regenerate Briefing" : "Generate Briefing";
  const tooltip = noSources
    ? "Upload a layer or run an adapter first — the engine has nothing to cite."
    : isPending
      ? "Generation in progress…"
      : hasNarrative
        ? "Re-run the engine. The current narrative is preserved as the prior version."
        : "Synthesize a seven-section A–G briefing from the cited sources.";

  // The mock generator stamps `system:briefing-engine` for the
  // `generatedBy` field; render a friendlier label when we
  // recognise it.
  const generatedByLabel = narrative?.generatedBy
    ? narrative.generatedBy === "system:briefing-engine"
      ? "Briefing engine (mock)"
      : narrative.generatedBy
    : null;
  const generatedAtLabel = narrative?.generatedAt
    ? new Date(narrative.generatedAt).toLocaleString()
    : null;

  // Citation count surfaced from the status payload — non-zero is a
  // model-quality regression and we want the architect to see it
  // surfaced in the UI, not just the server logs.
  const invalidCount =
    statusQuery.data?.state === "completed"
      ? (statusQuery.data.invalidCitationCount ?? 0)
      : 0;
  // Verbatim stripped tokens (Task #176) — the warning banner
  // renders each one as a "broken" pill so the architect can see
  // which sources were referenced but no longer exist. Older job
  // entries (or older API servers, until the next deploy) won't
  // have this field; fall back to an empty list rather than the
  // count so the renderer doesn't fabricate placeholder pills.
  const invalidTokens =
    statusQuery.data?.state === "completed"
      ? (statusQuery.data.invalidCitations ?? [])
      : [];
  const failureMessage =
    statusQuery.data?.state === "failed" ? statusQuery.data.error : null;

  // Set of currently-known source ids — drives the citation pill
  // renderer's "render as clickable pill vs. fall back to plain
  // label" decision. Recomputed only when the sources list
  // identity changes so re-renders during card toggle don't
  // re-allocate the set.
  const knownSourceIds = useMemo(
    () => new Set(sources.map((s) => s.id)),
    [sources],
  );

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
          </div>
        </div>
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

      {hasNarrative && (
        <div
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
          data-testid="briefing-narrative-sections"
        >
          {SECTION_ORDER.map(({ key, label, blurb }) => {
            const body = pickSection(narrative, key);
            const isOpen = expanded[key];
            const isEmpty = !body || body.trim().length === 0;
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
                      style={{ fontSize: 13, fontWeight: 600 }}
                    >
                      {label}
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
                      whiteSpace: "pre-wrap",
                      lineHeight: 1.5,
                      color: isEmpty ? "var(--text-muted)" : undefined,
                    }}
                  >
                    {isEmpty
                      ? "No content in this section."
                      : renderBriefingBody(
                          body!,
                          knownSourceIds,
                          onJumpToSource,
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

function SiteContextTab({ engagementId }: { engagementId: string }) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const briefingQuery = useGetEngagementBriefing(engagementId);
  const queryClient = useQueryClient();

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

  const sources = briefingQuery.data?.briefing?.sources ?? [];
  const narrative = briefingQuery.data?.briefing?.narrative ?? null;
  const existingLayerKinds = useMemo(
    () => sources.map((s) => s.layerKind),
    [sources],
  );

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
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="sc-btn"
            onClick={() => generateMutation.mutate({ id: engagementId })}
            disabled={generateMutation.isPending}
            data-testid="generate-layers-button"
            title="Run every applicable federal/state/local adapter and persist the results as briefing sources."
          >
            {generateMutation.isPending ? "Generating…" : "Generate Layers"}
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

      {lastGenerateErrorSlug === "no_applicable_adapters" ? (
        // Distinct empty-pilot-jurisdiction banner (Task #177). The
        // POST already returns a structured 422 with a human-readable
        // `message` for engagements outside the three pilot
        // jurisdictions (Bastrop TX, Moab UT, Salmon ID). Surfacing
        // it through the generic `generate-layers-error` alert reads
        // as an upstream failure; this branch instead frames it as
        // an actionable dead-end and offers the manual-upload path
        // the architect would otherwise have to discover on their
        // own.
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
              {lastGenerateError}
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
                {sourcesByTier[tier].map((source) => (
                  <BriefingSourceRow
                    key={source.id}
                    engagementId={engagementId}
                    source={source}
                    isHighlighted={highlightedSourceId === source.id}
                  />
                ))}
              </div>
            ),
          )}
        </div>
      )}

      <BriefingNarrativePanel
        engagementId={engagementId}
        narrative={narrative}
        sourceCount={sources.length}
        sources={sources}
        onJumpToSource={handleJumpToSource}
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

/**
 * Tiny relative-time formatter for the "Materialized at" line. Kept
 * local rather than reaching for a date-fns dependency because the
 * timestamps the affordance shows only need second / minute / hour /
 * day granularity — the absolute ISO string is exposed via the
 * pill's title attribute for anything finer.
 */
function formatRelativeMaterializedAt(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const now = Date.now();
  const deltaSec = Math.max(0, Math.floor((now - then) / 1000));
  if (deltaSec < 45) return "just now";
  if (deltaSec < 60 * 60) return `${Math.floor(deltaSec / 60)} min ago`;
  if (deltaSec < 60 * 60 * 24)
    return `${Math.floor(deltaSec / 60 / 60)} h ago`;
  return `${Math.floor(deltaSec / 60 / 60 / 24)} d ago`;
}

/**
 * Human-readable label for each {@link MaterializableElementKind}
 * the C# Revit add-in can materialize. Mirrors the kinds defined in
 * the OpenAPI spec at `MaterializableElementKind`.
 */
const MATERIALIZABLE_ELEMENT_KIND_LABELS: Record<string, string> = {
  terrain: "Terrain",
  "property-line": "Property line",
  "setback-plane": "Setback plane",
  "buildable-envelope": "Buildable envelope",
  floodplain: "Floodplain",
  wetland: "Wetland",
  "neighbor-mass": "Neighbor mass",
};

/**
 * Human-readable label for each {@link BriefingDivergenceReason}.
 * The closed set mirrors `BriefingDivergenceReason` in the OpenAPI
 * spec so renaming a reason bucket on the schema side surfaces here
 * as a missing-label fallback rather than a runtime crash.
 */
const BRIEFING_DIVERGENCE_REASON_LABELS: Record<string, string> = {
  unpinned: "Unpinned",
  "geometry-edited": "Geometry edited",
  deleted: "Deleted",
  other: "Other override",
};

/**
 * Per-reason badge palette, keyed off the SmartCity theme tokens so
 * the pill picks the right dark/light contrast. We treat `deleted`
 * as the loudest signal (danger) — a deleted locked element is the
 * scenario the operator most needs to chase down — and the other
 * three reasons land on the warning palette so they read as
 * "noticed, not blocking".
 */
const BRIEFING_DIVERGENCE_REASON_COLORS: Record<
  string,
  { bg: string; fg: string }
> = {
  deleted: { bg: "var(--danger-dim)", fg: "var(--danger-text)" },
  unpinned: { bg: "var(--warning-dim)", fg: "var(--warning-text)" },
  "geometry-edited": {
    bg: "var(--warning-dim)",
    fg: "var(--warning-text)",
  },
  other: { bg: "var(--info-dim)", fg: "var(--info-text)" },
};

/**
 * DA-PI-5 / Spec 51a §2.2 — the "what did the architect change
 * inside Revit" feedback panel that closes the loop opened by the
 * `PushToRevitAffordance` above. Reads the engagement's bim-model
 * (to discover the bim-model id) and lists the recorded divergences
 * grouped by element so the operator can scan "Buildable envelope:
 * geometry edited" at a glance instead of paging through a flat
 * stream of rows.
 *
 * Renders nothing while the bim-model query is still loading or
 * when no bim-model has ever been pushed — the affordance card
 * above already explains "Push to Revit first", and a second empty
 * card on a fresh engagement would just be visual noise. Once the
 * bim-model row exists, the panel always renders (with an empty
 * state when no divergence has been recorded yet) so the operator
 * has a stable place to look.
 *
 * The list refreshes automatically: the push mutation invalidates
 * the divergence query key (so a re-push picks up any divergences
 * the C# add-in recorded between the prior poll and now), and the
 * 60s `staleTime` keeps the read cheap during normal browsing.
 */
export function BriefingDivergencesPanel({
  engagementId,
}: {
  engagementId: string;
}) {
  const bimModelQuery = useGetEngagementBimModel(engagementId);
  const bimModelId = bimModelQuery.data?.bimModel?.id ?? null;

  const divergencesQuery = useListBimModelDivergences(bimModelId ?? "", {
    query: {
      enabled: bimModelId !== null,
      queryKey: getListBimModelDivergencesQueryKey(bimModelId ?? ""),
      staleTime: 60_000,
    },
  });

  // Hide the panel until the engagement has actually been pushed to
  // Revit at least once. This is the same guard the affordance uses
  // to flip from "Push" to "Push again" — if there's no bim-model
  // row, there cannot be any divergences either, and the empty card
  // would just duplicate the affordance's "not pushed yet" state.
  if (bimModelQuery.isLoading || bimModelId === null) {
    return null;
  }

  const divergences = divergencesQuery.data?.divergences ?? [];
  const grouped = groupDivergencesByElement(divergences);

  return (
    <div
      className="sc-card"
      data-testid="briefing-divergences-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 12,
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div className="sc-medium">Architect overrides in Revit</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          The C# add-in records every edit an architect makes to a
          locked element. Use this list to confirm the briefing still
          matches what's in the model.
        </div>
      </div>

      {divergencesQuery.isLoading && (
        <div
          data-testid="briefing-divergences-loading"
          style={{ fontSize: 12, color: "var(--text-muted)" }}
        >
          Loading recent overrides…
        </div>
      )}

      {divergencesQuery.isError && (
        <div
          role="alert"
          data-testid="briefing-divergences-error"
          style={{
            fontSize: 12,
            color: "var(--danger-text)",
            background: "var(--danger-dim)",
            padding: 8,
            borderRadius: 4,
          }}
        >
          Couldn't load recent overrides. Try refreshing in a moment.
        </div>
      )}

      {!divergencesQuery.isLoading &&
        !divergencesQuery.isError &&
        divergences.length === 0 && (
          <div
            data-testid="briefing-divergences-empty"
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              fontStyle: "italic",
              padding: "8px 0",
            }}
          >
            No overrides recorded yet — the briefing matches what's in
            Revit.
          </div>
        )}

      {grouped.length > 0 && (
        <div
          data-testid="briefing-divergences-list"
          style={{ display: "flex", flexDirection: "column", gap: 12 }}
        >
          {grouped.map((group) => (
            <BriefingDivergenceGroup key={group.elementId} group={group} />
          ))}
        </div>
      )}
    </div>
  );
}

interface BriefingDivergenceGroupShape {
  elementId: string;
  elementKind: string | null;
  elementLabel: string | null;
  rows: BimModelDivergenceListEntry[];
}

/**
 * Group divergences by `materializableElementId` so the panel can
 * render one card per element. Within a group, rows stay in the
 * server's newest-first order so the most recent override is the
 * first thing the operator reads. Groups themselves are ordered by
 * the newest divergence in the group — an element the architect just
 * touched bubbles to the top.
 */
function groupDivergencesByElement(
  rows: ReadonlyArray<BimModelDivergenceListEntry>,
): BriefingDivergenceGroupShape[] {
  const byId = new Map<string, BriefingDivergenceGroupShape>();
  for (const row of rows) {
    const existing = byId.get(row.materializableElementId);
    if (existing) {
      existing.rows.push(row);
      // Keep `elementKind` / `elementLabel` populated from whichever
      // row in the group has them — a deleted-element fallback row
      // shouldn't blank out a label that an earlier row carried.
      if (!existing.elementKind && row.elementKind) {
        existing.elementKind = row.elementKind;
      }
      if (!existing.elementLabel && row.elementLabel) {
        existing.elementLabel = row.elementLabel;
      }
    } else {
      byId.set(row.materializableElementId, {
        elementId: row.materializableElementId,
        elementKind: row.elementKind,
        elementLabel: row.elementLabel,
        rows: [row],
      });
    }
  }
  return Array.from(byId.values());
}

function BriefingDivergenceGroup({
  group,
}: {
  group: BriefingDivergenceGroupShape;
}) {
  const kindLabel = group.elementKind
    ? (MATERIALIZABLE_ELEMENT_KIND_LABELS[group.elementKind] ??
      group.elementKind)
    : "Element no longer in briefing";
  return (
    <div
      data-testid="briefing-divergences-group"
      data-element-id={group.elementId}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: 8,
        border: "1px solid var(--border-default)",
        borderRadius: 4,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <div className="sc-medium" style={{ fontSize: 13 }}>
          {kindLabel}
        </div>
        {group.elementLabel && (
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {group.elementLabel}
          </div>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {group.rows.map((row) => (
          <BriefingDivergenceRow key={row.id} row={row} />
        ))}
      </div>
    </div>
  );
}

function BriefingDivergenceRow({
  row,
}: {
  row: BimModelDivergenceListEntry;
}) {
  const reasonLabel =
    BRIEFING_DIVERGENCE_REASON_LABELS[row.reason] ?? row.reason;
  const palette =
    BRIEFING_DIVERGENCE_REASON_COLORS[row.reason] ??
    BRIEFING_DIVERGENCE_REASON_COLORS.other;
  return (
    <div
      data-testid="briefing-divergences-row"
      data-divergence-id={row.id}
      data-divergence-reason={row.reason}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "6px 8px",
        background: "var(--bg-subtle)",
        borderRadius: 4,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span
          data-testid="briefing-divergences-reason-badge"
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
          {reasonLabel}
        </span>
        <span
          title={new Date(row.createdAt).toISOString()}
          style={{ fontSize: 11, color: "var(--text-muted)" }}
        >
          {formatRelativeMaterializedAt(row.createdAt)}
        </span>
      </div>
      {row.note && (
        <div
          data-testid="briefing-divergences-note"
          style={{
            fontSize: 12,
            color: "var(--text-secondary)",
            whiteSpace: "pre-wrap",
          }}
        >
          {row.note}
        </div>
      )}
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
