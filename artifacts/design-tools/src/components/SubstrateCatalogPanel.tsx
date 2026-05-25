/**
 * SubstrateCatalogPanel — the live Hauska substrate catalog.
 *
 * QA-17: the Code Library listed only the two jurisdictions with a
 * cortex-prod-local corpus. This panel reads `/api/substrate/jurisdictions`,
 * which cortex-api backs with the Hauska MCP server's `list_jurisdictions`
 * tool, so every ingested jurisdiction shows up — including the
 * `platform-internal` ones an authenticated Cortex product key unlocks.
 *
 * Net-new read surface: it does not replace the cortex-prod-local
 * jurisdiction cards above it (those still own warmup + atom browsing).
 * Self-contained on `fetch` (no react-query) so it carries no QueryClient
 * coupling into the page.
 */

import { useEffect, useState } from "react";
import { Globe } from "lucide-react";

type SubstrateAccessPolicy =
  | "public-free"
  | "public-paid"
  | "platform-internal"
  | "tenant-private";

interface SubstrateJurisdiction {
  key: string;
  displayName: string;
  atomCount: number;
  accessPolicy: SubstrateAccessPolicy;
  qualityBar: string;
  driftStatus: string;
  lastRefreshedAt: string | null;
}

interface SubstrateCatalog {
  source: "mcp" | "mock";
  jurisdictions: SubstrateJurisdiction[];
  total?: number;
  filtered?: number;
}

async function fetchSubstrateCatalog(
  stateCodes: string[],
): Promise<SubstrateCatalog & { total?: number; filtered?: number }> {
  const params = new URLSearchParams();
  if (stateCodes.length > 0) {
    params.set("states", stateCodes.join(","));
  }
  const qs = params.toString();
  const res = await fetch(
    `/api/substrate/jurisdictions${qs ? `?${qs}` : ""}`,
  );
  if (!res.ok) {
    // The route answers 502 with { error, code, detail } when the
    // substrate itself is unreachable — surface the detail so the
    // operator can act without server-log access.
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { detail?: string; error?: string };
      detail = body.detail ?? body.error ?? detail;
    } catch {
      /* non-JSON body — keep the status-code message */
    }
    throw new Error(detail);
  }
  return (await res.json()) as SubstrateCatalog;
}

/** ADR-017 access tier → badge label + color. */
const ACCESS_POLICY_BADGE: Record<
  SubstrateAccessPolicy,
  { label: string; bg: string; fg: string }
> = {
  "public-free": {
    label: "Public",
    bg: "rgba(46, 160, 110, 0.18)",
    fg: "#2ea06e",
  },
  "public-paid": {
    label: "Public · Paid",
    bg: "rgba(180, 140, 40, 0.18)",
    fg: "#b48c28",
  },
  "platform-internal": {
    label: "Platform-internal",
    bg: "rgba(0, 180, 216, 0.15)",
    fg: "var(--cyan)",
  },
  "tenant-private": {
    label: "Tenant-private",
    bg: "rgba(170, 90, 200, 0.18)",
    fg: "#aa5ac8",
  },
};

export function SubstrateCatalogPanel({
  onSourceChange,
  stateCodes = [],
  showAllJurisdictions = false,
  onShowAllChange,
}: {
  /** QA-38 — parent hides cortex-local split when source is live MCP. */
  onSourceChange?: (source: "mcp" | "mock") => void;
  /** v3 — server-side state filter (engagements ∪ practice states). Omit when show-all. */
  stateCodes?: string[];
  /** v3 — fetch nationwide catalog (no `?states=`). */
  showAllJurisdictions?: boolean;
  onShowAllChange?: (showAll: boolean) => void;
} = {}) {
  const [data, setData] = useState<SubstrateCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchStates = showAllJurisdictions ? [] : stateCodes;

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    fetchSubstrateCatalog(fetchStates)
      .then((catalog) => {
        if (cancelled) return;
        setData(catalog);
        onSourceChange?.(catalog.source);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchStates.join(","), showAllJurisdictions]);

  return (
    <div className="flex flex-col gap-3" data-testid="substrate-catalog-panel">
      {data?.source === "mock" && (
        <div
          className="alert-block warning rounded-md"
          data-testid="substrate-mock-banner"
          style={{ fontSize: 12, padding: "10px 12px" }}
        >
          <strong>Fixture catalog only (5 jurisdictions).</strong> Live Hauska
          ingest (Sync 5 TX metros, Dallas, etc.) requires{" "}
          <code>HAUSKA_SUBSTRATE_MODE=mcp</code> plus <code>HAUSKA_MCP_URL</code>{" "}
          and <code>HAUSKA_MCP_KEY</code> on api-server, then restart. See{" "}
          <code>docs/deploy.md</code> — Local dev: live substrate catalog.
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <Globe size={16} />
        <h2 className="sc-label">Hauska Substrate Catalog</h2>
        {data && (
          <span
            className="sc-meta opacity-60"
            data-testid="substrate-source"
            title={
              data.source === "mcp"
                ? "Live from the Hauska MCP server"
                : "Fixture data — set HAUSKA_SUBSTRATE_MODE=mcp for the live catalog"
            }
          >
            {data.source === "mcp" ? "live" : "fixture"}
          </span>
        )}
        {onShowAllChange && (
          <label
            className="sc-meta flex items-center gap-2 cursor-pointer ml-auto"
            data-testid="substrate-show-all-toggle"
          >
            <input
              type="checkbox"
              checked={showAllJurisdictions}
              onChange={(e) => onShowAllChange(e.target.checked)}
            />
            Show all jurisdictions
          </label>
        )}
      </div>
      <p className="sc-body opacity-70">
        Every jurisdiction ingested into the Hauska substrate, read live
        through the MCP <code>list_jurisdictions</code> surface. An
        authenticated Cortex key also surfaces partnership-pending
        (platform-internal) jurisdictions.
      </p>

      {isLoading && (
        <div className="sc-body opacity-60" data-testid="substrate-loading">
          Loading substrate catalog…
        </div>
      )}

      {error && (
        <div
          className="alert-block warning rounded-md"
          data-testid="substrate-error"
          style={{ fontSize: 12, padding: "8px 10px" }}
        >
          Substrate catalog unavailable: {error}
        </div>
      )}

      {data && (
        <>
          <div className="sc-meta opacity-70" data-testid="substrate-count">
            {showAllJurisdictions || fetchStates.length === 0 ? (
              <>
                {data.jurisdictions.length} jurisdiction
                {data.jurisdictions.length === 1 ? "" : "s"} nationwide
                {data.total != null && data.total !== data.jurisdictions.length
                  ? ` (${data.total} in catalog)`
                  : ""}
              </>
            ) : (
              <>
                Showing {data.filtered ?? data.jurisdictions.length} jurisdiction
                {(data.filtered ?? data.jurisdictions.length) === 1 ? "" : "s"}{" "}
                in your states
                {data.total != null && (
                  <>
                    {" "}
                    · {data.total} nationwide
                  </>
                )}
              </>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {data.jurisdictions.map((j) => {
              const badge = ACCESS_POLICY_BADGE[j.accessPolicy];
              return (
                <div
                  key={j.key}
                  data-testid={`substrate-jurisdiction-${j.key}`}
                  className="sc-card p-3 flex flex-col gap-2"
                  style={{
                    border: "1px solid var(--border-default)",
                    borderRadius: 6,
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="sc-medium">{j.displayName}</span>
                    <span
                      data-testid={`substrate-access-${j.key}`}
                      style={{
                        background: badge.bg,
                        color: badge.fg,
                        fontSize: 9,
                        padding: "2px 6px",
                        borderRadius: 3,
                        letterSpacing: "0.04em",
                        textTransform: "uppercase",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {badge.label}
                    </span>
                  </div>
                  <div className="sc-meta opacity-60">{j.key}</div>
                  <div className="flex items-baseline gap-3">
                    <div>
                      <div
                        className="text-xl"
                        data-testid={`substrate-atomcount-${j.key}`}
                      >
                        {j.atomCount}
                      </div>
                      <div className="sc-meta opacity-60">atoms</div>
                    </div>
                    <div className="ml-auto sc-meta opacity-60 text-right">
                      {j.qualityBar} · {j.driftStatus}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export default SubstrateCatalogPanel;
