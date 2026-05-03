import { useMemo, useState } from "react";
import { DashboardLayout } from "@workspace/portal-ui";
import {
  useListReviewerQueue,
  getListReviewerQueueQueryKey,
  type SubmissionStatus,
} from "@workspace/api-client-react";
import { useNavGroups } from "../components/NavGroups";
import { useSessionAudience } from "../lib/session";
import {
  ReviewerQueueList,
  filterReviewerQueueItems,
} from "../components/ReviewerQueueList";

interface QueueBucketPageProps {
  status: SubmissionStatus;
  title: string;
  emptyMessage: string;
  cardLabel: string;
  testIdPrefix: string;
  /**
   * Server-side ordering for the queue. `submittedAt` (default)
   * matches the Inbox; the Approved / Rejected pages pass
   * `respondedAt` so freshest decisions surface first.
   */
  order?: "submittedAt" | "respondedAt";
}

export default function QueueBucketPage({
  status,
  title,
  emptyMessage,
  cardLabel,
  testIdPrefix,
  order,
}: QueueBucketPageProps) {
  const navGroups = useNavGroups();
  const { audience, isLoading: audienceLoading } = useSessionAudience();
  // The reviewer-queue endpoint 403s any non-internal audience;
  // skip the fetch and render an inline access-denied banner.
  const enabled = audience === "internal";

  const params = useMemo(
    () => (order ? { status, order } : { status }),
    [status, order],
  );

  const { data, isLoading, isError } = useListReviewerQueue(params, {
    query: {
      queryKey: getListReviewerQueueQueryKey(params),
      enabled,
    },
  });

  const items = data?.items ?? [];

  const [searchQuery, setSearchQuery] = useState("");
  const trimmedQuery = searchQuery.trim();
  const filteredItems = useMemo(
    () => filterReviewerQueueItems(items, trimmedQuery),
    [items, trimmedQuery],
  );
  const renderedCount = filteredItems.length;
  const totalCount = items.length;

  return (
    <DashboardLayout
      title={title}
      navGroups={navGroups}
      brandLabel="SMARTCITY OS"
      brandProductName="Plan Review"
      search={{
        placeholder: "Search submittals...",
        value: searchQuery,
        onChange: setSearchQuery,
      }}
    >
      <div className="flex flex-col gap-6">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-[22px] font-bold font-['Oxygen'] text-[var(--text-primary)] m-0">
              {title}
            </h2>
            <div
              className="sc-body mt-1"
              data-testid={`${testIdPrefix}-summary`}
            >
              {!enabled
                ? audienceLoading
                  ? "Loading session…"
                  : "Reviewer-only view"
                : isLoading
                  ? "Loading…"
                  : `${renderedCount} ${
                      renderedCount === 1 ? "submission" : "submissions"
                    }`}
            </div>
          </div>
        </div>

        <div className="sc-card">
          <div className="sc-card-header sc-row-sb">
            <span className="sc-label">{cardLabel}</span>
            <span className="sc-meta">
              {trimmedQuery
                ? `${renderedCount} of ${totalCount} items`
                : `${totalCount} items`}
            </span>
          </div>
          <div
            className="flex flex-col"
            data-testid={`${testIdPrefix}-list`}
          >
            {!enabled ? (
              <div
                className="p-8 text-center sc-body"
                data-testid={`${testIdPrefix}-not-reviewer`}
              >
                {audienceLoading
                  ? "Loading session…"
                  : `${title} is reviewer-only.`}
              </div>
            ) : (
              <ReviewerQueueList
                items={items}
                isLoading={isLoading}
                isError={isError}
                searchQuery={searchQuery}
                emptyMessage={emptyMessage}
              />
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
