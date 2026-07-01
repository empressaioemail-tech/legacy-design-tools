import { useEffect, useState } from "react";
import { useEngagement } from "../../tile-shell/providers/EngagementProvider";
import { TileStatusBanner } from "../../tile-shell/components/TileStatusBanner";
import {
  fetchEngagementResponseTasks,
  type PlanReviewResponseTaskWire,
} from "../../lib/planReviewBff";

export default function ResponseTasksTile() {
  const { engagementId } = useEngagement();
  const [tasks, setTasks] = useState<PlanReviewResponseTaskWire[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!engagementId) {
      setTasks([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchEngagementResponseTasks(engagementId)
      .then((res) => {
        if (!cancelled) setTasks(res.responseTasks);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load tasks");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [engagementId]);

  return (
    <div
      style={{
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        overflow: "auto",
        height: "100%",
      }}
    >
      <TileStatusBanner status="live" label="Response Tasks" />
      {!engagementId ? (
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
          Select a case first.
        </p>
      ) : loading ? (
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
          Loading…
        </p>
      ) : tasks.length === 0 ? (
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
          Run compliance review first to generate response tasks.
        </p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
          {tasks.map((t) => (
            <li
              key={t.entityId}
              style={{
                padding: 8,
                borderRadius: 6,
                border: "1px solid var(--border-subtle)",
                fontSize: 12,
              }}
            >
              <div style={{ fontWeight: 600 }}>{t.title}</div>
              <div style={{ color: "var(--text-secondary)", marginTop: 4 }}>
                {t.description}
              </div>
              <div style={{ marginTop: 4, color: "var(--text-muted)" }}>
                Status: {t.state}
                {t.findingId ? ` · finding ${t.findingId.slice(0, 8)}…` : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <div role="alert" style={{ fontSize: 12, color: "var(--danger-text)" }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
