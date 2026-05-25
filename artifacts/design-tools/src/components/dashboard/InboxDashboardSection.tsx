import { useMemo, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ChevronRight, Inbox } from "lucide-react";
import {
  DEMO_INBOX_ITEMS,
  inboxHref,
  type DemoInboxItem,
  type DemoInboxKind,
} from "../../demo/seed";
import { relativeTime } from "../../lib/relativeTime";

const MAX_CARDS = 4;

function Kpi({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: ReactNode;
}) {
  return (
    <div className="cockpit-dashboard-kpi">
      <div className="cockpit-overline">{label}</div>
      <div className="cockpit-kpi-value">{value}</div>
      {sub && <div className="cockpit-kpi-sub">{sub}</div>}
    </div>
  );
}

function kindLabel(kind: DemoInboxKind): string {
  switch (kind) {
    case "needs-you":
      return "Action";
    case "ai":
      return "AI alert";
    case "mention":
      return "Mention";
    case "reviewer":
      return "Reviewer";
    default:
      return "FYI";
  }
}

function kindPillStyle(kind: DemoInboxKind): React.CSSProperties {
  switch (kind) {
    case "needs-you":
    case "reviewer":
      return {
        background: "var(--danger-dim)",
        color: "var(--danger-text)",
      };
    case "ai":
      return {
        background: "var(--info-dim)",
        color: "var(--info-text)",
      };
    case "mention":
      return {
        background: "var(--cyan-dim)",
        color: "var(--cyan-text)",
      };
    default:
      return {
        background: "var(--bg-highlight)",
        color: "var(--text-secondary)",
      };
  }
}

function InboxKindPill({ kind }: { kind: DemoInboxKind }) {
  return (
    <span
      className="sc-pill cockpit-inbox-kind-pill"
      data-kind={kind}
      style={{
        ...kindPillStyle(kind),
        textTransform: "uppercase",
        fontSize: 9,
        letterSpacing: "0.05em",
        padding: "2px 6px",
        borderRadius: 4,
        flexShrink: 0,
      }}
    >
      {kindLabel(kind)}
    </span>
  );
}

function InboxItemChip({ item }: { item: DemoInboxItem }) {
  return (
    <Link
      href={inboxHref(item)}
      className="cockpit-engagement-card cockpit-engagement-card--compact cockpit-inbox-item-chip"
      data-testid={`inbox-row-${item.id}`}
      data-inbox-kind={item.kind}
    >
      <div className="cockpit-engagement-card-header">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="cockpit-engagement-name truncate">{item.title}</span>
          <span className="cockpit-engagement-meta truncate">
            {item.engagementName}
          </span>
        </div>
        <InboxKindPill kind={item.kind} />
      </div>
      <div className="cockpit-engagement-footer">
        <span className="truncate min-w-0">{item.preview}</span>
        <span className="flex-shrink-0">{relativeTime(item.createdAt)}</span>
      </div>
    </Link>
  );
}

const PRIORITY: DemoInboxKind[] = [
  "needs-you",
  "reviewer",
  "ai",
  "mention",
  "fyi",
];

function priorityRank(kind: DemoInboxKind): number {
  const idx = PRIORITY.indexOf(kind);
  return idx === -1 ? PRIORITY.length : idx;
}

/**
 * Dashboard inbox column — mirrors {@link ProjectsDashboardSection} layout
 * (KPI row, CTA strip, 2×2 chip grid).
 */
export function InboxDashboardSection() {
  const [actionOnly, setActionOnly] = useState(false);

  const needsYou = DEMO_INBOX_ITEMS.filter(
    (i) => i.kind === "needs-you" || i.kind === "reviewer",
  );
  const aiItems = DEMO_INBOX_ITEMS.filter((i) => i.kind === "ai");
  const mentions = DEMO_INBOX_ITEMS.filter((i) => i.kind === "mention");
  const fyi = DEMO_INBOX_ITEMS.filter((i) => i.kind === "fyi");

  const needsCount = needsYou.length;
  const total = DEMO_INBOX_ITEMS.length;

  const visibleItems = useMemo(() => {
    let list = [...DEMO_INBOX_ITEMS];
    if (actionOnly) {
      list = list.filter(
        (i) => i.kind === "needs-you" || i.kind === "reviewer",
      );
    }
    list.sort(
      (a, b) =>
        priorityRank(a.kind) - priorityRank(b.kind) ||
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    return list.slice(0, MAX_CARDS);
  }, [actionOnly]);

  return (
    <section
      className="cockpit-dashboard-section"
      data-testid="inbox-action-queue"
    >
      <header className="cockpit-dashboard-section-head">
        <div>
          <h2 className="cockpit-dashboard-section-title">Inbox</h2>
          <p className="cockpit-dashboard-section-sub">
            {total} items · {needsCount} need you
          </p>
        </div>
        <div className="cockpit-dashboard-section-actions">
          <label className="cockpit-toggle cockpit-dashboard-toggle">
            <input
              type="checkbox"
              data-testid="inbox-filter-action-only"
              checked={actionOnly}
              onChange={(e) => setActionOnly(e.target.checked)}
            />
            Action only
          </label>
        </div>
      </header>

      <div
        className="cockpit-dashboard-kpi-row"
        data-testid="inbox-dashboard-kpis"
      >
        <Kpi
          label="Needs action"
          value={needsCount}
          sub={
            needsCount > 0 ? (
              <span data-testid="inbox-needs-you">{needsCount} open</span>
            ) : (
              "All clear"
            )
          }
        />
        <Kpi
          label="AI flagging"
          value={aiItems.length}
          sub={
            aiItems.length > 0 ? (
              <span data-testid="inbox-ai">{aiItems.length} alerts</span>
            ) : (
              "None"
            )
          }
        />
        <Kpi
          label="Mentions"
          value={mentions.length}
          sub={
            fyi.length > 0 ? (
              <span data-testid="inbox-fyi">{fyi.length} FYI</span>
            ) : (
              "No FYI"
            )
          }
        />
      </div>

      <Link
        href="/inbox"
        className="cockpit-intake-cta cockpit-intake-cta--compact"
        data-testid="inbox-open-full"
      >
        <Inbox size={14} aria-hidden />
        <span>Open full inbox</span>
      </Link>

      {visibleItems.length === 0 ? (
        <div className="cockpit-dashboard-empty sc-prose opacity-70">
          No inbox items to show. You&apos;re caught up.
        </div>
      ) : (
        <div
          className="cockpit-dashboard-project-grid"
          data-testid="inbox-item-grid"
        >
          {visibleItems.map((item) => (
            <InboxItemChip key={item.id} item={item} />
          ))}
        </div>
      )}

      {total > MAX_CARDS && (
        <p className="cockpit-dashboard-more-hint sc-meta">
          Showing {visibleItems.length} of {total}.{" "}
          <Link href="/inbox" className="cockpit-dashboard-section-link">
            Open full inbox
            <ChevronRight size={12} aria-hidden />
          </Link>
        </p>
      )}
    </section>
  );
}
