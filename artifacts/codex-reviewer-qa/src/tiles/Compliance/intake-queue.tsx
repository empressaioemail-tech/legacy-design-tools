import { useEffect, useState, type CSSProperties } from "react";
import { useEngagement } from "../../tile-shell/providers/EngagementProvider";
import { TileStatusBanner } from "../../tile-shell/components/TileStatusBanner";
import { fetchEngagement, fetchQueue } from "../../lib/planReviewBff";
import type { EngagementQueueItem } from "../../tile-shell/types";

const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
};

export default function IntakeQueueTile() {
  const { engagementId, setEngagement, setLoading, queueRefreshToken } = useEngagement();
  const [queue, setQueue] = useState<EngagementQueueItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingQueue, setLoadingQueue] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoadingQueue(true);
    fetchQueue()
      .then((items) => {
        if (!cancelled) setQueue(items);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load queue");
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingQueue(false);
      });
    return () => {
      cancelled = true;
    };
  }, [queueRefreshToken]);

  async function selectCase(id: string) {
    setError(null);
    setLoading(true);
    try {
      const detail = await fetchEngagement(id);
      setEngagement(id, detail);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load engagement");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <TileStatusBanner status="live" label="Intake & Queue" />
      <span style={labelStyle}>Reviewer queue</span>
      {loadingQueue ? (
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading…</span>
      ) : error ? (
        <div role="alert" style={{ fontSize: 12, color: "var(--danger-text)" }}>
          {error}
        </div>
      ) : queue.length === 0 ? (
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          No cases in queue.
        </span>
      ) : (
        <ul
          data-testid="intake-queue-list"
          style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}
        >
          {queue.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                data-testid={`queue-item-${item.engagementId}`}
                onClick={() => void selectCase(item.engagementId)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 10px",
                  borderRadius: 6,
                  border:
                    engagementId === item.engagementId
                      ? "1px solid var(--accent, var(--info-text))"
                      : "1px solid var(--border-subtle)",
                  background:
                    engagementId === item.engagementId
                      ? "var(--info-dim)"
                      : "transparent",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                <div style={{ fontWeight: 600 }}>{item.engagementName}</div>
                <div style={{ color: "var(--text-secondary)" }}>
                  {item.status} · {item.openFindingCount} open · {item.daysInQueue}d
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
