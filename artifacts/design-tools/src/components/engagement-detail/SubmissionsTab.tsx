import { useMemo } from "react";
import {
  useListEngagementSubmissions,
  getListEngagementSubmissionsQueryKey,
  type EngagementSubmissionSummary,
  type SubmissionStatus,
} from "@workspace/api-client-react";
import { ReviewerComment } from "@workspace/portal-ui";
import { relativeTime } from "../../lib/relativeTime";
import {
  backfillAnnotation,
  formatBackfillTally,
  matchesBackfillFilter,
  summarizeBackfillTallies,
  type BackfillFilter,
} from "../../lib/submissionBackfill";

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
 * two surfaces stay consistent. The architect view is read-only
 * with respect to verdicts: reviewer responses are recorded in
 * plan-review via `DecideModal` (PLR-6); this list simply
 * surfaces whatever the listing query returns.
 *
 * Pagination is still a follow-up: engagements typically accumulate
 * a handful of packages, so a bare array is fine for now.
 */
export function SubmissionsTab({
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

  // The architect-side submissions tab is read-only since the
  // legacy `/response` route was retired (Task #479). Reviewer
  // verdicts are recorded in plan-review via `DecideModal`
  // (PLR-6); this view simply renders whatever the listing query
  // returns.
  const resolvedSubmissions = useMemo(() => {
    if (!submissions) return [];
    return submissions.map((s) => ({
      row: s,
      respondedAt: s.respondedAt,
      responseRecordedAt: s.responseRecordedAt,
    }));
  }, [submissions]);

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
            // present on the row; reviewer comment, respondedAt,
            // and responseRecordedAt remain optional. The legacy
            // local-mirror was removed alongside the retired
            // `/response` route (Task #479) — verdicts now flow in
            // exclusively from the plan-review DecideModal.
            const status: SubmissionStatus = s.status;
            const reviewerComment: string | null = s.reviewerComment;
            const respondedAt: string | null = s.respondedAt;
            const responseRecordedAt: string | null = s.responseRecordedAt;
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
    </>
  );
}
