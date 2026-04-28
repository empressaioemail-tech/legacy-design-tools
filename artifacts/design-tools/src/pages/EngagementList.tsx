import { Link } from "wouter";
import {
  useListEngagements,
  getListEngagementsQueryKey,
} from "@workspace/api-client-react";
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

export function EngagementList() {
  const { data, refetch, isFetching } = useListEngagements({
    query: {
      queryKey: getListEngagementsQueryKey(),
      refetchInterval: 5000,
    },
  });
  const engagements = data ?? [];
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
            </div>
          </div>
          <button
            className="sc-btn-ghost"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            {isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {engagements.length === 0 ? (
          <div className="sc-card p-8">
            <div className="sc-prose text-center opacity-70">
              No engagements yet. Send a snapshot from Revit to create one.
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {engagements.map((e) => {
              const latest = e.latestSnapshot;
              return (
                <Link
                  key={e.id}
                  href={`/engagements/${e.id}`}
                  className="sc-card sc-card-clickable flex flex-col"
                  style={{ textDecoration: "none", color: "inherit" }}
                >
                  <div className="sc-card-header sc-row-sb">
                    <span className="sc-medium">{e.name}</span>
                    <StatusPill status={e.status} />
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
