import {
  useGetEngagementBriefing,
  getGetEngagementBriefingQueryKey,
  type EngagementDetail as EngagementDetailType,
} from "@workspace/api-client-react";
import { SiteMap } from "@workspace/site-context/client";
import { ParcelZoningCard } from "@workspace/portal-ui";
import { relativeTime } from "../../lib/relativeTime";
import { StatusPill } from "./StatusPill";

const PROJECT_TYPE_LABEL: Record<string, string> = {
  new_build: "New build",
  renovation: "Renovation",
  addition: "Addition",
  tenant_improvement: "Tenant improvement",
  other: "Other",
};

function KvGrid({
  rows,
}: {
  rows: Array<{ label: string; value: React.ReactNode }>;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(140px, 1fr) 2fr",
        gap: "6px 12px",
        fontSize: 12,
      }}
    >
      {rows.map((r, i) => (
        <div key={i} style={{ display: "contents" }}>
          <div
            className="sc-data-label"
            style={{ color: "var(--text-secondary)" }}
          >
            {r.label}
          </div>
          <div style={{ color: "var(--text-primary)" }}>{r.value}</div>
        </div>
      ))}
    </div>
  );
}

export function SiteTab({
  engagement,
  onAddAddress,
}: {
  engagement: EngagementDetailType;
  onAddAddress: () => void;
}) {
  const site = engagement.site;
  const geocode = site?.geocode ?? null;

  // Task #424 — pull the parcel briefing so the Parcel & Zoning card
  // can surface real data (parcel id, zoning, overlays, provenance)
  // instead of the long-standing "Coming soon" placeholder. Driven
  // off the same hook used elsewhere on the page so the cache stays
  // shared with the Site Context tab.
  const briefingQuery = useGetEngagementBriefing(engagement.id, {
    query: {
      queryKey: getGetEngagementBriefingQueryKey(engagement.id),
      enabled: !!engagement.id,
    },
  });
  const briefing = briefingQuery.data?.briefing ?? null;

  const locationRows: Array<{ label: string; value: React.ReactNode }> = [
    { label: "Address", value: site?.address ?? "—" },
    {
      label: "Coordinates",
      value: geocode
        ? `${geocode.latitude.toFixed(5)}, ${geocode.longitude.toFixed(5)}`
        : "—",
    },
    {
      label: "Jurisdiction",
      value: geocode
        ? [geocode.jurisdictionCity, geocode.jurisdictionState]
            .filter(Boolean)
            .join(", ") || "—"
        : "—",
    },
    {
      label: "Geocoded",
      value: geocode ? relativeTime(geocode.geocodedAt) : "Not yet",
    },
  ];

  const projectRows: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: "Project type",
      value: site?.projectType
        ? (PROJECT_TYPE_LABEL[site.projectType] ?? site.projectType)
        : "—",
    },
    { label: "Zoning code", value: site?.zoningCode ?? "—" },
    {
      label: "Lot area",
      value:
        site?.lotAreaSqft !== null && site?.lotAreaSqft !== undefined
          ? `${site.lotAreaSqft.toLocaleString()} sq ft`
          : "—",
    },
    {
      label: "Project status",
      value: <StatusPill status={engagement.status} />,
    },
  ];

  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <div className="flex flex-col gap-4">
        <div className="sc-card flex flex-col">
          <div className="sc-card-header">
            <span className="sc-label">LOCATION</span>
          </div>
          <div className="p-3">
            {geocode ? (
              <SiteMap
                latitude={geocode.latitude}
                longitude={geocode.longitude}
                addressLabel={site?.address ?? undefined}
                height={280}
              />
            ) : (
              <div
                className="sc-prose"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 12,
                  height: 200,
                  textAlign: "center",
                  opacity: 0.8,
                }}
              >
                <div>Add an address to plot this project on the map.</div>
                <button className="sc-btn-primary" onClick={onAddAddress}>
                  Add address
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="sc-card p-4">
          <KvGrid rows={locationRows} />
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div className="sc-card flex flex-col">
          <div className="sc-card-header">
            <span className="sc-label">PROJECT</span>
          </div>
          <div className="p-4">
            <KvGrid rows={projectRows} />
          </div>
        </div>

        <ParcelZoningCard
          hasGeocode={!!geocode}
          zoningCodeFromSite={site?.zoningCode ?? null}
          lotAreaSqftFromSite={site?.lotAreaSqft ?? null}
          briefing={briefing}
          siteContextHref={`/engagements/${engagement.id}?tab=site-context`}
        />
      </div>
    </div>
  );
}
