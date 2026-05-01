import {
  useGetEngagement,
  useGetEngagementBriefing,
  getGetEngagementQueryKey,
  getGetEngagementBriefingQueryKey,
  type EngagementDetail,
  type EngagementBriefingNarrative,
  type ProjectType,
} from "@workspace/api-client-react";

/**
 * Plan-review's read-only "Engagement Context" tab on the submission
 * detail modal (Wave 2 Sprint A — Task #319). Surfaces the briefing
 * snapshot + parcel info the reviewer needs while reviewing a
 * submission, without bouncing them out to the engagement page or
 * over to the design-tools artifact.
 *
 * The tab composes two server reads:
 *   - `useGetEngagement(engagementId)` — supplies the parcel
 *     intelligence the reviewer wants to see at a glance:
 *     jurisdiction, address, project type, zoning code, lot area.
 *   - `useGetEngagementBriefing(engagementId)` — supplies the
 *     briefing narrative; we surface Section A (Executive Summary)
 *     verbatim plus the `generatedAt` provenance line so the
 *     reviewer can frame the rest of the modal against the briefing
 *     the architect actually generated.
 *
 * Section A is intentionally the only section rendered: it is the
 * narrative-side TL;DR (no citations, ~150 words by spec) and the
 * one section the reviewer needs to anchor their review against.
 * Sections B–G stay on the design-tools / plan-review engagement
 * page where the full briefing surface lives — this tab is a
 * preview, not a duplicate of the briefing reader.
 *
 * Read-only by design — no edit / regenerate affordances. The
 * architect side owns the briefing lifecycle; reviewers see what
 * was generated.
 */
const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  new_build: "New build",
  renovation: "Renovation",
  addition: "Addition",
  tenant_improvement: "Tenant improvement",
  other: "Other",
};

function formatLotArea(sqft: number | null): string {
  if (sqft == null) return "—";
  return `${sqft.toLocaleString("en-US")} sqft`;
}

function formatProjectType(type: ProjectType | null): string {
  if (type == null) return "—";
  return PROJECT_TYPE_LABELS[type] ?? type;
}

function ParcelInfoCard({ engagement }: { engagement: EngagementDetail }) {
  const site = engagement.site;
  return (
    <div
      data-testid="engagement-context-parcel-card"
      className="sc-card"
      style={{
        padding: 16,
        border: "1px solid var(--border-default)",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div className="sc-medium" style={{ fontSize: 14 }}>
        Parcel info
      </div>
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "max-content 1fr",
          columnGap: 16,
          rowGap: 6,
          margin: 0,
          fontSize: 12,
        }}
      >
        <dt style={{ color: "var(--text-muted)" }}>Jurisdiction</dt>
        <dd
          data-testid="engagement-context-jurisdiction"
          style={{
            margin: 0,
            color: engagement.jurisdiction
              ? "var(--text-default)"
              : "var(--text-muted)",
          }}
        >
          {engagement.jurisdiction ?? "—"}
        </dd>
        <dt style={{ color: "var(--text-muted)" }}>Address</dt>
        <dd
          data-testid="engagement-context-address"
          style={{
            margin: 0,
            color:
              site.address || engagement.address
                ? "var(--text-default)"
                : "var(--text-muted)",
          }}
        >
          {site.address ?? engagement.address ?? "—"}
        </dd>
        <dt style={{ color: "var(--text-muted)" }}>Project type</dt>
        <dd
          data-testid="engagement-context-project-type"
          style={{
            margin: 0,
            color: site.projectType
              ? "var(--text-default)"
              : "var(--text-muted)",
          }}
        >
          {formatProjectType(site.projectType)}
        </dd>
        <dt style={{ color: "var(--text-muted)" }}>Zoning code</dt>
        <dd
          data-testid="engagement-context-zoning-code"
          style={{
            margin: 0,
            color: site.zoningCode
              ? "var(--text-default)"
              : "var(--text-muted)",
          }}
        >
          {site.zoningCode ?? "—"}
        </dd>
        <dt style={{ color: "var(--text-muted)" }}>Lot area</dt>
        <dd
          data-testid="engagement-context-lot-area"
          style={{
            margin: 0,
            color:
              site.lotAreaSqft != null
                ? "var(--text-default)"
                : "var(--text-muted)",
          }}
        >
          {formatLotArea(site.lotAreaSqft)}
        </dd>
      </dl>
    </div>
  );
}

function BriefingSummaryCard({
  narrative,
}: {
  narrative: EngagementBriefingNarrative | null;
}) {
  const generatedAtAbsolute = narrative?.generatedAt
    ? new Date(narrative.generatedAt).toLocaleString()
    : null;
  const sectionA = narrative?.sectionA?.trim() ?? "";
  return (
    <div
      data-testid="engagement-context-briefing-card"
      className="sc-card"
      style={{
        padding: 16,
        border: "1px solid var(--border-default)",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div className="sc-medium" style={{ fontSize: 14 }}>
          Briefing summary
        </div>
        {generatedAtAbsolute && (
          <span
            data-testid="engagement-context-briefing-generated-at"
            title={generatedAtAbsolute}
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            Generated {generatedAtAbsolute}
          </span>
        )}
      </div>
      {sectionA ? (
        <div
          data-testid="engagement-context-briefing-section-a"
          className="sc-prose"
          style={{
            margin: 0,
            fontSize: 13,
            color: "var(--text-default)",
            whiteSpace: "pre-wrap",
            lineHeight: 1.5,
          }}
        >
          {sectionA}
        </div>
      ) : (
        <div
          data-testid="engagement-context-briefing-empty"
          style={{ fontSize: 12, color: "var(--text-muted)" }}
        >
          The briefing engine has not generated an executive summary
          for this engagement yet. Once the architect runs the
          briefing generator, Section A will appear here.
        </div>
      )}
    </div>
  );
}

export interface EngagementContextTabProps {
  engagementId: string;
}

export function EngagementContextTab({
  engagementId,
}: EngagementContextTabProps) {
  const engagementQuery = useGetEngagement(engagementId, {
    query: {
      enabled: !!engagementId,
      queryKey: getGetEngagementQueryKey(engagementId),
    },
  });
  const briefingQuery = useGetEngagementBriefing(engagementId, {
    query: {
      enabled: !!engagementId,
      queryKey: getGetEngagementBriefingQueryKey(engagementId),
    },
  });

  const engagement = engagementQuery.data ?? null;
  const briefing = briefingQuery.data?.briefing ?? null;

  return (
    <div
      data-testid="engagement-context-tab"
      style={{ display: "flex", flexDirection: "column", gap: 16 }}
    >
      {engagementQuery.isLoading && (
        <div
          data-testid="engagement-context-tab-loading"
          className="sc-body opacity-60"
          style={{ fontSize: 13 }}
        >
          Loading engagement context…
        </div>
      )}

      {!engagementQuery.isLoading && engagement == null && (
        <div
          data-testid="engagement-context-tab-error"
          className="sc-card"
          style={{
            padding: 16,
            border: "1px dashed var(--border-default)",
            borderRadius: 6,
            color: "var(--text-secondary)",
            fontSize: 13,
          }}
        >
          Couldn't load the engagement context for this submission.
        </div>
      )}

      {engagement && <ParcelInfoCard engagement={engagement} />}

      {engagement && (
        <BriefingSummaryCard narrative={briefing?.narrative ?? null} />
      )}
    </div>
  );
}
