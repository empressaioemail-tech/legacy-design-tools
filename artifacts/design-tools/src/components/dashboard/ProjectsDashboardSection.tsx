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
import { relativeTime } from "../../lib/relativeTime";
import { Link2 } from "lucide-react";
import { ClientIntakeModal } from "../intake/ClientIntakeModal";

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
        fontSize: 9,
        letterSpacing: "0.05em",
        padding: "2px 6px",
        borderRadius: 4,
      }}
    >
      No adapters
    </span>
  );
}

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

const MAX_CARDS = 6;

export function ProjectsDashboardSection({
  onRefresh,
  isFetching,
}: {
  onRefresh: () => void;
  isFetching: boolean;
}) {
  const { data } = useListEngagements({
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

  const sortedEngagements = useMemo(() => {
    return [...engagements].sort((a, b) => {
      const aRank = eligibilityById.get(a.id)?.isInPilot ? 0 : 1;
      const bRank = eligibilityById.get(b.id)?.isInPilot ? 0 : 1;
      return aRank - bRank;
    });
  }, [engagements, eligibilityById]);

  const [hideOutOfPilot, setHideOutOfPilot] = useState(false);
  const [intakeOpen, setIntakeOpen] = useState(false);

  const visibleEngagements = useMemo(() => {
    let list = sortedEngagements.filter((e) => e.status !== "archived");
    if (hideOutOfPilot)
      list = list.filter((e) => eligibilityById.get(e.id)?.isInPilot);
    return list.slice(0, MAX_CARDS);
  }, [sortedEngagements, eligibilityById, hideOutOfPilot]);

  const activeCount = engagements.filter((e) => e.status === "active").length;
  const inPilotCount = engagements.filter(
    (e) => eligibilityById.get(e.id)?.isInPilot,
  ).length;
  const outOfPilotCount = engagements.length - inPilotCount;

  return (
    <section className="cockpit-dashboard-section">
      <header className="cockpit-dashboard-section-head">
        <div>
          <h2 className="cockpit-dashboard-section-title">Projects</h2>
          <p className="cockpit-dashboard-section-sub">
            {engagements.length} engagements · {activeCount} active
          </p>
        </div>
        <div className="cockpit-dashboard-section-actions">
          <label className="cockpit-toggle cockpit-dashboard-toggle">
            <input
              type="checkbox"
              data-testid="engagements-filter-in-pilot"
              checked={hideOutOfPilot}
              onChange={(e) => setHideOutOfPilot(e.target.checked)}
            />
            In-pilot only
          </label>
          <button
            type="button"
            className="cockpit-btn-ghost sc-btn-sm"
            onClick={onRefresh}
            disabled={isFetching}
          >
            {isFetching ? "…" : "Refresh"}
          </button>
        </div>
      </header>

      <div
        className="cockpit-dashboard-kpi-row"
        data-testid="engagements-portfolio-kpis"
      >
        <Kpi label="Total" value={engagements.length} />
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
          value={engagements.reduce((a, e) => a + (e.snapshotCount ?? 0), 0)}
        />
      </div>

      <button
        type="button"
        className="cockpit-intake-cta cockpit-intake-cta--compact"
        onClick={() => setIntakeOpen(true)}
        data-testid="engagements-intake-cta"
      >
        <Link2 size={14} aria-hidden />
        <span>New project from link, file, or note</span>
      </button>

      {visibleEngagements.length === 0 ? (
        <div className="cockpit-dashboard-empty sc-prose opacity-70">
          No projects to show. Send a snapshot from Revit or start intake.
        </div>
      ) : (
        <div className="cockpit-dashboard-project-grid">
          {visibleEngagements.map((e) => {
            const latest = e.latestSnapshot;
            const eligibility = eligibilityById.get(e.id);
            return (
              <Link
                key={e.id}
                href={`/engagements/${e.id}`}
                data-testid={`engagement-card-${e.id}`}
                data-in-pilot={eligibility?.isInPilot ? "true" : "false"}
                className="cockpit-engagement-card cockpit-engagement-card--compact"
              >
                <div className="cockpit-engagement-card-header">
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="cockpit-engagement-name truncate">
                      {e.name}
                    </span>
                    <span className="cockpit-engagement-meta truncate">
                      {e.jurisdiction ?? "—"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {eligibility && !eligibility.isInPilot ? (
                      <NoAdaptersPill message={eligibility.message} />
                    ) : null}
                    <StatusPill status={e.status} />
                  </div>
                </div>
                <div className="cockpit-engagement-footer">
                  <span>
                    {e.snapshotCount} snap · {latest?.sheetCount ?? "—"} sheets
                  </span>
                  <span>
                    {relativeTime(latest?.receivedAt ?? e.updatedAt)}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {engagements.length > MAX_CARDS && (
        <p className="cockpit-dashboard-more-hint sc-meta">
          Showing {visibleEngagements.length} of {engagements.length}. Open a
          project from the list rail when inside an engagement.
        </p>
      )}

      <ClientIntakeModal
        isOpen={intakeOpen}
        onClose={() => setIntakeOpen(false)}
      />
    </section>
  );
}
