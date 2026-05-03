import QueueBucketPage from "./QueueBucketPage";

export default function Rejected() {
  return (
    <QueueBucketPage
      status="rejected"
      title="Rejected"
      cardLabel="REJECTED"
      testIdPrefix="rejected"
      emptyMessage="Nothing has been rejected. Good news."
    />
  );
}
