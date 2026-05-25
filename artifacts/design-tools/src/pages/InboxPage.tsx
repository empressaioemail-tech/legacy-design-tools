import { AppShell } from "../components/AppShell";
import { InboxActionQueue } from "../components/inbox/InboxActionQueue";

/** Full inbox triage — buckets, mentions, FYI, filters, and today's plan. */
export function InboxPage() {
  return (
    <AppShell title="Inbox">
      <div className="cockpit-inbox-page">
        <InboxActionQueue />
      </div>
    </AppShell>
  );
}
