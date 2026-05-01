import { useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { ChevronRight } from "lucide-react";
import { DashboardLayout } from "@workspace/portal-ui";
import {
  useListEngagements,
  getListEngagementsQueryKey,
  EngagementStatus,
  type EngagementSummary,
} from "@workspace/api-client-react";
import {
  filterApplicableAdapters,
  noApplicableAdaptersMessage,
  resolveJurisdiction,
  type AdapterContext,
} from "@workspace/adapters";
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

/**
 * "No adapters" pill — mirrors the design-tools EngagementList card pill
 * (Task #235) so reviewers in the plan-review surface can triage out-of-
 * pilot engagements without opening each detail page (Task #278). The
 * tooltip is the same `noApplicableAdaptersMessage` copy the design-tools
 * list and the EngagementDetail Site Context banner render, so the two
 * surfaces' wording cannot drift.
 */
function NoAdaptersPill({ message }: { message: string }) {
  return (
    <span
      className="sc-pill"
      data-testid="engagement-row-no-adapters-pill"
      title={message}
      style={{
        background: "var(--info-dim)",
        color: "var(--info-text)",
        textTransform: "uppercase",
        fontSize: 11,
        letterSpacing: "0.05em",
        padding: "3px 8px",
        borderRadius: 4,
      }}
    >
      No adapters
    </span>
  );
}

/**
 * Pre-flight pilot eligibility computed from a cached engagement-list
 * row, matching `computeEligibility` in design-tools EngagementList
 * (Task #235). Both surfaces feed the same `resolveJurisdiction` +
 * `filterApplicableAdapters` pair from `@workspace/adapters/eligibility`,
 * which is also the source of truth the server's `generateLayers` 422
 * envelope reads from — so the plan-review pill, the design-tools
 * pill, the EngagementDetail banner, and the server verdict cannot
 * disagree.
 */
function computeEligibility(e: EngagementSummary): {
  isInPilot: boolean;
  message: string;
} {
  const geocode = e.site?.geocode ?? null;
  const jurisdiction = resolveJurisdiction({
    jurisdictionCity: geocode?.jurisdictionCity ?? null,
    jurisdictionState: geocode?.jurisdictionState ?? null,
    jurisdiction: e.jurisdiction ?? null,
    address: e.address ?? null,
  });
  const lat = geocode?.latitude ?? NaN;
  const lng = geocode?.longitude ?? NaN;
  const ctx: AdapterContext = {
    parcel: { latitude: lat, longitude: lng },
    jurisdiction,
  };
  const applicable = filterApplicableAdapters(ctx);
  return {
    isInPilot: applicable.length > 0,
    message: noApplicableAdaptersMessage(jurisdiction),
  };
}

function EngagementRow({
  engagement,
  eligibility,
}: {
  engagement: EngagementSummary;
  eligibility: { isInPilot: boolean; message: string };
}) {
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
      data-in-pilot={eligibility.isInPilot ? "true" : "false"}
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
          {!eligibility.isInPilot ? (
            <NoAdaptersPill message={eligibility.message} />
          ) : null}
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

const VALID_FILTERS = new Set<StatusFilter>([
  "active",
  "on_hold",
  "archived",
  "all",
]);

function parseFilterFromSearch(search: string): StatusFilter {
  const params = new URLSearchParams(search);
  const raw = params.get("status");
  if (raw && VALID_FILTERS.has(raw as StatusFilter)) {
    return raw as StatusFilter;
  }
  return "active";
}

export default function EngagementsList() {
  const navGroups = useNavGroups();
  const { data, isLoading, isError, refetch, isFetching } = useListEngagements({
    query: {
      queryKey: getListEngagementsQueryKey(),
    },
  });
  const engagements = data ?? [];

  const search = useSearch();
  const [location, setLocation] = useLocation();
  const filter = parseFilterFromSearch(search);

  const setFilter = (next: StatusFilter) => {
    const params = new URLSearchParams(search);
    if (next === "active") {
      params.delete("status");
    } else {
      params.set("status", next);
    }
    const qs = params.toString();
    setLocation(qs ? `${location}?${qs}` : location, { replace: true });
  };

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

  // Per-row pilot verdict, computed once per engagement and shared
  // between the row pill, the out-of-pilot tally, and the "Show only
  // in-pilot" filter so the three surfaces' verdicts cannot drift
  // (Task #303 B.2 — mirrors the design-tools EngagementList Task
  // #235 / #277 contract). All three read the same
  // `resolveJurisdiction` + `filterApplicableAdapters` pair via
  // `computeEligibility`, which is also the source of truth the
  // server's generate-layers 422 envelope reads from.
  const eligibilityById = useMemo(() => {
    const m = new Map<string, ReturnType<typeof computeEligibility>>();
    for (const e of engagements) {
      m.set(e.id, computeEligibility(e));
    }
    return m;
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

  // Out-of-pilot tally over the entire engagement list (not just the
  // status-filtered slice) so the count stays stable when the
  // architect flips between status tabs — the tally is about the
  // whole pipeline, not a single status bucket.
  const outOfPilotCount = useMemo(() => {
    let n = 0;
    for (const e of engagements) {
      if (!eligibilityById.get(e.id)?.isInPilot) n += 1;
    }
    return n;
  }, [engagements, eligibilityById]);

  // "Show only in-pilot" toggle (Task #303 B.2). Defaults off so the
  // existing "show everything" behaviour is preserved on first load;
  // flipping it on hides every row whose jurisdiction resolves to no
  // applicable adapters so a reviewer can focus triage on the
  // actionable subset.
  const [hideOutOfPilot, setHideOutOfPilot] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const trimmedQuery = searchQuery.trim().toLowerCase();
  const searchFiltered = useMemo(() => {
    let rows = statusFiltered;
    if (hideOutOfPilot) {
      rows = rows.filter((e) => eligibilityById.get(e.id)?.isInPilot);
    }
    if (!trimmedQuery) return rows;
    return rows.filter((e) => {
      const haystack = [e.name, e.jurisdiction, e.address]
        .filter((s): s is string => !!s)
        .join(" ")
        .toLowerCase();
      return haystack.includes(trimmedQuery);
    });
  }, [statusFiltered, trimmedQuery, hideOutOfPilot, eligibilityById]);

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
              {/*
                Task #303 B.2 — surface the out-of-pilot tally inline
                with the at-a-glance summary so reviewers can see how
                many engagements would be hidden by "Show only
                in-pilot" without needing to flip the toggle. Mirrors
                the design-tools EngagementList tally testid + copy
                so the two surfaces' wording cannot drift.
              */}
              {outOfPilotCount > 0 ? (
                <>
                  {" "}
                  ·{" "}
                  <span data-testid="engagements-out-of-pilot-tally">
                    {outOfPilotCount} out of pilot
                  </span>
                </>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/*
              Task #303 B.2 — "Show only in-pilot" toggle, mirroring
              the design-tools EngagementList Task #235 stretch goal.
              Defaults off so the existing "show everything" first
              load is preserved; flipping it on hides every row
              whose jurisdiction resolves to no applicable adapters
              so reviewers can focus triage on the actionable subset.
              The same `eligibilityById` map drives the row pill,
              the tally above, and this filter — so the three
              surfaces' verdicts cannot drift.
            */}
            <label
              className="sc-body opacity-80 flex items-center gap-2"
              style={{ cursor: "pointer", userSelect: "none" }}
            >
              <input
                type="checkbox"
                data-testid="engagements-filter-in-pilot"
                checked={hideOutOfPilot}
                onChange={(e) => setHideOutOfPilot(e.target.checked)}
              />
              Show only in-pilot
            </label>
            <button
              className="sc-btn-ghost"
              onClick={() => refetch()}
              disabled={isFetching}
              data-testid="engagements-refresh"
            >
              {isFetching ? "Refreshing…" : "Refresh"}
            </button>
          </div>
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
              // Distinguish "filtered everything out by hiding
              // out-of-pilot rows" from "free-text search misses"
              // (Task #303 B.2). When the in-pilot toggle is what
              // emptied the slice, surface the dedicated empty-state
              // so the reviewer knows to uncheck the toggle rather
              // than hunting for a different search term. We gate on
              // the toggle being on AND no search query active so a
              // stale-toggle + miss-typed search still falls through
              // to the existing copy.
              hideOutOfPilot && !trimmedQuery ? (
                <div
                  className="p-8 text-center sc-body"
                  data-testid="engagements-empty-filtered-in-pilot"
                >
                  No in-pilot engagements right now. Uncheck "Show only
                  in-pilot" to see the {statusFiltered.length} project
                  {statusFiltered.length === 1 ? "" : "s"} outside the
                  current adapter set.
                </div>
              ) : (
                <div
                  className="p-8 text-center sc-body"
                  data-testid="engagements-no-matches"
                >
                  No engagements match “{searchQuery.trim()}”. Try a different
                  name, jurisdiction, or address.
                </div>
              )
            ) : (
              searchFiltered.map((e) => (
                <EngagementRow
                  key={e.id}
                  engagement={e}
                  eligibility={
                    eligibilityById.get(e.id) ?? {
                      isInPilot: false,
                      message: "",
                    }
                  }
                />
              ))
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
