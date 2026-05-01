import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "wouter";
import {
  DashboardLayout,
  ReviewerComment,
  SubmissionRecordedBanner,
  SubmitToJurisdictionDialog,
} from "@workspace/portal-ui";
import {
  useGetEngagement,
  useListEngagementSubmissions,
  getGetEngagementQueryKey,
  getListEngagementSubmissionsQueryKey,
  type EngagementSubmissionSummary,
  type SubmissionReceipt,
  type SubmissionStatus,
} from "@workspace/api-client-react";
import { useNavGroups } from "../components/NavGroups";
import { BriefingRecentRunsPanel } from "../components/BriefingRecentRunsPanel";
import { relativeTime } from "../lib/relativeTime";

/**
 * Human-readable label for each {@link SubmissionStatus}, mirroring
 * `SUBMISSION_STATUS_LABELS` in `artifacts/api-server/src/atoms/
 * submission.atom.ts`. Duplicated here (rather than imported) because
 * the api-server package is a server-side workspace and the FE cannot
 * import from it; both sides are kept in lock-step by the
 * `SubmissionStatus` enum's exhaustive `Record` typing.
 */
const SUBMISSION_STATUS_LABELS: Record<SubmissionStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  corrections_requested: "Corrections requested",
  rejected: "Rejected",
};

/**
 * Per-status badge palette, keyed off the existing SmartCity theme
 * tokens (see `lib/portal-ui/src/styles/smartcity-themes.css`) so the
 * pill picks up the correct dark/light contrast automatically:
 *   - approved → success (green)
 *   - corrections_requested → warning (amber)
 *   - rejected → danger (red)
 *   - pending → info (blue) — neutral "awaiting reply" state, kept
 *     visually distinct from the muted body copy so reviewers can
 *     scan the list and spot pending packages at a glance.
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
 * EngagementDetail — Plan Review's per-engagement surface (Task #83).
 *
 * Task #75 originally asked for the past-submissions list to live on
 * the plan-review side, but plan-review had no engagement detail page
 * (the existing routes are ReviewConsole, Sheets, FindingsLibrary,
 * SubmittalDetail, etc., all keyed off mock submittal IDs rather than
 * server-side engagement IDs). This page is that missing surface: it
 * deep-links by engagement id (`/engagements/:id`) and reuses the
 * generated `useListEngagementSubmissions` hook against
 * `GET /api/engagements/:id/submissions`, so a Plan Review user can
 * see prior packages submitted to a jurisdiction without bouncing to
 * the design-tools artifact.
 *
 * The submission row layout mirrors the `SubmissionsTab` in
 * `design-tools/src/pages/EngagementDetail.tsx` (jurisdiction label,
 * relative-time with a tooltip of the absolute timestamp, optional
 * pre-wrapped note) so the two surfaces stay visually consistent.
 *
 * Task #88 added a parallel "Submit to jurisdiction" action next to
 * the Past Submissions list so reviewers can record a new package
 * without bouncing to design-tools. The dialog is mirrored from the
 * design-tools copy (artifacts never import each other) and reuses
 * the generated `useCreateEngagementSubmission` hook; on success it
 * invalidates `getListEngagementSubmissionsQueryKey(id)` so the new
 * row appears immediately.
 */
export default function EngagementDetail() {
  const navGroups = useNavGroups();
  const params = useParams();
  const id = params.id as string;
  const [submitOpen, setSubmitOpen] = useState(false);
  // Top-bar search filters the past-submissions list by jurisdiction,
  // status, note, or reviewer comment (Task #111). The query is held
  // here so the layout's `Header` and the list both see the same
  // value, mirroring the wiring in EngagementsList (Task #95).
  const [searchQuery, setSearchQuery] = useState("");
  // Last successful jurisdiction submission, surfaced as a non-blocking
  // confirmation banner above the past-submissions list (Task #100).
  // We keep the full receipt (not just `submittedAt`) so a future
  // "View on timeline" affordance can deep-link by `submissionId`
  // without another round trip — matching the design-tools convention.
  // The `jurisdiction` snapshot is captured separately because the
  // server `SubmissionReceipt` shape does not carry it; pinning the
  // value at submit-time means a same-session edit to the engagement's
  // jurisdiction won't retroactively rewrite the banner copy.
  const [lastSubmission, setLastSubmission] = useState<{
    receipt: SubmissionReceipt;
    jurisdiction: string | null;
  } | null>(null);
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

  const { data: engagement, isLoading: engagementLoading } = useGetEngagement(
    id,
    {
      query: {
        enabled: !!id,
        queryKey: getGetEngagementQueryKey(id),
      },
    },
  );

  const title = engagement?.name ?? `Engagement ${id}`;
  const subtitleParts = [
    engagement?.jurisdiction,
    engagement?.site?.address ?? engagement?.address ?? null,
  ].filter((s): s is string => !!s);

  // The submit affordance only makes sense once the engagement
  // record has loaded — we need its name (and jurisdiction, when
  // present) to title the confirmation dialog. Disable instead of
  // hide so the button keeps its place in the layout while loading.
  const canSubmit = !!engagement && !!id;

  return (
    <DashboardLayout
      title={title}
      navGroups={navGroups}
      brandLabel="SMARTCITY OS"
      brandProductName="Plan Review"
      search={{
        placeholder: "Search submissions...",
        value: searchQuery,
        onChange: setSearchQuery,
      }}
    >
      <div className="flex flex-col gap-6">
        <div>
          <Link
            href="/"
            className="sc-meta"
            style={{ color: "var(--text-secondary)" }}
          >
            ← Back to Inbox
          </Link>
          <h2
            className="text-[22px] font-bold font-['Oxygen'] text-[var(--text-primary)]"
            style={{ marginTop: 8 }}
          >
            {engagementLoading ? "Loading engagement…" : title}
          </h2>
          {subtitleParts.length > 0 && (
            <div className="sc-body mt-1">{subtitleParts.join(" · ")}</div>
          )}
        </div>

        {lastSubmission && (
          <SubmissionRecordedBanner
            submittedAt={lastSubmission.receipt.submittedAt}
            jurisdiction={lastSubmission.jurisdiction}
            onDismiss={() => setLastSubmission(null)}
          />
        )}

        <SubmissionsList
          engagementId={id}
          onSubmit={() => setSubmitOpen(true)}
          canSubmit={canSubmit}
          searchQuery={searchQuery}
        />

        {/*
          Task #261 — auditor-side mirror of the Design Tools "Recent
          runs" disclosure (Task #230). External reviewers who land in
          Plan Review can now spot a suspicious briefing-generation
          attempt (failed run, completed run with stripped citations)
          without bouncing across to Design Tools to investigate. The
          panel only fetches `/engagements/:id/briefing/runs` once the
          disclosure is actually opened, so a page load that never
          touches it costs zero extra round trips.
        */}
        {id && <BriefingRecentRunsPanel engagementId={id} />}
      </div>

      {engagement && (
        <SubmitToJurisdictionDialog
          engagementId={engagement.id}
          engagementName={engagement.name}
          jurisdiction={engagement.jurisdiction ?? null}
          isOpen={submitOpen}
          onClose={() => setSubmitOpen(false)}
          onSubmitted={(receipt) =>
            setLastSubmission({
              receipt,
              jurisdiction: engagement.jurisdiction ?? null,
            })
          }
        />
      )}
    </DashboardLayout>
  );
}

function SubmissionsList({
  engagementId,
  onSubmit,
  canSubmit,
  searchQuery,
}: {
  engagementId: string;
  onSubmit: () => void;
  canSubmit: boolean;
  searchQuery: string;
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

  const trimmedQuery = searchQuery.trim().toLowerCase();
  const filteredSubmissions = useMemo(() => {
    if (!submissions) return submissions;
    if (!trimmedQuery) return submissions;
    return submissions.filter((s) => {
      const haystack = [
        s.jurisdiction,
        s.status,
        s.note,
        s.reviewerComment,
      ]
        .filter((v): v is string => !!v)
        .join(" ")
        .toLowerCase();
      return haystack.includes(trimmedQuery);
    });
  }, [submissions, trimmedQuery]);

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
        style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}
      >
        <div className="sc-prose opacity-70" style={{ maxWidth: 480 }}>
          No submissions recorded for this engagement yet. Once a
          package is submitted to a jurisdiction, it will appear here.
        </div>
        <button
          type="button"
          className="sc-btn-primary"
          onClick={onSubmit}
          disabled={!canSubmit}
          data-testid="submit-jurisdiction-trigger"
        >
          Submit to jurisdiction
        </button>
      </div>
    );
  }

  const visibleSubmissions = filteredSubmissions ?? [];
  return (
    <div className="sc-card flex flex-col" data-testid="submissions-list">
      <div
        className="sc-card-header sc-row-sb"
        style={{ display: "flex", alignItems: "center", gap: 12 }}
      >
        <span className="sc-label">PAST SUBMISSIONS</span>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="sc-meta">
            {trimmedQuery
              ? `${visibleSubmissions.length} of ${submissions.length} items`
              : `${submissions.length} total`}
          </span>
          <button
            type="button"
            className="sc-btn-primary"
            onClick={onSubmit}
            disabled={!canSubmit}
            data-testid="submit-jurisdiction-trigger"
          >
            Submit to jurisdiction
          </button>
        </div>
      </div>
      <div className="flex flex-col">
        {visibleSubmissions.length === 0 ? (
          <div
            className="p-6 text-center sc-body"
            data-testid="submissions-no-matches"
          >
            No submissions match “{searchQuery.trim()}”. Try a different
            jurisdiction, status, or note.
          </div>
        ) : (
          visibleSubmissions.map((s: EngagementSubmissionSummary) => (
            <SubmissionRow key={s.id} submission={s} />
          ))
        )}
      </div>
    </div>
  );
}

/**
 * SubmissionRow — single row in the past-submissions list (Task #86).
 *
 * The row is a vertical stack of three optional sections:
 *   1. Header line: jurisdiction label + status badge + relative
 *      "submitted at" timestamp (the badge sits next to the
 *      jurisdiction so reviewers can spot pending vs. responded
 *      packages without scanning the timestamp column).
 *   2. Reviewer comment (when present) — the same muted body style
 *      as the existing submission note. Rendered with `whiteSpace:
 *      pre-wrap` so multi-line replies survive intact.
 *   3. Submission note (the original outbound free-text from the
 *      submitter) — kept underneath the reviewer comment so the
 *      back-and-forth reads top-down (jurisdiction reply, then the
 *      package note that was sent in).
 *
 * The "responded at" timestamp lives on a meta line beneath the
 * reviewer comment when a reply has been recorded. It uses the same
 * `relativeTime()` helper as the "submitted at" stamp so the two
 * timestamps render in matching human-friendly form.
 */
function SubmissionRow({
  submission: s,
}: {
  submission: EngagementSubmissionSummary;
}) {
  // The OpenAPI contract guarantees `status` is always present
  // (defaulted to "pending" by the row schema), so we can drive the
  // badge unconditionally; reviewer comment and respondedAt remain
  // optional and only render when actually populated.
  const status = s.status;
  const hasResponse = status !== "pending" && s.respondedAt != null;
  return (
    <div
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
        style={{ display: "flex", alignItems: "center", gap: 12 }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
          }}
        >
          <span
            className="sc-medium"
            style={{ color: "var(--text-primary)", fontSize: 13 }}
          >
            {s.jurisdiction ?? "Jurisdiction not recorded"}
          </span>
          <SubmissionStatusBadge status={status} />
        </div>
        <span
          className="sc-meta"
          title={new Date(s.submittedAt).toLocaleString()}
          style={{ color: "var(--text-secondary)", fontSize: 11 }}
        >
          {relativeTime(s.submittedAt)}
        </span>
      </div>
      {hasResponse && (
        <div
          data-testid={`submission-response-${s.id}`}
          style={{ display: "flex", flexDirection: "column", gap: 2 }}
        >
          {s.reviewerComment && (
            <ReviewerComment
              submissionId={s.id}
              comment={s.reviewerComment}
            />
          )}
          <span
            className="sc-meta"
            data-testid={`submission-responded-at-${s.id}`}
            title={new Date(s.respondedAt!).toLocaleString()}
            style={{ color: "var(--text-secondary)", fontSize: 11 }}
          >
            Responded {relativeTime(s.respondedAt)}
          </span>
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
          }}
        >
          {s.note}
        </div>
      )}
    </div>
  );
}
