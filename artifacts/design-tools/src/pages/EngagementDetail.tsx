import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetEngagement,
  useGetSnapshot,
  useListEngagementSubmissions,
  useUpdateEngagement,
  getGetEngagementQueryKey,
  getGetSnapshotQueryKey,
  getListEngagementsQueryKey,
  getListEngagementSubmissionsQueryKey,
  type EngagementDetail as EngagementDetailType,
  type EngagementSubmissionSummary,
  type SubmissionReceipt,
  type SubmissionResponse,
  type SubmissionStatus,
} from "@workspace/api-client-react";
import { SiteMap } from "@workspace/site-context/client";
import type { SheetSummary } from "@workspace/api-client-react";
import { AppShell } from "../components/AppShell";
import { ClaudeChat } from "../components/ClaudeChat";
import { EngagementDetailsModal } from "../components/EngagementDetailsModal";
import { RecordSubmissionResponseDialog } from "../components/RecordSubmissionResponseDialog";
import { RevitBinding } from "../components/RevitBinding";
import { SheetGrid } from "../components/SheetGrid";
import { SubmitToJurisdictionDialog } from "../components/SubmitToJurisdictionDialog";
import { useEngagementsStore } from "../store/engagements";
import { useSidebarState } from "@workspace/portal-ui";
import { relativeTime } from "../lib/relativeTime";

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

/**
 * Non-blocking confirmation banner shown above the engagement header
 * after a successful "Submit to jurisdiction" action. The dialog itself
 * already closes on success, so this banner is the visible receipt that
 * something was recorded — it pairs the human-friendly relative time
 * (e.g. "just now") with the absolute timestamp on hover so a teammate
 * can verify exactly when the submission landed without opening the
 * (not-yet-shipped) submissions list. Auto-dismiss and the close button
 * are wired up by the parent so the banner stays presentational.
 */
function SubmissionRecordedBanner({
  submittedAt,
  onDismiss,
}: {
  submittedAt: string;
  onDismiss: () => void;
}) {
  const absolute = useMemo(() => {
    const d = new Date(submittedAt);
    return Number.isNaN(d.getTime()) ? submittedAt : d.toLocaleString();
  }, [submittedAt]);
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="submit-jurisdiction-success-banner"
      className="sc-card flex items-center justify-between flex-shrink-0"
      style={{
        padding: "10px 14px",
        background: "rgba(0,180,216,0.10)",
        borderColor: "rgba(0,180,216,0.45)",
        color: "var(--text-primary)",
      }}
    >
      <div className="flex items-center gap-2" style={{ fontSize: 13 }}>
        <span aria-hidden style={{ color: "var(--cyan)", fontWeight: 600 }}>
          ✓
        </span>
        <span>
          Submission recorded ·{" "}
          <span title={absolute} style={{ color: "var(--text-secondary)" }}>
            {relativeTime(submittedAt)}
          </span>
        </span>
      </div>
      <button
        type="button"
        className="sc-btn-ghost"
        onClick={onDismiss}
        aria-label="Dismiss submission confirmation"
        data-testid="submit-jurisdiction-success-dismiss"
        style={{ padding: "2px 8px", fontSize: 12 }}
      >
        Dismiss
      </button>
    </div>
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
  return (
    <div className="sc-card p-4">
      <div className="sc-label">{label}</div>
      <div className="sc-kpi-md mt-2">{value ?? "—"}</div>
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
 * Site context tab — DA-PI-1 sprint scaffolding.
 *
 * The four parcel-intelligence atoms (parcel-briefing, intent,
 * briefing-source, neighboring-context) register shape-only this
 * sprint; the briefing engine that resolves them ships in DA-PI-3
 * (per Spec 51 §7's sprint table). This tab exists now so the IA is
 * stable, deep links work (`?tab=site-context`), and a follow-up
 * sprint can drop the briefing/intent/source list cards in without
 * having to plumb routing or tab state.
 *
 * Until the engine ships, the body is a deliberate empty state — no
 * hidden `useEffect` calls, no probe of unfinished endpoints — so
 * loading the tab has no side effects.
 */
function SiteContextTab() {
  return (
    <div className="sc-card p-6 flex items-center justify-center flex-1">
      <div className="sc-prose text-center opacity-70" style={{ maxWidth: 480 }}>
        <div className="sc-medium mb-2">Site context</div>
        <div>
          Parcel briefing, intent, neighboring context, and cited briefing
          sources will surface here once the briefing engine ships. The atom
          shapes are registered so deep links (<code>?tab=site-context</code>)
          and the chat inline-reference resolver already recognize this view.
        </div>
      </div>
    </div>
  );
}

/**
 * Visual accent for a recorded submission status. Mirrors the
 * `STATUS_ACCENT` palette used for the engagement-level pill so the
 * row-level status badge stays visually consistent with the rest of
 * the page.
 */
const SUBMISSION_STATUS_ACCENT: Record<
  SubmissionStatus,
  { bg: string; color: string; label: string }
> = {
  pending: {
    bg: "var(--bg-input)",
    color: "var(--text-muted)",
    label: "Pending",
  },
  approved: {
    bg: "rgba(34,197,94,0.18)",
    color: "#22c55e",
    label: "Approved",
  },
  corrections_requested: {
    bg: "rgba(245,158,11,0.18)",
    color: "#f59e0b",
    label: "Corrections requested",
  },
  rejected: {
    bg: "rgba(239,68,68,0.18)",
    color: "#ef4444",
    label: "Rejected",
  },
};

function SubmissionStatusPill({ status }: { status: SubmissionStatus }) {
  const accent =
    SUBMISSION_STATUS_ACCENT[status] ?? SUBMISSION_STATUS_ACCENT.pending;
  return (
    <span
      className="sc-pill"
      style={{
        background: accent.bg,
        color: accent.color,
        textTransform: "uppercase",
        fontSize: 10.5,
        letterSpacing: "0.05em",
        padding: "2px 7px",
        borderRadius: 4,
      }}
    >
      {accent.label}
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
 * submitted-at relative timestamp, and the optional free-text note.
 * Each row carries a "Record response" action that opens
 * `RecordSubmissionResponseDialog`.
 *
 * The current `EngagementSubmissionSummary` shape does not include
 * `status` / `reviewerComment` (the sister task "Show jurisdiction
 * response status and comment on the engagement page" surfaces them
 * in the listing). To meet the acceptance criterion that the row
 * reflects the response *immediately after submitting*, this tab
 * keeps a local map of just-recorded responses keyed by submission
 * id. When the listing eventually carries those columns, the
 * resolver below prefers the listing payload over the local mirror,
 * so the local-state path collapses to dead weight (and can be
 * removed) without any change to the dialog or the row shape.
 *
 * Pagination is still a follow-up: engagements typically accumulate
 * a handful of packages, so a bare array is fine for now.
 */
function SubmissionsTab({ engagementId }: { engagementId: string }) {
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

  const dialogTarget =
    responseDialogFor && submissions
      ? (submissions.find((s) => s.id === responseDialogFor) ?? null)
      : null;

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
          <span className="sc-label">PAST SUBMISSIONS</span>
          <span className="sc-meta">{submissions.length} total</span>
        </div>
        <div className="flex flex-col">
          {submissions.map((s: EngagementSubmissionSummary) => {
            // Prefer a row-carried status (sister task) when present;
            // fall back to the locally-recorded response so the row
            // updates immediately after the user records a reply.
            const rowStatus =
              (s as EngagementSubmissionSummary & {
                status?: SubmissionStatus | null;
                reviewerComment?: string | null;
              }).status ?? null;
            const rowComment =
              (s as EngagementSubmissionSummary & {
                reviewerComment?: string | null;
              }).reviewerComment ?? null;
            const localResponse = recordedResponses[s.id] ?? null;
            const status: SubmissionStatus =
              rowStatus ?? localResponse?.status ?? "pending";
            const comment: string | null =
              rowComment ?? localResponse?.reviewerComment ?? null;
            const respondedAt: string | null =
              localResponse?.respondedAt ?? null;
            return (
              <div
                key={s.id}
                className="sc-card-row"
                data-testid={`submission-row-${s.id}`}
                style={{
                  padding: "12px 16px",
                  borderBottom: "1px solid var(--border-default)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
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
                      <SubmissionStatusPill status={status} />
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
                    onClick={() => setResponseDialogFor(s.id)}
                    data-testid={`submission-record-response-${s.id}`}
                    style={{ padding: "2px 10px", fontSize: 12 }}
                  >
                    {status === "pending"
                      ? "Record response"
                      : "Update response"}
                  </button>
                </div>
                {s.note && (
                  <div
                    className="sc-body"
                    style={{
                      color: "var(--text-secondary)",
                      fontSize: 12,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {s.note}
                  </div>
                )}
                {comment && (
                  <div
                    data-testid={`submission-comment-${s.id}`}
                    className="sc-body"
                    style={{
                      borderLeft: "2px solid var(--border-default)",
                      paddingLeft: 8,
                      color: "var(--text-primary)",
                      fontSize: 12,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    <span
                      className="sc-label"
                      style={{
                        color: "var(--text-secondary)",
                        marginRight: 6,
                      }}
                    >
                      REVIEWER
                      {respondedAt
                        ? ` · ${relativeTime(respondedAt)}`
                        : ""}
                      :
                    </span>
                    {comment}
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
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"intake" | "edit">("edit");
  const [submitOpen, setSubmitOpen] = useState(false);
  // Last successful jurisdiction submission, surfaced as a non-blocking
  // confirmation banner above the engagement header. We keep the full
  // receipt (not just `submittedAt`) so a future "View on timeline"
  // affordance can deep-link by `submissionId` without another round trip.
  const [lastSubmission, setLastSubmission] =
    useState<SubmissionReceipt | null>(null);
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
            submittedAt={lastSubmission.submittedAt}
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
              data-testid="submit-jurisdiction-open"
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
                <div className="flex-1 overflow-y-auto sc-scroll">
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

        {tab === "site-context" && <SiteContextTab />}

        {tab === "submissions" && (
          <SubmissionsTab engagementId={engagement.id} />
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
        onSubmitted={(receipt) => setLastSubmission(receipt)}
      />
    </AppShell>
  );
}
