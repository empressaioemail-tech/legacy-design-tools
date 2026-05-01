import { useMemo, useState } from "react";
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
import { AppShell } from "../components/AppShell";
import { relativeTime } from "../lib/relativeTime";

const STATUS_ACCENT: Record<string, { bg: string; color: string }> = {
  active: { bg: "rgba(0,180,216,0.15)", color: "var(--cyan)" },
  on_hold: { bg: "rgba(245,158,11,0.18)", color: "#f59e0b" },
  archived: { bg: "var(--bg-input)", color: "var(--text-muted)" },
};

function StatusPill({ status }: { status: string }) {
  const accent = STATUS_ACCENT[status] ?? STATUS_ACCENT.active;
  return (
    <span
      className="sc-pill"
      style={{
        background: accent.bg,
        color: accent.color,
        textTransform: "uppercase",
        fontSize: 11,
        letterSpacing: "0.05em",
        padding: "3px 8px",
        borderRadius: 4,
      }}
    >
      {status.replace("_", " ")}
    </span>
  );
}

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

function CountCell({
  label,
  value,
}: {
  label: string;
  value: number | null | undefined;
}) {
  return (
    <div>
      <div className="sc-data-label">{label}</div>
      <div className="sc-mono mt-1">{value ?? "—"}</div>
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
 *
 * The card-level message is derived once via the shared
 * `noApplicableAdaptersMessage` helper and passed into the pill's
 * `title` tooltip so the list and detail copy stay in lockstep.
 *
 * Computed off the same `EngagementSummary` shape returned by
 * `GET /engagements` — the row already carries `site.geocode`
 * (jurisdictionCity / jurisdictionState) and the freeform
 * `jurisdiction` / `address` columns the resolver consumes.
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

export function EngagementList() {
  const { data, refetch, isFetching } = useListEngagements({
    query: {
      queryKey: getListEngagementsQueryKey(),
      refetchInterval: 5000,
    },
  });
  const engagements = data ?? [];

  // Per-row eligibility, memoized so a refetch with the same row
  // shapes doesn't re-run the resolver unnecessarily. The map is
  // keyed by id so the filter checkbox below can read each row's
  // verdict in O(1) without re-invoking the resolver.
  const eligibilityById = useMemo(() => {
    const m = new Map<string, ReturnType<typeof computeEligibility>>();
    for (const e of engagements) m.set(e.id, computeEligibility(e));
    return m;
  }, [engagements]);

  // Optional list-level filter (Task #235 stretch goal). Defaults
  // off so the existing "show everything" behaviour is preserved on
  // first load; flipping it on hides every row whose jurisdiction
  // resolves to no applicable adapters so an architect can focus
  // triage on the actionable subset.
  const [hideOutOfPilot, setHideOutOfPilot] = useState(false);
  const visibleEngagements = useMemo(
    () =>
      hideOutOfPilot
        ? engagements.filter((e) => eligibilityById.get(e.id)?.isInPilot)
        : engagements,
    [engagements, eligibilityById, hideOutOfPilot],
  );
  const outOfPilotCount = engagements.length - visibleEngagementsInPilotCount(
    engagements,
    eligibilityById,
  );

  const totalSnapshots = engagements.reduce(
    (acc, e) => acc + (e.snapshotCount ?? 0),
    0,
  );
  const activeCount = engagements.filter((e) => e.status === "active").length;

  return (
    <AppShell title="Projects">
      <div className="flex flex-col gap-6 h-full">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-[22px] m-0">Active engagements</h2>
            <div className="sc-body opacity-70 mt-1">
              {activeCount} active · {totalSnapshots} total snapshot
              {totalSnapshots === 1 ? "" : "s"}
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
            >
              {isFetching ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        {engagements.length === 0 ? (
          <div className="sc-card p-8">
            <div className="sc-prose text-center opacity-70">
              No engagements yet. Send a snapshot from Revit to create one.
            </div>
          </div>
        ) : visibleEngagements.length === 0 ? (
          <div className="sc-card p-8">
            <div
              className="sc-prose text-center opacity-70"
              data-testid="engagements-empty-filtered"
            >
              No in-pilot engagements right now. Uncheck "Show only in-pilot"
              to see the {engagements.length} project
              {engagements.length === 1 ? "" : "s"} outside the current
              adapter set.
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {visibleEngagements.map((e) => {
              const latest = e.latestSnapshot;
              const eligibility = eligibilityById.get(e.id);
              return (
                <Link
                  key={e.id}
                  href={`/engagements/${e.id}`}
                  data-testid={`engagement-card-${e.id}`}
                  data-in-pilot={eligibility?.isInPilot ? "true" : "false"}
                  className="sc-card sc-card-clickable flex flex-col"
                  style={{ textDecoration: "none", color: "inherit" }}
                >
                  <div className="sc-card-header sc-row-sb">
                    <span className="sc-medium">{e.name}</span>
                    <div className="flex items-center gap-2">
                      {eligibility && !eligibility.isInPilot ? (
                        <NoAdaptersPill message={eligibility.message} />
                      ) : null}
                      <StatusPill status={e.status} />
                    </div>
                  </div>
                  <div className="flex flex-col gap-3" style={{ padding: 14 }}>
                    {e.address ? (
                      <div className="sc-body">{e.address}</div>
                    ) : (
                      <div className="sc-micro opacity-60">No address set</div>
                    )}
                    {e.jurisdiction && (
                      <div className="sc-meta">{e.jurisdiction}</div>
                    )}
                    <div className="grid grid-cols-4 gap-3 mt-2">
                      <CountCell label="SHEETS" value={latest?.sheetCount} />
                      <CountCell label="ROOMS" value={latest?.roomCount} />
                      <CountCell label="LEVELS" value={latest?.levelCount} />
                      <CountCell label="WALLS" value={latest?.wallCount} />
                    </div>
                  </div>
                  <div className="sc-card-footer sc-row-sb">
                    <span className="sc-meta">
                      {e.snapshotCount} snapshot{e.snapshotCount === 1 ? "" : "s"}
                    </span>
                    <span className="sc-meta">
                      Updated {relativeTime(latest?.receivedAt ?? e.updatedAt)}
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
