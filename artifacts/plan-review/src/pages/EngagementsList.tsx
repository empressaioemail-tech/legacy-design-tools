import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import { DashboardLayout } from "@workspace/portal-ui";
import {
  useListEngagements,
  getListEngagementsQueryKey,
  EngagementStatus,
  type EngagementSummary,
} from "@workspace/api-client-react";
import { useNavGroups } from "../components/NavGroups";
import { relativeTime } from "../lib/relativeTime";

/**
 * EngagementsList — Plan Review's browsable index of engagements (Task #87).
 *
 * Task #83 added a per-engagement detail surface at `/engagements/:id`
 * inside plan-review, but reviewers had no in-app way to discover the
 * UUIDs to deep-link into. This page lists every engagement returned
 * by `useListEngagements` and links each row to that detail page so a
 * Plan Review user no longer has to bounce out to the design-tools
 * artifact (where the equivalent EngagementList lives) just to copy
 * an id.
 *
 * Visual language matches the existing Review Console queue: a single
 * `sc-card` with `sc-card-row` link rows, jurisdiction · address as
 * the secondary line, and an inline status pill — rather than the
 * card-grid layout used in design-tools, which would feel out of
 * place next to the Inbox.
 */

const STATUS_PILL: Record<string, string> = {
  active: "sc-pill-cyan",
  on_hold: "sc-pill-amber",
  archived: "sc-pill-muted",
};

function StatusPill({ status }: { status: EngagementSummary["status"] }) {
  const cls = STATUS_PILL[status] ?? "sc-pill-muted";
  return (
    <span className={`sc-pill ${cls} capitalize shrink-0`}>
      {status.replace("_", " ")}
    </span>
  );
}

function EngagementRow({ engagement }: { engagement: EngagementSummary }) {
  const initials = engagement.name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const subtitleParts = [engagement.jurisdiction, engagement.address].filter(
    (s): s is string => !!s,
  );

  return (
    <Link
      href={`/engagements/${engagement.id}`}
      className="sc-card-row flex items-center gap-3 no-underline"
      data-testid={`engagement-row-${engagement.id}`}
    >
      <div
        className="sc-avatar-mark shrink-0"
        style={{ background: "#6398AA", color: "#0f1318" }}
      >
        {initials || "EN"}
      </div>

      <div className="flex flex-col min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <div className="sc-medium truncate">{engagement.name}</div>
          <StatusPill status={engagement.status} />
        </div>
        <div className="flex items-center gap-2 mt-1 min-w-0">
          {subtitleParts.length > 0 ? (
            <span className="sc-meta truncate">
              {subtitleParts.join(" · ")}
            </span>
          ) : (
            <span className="sc-meta opacity-60">No jurisdiction or address</span>
          )}
        </div>
      </div>

      <div className="hidden md:block sc-meta shrink-0 w-32 text-right">
        {engagement.snapshotCount} snapshot
        {engagement.snapshotCount === 1 ? "" : "s"}
      </div>

      <div className="hidden md:block sc-mono-sm shrink-0 w-28 text-right text-[var(--text-secondary)]">
        {relativeTime(
          engagement.latestSnapshot?.receivedAt ?? engagement.updatedAt,
        )}
      </div>

      <ChevronRight size={14} className="text-[var(--text-muted)] shrink-0" />
    </Link>
  );
}

type StatusFilter = EngagementStatus | "all";

const FILTER_TABS: ReadonlyArray<{
  value: StatusFilter;
  label: string;
  testId: string;
}> = [
  { value: "active", label: "Active", testId: "engagements-filter-active" },
  { value: "on_hold", label: "On hold", testId: "engagements-filter-on-hold" },
  { value: "archived", label: "Archived", testId: "engagements-filter-archived" },
  { value: "all", label: "All", testId: "engagements-filter-all" },
];

const FILTER_HEADER: Record<StatusFilter, string> = {
  active: "ACTIVE ENGAGEMENTS",
  on_hold: "ON-HOLD ENGAGEMENTS",
  archived: "ARCHIVED ENGAGEMENTS",
  all: "ALL ENGAGEMENTS",
};

const FILTER_EMPTY: Record<StatusFilter, string> = {
  active: "No active engagements right now.",
  on_hold: "Nothing is on hold.",
  archived: "No archived engagements.",
  all: "No engagements yet. They'll appear here once a snapshot is ingested from Revit.",
};

export default function EngagementsList() {
  const navGroups = useNavGroups();
  const { data, isLoading, isError, refetch, isFetching } = useListEngagements({
    query: {
      queryKey: getListEngagementsQueryKey(),
    },
  });
  const engagements = data ?? [];
  const [filter, setFilter] = useState<StatusFilter>("active");

  const counts = useMemo(() => {
    const c: Record<EngagementStatus, number> = {
      active: 0,
      on_hold: 0,
      archived: 0,
    };
    for (const e of engagements) {
      c[e.status] = (c[e.status] ?? 0) + 1;
    }
    return c;
  }, [engagements]);

  const statusFiltered = useMemo(
    () =>
      filter === "all"
        ? engagements
        : engagements.filter((e) => e.status === filter),
    [engagements, filter],
  );

  const total = engagements.length;
  const summary =
    filter === "all"
      ? `${total} total · ${counts.active} active`
      : `${statusFiltered.length} ${FILTER_TABS.find((t) => t.value === filter)!.label.toLowerCase()} · ${total} total`;

  const [searchQuery, setSearchQuery] = useState("");
  const trimmedQuery = searchQuery.trim().toLowerCase();
  const searchFiltered = useMemo(() => {
    if (!trimmedQuery) return statusFiltered;
    return statusFiltered.filter((e) => {
      const haystack = [e.name, e.jurisdiction, e.address]
        .filter((s): s is string => !!s)
        .join(" ")
        .toLowerCase();
      return haystack.includes(trimmedQuery);
    });
  }, [statusFiltered, trimmedQuery]);

  return (
    <DashboardLayout
      title="Engagements"
      navGroups={navGroups}
      brandLabel="SMARTCITY OS"
      brandProductName="Plan Review"
      search={{
        placeholder: "Search engagements...",
        value: searchQuery,
        onChange: setSearchQuery,
      }}
    >
      <div className="flex flex-col gap-6">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-[22px] font-bold font-['Oxygen'] text-[var(--text-primary)] m-0">
              Engagements
            </h2>
            <div
              className="sc-body mt-1"
              data-testid="engagements-summary"
            >
              {summary}
            </div>
          </div>
          <button
            className="sc-btn-ghost"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="engagements-refresh"
          >
            {isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        <div
          role="tablist"
          aria-label="Filter engagements by status"
          className="flex items-center gap-2 flex-wrap"
          data-testid="engagements-filter"
        >
          {FILTER_TABS.map((tab) => {
            const tabCount =
              tab.value === "all" ? total : counts[tab.value];
            const selected = filter === tab.value;
            return (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setFilter(tab.value)}
                data-testid={tab.testId}
                className={selected ? "sc-btn-primary" : "sc-btn-sm"}
              >
                {tab.label}
                <span className="ml-1.5 opacity-70">({tabCount})</span>
              </button>
            );
          })}
        </div>

        <div className="sc-card">
          <div className="sc-card-header sc-row-sb">
            <span className="sc-label">{FILTER_HEADER[filter]}</span>
            <span className="sc-meta">
              {trimmedQuery
                ? `${searchFiltered.length} of ${statusFiltered.length} items`
                : `${statusFiltered.length} items`}
            </span>
          </div>
          <div className="flex flex-col" data-testid="engagements-list">
            {isLoading ? (
              <div
                className="p-8 text-center sc-body"
                data-testid="engagements-loading"
              >
                Loading engagements…
              </div>
            ) : isError ? (
              <div
                className="p-8 text-center sc-body text-[var(--danger)]"
                data-testid="engagements-error"
              >
                Couldn't load engagements. Try refreshing.
              </div>
            ) : statusFiltered.length === 0 ? (
              <div
                className="p-8 text-center sc-body"
                data-testid="engagements-empty"
              >
                {total === 0 ? FILTER_EMPTY.all : FILTER_EMPTY[filter]}
              </div>
            ) : searchFiltered.length === 0 ? (
              <div
                className="p-8 text-center sc-body"
                data-testid="engagements-no-matches"
              >
                No engagements match “{searchQuery.trim()}”. Try a different
                name, jurisdiction, or address.
              </div>
            ) : (
              searchFiltered.map((e) => (
                <EngagementRow key={e.id} engagement={e} />
              ))
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
