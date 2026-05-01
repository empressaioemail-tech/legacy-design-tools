import { useParams, Link } from "wouter";
import { DashboardLayout } from "@workspace/portal-ui";
import {
  useGetEngagement,
  useListEngagementSubmissions,
  getGetEngagementQueryKey,
  getListEngagementSubmissionsQueryKey,
  type EngagementSubmissionSummary,
  type SubmissionStatus,
} from "@workspace/api-client-react";
import { useNavGroups } from "../components/NavGroups";
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
 * pre-wrapped note) so the two surfaces stay visually consistent. We
 * deliberately do NOT host the "Submit to jurisdiction" action here
 * — that flow lives in the design-tools workflow and Task #75's
 * acceptance only required read-side parity inside plan-review.
 */
export default function EngagementDetail() {
  const navGroups = useNavGroups();
  const params = useParams();
  const id = params.id as string;
  const navGroups = useNavGroups();

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

  return (
    <DashboardLayout
      title={title}
      navGroups={navGroups}
      brandLabel="SMARTCITY OS"
      brandProductName="Plan Review"
      search={{ placeholder: "Search submittals..." }}
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

        <SubmissionsList engagementId={id} />
      </div>
    </DashboardLayout>
  );
}

function SubmissionsList({ engagementId }: { engagementId: string }) {
  const { data: submissions, isLoading } = useListEngagementSubmissions(
    engagementId,
    {
      query: {
        enabled: !!engagementId,
        queryKey: getListEngagementSubmissionsQueryKey(engagementId),
      },
    },
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
          No submissions recorded for this engagement yet. Once a
          package is submitted to a jurisdiction, it will appear here.
        </div>
      </div>
    );
  }

  return (
    <div className="sc-card flex flex-col" data-testid="submissions-list">
      <div className="sc-card-header sc-row-sb">
        <span className="sc-label">PAST SUBMISSIONS</span>
        <span className="sc-meta">{submissions.length} total</span>
      </div>
      <div className="flex flex-col">
        {submissions.map((s: EngagementSubmissionSummary) => (
          <SubmissionRow key={s.id} submission={s} />
        ))}
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
            <div
              className="sc-body"
              data-testid={`submission-reviewer-comment-${s.id}`}
              style={{
                color: "var(--text-primary)",
                fontSize: 12,
                whiteSpace: "pre-wrap",
                borderLeft: "2px solid var(--border-active)",
                paddingLeft: 8,
              }}
            >
              {s.reviewerComment}
            </div>
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
