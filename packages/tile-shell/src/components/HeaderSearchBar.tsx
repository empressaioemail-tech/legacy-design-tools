import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  useEngagement,
  type ActiveParcel,
} from "../providers/EngagementProvider";

/**
 * Prominent, always-visible header search — the workflow front door.
 *
 * This is the promoted form of AddressSearchBox (setter #2 of the three unified
 * active-parcel setters). The old box was buried in the SpaceBar among preset
 * pills / Save / Export / +Functions and users could not find it; this renders
 * as the primary element of a dedicated top band: a wide input, debounced
 * geocode typeahead preview, a clear affordance, keyboard focus/navigation, and
 * an explicit search action.
 *
 * The geocode call is injected via `onGeocode` (the app owns the BFF client), so
 * this package stays client-free. On a resolved selection the parcel is written
 * to the ONE shared active-parcel context via `setActiveParcel`, exactly as the
 * old box did — the map, property brief, hazard, setbacks, and every other
 * address-scoped tile react. `onResolved` (optional) fires after the context is
 * set so the app can resolve/create an engagement and load detail.
 */
export function HeaderSearchBar({
  onGeocode,
  onResolved,
  onPreview,
  autoFocus = true,
}: {
  /** Geocode a free-text query to a parcel, or null on miss. App-supplied. */
  onGeocode: (query: string) => Promise<ActiveParcel | null>;
  /** Post-set hook — app may resolve/create an engagement and load its detail. */
  onResolved?: (parcel: ActiveParcel) => Promise<void> | void;
  /**
   * Optional debounced typeahead preview. When supplied, the bar shows a live
   * geocode preview dropdown as the user types (app owns the client, so the
   * preview call is injected too). A single-suggestion contract keeps this
   * dependency-free and honest — the BFF geocode returns one best match.
   */
  onPreview?: (query: string) => Promise<ActiveParcel | null>;
  autoFocus?: boolean;
}) {
  const { setActiveParcel, activeParcel } = useEngagement();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ActiveParcel | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewSeq = useRef(0);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const commit = useCallback(
    (parcel: ActiveParcel) => {
      setActiveParcel(parcel);
      setPreviewOpen(false);
      setPreview(null);
      if (onResolved) void onResolved(parcel);
    },
    [setActiveParcel, onResolved],
  );

  const run = useCallback(async () => {
    const q = query.trim();
    if (!q || busy) return;
    // If a debounced preview already resolved this exact query, commit it
    // directly (avoids a redundant second geocode round-trip).
    if (preview && preview.address && previewOpen) {
      commit(preview);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const parcel = await onGeocode(q);
      if (!parcel) {
        setError("No parcel found for that address.");
        return;
      }
      commit(parcel);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Address search failed.");
    } finally {
      setBusy(false);
    }
  }, [query, busy, preview, previewOpen, onGeocode, commit]);

  // Debounced typeahead preview. Only active when the app supplies onPreview.
  useEffect(() => {
    if (!onPreview) return;
    const q = query.trim();
    if (q.length < 4) {
      setPreview(null);
      setPreviewOpen(false);
      return;
    }
    const seq = ++previewSeq.current;
    const t = setTimeout(async () => {
      try {
        const p = await onPreview(q);
        // Ignore stale responses (a newer keystroke superseded this one).
        if (seq !== previewSeq.current) return;
        setPreview(p);
        setPreviewOpen(p != null);
      } catch {
        if (seq !== previewSeq.current) return;
        setPreview(null);
        setPreviewOpen(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query, onPreview]);

  const clear = useCallback(() => {
    setQuery("");
    setError(null);
    setPreview(null);
    setPreviewOpen(false);
    inputRef.current?.focus();
  }, []);

  const activeLabel = useMemo(() => {
    if (activeParcel.address) return activeParcel.address;
    if (activeParcel.jurisdiction) return activeParcel.jurisdiction;
    return null;
  }, [activeParcel]);

  return (
    <div
      data-testid="header-search-bar"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--h-space-md)",
        padding: "12px 20px",
        background: "var(--h-surface-1)",
        borderBottom: "1px solid var(--h-border-subtle)",
      }}
    >
      <span
        style={{
          fontSize: 15,
          fontWeight: 800,
          letterSpacing: 0.2,
          color: "var(--h-text-primary)",
          whiteSpace: "nowrap",
        }}
      >
        Cortex Workspace
      </span>
      <div style={{ position: "relative", flex: 1, maxWidth: 720 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 12px",
            height: 44,
            borderRadius: 10,
            border: "1px solid var(--h-border-strong)",
            background: "var(--h-surface-2)",
            boxShadow: "0 1px 0 rgba(0,0,0,0.2) inset",
          }}
        >
          <span aria-hidden style={{ fontSize: 16, color: "var(--h-text-muted)" }}>
            ⌕
          </span>
          <input
            ref={inputRef}
            data-testid="header-search-input"
            type="text"
            value={query}
            placeholder="Search an address to load the property…"
            disabled={busy}
            onChange={(e) => {
              setQuery(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
              if (e.key === "Escape") {
                if (previewOpen) setPreviewOpen(false);
                else clear();
              }
            }}
            style={inputStyle}
            aria-label="Search address"
            autoComplete="off"
          />
          {query ? (
            <button
              type="button"
              data-testid="header-search-clear"
              aria-label="Clear search"
              onClick={clear}
              style={iconButtonStyle}
            >
              ×
            </button>
          ) : null}
          <button
            type="button"
            data-testid="header-search-go"
            onClick={() => void run()}
            disabled={busy || !query.trim()}
            style={goStyle(busy || !query.trim())}
          >
            {busy ? "Searching…" : "Search"}
          </button>
        </div>

        {previewOpen && preview ? (
          <button
            type="button"
            data-testid="header-search-preview"
            onMouseDown={(e) => {
              // onMouseDown (not onClick) so it fires before the input blur.
              e.preventDefault();
              commit(preview);
            }}
            style={previewStyle}
          >
            <span style={{ fontSize: 13, color: "var(--h-text-primary)" }}>
              {preview.address ?? "Selected parcel"}
            </span>
            <span style={{ fontSize: 11, color: "var(--h-text-muted)" }}>
              {preview.jurisdiction ?? ""}
              {preview.lat != null && preview.lng != null
                ? `  ·  ${preview.lat.toFixed(4)}, ${preview.lng.toFixed(4)}`
                : ""}
            </span>
          </button>
        ) : null}
      </div>

      {error ? (
        <span
          role="alert"
          data-testid="header-search-error"
          style={{ fontSize: 12, color: "var(--h-error)", maxWidth: 240 }}
        >
          {error}
        </span>
      ) : activeLabel ? (
        <span
          data-testid="header-search-active"
          style={{
            fontSize: 12,
            color: "var(--h-text-muted)",
            maxWidth: 280,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={activeLabel}
        >
          Active: {activeLabel}
        </span>
      ) : null}
    </div>
  );
}

const inputStyle: CSSProperties = {
  flex: 1,
  border: "none",
  outline: "none",
  background: "transparent",
  color: "var(--h-text-primary)",
  fontSize: 14,
  height: "100%",
};

const iconButtonStyle: CSSProperties = {
  border: "none",
  background: "transparent",
  color: "var(--h-text-muted)",
  fontSize: 18,
  lineHeight: 1,
  cursor: "pointer",
  padding: "0 4px",
};

function goStyle(disabled: boolean): CSSProperties {
  return {
    padding: "0 16px",
    height: 32,
    borderRadius: 8,
    border: "none",
    background: disabled ? "var(--h-surface-3)" : "var(--h-accent)",
    color: disabled ? "var(--h-text-muted)" : "#fff",
    fontSize: 13,
    fontWeight: 700,
    whiteSpace: "nowrap",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

const previewStyle: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  left: 0,
  right: 0,
  display: "flex",
  flexDirection: "column",
  gap: 2,
  alignItems: "flex-start",
  textAlign: "left",
  padding: "10px 14px",
  borderRadius: 10,
  border: "1px solid var(--h-border-strong)",
  background: "var(--h-surface-2)",
  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
  cursor: "pointer",
  zIndex: 40,
};
