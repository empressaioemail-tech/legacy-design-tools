import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import type {
  ReviewerQueueItem,
  SubmissionStatus,
} from "@workspace/api-client-react";
import { relativeTime } from "../lib/relativeTime";

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
  searchQuery?: string;
  emptyMessage?: string;
}

export function ReviewerQueueList({
  items,
  isLoading,
  isError,
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
