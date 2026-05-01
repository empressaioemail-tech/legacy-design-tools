import { useParams, Link } from "wouter";
import { DashboardLayout } from "@workspace/portal-ui";
import {
  useGetEngagement,
  useListEngagementSubmissions,
  getGetEngagementQueryKey,
  getListEngagementSubmissionsQueryKey,
  type EngagementSubmissionSummary,
} from "@workspace/api-client-react";
import { navGroups } from "../components/NavGroups";
import { relativeTime } from "../lib/relativeTime";

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
  const params = useParams();
  const id = params.id as string;

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
          <div
            key={s.id}
            className="sc-card-row"
            data-testid={`submission-row-${s.id}`}
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid var(--border-default)",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <div
              className="sc-row-sb"
              style={{ display: "flex", alignItems: "baseline", gap: 12 }}
            >
              <span
                className="sc-medium"
                style={{ color: "var(--text-primary)", fontSize: 13 }}
              >
                {s.jurisdiction ?? "Jurisdiction not recorded"}
              </span>
              <span
                className="sc-meta"
                title={new Date(s.submittedAt).toLocaleString()}
                style={{ color: "var(--text-secondary)", fontSize: 11 }}
              >
                {relativeTime(s.submittedAt)}
              </span>
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
          </div>
        ))}
      </div>
    </div>
  );
}
