import { Link } from "wouter";
import { AppShell } from "../components/AppShell";
import { TabHeader } from "../components/cockpit/TabChrome";
import { DEMO_INBOX_ITEMS, isDemoSeedEnabled } from "../demo/seed";
import { relativeTime } from "../lib/relativeTime";
import { Inbox, AlertCircle, Bell, Sparkles } from "lucide-react";

function kindLabel(kind: (typeof DEMO_INBOX_ITEMS)[number]["kind"]): string {
  switch (kind) {
    case "needs-you":
      return "Needs you";
    case "reviewer":
      return "Reviewer";
    default:
      return "FYI";
  }
}

function KindIcon({
  kind,
}: {
  kind: (typeof DEMO_INBOX_ITEMS)[number]["kind"];
}) {
  if (kind === "needs-you") return <AlertCircle size={16} />;
  if (kind === "reviewer") return <Sparkles size={16} />;
  return <Bell size={16} />;
}

/**
 * Workspace inbox — ActionQueue-style triage (demo seed when enabled).
 */
export function InboxPage() {
  const needsYou = DEMO_INBOX_ITEMS.filter((i) => i.kind === "needs-you");
  const fyi = DEMO_INBOX_ITEMS.filter((i) => i.kind === "fyi");
  const reviewer = DEMO_INBOX_ITEMS.filter((i) => i.kind === "reviewer");

  return (
    <AppShell>
      <div className="cockpit-inbox-page" data-testid="inbox-page">
        <TabHeader
          overline="Workspace"
          title="Inbox"
          subtitle="Cross-project queue: client comments, reviewer requests, and system events. Open a row to jump into the engagement."
          testId="inbox-tab-header"
        />

        {!isDemoSeedEnabled() && (
          <p className="sc-prose opacity-70" data-testid="inbox-live-hint">
            Set <code>VITE_DEMO_SEED=1</code> for demo queue rows during local UI
            work. Live notifications still flow through{" "}
            <Link href="/notifications" className="sc-link">
              legacy notifications
            </Link>
            .
          </p>
        )}

        <section className="cockpit-inbox-section" data-testid="inbox-needs-you">
          <h2 className="cockpit-inbox-section-title">
            <Inbox size={16} aria-hidden="true" />
            Needs you
            <span className="cockpit-inbox-count">{needsYou.length}</span>
          </h2>
          <ul className="cockpit-inbox-list">
            {needsYou.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/engagements/${item.engagementId}?view=review`}
                  className="cockpit-inbox-row"
                  data-testid={`inbox-row-${item.id}`}
                >
                  <span
                    className="cockpit-inbox-row-accent"
                    data-kind={item.kind}
                    aria-hidden="true"
                  />
                  <span className="cockpit-inbox-row-icon">
                    <KindIcon kind={item.kind} />
                  </span>
                  <span className="cockpit-inbox-row-body">
                    <span className="cockpit-inbox-row-title">{item.title}</span>
                    <span className="cockpit-inbox-row-preview">{item.preview}</span>
                    <span className="cockpit-inbox-row-meta">
                      {item.engagementName} · {relativeTime(item.createdAt)}
                    </span>
                  </span>
                  <span className="cockpit-inbox-row-pill">{kindLabel(item.kind)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section className="cockpit-inbox-section" data-testid="inbox-reviewer">
          <h2 className="cockpit-inbox-section-title">Reviewer</h2>
          <ul className="cockpit-inbox-list">
            {reviewer.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/engagements/${item.engagementId}?view=review&segment=findings`}
                  className="cockpit-inbox-row"
                  data-testid={`inbox-row-${item.id}`}
                >
                  <span className="cockpit-inbox-row-accent" data-kind={item.kind} />
                  <span className="cockpit-inbox-row-body">
                    <span className="cockpit-inbox-row-title">{item.title}</span>
                    <span className="cockpit-inbox-row-preview">{item.preview}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section className="cockpit-inbox-section" data-testid="inbox-fyi">
          <h2 className="cockpit-inbox-section-title">FYI</h2>
          <ul className="cockpit-inbox-list">
            {fyi.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/engagements/${item.engagementId}`}
                  className="cockpit-inbox-row"
                  data-testid={`inbox-row-${item.id}`}
                >
                  <span className="cockpit-inbox-row-body">
                    <span className="cockpit-inbox-row-title">{item.title}</span>
                    <span className="cockpit-inbox-row-preview">{item.preview}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </AppShell>
  );
}
