import { useCallback, useState, type CSSProperties } from "react";
import {
  useEngagement,
  type ActiveParcel,
} from "../providers/EngagementProvider";

/**
 * Top-bar address search. Setter #2 of the three unified active-parcel setters.
 *
 * The geocoding call is injected via `onGeocode` (the app owns the BFF client),
 * so this package stays free of any client dependency. On a hit, the resolved
 * parcel is written to the ONE shared active-parcel context via
 * `setActiveParcel`, so the map, property brief, hazard, setbacks, and every
 * other address-scoped tile react. If the app also resolves/creates an
 * engagement for the parcel it returns `engagementId` on the parcel and may
 * separately load the engagement detail (via `onResolved`).
 */
export function AddressSearchBox({
  onGeocode,
  onResolved,
}: {
  /** Geocode a free-text query to a parcel, or null on miss. App-supplied. */
  onGeocode: (query: string) => Promise<ActiveParcel | null>;
  /**
   * Optional post-set hook — e.g. the app can create/resolve an engagement for
   * the parcel and load its full detail. Runs after the shared context is set.
   */
  onResolved?: (parcel: ActiveParcel) => Promise<void> | void;
}) {
  const { setActiveParcel } = useEngagement();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      const parcel = await onGeocode(q);
      if (!parcel) {
        setError("No parcel found for that address.");
        return;
      }
      setActiveParcel(parcel);
      if (onResolved) await onResolved(parcel);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Address search failed.");
    } finally {
      setBusy(false);
    }
  }, [query, busy, onGeocode, setActiveParcel, onResolved]);

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <input
        data-testid="address-search-input"
        type="text"
        value={query}
        placeholder="Search address…"
        disabled={busy}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void run();
        }}
        style={inputStyle}
        aria-label="Address search"
      />
      <button
        type="button"
        data-testid="address-search-go"
        onClick={() => void run()}
        disabled={busy || !query.trim()}
        style={goStyle(busy || !query.trim())}
      >
        {busy ? "…" : "Go"}
      </button>
      {error ? (
        <span
          role="alert"
          style={{ fontSize: 11, color: "var(--h-error)", maxWidth: 200 }}
        >
          {error}
        </span>
      ) : null}
    </span>
  );
}

const inputStyle: CSSProperties = {
  padding: "4px 10px",
  borderRadius: 999,
  border: "1px solid var(--h-border-subtle)",
  background: "var(--h-surface-2)",
  color: "var(--h-text-primary)",
  fontSize: 12,
  width: 200,
};

function goStyle(disabled: boolean): CSSProperties {
  return {
    padding: "4px 12px",
    borderRadius: 999,
    border: "1px solid var(--h-border-subtle)",
    background: disabled ? "transparent" : "var(--h-accent)",
    color: disabled ? "var(--h-text-muted)" : "#fff",
    fontSize: 12,
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}
