import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import {
  ApiError,
  type ReviewerQueueItem,
  type SubmissionStatus,
} from "@workspace/api-client-react";
import { relativeTime } from "../lib/relativeTime";
import { setDevSessionAudience } from "../lib/devSession";

const STATUS_PILL_CLASS: Record<SubmissionStatus, string> = {
  pending: "sc-pill-cyan",
  approved: "sc-pill-green",
  corrections_requested: "sc-pill-amber",
  rejected: "sc-pill-red",
};

const STATUS_PILL_LABEL: Record<SubmissionStatus, string> = {
  pending: "pending",
  approved: "approved",
  corrections_requested: "corrections",
  rejected: "rejected",
};

export function ReviewerQueueRow({ item }: { item: ReviewerQueueItem }) {
  const initials = item.engagementName
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const subtitleParts = [item.jurisdiction, item.address].filter(
    (s): s is string => !!s,
  );

  // EngagementDetail reads ?submission=&tab=note on mount to open the
  // submission modal directly to the Note tab.
  const href = `/engagements/${item.engagementId}?submission=${item.submissionId}&tab=note`;

  const pillClass = STATUS_PILL_CLASS[item.status] ?? "sc-pill-muted";
  const pillLabel = STATUS_PILL_LABEL[item.status] ?? item.status;

  return (
    <Link
      href={href}
      className="sc-card-row flex items-center gap-3 no-underline"
      data-testid={`reviewer-queue-row-${item.submissionId}`}
    >
      <div
        className="sc-avatar-mark shrink-0"
        style={{ background: "#6398AA", color: "#0f1318" }}
      >
        {initials || "EN"}
      </div>

      <div className="flex flex-col min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <div className="sc-medium truncate">{item.engagementName}</div>
          {item.applicantFirm ? (
            <span
              className="sc-meta truncate text-[var(--text-secondary)]"
              data-testid={`reviewer-queue-row-${item.submissionId}-firm`}
            >
              · {item.applicantFirm}
            </span>
          ) : null}
          <span className={`sc-pill ${pillClass} capitalize shrink-0`}>
            {pillLabel}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-1 min-w-0">
          {subtitleParts.length > 0 ? (
            <span
              className="sc-meta truncate"
              data-testid={`reviewer-queue-row-${item.submissionId}-subtitle`}
            >
              {subtitleParts.join(" · ")}
            </span>
          ) : (
            <span className="sc-meta opacity-60">
              No applicant, jurisdiction, or address
            </span>
          )}
        </div>
      </div>

      <div
        className="hidden md:block sc-mono-sm shrink-0 w-28 text-right text-[var(--text-secondary)]"
        title={new Date(item.submittedAt).toLocaleString()}
      >
        {relativeTime(item.submittedAt)}
      </div>

      <ChevronRight size={14} className="text-[var(--text-muted)] shrink-0" />
    </Link>
  );
}

export function filterReviewerQueueItems(
  items: ReadonlyArray<ReviewerQueueItem>,
  trimmedQuery: string,
): ReviewerQueueItem[] {
  if (!trimmedQuery) return items.slice();
  const needle = trimmedQuery.toLowerCase();
  return items.filter((s) => {
    const haystack = [
      s.engagementName,
      s.jurisdiction,
      s.address,
      s.applicantFirm,
      s.status,
      s.note,
      s.reviewerComment,
    ]
      .filter((v): v is string => !!v)
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

interface ReviewerQueueListProps {
  items: ReadonlyArray<ReviewerQueueItem>;
  isLoading: boolean;
  isError: boolean;
  /**
   * The error thrown by the underlying React Query call, when
   * available. Used to distinguish a 403 audience-mismatch (the
   * caller's session isn't `internal`) from a generic load failure
   * — the former gets a focused empty state with a one-click
   * switch-to-reviewer affordance instead of the generic
   * "Couldn't load…" copy. See Task #504.
   */
  error?: unknown;
  searchQuery?: string;
  emptyMessage?: string;
}

function isAudienceMismatchError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

function handleSwitchToReviewer() {
  setDevSessionAudience("internal");
  window.location.reload();
}

export function ReviewerQueueList({
  items,
  isLoading,
  isError,
  error,
  searchQuery = "",
  emptyMessage = "No submissions awaiting review. The AI Reviewer is monitoring intake.",
}: ReviewerQueueListProps) {
  if (isLoading) {
    return (
      <div
        className="p-8 text-center sc-body"
        data-testid="review-queue-loading"
      >
        Loading queue…
      </div>
    );
  }
  if (isError) {
    if (isAudienceMismatchError(error)) {
      return (
        <div
          className="p-8 text-center sc-body flex flex-col items-center gap-3"
          data-testid="review-queue-audience-mismatch"
        >
          <div>
            You're signed in as an architect — switch to reviewer to see the
            queue.
          </div>
          {!import.meta.env.PROD ? (
            <button
              type="button"
              className="sc-btn-primary"
              data-testid="review-queue-switch-to-reviewer"
              onClick={handleSwitchToReviewer}
            >
              Switch to reviewer
            </button>
          ) : null}
        </div>
      );
    }
    return (
      <div
        className="p-8 text-center sc-body"
        data-testid="review-queue-error"
      >
        Couldn't load the reviewer queue. Refresh to try again.
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div
        className="p-8 text-center sc-body"
        data-testid="review-queue-empty"
      >
        {emptyMessage}
      </div>
    );
  }
  const filtered = filterReviewerQueueItems(items, searchQuery.trim());
  if (filtered.length === 0) {
    return (
      <div
        className="p-8 text-center sc-body"
        data-testid="review-queue-no-matches"
      >
        No submissions match “{searchQuery.trim()}”. Try a different
        project, jurisdiction, or status.
      </div>
    );
  }
  return (
    <>
      {filtered.map((it) => (
        <ReviewerQueueRow key={it.submissionId} item={it} />
      ))}
    </>
  );
}
