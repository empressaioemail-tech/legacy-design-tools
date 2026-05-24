import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
  Archive,
  ChevronDown,
  ChevronRight,
  Clock,
  Filter,
  Send,
  Sparkles,
} from "lucide-react";
import {
  DEMO_INBOX_ITEMS,
  DEMO_INBOX_TODAY_PLAN,
  demoInboxEngagementFilters,
  inboxHref,
  isDemoSeedEnabled,
  type DemoInboxItem,
  type DemoInboxKind,
} from "../../demo/seed";
import { relativeTime } from "../../lib/relativeTime";

function bucketFor(kind: DemoInboxKind): string {
  switch (kind) {
    case "needs-you":
      return "needs-you";
    case "ai":
      return "ai";
    case "mention":
      return "mentions";
    case "reviewer":
      return "reviewer";
    default:
      return "fyi";
  }
}

function ActionCard({
  item,
  compact = false,
}: {
  item: DemoInboxItem;
  compact?: boolean;
}) {
  return (
    <div
      className={`cockpit-inbox-action-card${item.muted ? " cockpit-inbox-action-card--muted" : ""}`}
      data-testid={`inbox-row-${item.id}`}
    >
      <div className="cockpit-inbox-action-card-accent" data-kind={item.kind} />
      <div className="cockpit-inbox-action-card-body">
        <div className="cockpit-inbox-action-card-head">
          <div className="cockpit-inbox-action-card-headline">
            <AlertTriangle
              size={16}
              className="cockpit-inbox-action-card-icon"
              aria-hidden="true"
            />
            <span>{item.title}</span>
            <span className="cockpit-inbox-action-card-dot">·</span>
            <span className="cockpit-inbox-action-card-time">
              {relativeTime(item.createdAt)}
            </span>
          </div>
          {item.dueLabel && (
            <span className="cockpit-inbox-action-card-due">
              <Clock size={12} aria-hidden="true" />
              {item.dueLabel}
            </span>
          )}
        </div>
        <p className="cockpit-inbox-action-card-preview">{item.preview}</p>
        <div className="cockpit-inbox-action-card-footer">
          <span className="cockpit-inbox-engagement-chip">{item.engagementName}</span>
          <div className="cockpit-inbox-action-card-actions">
            {!compact ? (
              <>
                <button type="button" className="cockpit-inbox-ghost-btn">
                  Dismiss
                </button>
                <button type="button" className="cockpit-inbox-ghost-btn">
                  Snooze
                </button>
              </>
            ) : null}
            <Link href={inboxHref(item)} className="cockpit-inbox-cta-btn">
              {item.ctaLabel ?? "Open"}
              <ChevronRight size={14} aria-hidden="true" />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function AiCard({ item }: { item: DemoInboxItem }) {
  return (
    <Link
      href={inboxHref(item)}
      className="cockpit-inbox-ai-card"
      data-testid={`inbox-row-${item.id}`}
    >
      <div className="cockpit-inbox-ai-card-accent" />
      <div className="cockpit-inbox-ai-card-head">
        <span className="cockpit-inbox-ai-label">
          <Sparkles size={14} aria-hidden="true" />
          AI alert
        </span>
        <span className="cockpit-inbox-action-card-time">
          {relativeTime(item.createdAt)}
        </span>
      </div>
      <h3 className="cockpit-inbox-ai-title">{item.title}</h3>
      <p className="cockpit-inbox-ai-preview">{item.preview}</p>
      <div className="cockpit-inbox-ai-footer">
        <span>{item.engagementName}</span>
        <span className="cockpit-inbox-ai-cta">
          {item.ctaLabel ?? "Open"}
          <ChevronRight size={14} aria-hidden="true" />
        </span>
      </div>
    </Link>
  );
}

function MentionCard({ item }: { item: DemoInboxItem }) {
  return (
    <div className="cockpit-inbox-mention-card" data-testid={`inbox-row-${item.id}`}>
      <div className="cockpit-inbox-mention-card-accent" />
      <div className="cockpit-inbox-mention-avatar" aria-hidden="true">
        @
      </div>
      <div className="cockpit-inbox-mention-body">
        <div className="cockpit-inbox-mention-head">
          <span>{item.title}</span>
          <span className="cockpit-inbox-action-card-time">
            {relativeTime(item.createdAt)} · {item.engagementName}
          </span>
        </div>
        <div className="cockpit-inbox-mention-quote">{item.preview}</div>
        <div className="cockpit-inbox-mention-reply">
          <input
            type="text"
            readOnly
            placeholder="Reply…"
            className="cockpit-inbox-mention-input"
            aria-label={`Reply to ${item.title}`}
          />
          <button type="button" className="cockpit-inbox-mention-send" aria-label="Send reply">
            <Send size={14} />
          </button>
          <Link href={inboxHref(item)} className="cockpit-inbox-ghost-btn">
            Open
          </Link>
        </div>
      </div>
    </div>
  );
}

function FyiChip({ item }: { item: DemoInboxItem }) {
  return (
    <Link href={inboxHref(item)} className="cockpit-inbox-fyi-chip" data-testid={`inbox-row-${item.id}`}>
      <span className="cockpit-inbox-fyi-dot" />
      <span className="cockpit-inbox-fyi-title">{item.title}</span>
      <span className="cockpit-inbox-fyi-time">{relativeTime(item.createdAt)}</span>
    </Link>
  );
}

function FyiRow({ item }: { item: DemoInboxItem }) {
  return (
    <div
      className={`cockpit-inbox-fyi-row${item.muted ? " cockpit-inbox-fyi-row--muted" : ""}`}
      data-testid={`inbox-row-${item.id}`}
    >
      <span className="cockpit-inbox-fyi-dot" />
      <div className="cockpit-inbox-fyi-row-body">
        <div className="cockpit-inbox-fyi-row-title">{item.title}</div>
        <div className="cockpit-inbox-fyi-row-meta">
          {item.engagementName} · {relativeTime(item.createdAt)} · {item.preview}
        </div>
      </div>
      <Link href={inboxHref(item)} className="cockpit-inbox-ghost-btn">
        View
      </Link>
    </div>
  );
}

export function InboxActionQueue({ compact = false }: { compact?: boolean }) {
  const [fyiExpanded, setFyiExpanded] = useState(false);
  const [range, setRange] = useState<"today" | "week" | "all">("today");
  const filters = useMemo(() => demoInboxEngagementFilters(), []);

  const needsYou = DEMO_INBOX_ITEMS.filter((i) => i.kind === "needs-you");
  const aiItems = DEMO_INBOX_ITEMS.filter((i) => i.kind === "ai");
  const mentions = DEMO_INBOX_ITEMS.filter((i) => i.kind === "mention");
  const fyi = DEMO_INBOX_ITEMS.filter((i) => i.kind === "fyi");

  const needsCount = needsYou.length;
  const needsVisible = compact ? needsYou.slice(0, 2) : needsYou;
  const aiVisible = compact ? aiItems.slice(0, 2) : aiItems;

  return (
    <div
      className={
        compact
          ? "cockpit-inbox-queue cockpit-inbox-queue--compact"
          : "cockpit-inbox-queue"
      }
      data-testid="inbox-action-queue"
    >
      <div className="cockpit-inbox-queue-main">
        <header className="cockpit-inbox-hero">
          {compact ? (
            <h2 className="cockpit-dashboard-section-title">
              Inbox
              <span className="cockpit-inbox-hero-sub">
                · {needsCount} need you
              </span>
            </h2>
          ) : (
            <h1 className="cockpit-inbox-hero-title">
              Good morning, Operator
              <span className="cockpit-inbox-hero-sub">
                · {needsCount} {needsCount === 1 ? "thing needs" : "things need"}{" "}
                you today
              </span>
            </h1>
          )}
          {!compact && (
          <div className="cockpit-inbox-hero-toolbar">
            <div
              className="cockpit-inbox-bucket-bar"
              role="img"
              aria-label="Inbox bucket distribution"
            >
              <span className="cockpit-inbox-bucket-bar-seg" data-bucket="action" />
              <span className="cockpit-inbox-bucket-bar-seg" data-bucket="ai" />
              <span className="cockpit-inbox-bucket-bar-seg" data-bucket="mentions" />
              <span className="cockpit-inbox-bucket-bar-seg" data-bucket="fyi" />
            </div>
            <div className="cockpit-inbox-range-toggle" role="group" aria-label="Time range">
              {(["today", "week", "all"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  className="cockpit-inbox-range-btn"
                  data-active={range === key ? "true" : "false"}
                  onClick={() => setRange(key)}
                >
                  {key === "today" ? "Today" : key === "week" ? "This week" : "All"}
                </button>
              ))}
            </div>
          </div>
          )}
        </header>

        {!compact && !isDemoSeedEnabled() && (
          <p className="sc-prose opacity-70" data-testid="inbox-live-hint">
            Set <code>VITE_DEMO_SEED=1</code> for the full ActionQueue demo. Live
            notifications still sync from the API when signed in.
          </p>
        )}

        {compact ? (
          <div className="cockpit-dashboard-inbox-buckets">
            <section className="cockpit-inbox-bucket" data-testid="inbox-needs-you">
              <h2 className="cockpit-inbox-bucket-title">
                <span className="cockpit-inbox-bucket-dot" data-bucket="action" />
                Needs your action
                <span className="cockpit-inbox-bucket-count">({needsYou.length})</span>
              </h2>
              <div className="cockpit-inbox-action-list">
                {needsVisible.map((item) => (
                  <ActionCard key={item.id} item={item} compact />
                ))}
              </div>
            </section>

            <section className="cockpit-inbox-bucket" data-testid="inbox-ai">
              <h2 className="cockpit-inbox-bucket-title">
                <span className="cockpit-inbox-bucket-dot" data-bucket="ai" />
                AI is flagging
                <span className="cockpit-inbox-bucket-count">({aiItems.length})</span>
              </h2>
              <div className="cockpit-inbox-ai-grid">
                {aiVisible.map((item) => (
                  <AiCard key={item.id} item={item} />
                ))}
              </div>
            </section>
          </div>
        ) : (
          <>
            <section className="cockpit-inbox-bucket" data-testid="inbox-needs-you">
              <h2 className="cockpit-inbox-bucket-title">
                <span className="cockpit-inbox-bucket-dot" data-bucket="action" />
                Needs your action
                <span className="cockpit-inbox-bucket-count">({needsYou.length})</span>
              </h2>
              <div className="cockpit-inbox-action-list">
                {needsVisible.map((item) => (
                  <ActionCard key={item.id} item={item} />
                ))}
              </div>
            </section>

            <section className="cockpit-inbox-bucket" data-testid="inbox-ai">
              <h2 className="cockpit-inbox-bucket-title">
                <span className="cockpit-inbox-bucket-dot" data-bucket="ai" />
                AI is flagging
                <span className="cockpit-inbox-bucket-count">({aiItems.length})</span>
              </h2>
              <div className="cockpit-inbox-ai-grid">
                {aiVisible.map((item) => (
                  <AiCard key={item.id} item={item} />
                ))}
              </div>
            </section>
          </>
        )}

        {!compact && (
        <>
        <section className="cockpit-inbox-bucket" data-testid="inbox-mentions">
          <h2 className="cockpit-inbox-bucket-title">
            <span className="cockpit-inbox-bucket-dot" data-bucket="mentions" />
            @ Mentions
            <span className="cockpit-inbox-bucket-count">({mentions.length})</span>
          </h2>
          <div className="cockpit-inbox-mention-list">
            {mentions.map((item) => (
              <MentionCard key={item.id} item={item} />
            ))}
          </div>
        </section>

        <section className="cockpit-inbox-bucket" data-testid="inbox-fyi">
          <button
            type="button"
            className="cockpit-inbox-fyi-toggle"
            onClick={() => setFyiExpanded((v) => !v)}
            aria-expanded={fyiExpanded}
          >
            <span className="cockpit-inbox-bucket-title cockpit-inbox-bucket-title--button">
              <span className="cockpit-inbox-bucket-dot" data-bucket="fyi" />
              Just FYI
              <span className="cockpit-inbox-bucket-count">({fyi.length})</span>
            </span>
            <span className="cockpit-inbox-fyi-toggle-label">
              {fyiExpanded ? "Collapse" : "Show all"}
              <ChevronDown
                size={16}
                className={fyiExpanded ? "cockpit-inbox-chevron-open" : ""}
                aria-hidden="true"
              />
            </span>
          </button>
          {!fyiExpanded ? (
            <div className="cockpit-inbox-fyi-chips">
              {fyi.map((item) => (
                <FyiChip key={item.id} item={item} />
              ))}
            </div>
          ) : (
            <div className="cockpit-inbox-fyi-expanded">
              {fyi.map((item) => (
                <FyiRow key={item.id} item={item} />
              ))}
            </div>
          )}
        </section>
        </>
        )}

        {compact && (
          <div className="cockpit-dashboard-inbox-summary sc-meta">
            {mentions.length > 0 && (
              <span data-testid="inbox-mentions">
                {mentions.length} @mentions
              </span>
            )}
            {fyi.length > 0 && (
              <span data-testid="inbox-fyi">{fyi.length} FYI</span>
            )}
            <Link href="/inbox" className="cockpit-dashboard-section-link">
              Open full inbox
              <ChevronRight size={12} aria-hidden />
            </Link>
          </div>
        )}

        {!compact && (
        <footer className="cockpit-inbox-archive">
          <button type="button" className="cockpit-inbox-archive-btn">
            <Archive size={16} aria-hidden="true" />
            47 archived · view
          </button>
        </footer>
        )}
      </div>

      {!compact && (
      <aside className="cockpit-inbox-aside" aria-label="Inbox filters and plan">
        <div className="cockpit-inbox-aside-block">
          <h3 className="cockpit-inbox-aside-title">
            <Filter size={14} aria-hidden="true" />
            Filter by engagement
          </h3>
          <ul className="cockpit-inbox-filter-list">
            {filters.map((f) => (
              <li key={f.id}>
                <label className="cockpit-inbox-filter-row">
                  <span
                    className="cockpit-inbox-filter-check"
                    data-checked={f.selected ? "true" : "false"}
                    aria-hidden="true"
                  />
                  <span>{f.name}</span>
                  <span className="cockpit-inbox-filter-count">{f.count}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>

        <div className="cockpit-inbox-aside-block cockpit-inbox-ai-assistant">
          <h3 className="cockpit-inbox-aside-title">
            <Sparkles size={14} aria-hidden="true" />
            AI assistant
          </h3>
          <p className="cockpit-inbox-ai-assistant-copy">
            You have <strong>{needsCount} open action items</strong>. Want draft
            holding-reply messages for reviewer requests?
          </p>
          <button type="button" className="cockpit-inbox-ai-assistant-btn">
            Generate drafts
          </button>
        </div>

        <div className="cockpit-inbox-aside-block">
          <div className="cockpit-inbox-aside-title-row">
            <h3 className="cockpit-inbox-aside-title">Today&apos;s plan</h3>
            <button type="button" className="cockpit-inbox-plan-edit">
              Edit
            </button>
          </div>
          <ol className="cockpit-inbox-plan-list">
            {DEMO_INBOX_TODAY_PLAN.map((step) => (
              <li key={step.time} className="cockpit-inbox-plan-step" data-tone={step.tone}>
                <span className="cockpit-inbox-plan-dot" />
                <div>
                  <div className="cockpit-inbox-plan-time">
                    {step.time}{" "}
                    <span className="cockpit-inbox-plan-duration">({step.duration})</span>
                  </div>
                  <div className="cockpit-inbox-plan-label">{step.label}</div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </aside>
      )}
    </div>
  );
}

/** @internal exported for tests */
export function inboxItemsByBucket() {
  const buckets: Record<string, DemoInboxItem[]> = {};
  for (const item of DEMO_INBOX_ITEMS) {
    const b = bucketFor(item.kind);
    (buckets[b] ??= []).push(item);
  }
  return buckets;
}
