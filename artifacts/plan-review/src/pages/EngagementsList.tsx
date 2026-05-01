import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import { DashboardLayout } from "@workspace/portal-ui";
import {
  useListEngagements,
  getListEngagementsQueryKey,
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

export default function EngagementsList() {
  const navGroups = useNavGroups();
  const { data, isLoading, isError, refetch, isFetching } = useListEngagements({
    query: {
      queryKey: getListEngagementsQueryKey(),
    },
  });
  const engagements = data ?? [];
  const activeCount = engagements.filter((e) => e.status === "active").length;

  return (
    <DashboardLayout
      title="Engagements"
      navGroups={navGroups}
      brandLabel="SMARTCITY OS"
      brandProductName="Plan Review"
      search={{ placeholder: "Search engagements..." }}
    >
      <div className="flex flex-col gap-6">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-[22px] font-bold font-['Oxygen'] text-[var(--text-primary)] m-0">
              Engagements
            </h2>
            <div className="sc-body mt-1">
              {engagements.length} total · {activeCount} active
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

        <div className="sc-card">
          <div className="sc-card-header sc-row-sb">
            <span className="sc-label">ALL ENGAGEMENTS</span>
            <span className="sc-meta">{engagements.length} items</span>
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
            ) : engagements.length === 0 ? (
              <div
                className="p-8 text-center sc-body"
                data-testid="engagements-empty"
              >
                No engagements yet. They'll appear here once a snapshot is
                ingested from Revit.
              </div>
            ) : (
              engagements.map((e) => (
                <EngagementRow key={e.id} engagement={e} />
              ))
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
