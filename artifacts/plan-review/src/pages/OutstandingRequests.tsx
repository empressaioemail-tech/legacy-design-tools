import { useMemo } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { ChevronRight } from "lucide-react";
import { DashboardLayout } from "@workspace/portal-ui";
import {
  useListMyReviewerRequests,
  getListMyReviewerRequestsQueryKey,
  type ReviewerRequestStatus,
  type ReviewerRequestWithEngagement,
} from "@workspace/api-client-react";
import { useNavGroups } from "../components/NavGroups";
import { useSessionAudience } from "../lib/session";
import { relativeTime } from "../lib/relativeTime";

// Cross-engagement reviewer-side queue. Server-side ownership scoping
// is the source-of-truth; this page is purely a presentation surface
// over `GET /api/reviewer-requests`.

type StatusFilter = "pending" | "all";

const FILTER_TABS: ReadonlyArray<{
  value: StatusFilter;
  label: string;
  testId: string;
}> = [
  { value: "pending", label: "Pending", testId: "requests-filter-pending" },
  { value: "all", label: "All", testId: "requests-filter-all" },
];

const FILTER_HEADER: Record<StatusFilter, string> = {
  pending: "OUTSTANDING REQUESTS",
  all: "ALL REQUESTS",
};

const FILTER_EMPTY: Record<StatusFilter, string> = {
  pending: "You have no outstanding requests.",
  all: "You have no requests in your history.",
};

const KIND_LABEL: Record<string, string> = {
  "refresh-briefing-source": "Refresh briefing source",
  "refresh-bim-model": "Refresh BIM model",
  "regenerate-briefing": "Regenerate briefing",
};

const STATUS_LABEL: Record<ReviewerRequestStatus, string> = {
  pending: "Pending",
  dismissed: "Dismissed",
  resolved: "Resolved",
};

const STATUS_PILL_CLASS: Record<ReviewerRequestStatus, string> = {
  pending: "sc-pill sc-pill-amber",
  dismissed: "sc-pill sc-pill-muted",
  resolved: "sc-pill sc-pill-green",
};

const VALID_FILTERS = new Set<StatusFilter>(["pending", "all"]);

function parseFilterFromSearch(search: string): StatusFilter {
  const params = new URLSearchParams(search);
  const raw = params.get("status");
  if (raw && VALID_FILTERS.has(raw as StatusFilter)) {
    return raw as StatusFilter;
  }
  return "pending";
}

function RequestRow({ row }: { row: ReviewerRequestWithEngagement }) {
  const kindLabel = KIND_LABEL[row.requestKind] ?? row.requestKind;
  const status = row.status as ReviewerRequestStatus;
  const subtitleParts = [row.engagement.jurisdiction].filter(
    (s): s is string => !!s,
  );
  return (
    <Link
      href={`/engagements/${row.engagement.id}`}
      className="sc-card-row flex items-center gap-3 no-underline"
      data-testid={`request-row-${row.id}`}
    >
      <div className="flex flex-col min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <div className="sc-medium truncate">{row.engagement.name}</div>
          <span
            className={`${STATUS_PILL_CLASS[status]} shrink-0`}
            data-testid={`request-row-status-${row.id}`}
          >
            {STATUS_LABEL[status]}
          </span>
          <span
            className="sc-pill sc-pill-cyan capitalize shrink-0"
            data-testid={`request-row-kind-${row.id}`}
          >
            {kindLabel}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-1 min-w-0">
          <span className="sc-meta truncate">
            {subtitleParts.length > 0
              ? subtitleParts.join(" · ") + " · "
              : ""}
            {row.reason}
          </span>
        </div>
      </div>

      <div className="hidden md:block sc-mono-sm shrink-0 w-28 text-right text-[var(--text-secondary)]">
        {relativeTime(row.requestedAt)}
      </div>

      <ChevronRight size={14} className="text-[var(--text-muted)] shrink-0" />
    </Link>
  );
}

export default function OutstandingRequests() {
  const navGroups = useNavGroups();
  const { audience, isLoading: audienceLoading } = useSessionAudience();

  const search = useSearch();
  const [location, setLocation] = useLocation();
  const filter = parseFilterFromSearch(search);

  // Endpoint 403s any non-reviewer audience; skip the request and
  // render an inline access-denied banner instead.
  const enabled = audience === "internal";

  const { data, isLoading, isError, refetch, isFetching } =
    useListMyReviewerRequests(
      { status: filter },
      {
        query: {
          queryKey: getListMyReviewerRequestsQueryKey({ status: filter }),
          enabled,
        },
      },
    );

  const setFilter = (next: StatusFilter) => {
    const params = new URLSearchParams(search);
    if (next === "pending") {
      params.delete("status");
    } else {
      params.set("status", next);
    }
    const qs = params.toString();
    setLocation(qs ? `${location}?${qs}` : location, { replace: true });
  };

  const requests = useMemo(() => data?.requests ?? [], [data]);
  const summaryNoun =
    filter === "pending"
      ? requests.length === 1
        ? "outstanding request"
        : "outstanding requests"
      : requests.length === 1
        ? "request"
        : "requests";

  return (
    <DashboardLayout
      title="Outstanding Requests"
      navGroups={navGroups}
      brandLabel="SMARTCITY OS"
      brandProductName="Plan Review"
    >
      <div className="flex flex-col gap-6">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-[22px] font-bold font-['Oxygen'] text-[var(--text-primary)] m-0">
              Outstanding Requests
            </h2>
            <div
              className="sc-body mt-1"
              data-testid="requests-summary"
            >
              {requests.length} {summaryNoun}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              className="sc-btn-ghost"
              onClick={() => refetch()}
              disabled={isFetching || !enabled}
              data-testid="requests-refresh"
            >
              {isFetching ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        <div
          role="tablist"
          aria-label="Filter reviewer requests by status"
          className="flex items-center gap-2 flex-wrap"
          data-testid="requests-filter"
        >
          {FILTER_TABS.map((tab) => {
            const selected = filter === tab.value;
            return (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setFilter(tab.value)}
                data-testid={tab.testId}
                className={selected ? "sc-btn-primary" : "sc-btn-sm"}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="sc-card">
          <div className="sc-card-header sc-row-sb">
            <span className="sc-label">{FILTER_HEADER[filter]}</span>
            <span className="sc-meta">{requests.length} items</span>
          </div>
          <div className="flex flex-col" data-testid="requests-list">
            {!enabled ? (
              <div
                className="p-8 text-center sc-body"
                data-testid="requests-not-reviewer"
              >
                {audienceLoading
                  ? "Loading session…"
                  : "Outstanding Requests is reviewer-only."}
              </div>
            ) : isLoading ? (
              <div
                className="p-8 text-center sc-body"
                data-testid="requests-loading"
              >
                Loading requests…
              </div>
            ) : isError ? (
              <div
                className="p-8 text-center sc-body text-[var(--danger)]"
                data-testid="requests-error"
              >
                Couldn't load requests. Try refreshing.
              </div>
            ) : requests.length === 0 ? (
              <div
                className="p-8 text-center sc-body"
                data-testid="requests-empty"
              >
                {FILTER_EMPTY[filter]}
              </div>
            ) : (
              requests.map((r) => <RequestRow key={r.id} row={r} />)
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
