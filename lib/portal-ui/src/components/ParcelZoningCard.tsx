/**
 * ParcelZoningCard — Site tab parcel & zoning summary.
 *
 * Three states discriminated by the `data-state` attribute:
 *   - `populated`     — geocode present + briefing has parcel/zoning data
 *   - `unsupported`   — geocode present but adapter coverage missing
 *   - `no-geocode`    — engagement has no geocode yet
 */
import type {
  EngagementBriefing,
  EngagementBriefingSource,
} from "@workspace/api-client-react";
import {
  isRecord,
  pickFirstString,
  pickFirstNumber,
  PARCEL_ID_KEYS,
  PARCEL_ACRES_KEYS,
  ZONING_CODE_KEYS,
  ZONING_DESC_KEYS,
  FLOOD_ZONE_KEYS,
} from "@workspace/adapters";

export interface ParcelZoningCardProps {
  hasGeocode: boolean;
  /** Reviewer-typed zoning code; wins over the briefing-derived code. */
  zoningCodeFromSite: string | null;
  /** Reviewer-typed lot area; falls back to acres × 43,560 from the parcel payload. */
  lotAreaSqftFromSite: number | null;
  briefing: EngagementBriefing | null;
  siteContextHref: string;
}

const SQFT_PER_ACRE = 43_560;

interface ParcelInfo {
  parcelId: string | null;
  lotAreaSqft: number | null;
  source: EngagementBriefingSource | null;
}

interface ZoningInfo {
  code: string | null;
  description: string | null;
  source: EngagementBriefingSource | null;
}

interface OverlayChip {
  key: string;
  label: string;
}

// Local-tier readings (county GIS) win over state-tier fallbacks for
// the same parcel/zoning field.
function extractParcelInfo(briefing: EngagementBriefing | null): ParcelInfo {
  const empty: ParcelInfo = {
    parcelId: null,
    lotAreaSqft: null,
    source: null,
  };
  if (!briefing) return empty;

  const tierOrder: Array<EngagementBriefingSource["sourceKind"]> = [
    "local-adapter",
    "state-adapter",
  ];
  for (const tier of tierOrder) {
    for (const source of briefing.sources) {
      if (source.supersededAt) continue;
      if (source.sourceKind !== tier) continue;
      const payload = source.payload as unknown;
      if (!isRecord(payload)) continue;
      if (payload["kind"] !== "parcel") continue;
      const parcel = payload["parcel"];
      if (!isRecord(parcel)) continue;
      const attrs = isRecord(parcel["attributes"])
        ? parcel["attributes"]
        : {};
      const parcelId = pickFirstString(attrs, PARCEL_ID_KEYS);
      const acres = pickFirstNumber(attrs, PARCEL_ACRES_KEYS);
      return {
        parcelId,
        lotAreaSqft:
          acres !== null ? Math.round(acres * SQFT_PER_ACRE) : null,
        source,
      };
    }
  }
  return empty;
}

function extractZoningInfo(briefing: EngagementBriefing | null): ZoningInfo {
  const empty: ZoningInfo = { code: null, description: null, source: null };
  if (!briefing) return empty;
  for (const source of briefing.sources) {
    if (source.supersededAt) continue;
    if (source.sourceKind !== "local-adapter") continue;
    const payload = source.payload as unknown;
    if (!isRecord(payload)) continue;
    if (payload["kind"] !== "zoning") continue;
    const zoning = payload["zoning"];
    if (!isRecord(zoning)) continue;
    const attrs = isRecord(zoning["attributes"]) ? zoning["attributes"] : {};
    const code = pickFirstString(attrs, ZONING_CODE_KEYS);
    const description = pickFirstString(attrs, ZONING_DESC_KEYS);
    if (code || description) {
      return { code, description, source };
    }
  }
  return empty;
}

/**
 * Walk the briefing for overlay chips — floodplain (Bastrop), FEMA
 * NFHL flood zone (everywhere), Edwards Aquifer (TCEQ). Returns at
 * most one chip per overlay kind; the FEMA federal layer is skipped
 * when a Bastrop floodplain reading is also present (the local-tier
 * reading is more specific so the federal chip would just duplicate).
 */
function extractOverlayChips(
  briefing: EngagementBriefing | null,
): OverlayChip[] {
  if (!briefing) return [];
  const chips: OverlayChip[] = [];
  let sawLocalFloodplain = false;

  for (const source of briefing.sources) {
    if (source.supersededAt) continue;
    const payload = source.payload as unknown;
    if (!isRecord(payload)) continue;
    const kind = payload["kind"];

    if (kind === "floodplain") {
      sawLocalFloodplain = true;
      const inFlood = payload["inMappedFloodplain"] === true;
      if (inFlood) {
        const features = payload["features"];
        let zone: string | null = null;
        if (Array.isArray(features) && features.length > 0) {
          const first = features[0];
          if (isRecord(first)) {
            const attrs = isRecord(first["attributes"])
              ? first["attributes"]
              : {};
            zone = pickFirstString(attrs, FLOOD_ZONE_KEYS);
          }
        }
        chips.push({
          key: "floodplain-in",
          label: zone
            ? `In mapped floodplain (Zone ${zone})`
            : "In mapped floodplain",
        });
      } else {
        chips.push({
          key: "floodplain-out",
          label: "Outside mapped floodplain",
        });
      }
    } else if (kind === "edwards-aquifer") {
      const inRecharge = payload["inRecharge"] === true;
      const inContributing = payload["inContributing"] === true;
      if (inRecharge && inContributing) {
        chips.push({
          key: "edwards-both",
          label: "Edwards Aquifer recharge & contributing",
        });
      } else if (inRecharge) {
        chips.push({
          key: "edwards-recharge",
          label: "Edwards Aquifer recharge zone",
        });
      } else if (inContributing) {
        chips.push({
          key: "edwards-contrib",
          label: "Edwards Aquifer contributing zone",
        });
      }
    }
  }

  // Federal FEMA layer — only fall back to it when no local floodplain
  // chip was emitted (Bastrop's local reading is more specific).
  if (!sawLocalFloodplain) {
    for (const source of briefing.sources) {
      if (source.supersededAt) continue;
      if (source.layerKind !== "fema-nfhl-flood-zone") continue;
      const payload = source.payload as unknown;
      if (!isRecord(payload)) continue;
      if (payload["kind"] !== "flood-zone") continue;
      const zone =
        typeof payload["floodZone"] === "string"
          ? (payload["floodZone"] as string)
          : null;
      const inSfha = payload["inSpecialFloodHazardArea"] === true;
      if (zone && inSfha) {
        chips.push({
          key: "fema-sfha",
          label: `FEMA Zone ${zone} (high-risk)`,
        });
      } else if (zone) {
        chips.push({ key: "fema-zone", label: `FEMA Zone ${zone}` });
      } else {
        chips.push({
          key: "fema-none",
          label: "No mapped FEMA flood risk",
        });
      }
      break;
    }
  }

  return chips;
}

// Most recent snapshot date among the parcel + zoning sources;
// `null` when neither has a parsable date.
function pickProvenance(
  parcel: ParcelInfo,
  zoning: ZoningInfo,
): { provider: string | null; snapshotDate: string | null } | null {
  const candidates = [parcel.source, zoning.source].filter(
    (s): s is EngagementBriefingSource => s !== null,
  );
  if (candidates.length === 0) return null;
  let best: EngagementBriefingSource | null = null;
  let bestMs = -Infinity;
  for (const c of candidates) {
    if (!c.snapshotDate) continue;
    // `snapshotDate` is typed as `Date` but may round-trip as an ISO
    // string from the wire; `new Date(x)` accepts both.
    const raw: unknown = c.snapshotDate;
    const t = new Date(raw as string | number | Date).getTime();
    if (Number.isFinite(t) && t > bestMs) {
      bestMs = t;
      best = c;
    }
  }
  if (!best) {
    return {
      provider: candidates[0].provider ?? null,
      snapshotDate: null,
    };
  }
  const raw: unknown = best.snapshotDate;
  const iso = new Date(raw as string | number | Date).toISOString();
  return { provider: best.provider ?? null, snapshotDate: iso };
}

function relativeTime(input: string | Date | null | undefined): string {
  if (!input) return "—";
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return "—";
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

const ROW_LABEL_STYLE: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 600,
};

const ROW_VALUE_STYLE: React.CSSProperties = {
  fontSize: 13,
  color: "var(--text-primary)",
};

function KvRow({
  label,
  value,
  testid,
}: {
  label: string;
  value: React.ReactNode;
  testid: string;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "120px 1fr",
        alignItems: "baseline",
        gap: 12,
        padding: "6px 0",
      }}
    >
      <div style={ROW_LABEL_STYLE}>{label}</div>
      <div style={ROW_VALUE_STYLE} data-testid={testid}>
        {value}
      </div>
    </div>
  );
}

export function ParcelZoningCard({
  hasGeocode,
  zoningCodeFromSite,
  lotAreaSqftFromSite,
  briefing,
  siteContextHref,
}: ParcelZoningCardProps) {
  // ── No-geocode branch ────────────────────────────────────────────
  if (!hasGeocode) {
    return (
      <div
        className="sc-card flex flex-col"
        data-testid="parcel-zoning-card"
        data-state="no-geocode"
      >
        <div className="sc-card-header">
          <span className="sc-label">PARCEL &amp; ZONING</span>
        </div>
        <div className="p-4">
          <div
            className="sc-prose"
            style={{ fontSize: 12.5, opacity: 0.8 }}
            data-testid="parcel-zoning-card-no-geocode-message"
          >
            Add an address to see parcel and zoning details.
          </div>
        </div>
      </div>
    );
  }

  const parcel = extractParcelInfo(briefing);
  const zoning = extractZoningInfo(briefing);
  const overlays = extractOverlayChips(briefing);

  // Reviewer-edited site fields win over briefing-derived values.
  const zoningCode =
    zoningCodeFromSite && zoningCodeFromSite.trim().length > 0
      ? zoningCodeFromSite.trim()
      : zoning.code;
  const zoningDescription = zoning.description;
  const lotAreaSqft =
    lotAreaSqftFromSite !== null ? lotAreaSqftFromSite : parcel.lotAreaSqft;

  // Card needs at least one parcel- or zoning-identifying field to
  // count as populated. Overlay chips alone (e.g. Boston with only a
  // FEMA reading) fall back to the unsupported branch.
  const hasAnyData =
    parcel.parcelId !== null ||
    zoningCode !== null ||
    zoningDescription !== null;

  // ── Unsupported-jurisdiction branch ──────────────────────────────
  if (!hasAnyData) {
    return (
      <div
        className="sc-card flex flex-col"
        data-testid="parcel-zoning-card"
        data-state="unsupported"
      >
        <div className="sc-card-header">
          <span className="sc-label">PARCEL &amp; ZONING</span>
        </div>
        <div className="p-4">
          <div
            className="sc-prose"
            style={{
              fontSize: 12.5,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
            data-testid="parcel-zoning-card-unsupported-message"
          >
            <div>
              We don&apos;t have parcel and zoning data for this jurisdiction
              yet.
            </div>
            <div style={{ opacity: 0.8 }}>
              Federal layers (FEMA flood zone, USGS elevation) and any
              manually-uploaded sources still appear on the{" "}
              <a
                href={siteContextHref}
                data-testid="parcel-zoning-card-site-context-link"
                style={{ color: "var(--cyan)", textDecoration: "underline" }}
              >
                Site Context
              </a>{" "}
              tab.
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Populated branch ─────────────────────────────────────────────
  const provenance = pickProvenance(parcel, zoning);
  const zoningValue =
    zoningCode && zoningDescription
      ? `${zoningCode} · ${zoningDescription}`
      : (zoningCode ?? zoningDescription ?? "—");

  return (
    <div
      className="sc-card flex flex-col"
      data-testid="parcel-zoning-card"
      data-state="populated"
    >
      <div className="sc-card-header">
        <span className="sc-label">PARCEL &amp; ZONING</span>
      </div>
      <div className="p-4" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <KvRow
            label="Parcel ID"
            value={parcel.parcelId ?? "—"}
            testid="parcel-zoning-card-parcel-id"
          />
          <KvRow
            label="Zoning"
            value={zoningValue}
            testid="parcel-zoning-card-zoning"
          />
          <KvRow
            label="Lot area"
            value={
              lotAreaSqft !== null
                ? `${lotAreaSqft.toLocaleString()} sq ft`
                : "—"
            }
            testid="parcel-zoning-card-lot-area"
          />
        </div>

        {overlays.length > 0 && (
          <div>
            <div style={{ ...ROW_LABEL_STYLE, marginBottom: 6 }}>Overlays</div>
            <div
              style={{ display: "flex", flexWrap: "wrap", gap: 6 }}
              data-testid="parcel-zoning-card-overlays"
            >
              {overlays.map((chip) => (
                <span
                  key={chip.key}
                  data-testid={`parcel-zoning-card-overlay-${chip.key}`}
                  style={{
                    display: "inline-block",
                    padding: "3px 8px",
                    borderRadius: 999,
                    background: "var(--bg-input)",
                    border: "1px solid var(--border-default)",
                    fontSize: 11.5,
                    color: "var(--text-primary)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {chip.label}
                </span>
              ))}
            </div>
          </div>
        )}

        {provenance && (
          <div
            style={{
              borderTop: "1px solid var(--border-default)",
              paddingTop: 8,
              fontSize: 11,
              color: "var(--text-muted)",
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              alignItems: "baseline",
            }}
            data-testid="parcel-zoning-card-provenance"
          >
            <span>Source:</span>
            <span style={{ color: "var(--text-primary)" }}>
              {provenance.provider ?? "Adapter"}
            </span>
            {provenance.snapshotDate && (
              <>
                <span>·</span>
                <span>fetched {relativeTime(provenance.snapshotDate)}</span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
