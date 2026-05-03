import QueueBucketPage from "./QueueBucketPage";

// `corrections_requested` is the bucket the Inbox counts as "in review".
export default function InReview() {
  return (
    <QueueBucketPage
      status="corrections_requested"
      title="In Review"
      cardLabel="IN REVIEW"
      testIdPrefix="in-review"
      emptyMessage="No submissions are awaiting corrections right now."
    />
  );
}
