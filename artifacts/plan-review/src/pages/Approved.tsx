import QueueBucketPage from "./QueueBucketPage";

export default function Approved() {
  return (
    <QueueBucketPage
      status="approved"
      title="Approved"
      cardLabel="APPROVED"
      testIdPrefix="approved"
      emptyMessage="No approved submissions yet."
      order="respondedAt"
    />
  );
}
