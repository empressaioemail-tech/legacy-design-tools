import { useMemo } from "react";
import { useParams, useSearch, Link } from "wouter";
import { ArrowLeft, ArrowRight, Camera, Minus, Plus } from "lucide-react";
import {
  useGetEngagement,
  useGetSnapshot,
  getGetSnapshotQueryKey,
} from "@workspace/api-client-react";
import { AppShell } from "../components/AppShell";
import { relativeTime } from "../lib/relativeTime";
import {
  diffSnapshotPayloads,
  type EntityDiff,
  type SnapshotPayloadDiff,
} from "../lib/snapshotDiff";

const ENGAGEMENTS_BASE = `${import.meta.env.BASE_URL}engagements`;

/**
 * Side-by-side diff view for two snapshots in the same engagement
 * (Task #54). Wired up from the assistant chat chips: when the user
 * compared 2+ snapshots in a turn, each `{{atom:snapshot:<id>:focus}}`
 * citation chip deep-links here with `?a=<chip-id>&b=<other-id>`.
 *
 * Why a dedicated page rather than a modal?
 *   - The diff can be wide (rooms + sheets + levels + areas + walls)
 *     and benefits from full viewport space.
 *   - Bookmarkable / shareable URL — engineers can paste a compare
 *     link into a follow-up message in another tool.
 *   - Decouples chat panel state from compare state, so navigating
 *     here doesn't disturb in-progress chat threads.
 *
 * Both snapshot payloads are pulled via the same `useGetSnapshot` hook
 * the engagement detail page uses, so the React Query cache is shared
 * (the snapshots may already be in cache from a recent
 * `EngagementDetail` visit). The diff itself is computed in
 * `lib/snapshotDiff.ts` — pure data, no network — and renders a
 * structured comparison rather than just dumping raw JSON.
 */
export function EngagementCompare() {
  const params = useParams<{ id: string }>();
  const search = useSearch();
  const engagementId = params.id;

  // wouter's useSearch returns the raw query string ("a=xxx&b=yyy")
  // — parse it once and remember the values so a re-render from the
  // streaming chat panel doesn't churn URLSearchParams allocations.
  const { aId, bId } = useMemo(() => {
    const sp = new URLSearchParams(search);
    return {
      aId: sp.get("a") ?? "",
      bId: sp.get("b") ?? "",
    };
  }, [search]);

  const { data: engagement } = useGetEngagement(engagementId);

  // Snapshot fetch is gated by id presence (`enabled: !!aId`) so the
  // initial render with empty `?a=` doesn't hammer the API with a
  // GET /api/snapshots/. The hook still has to be called
  // unconditionally to satisfy React rules.
  const snapAQuery = useGetSnapshot(aId, {
    query: {
      queryKey: getGetSnapshotQueryKey(aId),
      enabled: aId.length > 0,
    },
  });
  const snapBQuery = useGetSnapshot(bId, {
    query: {
      queryKey: getGetSnapshotQueryKey(bId),
      enabled: bId.length > 0,
    },
  });

  const diff: SnapshotPayloadDiff | null = useMemo(() => {
    if (!snapAQuery.data || !snapBQuery.data) return null;
    return diffSnapshotPayloads(
      snapAQuery.data.payload,
      snapBQuery.data.payload,
    );
  }, [snapAQuery.data, snapBQuery.data]);

  const title = engagement?.name
    ? `Compare snapshots — ${engagement.name}`
    : "Compare snapshots";

  return (
    <AppShell title={title}>
      <div
        className="sc-scroll"
        style={{
          padding: "24px 32px",
          height: "100%",
          overflowY: "auto",
          color: "var(--text-primary)",
        }}
      >
        <div style={{ marginBottom: 16 }}>
          <Link
            href={`${ENGAGEMENTS_BASE}/${engagementId}`}
            className="sc-meta"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              color: "var(--text-secondary)",
              textDecoration: "none",
              fontSize: 11,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            <ArrowLeft size={12} />
            Back to engagement
          </Link>
        </div>

        {(!aId || !bId) && (
          <EmptyState
            message="Compare requires two snapshot ids in the URL — e.g. ?a=<id1>&b=<id2>."
          />
        )}

        {aId && bId && aId === bId && (
          <EmptyState
            message="Both `a` and `b` point to the same snapshot — nothing to compare. Pick a second snapshot in the chat panel and try again."
          />
        )}

        {aId && bId && aId !== bId && (
          <CompareBody
            engagementId={engagementId}
            snapAState={{
              isLoading: snapAQuery.isLoading,
              error: snapAQuery.error,
              data: snapAQuery.data ?? null,
              id: aId,
            }}
            snapBState={{
              isLoading: snapBQuery.isLoading,
              error: snapBQuery.error,
              data: snapBQuery.data ?? null,
              id: bId,
            }}
            diff={diff}
          />
        )}
      </div>
    </AppShell>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div
      className="sc-card"
      style={{
        padding: 24,
        background: "var(--bg-input)",
        border: "1px dashed var(--border-default)",
        color: "var(--text-secondary)",
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      {message}
    </div>
  );
}

interface SnapshotState {
  id: string;
  isLoading: boolean;
  error: unknown;
  data: {
    id: string;
    projectName: string;
    receivedAt: string;
    sheetCount: number | null;
    roomCount: number | null;
    levelCount: number | null;
    wallCount: number | null;
  } | null;
}

function CompareBody({
  engagementId: _engagementId,
  snapAState,
  snapBState,
  diff,
}: {
  engagementId: string;
  snapAState: SnapshotState;
  snapBState: SnapshotState;
  diff: SnapshotPayloadDiff | null;
}) {
  if (snapAState.isLoading || snapBState.isLoading) {
    return (
      <div className="sc-meta" style={{ color: "var(--text-secondary)" }}>
        Loading snapshots…
      </div>
    );
  }
  if (snapAState.error || snapBState.error) {
    const which: string[] = [];
    if (snapAState.error) which.push(`base (${snapAState.id.slice(0, 8)})`);
    if (snapBState.error) which.push(`head (${snapBState.id.slice(0, 8)})`);
    return (
      <EmptyState
        message={`Could not load snapshot${which.length === 1 ? "" : "s"}: ${which.join(", ")}. The id may be invalid or the snapshot may have been archived.`}
      />
    );
  }
  if (!snapAState.data || !snapBState.data || !diff) {
    return <EmptyState message="Snapshots not available." />;
  }

  return (
    <>
      <SnapshotHeaderRow
        base={snapAState.data}
        head={snapBState.data}
      />
      <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 16 }}>
        {diff.entities.length === 0 && diff.walls.delta === null && (
          <EmptyState
            message="Neither snapshot's payload contained recognisable entity arrays (rooms / sheets / levels / areas / walls). Nothing to diff."
          />
        )}
        {diff.entities.map((bucket) => (
          <EntityDiffCard key={bucket.label} bucket={bucket} />
        ))}
        {diff.walls.delta !== null && <WallsCard diff={diff.walls} />}
      </div>
    </>
  );
}

function SnapshotHeaderRow({
  base,
  head,
}: {
  base: NonNullable<SnapshotState["data"]>;
  head: NonNullable<SnapshotState["data"]>;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto 1fr",
        gap: 16,
        alignItems: "center",
      }}
    >
      <SnapshotHeaderCard label="Base" snapshot={base} side="left" />
      <ArrowRight size={20} style={{ color: "var(--text-secondary)" }} />
      <SnapshotHeaderCard label="Head" snapshot={head} side="right" />
    </div>
  );
}

function SnapshotHeaderCard({
  label,
  snapshot,
  side,
}: {
  label: string;
  snapshot: NonNullable<SnapshotState["data"]>;
  side: "left" | "right";
}) {
  const short = snapshot.id.slice(0, 8);
  return (
    <div
      className="sc-card"
      style={{
        padding: 16,
        textAlign: side === "left" ? "right" : "left",
      }}
    >
      <div
        className="sc-meta"
        style={{
          color: "var(--text-secondary)",
          fontSize: 10,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          background: "rgba(99, 152, 170, 0.18)",
          color: "var(--cyan)",
          fontSize: 11,
          letterSpacing: "0.04em",
          padding: "2px 8px",
          borderRadius: 4,
          textTransform: "uppercase",
          marginBottom: 8,
        }}
      >
        <Camera size={11} />
        SNAP·{short}
      </div>
      <div className="sc-ui" style={{ fontSize: 13, marginBottom: 4 }}>
        {snapshot.projectName}
      </div>
      <div
        className="sc-meta"
        style={{ color: "var(--text-secondary)", fontSize: 11 }}
      >
        Captured {relativeTime(snapshot.receivedAt)}
      </div>
      <div
        className="sc-meta"
        style={{
          color: "var(--text-secondary)",
          fontSize: 11,
          marginTop: 6,
        }}
      >
        {snapshot.sheetCount ?? "—"}sh · {snapshot.roomCount ?? "—"}rm ·{" "}
        {snapshot.levelCount ?? "—"}lv · {snapshot.wallCount ?? "—"}w
      </div>
    </div>
  );
}

function EntityDiffCard({ bucket }: { bucket: EntityDiff }) {
  const netDelta = bucket.headCount - bucket.baseCount;
  const sign = netDelta >= 0 ? "+" : "";
  const noChanges = bucket.added.length === 0 && bucket.removed.length === 0;
  return (
    <div className="sc-card" style={{ padding: 16 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 12,
        }}
      >
        <div className="sc-ui" style={{ fontSize: 14, fontWeight: 600 }}>
          {bucket.label}
        </div>
        <div
          className="sc-meta"
          style={{ color: "var(--text-secondary)", fontSize: 11 }}
        >
          {bucket.baseCount} → {bucket.headCount}{" "}
          <span style={{ marginLeft: 6 }}>
            (+{bucket.added.length}/-{bucket.removed.length} · net {sign}
            {netDelta})
          </span>
        </div>
      </div>
      {noChanges && (
        <div
          className="sc-meta"
          style={{ color: "var(--text-muted)", fontSize: 12 }}
        >
          No identity-keyed changes between snapshots.
        </div>
      )}
      {bucket.added.length > 0 && (
        <ChangeList icon="add" title="Added" entries={bucket.added} />
      )}
      {bucket.removed.length > 0 && (
        <div style={{ marginTop: bucket.added.length > 0 ? 12 : 0 }}>
          <ChangeList icon="remove" title="Removed" entries={bucket.removed} />
        </div>
      )}
    </div>
  );
}

function ChangeList({
  icon,
  title,
  entries,
}: {
  icon: "add" | "remove";
  title: string;
  entries: ReadonlyArray<{ key: string; label: string }>;
}) {
  const isAdd = icon === "add";
  const accent = isAdd ? "var(--cyan)" : "#f59e0b";
  return (
    <div>
      <div
        className="sc-meta"
        style={{
          color: accent,
          fontSize: 10,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          marginBottom: 6,
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        {isAdd ? <Plus size={10} /> : <Minus size={10} />}
        {title} ({entries.length})
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {entries.map((e) => (
          <span
            key={`${title}-${e.key}`}
            className="sc-pill"
            title={e.label}
            style={{
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 3,
              background: isAdd
                ? "rgba(0,180,216,0.12)"
                : "rgba(245,158,11,0.12)",
              color: accent,
              border: `1px solid ${accent}`,
            }}
          >
            {e.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function WallsCard({
  diff,
}: {
  diff: { baseCount: number | null; headCount: number | null; delta: number | null };
}) {
  const delta = diff.delta ?? 0;
  const sign = delta >= 0 ? "+" : "";
  return (
    <div className="sc-card" style={{ padding: 16 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <div className="sc-ui" style={{ fontSize: 14, fontWeight: 600 }}>
          Walls
        </div>
        <div
          className="sc-meta"
          style={{ color: "var(--text-secondary)", fontSize: 11 }}
        >
          {diff.baseCount ?? 0} → {diff.headCount ?? 0}{" "}
          <span style={{ marginLeft: 6 }}>
            ({sign}
            {delta})
          </span>
        </div>
      </div>
      <div
        className="sc-meta"
        style={{
          marginTop: 8,
          color: "var(--text-muted)",
          fontSize: 11,
          fontStyle: "italic",
        }}
      >
        Walls are diffed by count only — Revit walls don't carry a stable
        user-facing identifier the way rooms and sheets do.
      </div>
    </div>
  );
}
