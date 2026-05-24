import { useMemo, useState, type ReactNode } from "react";
import { Link } from "wouter";
import {
  useListEngagements,
  getListEngagementsQueryKey,
  type EngagementSummary,
} from "@workspace/api-client-react";
import {
  filterApplicableAdapters,
  noApplicableAdaptersMessage,
  resolveJurisdiction,
  type AdapterContext,
} from "@workspace/adapters";
import { StatusPill } from "@workspace/portal-ui";
import { AppShell } from "../components/AppShell";
import { relativeTime } from "../lib/relativeTime";

function NoAdaptersPill({ message }: { message: string }) {
  return (
    <span
      className="sc-pill"
      data-testid="engagement-card-no-adapters-pill"
      title={message}
      style={{
        background: "var(--info-dim)",
        color: "var(--info-text)",
        textTransform: "uppercase",
        fontSize: 10,
        letterSpacing: "0.05em",
        padding: "3px 8px",
        borderRadius: 4,
      }}
    >
      No adapters
    </span>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string | number; sub?: ReactNode }) {
  return (
    <div className="cockpit-portfolio-kpi">
      <div className="cockpit-overline">{label}</div>
      <div className="cockpit-kpi-value">{value}</div>
      {sub && <div className="cockpit-kpi-sub">{sub}</div>}
    </div>
  );
}

/**
 * Pre-flight pilot eligibility from a cached engagement-list row.
 *
 * Mirrors the per-engagement compute in `SiteContextTab` (Task #189)
 * but for the *list* surface so an architect can triage out-of-pilot
 * projects without opening each detail page (Task #235). Both
 * surfaces feed the same `resolveJurisdiction` + `filterApplicableAdapters`
 * pair from `@workspace/adapters/eligibility`, which is also the
 * source of truth the server's `generateLayers` 422 envelope reads
 * from — so the list pill, the detail-tab banner, and the server
 * verdict cannot disagree.
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
  const hasGeocode = Number.isFinite(lat) && Number.isFinite(lng);
  const ctx: AdapterContext = {
    parcel: { latitude: lat, longitude: lng },
    jurisdiction,
  };
  const applicable = filterApplicableAdapters(ctx);
  return {
    isInPilot: applicable.length > 0,
    message: noApplicableAdaptersMessage({ jurisdiction, hasGeocode }),
  };
}

export function EngagementList() {
  const { data, refetch, isFetching } = useListEngagements({
    query: {
      queryKey: getListEngagementsQueryKey(),
      refetchInterval: 5000,
    },
  });
  const engagements = data ?? [];

  const eligibilityById = useMemo(() => {
    const m = new Map<string, ReturnType<typeof computeEligibility>>();
    for (const e of engagements) m.set(e.id, computeEligibility(e));
    return m;
  }, [engagements]);

  // Stable sort: in-pilot first, preserves API's updatedAt desc within group.
  const sortedEngagements = useMemo(() => {
    return [...engagements].sort((a, b) => {
      const aRank = eligibilityById.get(a.id)?.isInPilot ? 0 : 1;
      const bRank = eligibilityById.get(b.id)?.isInPilot ? 0 : 1;
      return aRank - bRank;
    });
  }, [engagements, eligibilityById]);

  const [hideOutOfPilot, setHideOutOfPilot] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const visibleEngagements = useMemo(() => {
    let list = sortedEngagements;
    if (!showArchived) list = list.filter((e) => e.status !== "archived");
    if (hideOutOfPilot)
      list = list.filter((e) => eligibilityById.get(e.id)?.isInPilot);
    return list;
  }, [sortedEngagements, eligibilityById, hideOutOfPilot, showArchived]);

  const archivedCount = useMemo(
    () => engagements.filter((e) => e.status === "archived").length,
    [engagements],
  );
  const outOfPilotCount =
    engagements.length -
    visibleEngagementsInPilotCount(engagements, eligibilityById);

  const totalSnapshots = engagements.reduce(
    (acc, e) => acc + (e.snapshotCount ?? 0),
    0,
  );
  const totalSheets = engagements.reduce(
    (acc, e) => acc + (e.latestSnapshot?.sheetCount ?? 0),
    0,
  );
  const activeCount = engagements.filter((e) => e.status === "active").length;
  const inPilotCount = engagements.filter(
    (e) => eligibilityById.get(e.id)?.isInPilot,
  ).length;

  const headerActions = (
    <button
      className="cockpit-btn-ghost"
      onClick={() => refetch()}
      disabled={isFetching}
    >
      {isFetching ? "Refreshing…" : "Refresh"}
    </button>
  );

  return (
    <AppShell title="Projects" headerActions={headerActions}>
      <div className="cockpit-page flex flex-col gap-6">
        {/* PORTFOLIO KPI STRIP ---------------------------------- */}
        <section
          className="grid grid-cols-2 md:grid-cols-4 gap-3"
          data-testid="engagements-portfolio-kpis"
        >
          <Kpi
            label="Engagements"
            value={engagements.length}
            sub={`${activeCount} active`}
          />
          <Kpi
            label="In pilot"
            value={inPilotCount}
            sub={
              outOfPilotCount > 0 ? (
                <span data-testid="engagements-out-of-pilot-tally">
                  {outOfPilotCount} out of pilot
                </span>
              ) : (
                "All actionable"
              )
            }
          />
          <Kpi
            label="Snapshots"
            value={totalSnapshots}
            sub={`${totalSheets} sheets`}
          />
          <Kpi
            label="Archived"
            value={archivedCount}
            sub={
              archivedCount > 0 && !showArchived ? (
                <span data-testid="engagements-archived-tally">hidden</span>
              ) : (
                "—"
              )
            }
          />
        </section>

        {/* TOOLBAR --------------------------------------------- */}
        <div className="flex items-center justify-between gap-4">
          <div className="cockpit-overline">Portfolio · {visibleEngagements.length} visible</div>
          <div className="flex items-center gap-4">
            <label className="cockpit-toggle" style={{ cursor: "pointer", userSelect: "none" }}>
              <input
                type="checkbox"
                data-testid="engagements-filter-in-pilot"
                checked={hideOutOfPilot}
                onChange={(e) => setHideOutOfPilot(e.target.checked)}
              />
              In-pilot only
            </label>
            <label className="cockpit-toggle" style={{ cursor: "pointer", userSelect: "none" }}>
              <input
                type="checkbox"
                data-testid="engagements-filter-show-archived"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              Show archived
            </label>
          </div>
        </div>

        {/* ENGAGEMENT GRID ------------------------------------- */}
        {engagements.length === 0 ? (
          <div className="cockpit-card cockpit-empty">
            <div className="cockpit-empty-title">No engagements yet</div>
            <div className="cockpit-empty-body">
              Send a snapshot from Revit to create one.
            </div>
          </div>
        ) : visibleEngagements.length === 0 ? (
          <div className="cockpit-card cockpit-empty">
            <div
              className="cockpit-empty-body"
              data-testid="engagements-empty-filtered"
            >
              No in-pilot engagements right now. Uncheck "In-pilot only" to see
              the {engagements.length} project
              {engagements.length === 1 ? "" : "s"} outside the current adapter
              set.
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {visibleEngagements.map((e) => {
              const latest = e.latestSnapshot;
              const eligibility = eligibilityById.get(e.id);
              return (
                <Link
                  key={e.id}
                  href={`/engagements/${e.id}`}
                  data-testid={`engagement-card-${e.id}`}
                  data-in-pilot={eligibility?.isInPilot ? "true" : "false"}
                  className="cockpit-engagement-card"
                >
                  <div className="cockpit-engagement-card-header">
                    <div className="flex flex-col gap-1 min-w-0">
                      <span className="cockpit-engagement-name truncate">{e.name}</span>
                      <span className="cockpit-engagement-meta truncate">
                        {e.address ?? "No address set"}
                        {e.jurisdiction ? ` · ${e.jurisdiction}` : ""}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {eligibility && !eligibility.isInPilot ? (
                        <NoAdaptersPill message={eligibility.message} />
                      ) : null}
                      <StatusPill status={e.status} />
                    </div>
                  </div>
                  <div className="cockpit-engagement-kpis">
                    <CountCell label="Sheets" value={latest?.sheetCount} />
                    <CountCell label="Rooms" value={latest?.roomCount} />
                    <CountCell label="Levels" value={latest?.levelCount} />
                    <CountCell label="Walls" value={latest?.wallCount} />
                  </div>
                  <div className="cockpit-engagement-footer">
                    <span>
                      {e.snapshotCount} snapshot
                      {e.snapshotCount === 1 ? "" : "s"}
                    </span>
                    <span>
                      Updated{" "}
                      {relativeTime(latest?.receivedAt ?? e.updatedAt)}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </AppShell>
  );
}

function CountCell({
  label,
  value,
}: {
  label: string;
  value: number | null | undefined;
}) {
  return (
    <div>
      <div className="cockpit-cell-label">{label}</div>
      <div className="cockpit-cell-value">{value ?? "—"}</div>
    </div>
  );
}

function visibleEngagementsInPilotCount(
  engagements: EngagementSummary[],
  eligibilityById: Map<string, { isInPilot: boolean }>,
): number {
  let n = 0;
  for (const e of engagements) {
    if (eligibilityById.get(e.id)?.isInPilot) n += 1;
  }
  return n;
}
