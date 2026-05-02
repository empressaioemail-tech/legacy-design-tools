import { useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { ChevronRight } from "lucide-react";
import { DashboardLayout } from "@workspace/portal-ui";
import {
  useListMyReviewerRequests,
  useWithdrawReviewerRequest,
  getListMyReviewerRequestsQueryKey,
  type ReviewerRequestStatus,
  type ReviewerRequestTargetType,
  type ReviewerRequestWithEngagement,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavGroups } from "../components/NavGroups";
import { useSessionAudience, useSessionUserId } from "../lib/session";
import { relativeTime } from "../lib/relativeTime";

// Cross-engagement reviewer-side queue. Server-side ownership scoping
// is the source-of-truth; this page is purely a presentation surface
// over `GET /api/reviewer-requests`. Task #443 adds the inline
// withdraw affordance + an inline link to the target atom so the
// reviewer can act on (or back out of) their own ask without
// context-switching to the engagement detail tab tree first.

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
  withdrawn: "Withdrawn",
};

const STATUS_PILL_CLASS: Record<ReviewerRequestStatus, string> = {
  pending: "sc-pill sc-pill-amber",
  dismissed: "sc-pill sc-pill-muted",
  resolved: "sc-pill sc-pill-green",
  withdrawn: "sc-pill sc-pill-muted",
};

// Inline-link copy for the target atom column. The reviewer reads
// the row to decide whether to keep / withdraw the ask, so the
// label has to name the *thing they asked about*, not the abstract
// atom kind.
const TARGET_LABEL: Record<ReviewerRequestTargetType, string> = {
  "briefing-source": "Open briefing source",
  "bim-model": "Open BIM model",
  "parcel-briefing": "Open parcel briefing",
};

// Map a target atom to the engagement-detail deep-link that lands
// the reviewer on the right tab/section. We deliberately prefer
// hashes/queries that already exist on EngagementDetail rather than
// inventing new routing; if a future engagement-detail rework
// changes the hash names this map is the single point of update.
function targetHrefFor(row: ReviewerRequestWithEngagement): string {
  const base = `/engagements/${row.engagement.id}`;
  switch (row.targetEntityType as ReviewerRequestTargetType) {
    case "bim-model":
      return `${base}?tab=bim`;
    case "briefing-source":
    case "parcel-briefing":
      return `${base}#briefing`;
    default:
      return base;
  }
}

const VALID_FILTERS = new Set<StatusFilter>(["pending", "all"]);

function parseFilterFromSearch(search: string): StatusFilter {
  const params = new URLSearchParams(search);
  const raw = params.get("status");
  if (raw && VALID_FILTERS.has(raw as StatusFilter)) {
    return raw as StatusFilter;
  }
  return "pending";
}

function RequestRow({
  row,
  isOwn,
  filter,
}: {
  row: ReviewerRequestWithEngagement;
  isOwn: boolean;
  filter: StatusFilter;
}) {
  const kindLabel = KIND_LABEL[row.requestKind] ?? row.requestKind;
  const status = row.status as ReviewerRequestStatus;
  const subtitleParts = [row.engagement.jurisdiction].filter(
    (s): s is string => !!s,
  );
  const targetLabel =
    TARGET_LABEL[row.targetEntityType as ReviewerRequestTargetType] ??
    "Open target";
  const targetHref = targetHrefFor(row);

  const queryClient = useQueryClient();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const withdrawMutation = useWithdrawReviewerRequest({
    mutation: {
      onSuccess: async () => {
        // Invalidate every cached variant of the cross-engagement
        // list so the row disappears from `?status=pending` and
        // re-appears under `?status=all` with its new `withdrawn`
        // pill — without us having to manually surgery the cache.
        await queryClient.invalidateQueries({
          queryKey: getListMyReviewerRequestsQueryKey({ status: "pending" }),
        });
        await queryClient.invalidateQueries({
          queryKey: getListMyReviewerRequestsQueryKey({ status: "all" }),
        });
      },
      onError: () => {
        setErrorMessage("Couldn't withdraw — try again.");
      },
    },
  });

  // Only the *original requester* can withdraw, and only while the
  // row is still pending. The server enforces both gates; the FE
  // mirrors them so the affordance is hidden when it would 403/409.
  const canWithdraw = isOwn && status === "pending";

  const handleWithdraw = () => {
    if (!canWithdraw || withdrawMutation.isPending) return;
    setErrorMessage(null);
    withdrawMutation.mutate({ id: row.id, data: {} });
  };

  return (
    <div
      className="sc-card-row flex items-center gap-3"
      data-testid={`request-row-${row.id}`}
    >
      <Link
        href={`/engagements/${row.engagement.id}`}
        className="flex flex-col min-w-0 flex-1 no-underline"
        data-testid={`request-row-link-${row.id}`}
      >
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
      </Link>

      <div className="hidden md:flex flex-col items-end gap-1 shrink-0">
        <Link
          href={targetHref}
          className="sc-link sc-mono-sm"
          data-testid={`request-row-target-${row.id}`}
        >
          {targetLabel}
        </Link>
        <span className="sc-mono-sm w-28 text-right text-[var(--text-secondary)]">
          {relativeTime(row.requestedAt)}
        </span>
      </div>

      {canWithdraw ? (
        <button
          type="button"
          className="sc-btn-sm shrink-0"
          onClick={handleWithdraw}
          disabled={withdrawMutation.isPending}
          data-testid={`request-row-withdraw-${row.id}`}
          aria-label={`Withdraw request for ${row.engagement.name}`}
        >
          {withdrawMutation.isPending ? "Withdrawing…" : "Withdraw"}
        </button>
      ) : null}

      <Link
        href={`/engagements/${row.engagement.id}`}
        className="no-underline"
        aria-label={`Open ${row.engagement.name}`}
        data-testid={`request-row-chevron-${row.id}`}
      >
        <ChevronRight size={14} className="text-[var(--text-muted)] shrink-0" />
      </Link>

      {errorMessage ? (
        <span
          className="sr-only"
          role="alert"
          data-testid={`request-row-withdraw-error-${row.id}`}
        >
          {errorMessage}
        </span>
      ) : null}

      {filter === "pending" ? null : null}
    </div>
  );
}

export default function OutstandingRequests() {
  const navGroups = useNavGroups();
  const { audience, isLoading: audienceLoading } = useSessionAudience();
  const sessionUserId = useSessionUserId();

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
              requests.map((r) => (
                <RequestRow
                  key={r.id}
                  row={r}
                  filter={filter}
                  isOwn={
                    sessionUserId !== null &&
                    (r.requestedBy as { id?: string }).id === sessionUserId
                  }
                />
              ))
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
