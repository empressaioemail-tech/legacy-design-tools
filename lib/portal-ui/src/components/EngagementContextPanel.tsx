import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import {
  useGetEngagement,
  useGetEngagementBriefing,
  useListEngagementBriefingGenerationRuns,
  getGetEngagementQueryKey,
  getGetEngagementBriefingQueryKey,
  getListEngagementBriefingGenerationRunsQueryKey,
  type EngagementBriefing,
  type EngagementBriefingSource,
  type EngagementBriefingNarrative,
  type EngagementDetail,
} from "@workspace/api-client-react";
import { BriefingSourceRow } from "./BriefingSourceRow";
import { renderBriefingBody, scrollToBriefingSource } from "./briefingCitations";
import { BriefingRecentRunsPanel } from "./BriefingRecentRunsPanel";
import { SiteContextViewer } from "./SiteContextViewer";

// Lazy-loaded so Leaflet + its CSS only ship when the map renders.
const SiteMap = lazy(() =>
  import("@workspace/site-context/client").then((m) => ({ default: m.SiteMap })),
);

// Pure helper; imported from the `/client/overlays` sub-path so it
// does not drag SiteMap (Leaflet + CSS) into consumer module graphs.
import {
  extractBriefingSourceOverlays,
  type SiteMapOverlay,
} from "@workspace/site-context/client/overlays";

/**
 * Read-only briefing context surface — Task #305 (Wave 2 Sprint A).
 *
 * Composes the "what does the architect see when they open this
 * engagement's briefing" view for surfaces that should NOT mutate
 * the briefing (i.e. plan-review's reviewer modal). The architect-
 * side equivalent lives inline in
 * `artifacts/design-tools/src/pages/EngagementDetail.tsx` and adds
 * upload, regenerate, and re-run-stale-adapter affordances on top of
 * the same wire data; this component intentionally omits all of
 * those — reviewers are auditors, not editors.
 *
 * Sections rendered (top to bottom):
 *   1. Empty / loading / error envelope.
 *   2. Parcel briefing card — header summarising engagement id,
 *      briefing id, created/updated timestamps, and the current
 *      narrative's generation metadata so the auditor sees the
 *      "what am I looking at" frame before drilling into details.
 *   3. Briefing-source list, **tier-grouped** (Federal / State /
 *      Local / Manual) to mirror design-tools' tier-grouped layout.
 *      Each row reuses the shared {@link BriefingSourceDetails}
 *      expander so the structured payload (parcel id, zoning
 *      district, FEMA flood-zone, etc.) is one click away. The
 *      "Re-run stale adapter" callback is intentionally NOT wired
 *      — staleness still surfaces as a badge so the auditor can
 *      see it, but they cannot trigger a refresh from the reviewer
 *      surface.
 *   4. A–G narrative panel (`renderBriefingBody` stitches in the
 *      `{{atom|briefing-source|...}}` and `[[CODE:...]]` citation
 *      pills). Clicking a source pill scrolls to the matching row
 *      in the source list via the imperative
 *      {@link scrollToBriefingSource} helper that targets the
 *      `data-testid="briefing-source-<id>"` attribute every row in
 *      this component stamps.
 *   5. Prior-narrative comparison disclosure — when the runs envelope
 *      carries a `priorNarrative`, the auditor can read the body
 *      the briefing held *before* its current narrative was written
 *      inline so they can compare side-by-side without remembering
 *      or screenshotting the previous wording.
 *   6. Recent generation runs (read-only collapsed disclosure).
 *      When the briefing has a current `generationId`, the matching
 *      row is highlighted with a "Current" pill.
 *   7. Site-context viewer — the 2D OpenStreetMap overlay (Task
 *      #317) showing the engagement's geocoded parcel pin alongside
 *      the existing Three.js viewer for `ready` glb sources, so
 *      auditors can frame the geometry against the surrounding
 *      neighborhood instead of staring at meshes in a vacuum. The
 *      map is gated by the `VITE_REVIEWER_SITE_MAP_ENABLED` env var
 *      (defaults to "on"; set to `"false"` to drop the Leaflet
 *      bundle), and only renders when the engagement actually has a
 *      `site.geocode` — there's nothing useful to show otherwise.
 */

export interface EngagementContextPanelProps {
  /**
   * Task #316 — id of the engagement whose briefing the panel
   * renders. Threaded down to {@link BriefingSourceRow} so its
   * "View history" disclosure can fetch the per-layer history list
   * scoped to the right engagement.
   */
  engagementId: string;
  /**
   * Wave 2 Sprint D / V1-2 — caller's session audience. Forwarded
   * to {@link BriefingSourceRow} so its reviewer-side
   * `RequestRefreshAffordance` renders only when the caller is a
   * reviewer (`"internal"`). Defaults to `"user"` so existing
   * callers that don't pass anything keep their current behavior
   * (affordance hidden) without change.
   */
  audience?: "internal" | "user" | "ai";
  /**
   * Optional — id of the briefing generation that produced the BIM
   * model attached to the submission the reviewer is investigating.
   * Forwarded to {@link BriefingRecentRunsPanel} so the matching
   * historical run is tagged with a "Submitted" pill alongside the
   * "Current" pill on the run that produced the on-screen narrative.
   * Surfaces that don't have this id yet (it does not live on
   * `EngagementSubmissionSummary` today) should leave it unset.
   */
  producingGenerationId?: string | null;
  /**
   * Optional render-prop forwarded to {@link BriefingRecentRunsPanel}
   * for the Task #355 prior-narrative header. Forwarded as a
   * render-prop because the shared component lives in
   * `@workspace/briefing-prior-snapshot`, which already depends on
   * `@workspace/portal-ui` — importing it directly here would close
   * a workspace dependency cycle. Plan Review's SubmissionDetailModal
   * passes `BriefingPriorSnapshotHeader` from the lib it already
   * depends on.
   */
  renderPriorSnapshotHeader?: (args: {
    runGenerationId: string;
    priorNarrative: EngagementBriefingNarrative;
  }) => ReactNode;
  /**
   * Optional render-prop forwarded to {@link BriefingRecentRunsPanel}
   * for the Task #374 per-section word-level prior-narrative diff
   * (the seven A–G rows below the snapshot header). Forwarded as a
   * render-prop for the same workspace-cycle reason as
   * `renderPriorSnapshotHeader` above. Plan Review's
   * SubmissionDetailModal passes `BriefingPriorNarrativeDiff` here so
   * the modal's Engagement Context tab keeps rendering the diff rows
   * after the lift; surfaces that don't pass it (e.g. unit tests
   * that don't exercise the prior-narrative branch) get the header
   * alone, which matches the pre-Task-#374 fallback.
   */
  renderPriorNarrativeDiff?: (args: {
    runGenerationId: string;
    priorNarrative: EngagementBriefingNarrative;
    currentNarrative: EngagementBriefingNarrative | null;
  }) => ReactNode;
}

const SECTION_LABELS: Record<
  Exclude<keyof EngagementBriefingNarrative, "generatedAt" | "generatedBy" | "generationId">,
  string
> = {
  sectionA: "A — Executive Summary",
  sectionB: "B — Threshold Issues",
  sectionC: "C — Regulatory Gates",
  sectionD: "D — Site Infrastructure",
  sectionE: "E — Buildable Envelope",
  sectionF: "F — Neighboring Context",
  sectionG: "G — Next-Step Checklist",
};

type SourceTier = "federal" | "state" | "local" | "manual";

const TIER_ORDER: SourceTier[] = ["federal", "state", "local", "manual"];

const TIER_LABELS: Record<SourceTier, string> = {
  federal: "Federal layers",
  state: "State layers",
  local: "Local layers",
  manual: "Manually uploaded",
};

/**
 * Mirrors `tierForSource` in
 * `artifacts/design-tools/src/pages/EngagementDetail.tsx` so the two
 * surfaces tier-group identically. Unrecognized future enum values
 * fall through to "manual" so the UI degrades gracefully instead of
 * crashing before this map is updated.
 */
function tierForSource(
  kind: EngagementBriefingSource["sourceKind"],
): SourceTier {
  if (kind === "federal-adapter") return "federal";
  if (kind === "state-adapter") return "state";
  if (kind === "local-adapter") return "local";
  return "manual";
}

export function EngagementContextPanel({
  engagementId,
  audience = "user",
  producingGenerationId,
  renderPriorSnapshotHeader,
  renderPriorNarrativeDiff,
}: EngagementContextPanelProps) {
  const briefingQuery = useGetEngagementBriefing(engagementId, {
    query: {
      queryKey: getGetEngagementBriefingQueryKey(engagementId),
      enabled: !!engagementId,
    },
  });

  if (briefingQuery.isLoading) {
    return (
      <div
        data-testid="engagement-context-panel-loading"
        className="sc-body"
        style={{ padding: 16, color: "var(--text-muted)" }}
      >
        Loading engagement briefing…
      </div>
    );
  }

  if (briefingQuery.isError) {
    return (
      <div
        role="alert"
        data-testid="engagement-context-panel-error"
        className="sc-body"
        style={{ padding: 16, color: "var(--danger-text)" }}
      >
        Couldn&apos;t load the engagement briefing. Try again later.
      </div>
    );
  }

  const briefing = briefingQuery.data?.briefing ?? null;

  if (!briefing) {
    return (
      <div
        data-testid="engagement-context-panel-empty"
        className="sc-body"
        style={{
          padding: 16,
          color: "var(--text-muted)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
          No engagement briefing yet.
        </div>
        <div>
          The architect hasn&apos;t generated a parcel briefing for this
          engagement. Once a briefing exists, its adapter sources, the
          A–G narrative, and the 3D site-context viewer will appear
          here.
        </div>
        <BriefingRecentRunsPanel
          engagementId={engagementId}
          producingGenerationId={producingGenerationId ?? undefined}
          renderPriorSnapshotHeader={renderPriorSnapshotHeader}
          renderPriorNarrativeDiff={renderPriorNarrativeDiff}
        />
      </div>
    );
  }

  const currentGenerationId = briefing.narrative?.generationId ?? null;

  return (
    <div
      data-testid="engagement-context-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <ParcelBriefingCard briefing={briefing} />
      <BriefingSourcesSection
        engagementId={engagementId}
        audience={audience}
        sources={briefing.sources}
      />
      <NarrativeSection
        narrative={briefing.narrative}
        sourceIds={briefing.sources.map((s) => s.id)}
      />
      <PriorNarrativeSection engagementId={engagementId} />
      <BriefingRecentRunsPanel
        engagementId={engagementId}
        currentGenerationId={currentGenerationId}
        producingGenerationId={producingGenerationId ?? undefined}
        renderPriorSnapshotHeader={renderPriorSnapshotHeader}
        renderPriorNarrativeDiff={renderPriorNarrativeDiff}
      />
      <SiteContextSection
        engagementId={engagementId}
        sources={briefing.sources}
      />
    </div>
  );
}

/**
 * Header card summarising the parcel briefing row itself — the
 * "what am I looking at" frame the auditor sees before scanning
 * sources or narrative. Renders briefing id, engagement id,
 * created/updated timestamps, and the current narrative's
 * generation metadata when present.
 */
function ParcelBriefingCard({ briefing }: { briefing: EngagementBriefing }) {
  const narrative = briefing.narrative;
  return (
    <section
      data-testid="engagement-context-parcel-briefing-card"
      style={{
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        padding: 12,
        background: "var(--surface-1, transparent)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <header
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--text-muted)",
        }}
      >
        Parcel briefing
      </header>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "max-content 1fr",
          rowGap: 4,
          columnGap: 12,
          fontSize: 12,
        }}
      >
        <span style={{ color: "var(--text-muted)" }}>Briefing id</span>
        <code
          data-testid="parcel-briefing-id"
          style={{ color: "var(--text-primary)", fontSize: 11 }}
        >
          {briefing.id}
        </code>
        <span style={{ color: "var(--text-muted)" }}>Created</span>
        <span style={{ color: "var(--text-primary)" }}>
          {new Date(briefing.createdAt).toLocaleString()}
        </span>
        <span style={{ color: "var(--text-muted)" }}>Updated</span>
        <span style={{ color: "var(--text-primary)" }}>
          {new Date(briefing.updatedAt).toLocaleString()}
        </span>
        <span style={{ color: "var(--text-muted)" }}>Sources</span>
        <span style={{ color: "var(--text-primary)" }}>
          {briefing.sources.length}
        </span>
        {narrative ? (
          <>
            <span style={{ color: "var(--text-muted)" }}>Narrative</span>
            <span
              data-testid="parcel-briefing-narrative-status"
              style={{ color: "var(--success-text, #16a34a)" }}
            >
              Generated
              {narrative.generatedAt
                ? ` ${new Date(narrative.generatedAt).toLocaleString()}`
                : ""}
              {narrative.generatedBy ? ` by ${narrative.generatedBy}` : ""}
            </span>
          </>
        ) : (
          <>
            <span style={{ color: "var(--text-muted)" }}>Narrative</span>
            <span
              data-testid="parcel-briefing-narrative-status"
              style={{ color: "var(--text-muted)" }}
            >
              Not yet generated
            </span>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Read-only "Briefing sources" list, tier-grouped to mirror the
 * Federal / State / Local / Manual layout the architect sees on
 * design-tools. Stamps the `data-testid="briefing-source-<id>"`
 * attribute every row needs so the narrative panel's citation pills
 * can scroll to it via the shared {@link scrollToBriefingSource}
 * helper.
 *
 * Reuses the shared {@link BriefingSourceDetails} expander for the
 * structured layer payload. The "Re-run stale adapter" callback is
 * intentionally NOT wired — reviewers don't trigger adapter reruns
 * from this surface; the stale badge still surfaces so the auditor
 * can spot freshness regressions.
 */
function BriefingSourcesSection({
  engagementId,
  audience,
  sources,
}: {
  engagementId: string;
  audience: "internal" | "user" | "ai";
  sources: EngagementBriefingSource[];
}) {
  const grouped = useMemo(() => {
    const out: Record<SourceTier, EngagementBriefingSource[]> = {
      federal: [],
      state: [],
      local: [],
      manual: [],
    };
    for (const s of sources) out[tierForSource(s.sourceKind)].push(s);
    return out;
  }, [sources]);

  const totalCount = sources.length;
  const populatedTiers = TIER_ORDER.filter((t) => grouped[t].length > 0);

  return (
    <section
      data-testid="engagement-context-sources"
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <header
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--text-muted)",
        }}
      >
        Briefing sources ({totalCount})
      </header>
      {totalCount === 0 ? (
        <div
          data-testid="engagement-context-sources-empty"
          style={{
            padding: 12,
            color: "var(--text-muted)",
            fontSize: 13,
            border: "1px dashed var(--border-subtle)",
            borderRadius: 6,
          }}
        >
          No briefing sources have been gathered for this engagement yet.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {populatedTiers.map((tier) => (
            <TierGroup
              key={tier}
              engagementId={engagementId}
              audience={audience}
              tier={tier}
              sources={grouped[tier]}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function TierGroup({
  engagementId,
  audience,
  tier,
  sources,
}: {
  engagementId: string;
  audience: "internal" | "user" | "ai";
  tier: SourceTier;
  sources: EngagementBriefingSource[];
}) {
  return (
    <div
      data-testid={`engagement-context-tier-${tier}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: "var(--text-secondary)",
          letterSpacing: 0.2,
        }}
      >
        {TIER_LABELS[tier]} ({sources.length})
      </div>
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {sources.map((source) => (
          <li key={source.id} style={{ listStyle: "none" }}>
            {/*
              Task #316 — render the same {@link BriefingSourceRow}
              the architect sees on design-tools, with `readOnly`
              suppressing the "Retry conversion" / "Refresh this
              layer" / "Restore this version" mutate affordances.
              Reviewers get the same per-source generation history,
              divergence pills, and prior-run comparison disclosure
              the architect uses without being able to mutate the
              briefing.
            */}
            <BriefingSourceRow
              engagementId={engagementId}
              source={source}
              audience={audience}
              readOnly
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function NarrativeSection({
  narrative,
  sourceIds,
}: {
  narrative: EngagementBriefingNarrative | null;
  sourceIds: string[];
}) {
  const knownIds = useMemo(() => new Set(sourceIds), [sourceIds]);

  return (
    <section
      data-testid="engagement-context-narrative"
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <header
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--text-muted)",
        }}
      >
        Briefing narrative (A–G)
      </header>
      {!narrative ? (
        <div
          data-testid="engagement-context-narrative-empty"
          style={{
            padding: 12,
            color: "var(--text-muted)",
            fontSize: 13,
            border: "1px dashed var(--border-subtle)",
            borderRadius: 6,
          }}
        >
          The architect hasn&apos;t generated the A–G narrative for this
          engagement yet.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {(Object.keys(SECTION_LABELS) as Array<keyof typeof SECTION_LABELS>).map(
            (key) => {
              const body = narrative[key];
              if (!body) return null;
              return (
                <article
                  key={key}
                  data-testid={`engagement-context-narrative-${key}`}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  <h4
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: "var(--text-primary)",
                      margin: 0,
                    }}
                  >
                    {SECTION_LABELS[key]}
                  </h4>
                  <div
                    className="sc-prose"
                    style={{
                      fontSize: 13,
                      color: "var(--text-secondary)",
                      whiteSpace: "pre-wrap",
                      lineHeight: 1.5,
                    }}
                  >
                    {renderBriefingBody(body, knownIds, (id) =>
                      scrollToBriefingSource(id),
                    )}
                  </div>
                </article>
              );
            },
          )}
          {narrative.generatedAt && (
            <div
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
              }}
            >
              Generated{" "}
              {new Date(narrative.generatedAt).toLocaleString()}
              {narrative.generatedBy ? ` · by ${narrative.generatedBy}` : ""}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Prior-narrative comparison — reads the `priorNarrative` snapshot
 * the briefing held *before* its current narrative was written from
 * the runs envelope. Collapsed by default and only fetches when the
 * auditor opens it (lazy parity with {@link BriefingRecentRunsPanel}).
 *
 * When the briefing has never been regenerated (the first generation
 * has no prior) or no briefing row exists, the wire envelope sets
 * `priorNarrative` to null and the disclosure renders the empty
 * state — clarifying *why* there's nothing to compare rather than
 * silently hiding.
 */
function PriorNarrativeSection({ engagementId }: { engagementId: string }) {
  const [open, setOpen] = useState(false);
  const runsQuery = useListEngagementBriefingGenerationRuns(engagementId, {
    query: {
      queryKey: getListEngagementBriefingGenerationRunsQueryKey(engagementId),
      enabled: open,
      refetchOnWindowFocus: false,
    },
  });
  const prior = runsQuery.data?.priorNarrative ?? null;

  return (
    <section
      data-testid="engagement-context-prior-narrative"
      style={{
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        background: "var(--surface-1, transparent)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="engagement-context-prior-narrative-toggle"
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600 }}>
          Prior narrative (compare with current)
        </span>
        <span
          aria-hidden
          style={{ fontSize: 12, color: "var(--text-muted)" }}
        >
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div style={{ padding: "0 12px 12px 12px" }}>
          {runsQuery.isLoading && (
            <div
              data-testid="engagement-context-prior-narrative-loading"
              style={{ fontSize: 12, color: "var(--text-muted)" }}
            >
              Loading prior narrative…
            </div>
          )}
          {runsQuery.isError && !runsQuery.isLoading && (
            <div
              role="alert"
              data-testid="engagement-context-prior-narrative-error"
              style={{ fontSize: 12, color: "var(--danger-text)" }}
            >
              Couldn&apos;t load the prior narrative.
            </div>
          )}
          {!runsQuery.isLoading && !runsQuery.isError && !prior && (
            <div
              data-testid="engagement-context-prior-narrative-empty"
              style={{ fontSize: 12, color: "var(--text-muted)" }}
            >
              No prior narrative on file. The briefing either has never been
              regenerated (the first generation has no prior) or no briefing
              row exists yet.
            </div>
          )}
          {prior && (
            <div
              data-testid="engagement-context-prior-narrative-body"
              style={{ display: "flex", flexDirection: "column", gap: 8 }}
            >
              {prior.generatedAt && (
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text-muted)",
                  }}
                >
                  Prior generation:{" "}
                  {new Date(prior.generatedAt).toLocaleString()}
                  {prior.generatedBy ? ` · by ${prior.generatedBy}` : ""}
                </div>
              )}
              {(Object.keys(SECTION_LABELS) as Array<keyof typeof SECTION_LABELS>).map(
                (key) => {
                  const body = prior[key];
                  if (!body) return null;
                  return (
                    <article
                      key={key}
                      data-testid={`engagement-context-prior-narrative-${key}`}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 2,
                      }}
                    >
                      <h5
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: "var(--text-primary)",
                          margin: 0,
                        }}
                      >
                        {SECTION_LABELS[key]} (prior)
                      </h5>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--text-secondary)",
                          whiteSpace: "pre-wrap",
                          lineHeight: 1.5,
                        }}
                      >
                        {body}
                      </div>
                    </article>
                  );
                },
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// Default-on; set `VITE_REVIEWER_SITE_MAP_ENABLED="false"` to opt out.
function isSiteMapEnabled(): boolean {
  const raw = import.meta.env.VITE_REVIEWER_SITE_MAP_ENABLED;
  if (raw == null || raw === "") return true;
  return raw.toLowerCase() !== "false";
}

// OSM defaults; overridable via env for keyed/self-hosted tile sources.
function getMapTileConfig(): { url: string; attribution: string } {
  const url =
    import.meta.env.VITE_REVIEWER_SITE_MAP_TILE_URL ||
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
  const attribution =
    import.meta.env.VITE_REVIEWER_SITE_MAP_TILE_ATTRIBUTION ||
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  return { url, attribution };
}

function SiteContextSection({
  engagementId,
  sources,
}: {
  engagementId: string;
  sources: EngagementBriefingSource[];
}) {
  const mapEnabled = isSiteMapEnabled();
  const engagementQuery = useGetEngagement(engagementId, {
    query: {
      queryKey: getGetEngagementQueryKey(engagementId),
      enabled: mapEnabled && !!engagementId,
    },
  });
  const engagement: EngagementDetail | undefined = engagementQuery.data;
  const overlays = useMemo(
    () => extractBriefingSourceOverlays(sources),
    [sources],
  );

  return (
    <section
      data-testid="engagement-context-site-viewer"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minHeight: 360,
      }}
    >
      <header
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--text-muted)",
        }}
      >
        Site context
      </header>
      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            mapEnabled ? "minmax(0, 1fr) minmax(0, 1fr)" : "minmax(0, 1fr)",
          gap: 12,
          alignItems: "stretch",
        }}
      >
        {mapEnabled && (
          <SiteContextMapPanel
            engagement={engagement ?? null}
            isLoading={engagementQuery.isLoading}
            isError={engagementQuery.isError}
            overlays={overlays}
          />
        )}
        <div
          data-testid="engagement-context-site-viewer-3d"
          style={{ display: "flex", flexDirection: "column", minHeight: 320 }}
        >
          <SiteContextViewer sources={sources} />
        </div>
      </div>
    </section>
  );
}

function SiteContextMapPanel({
  engagement,
  isLoading,
  isError,
  overlays,
}: {
  engagement: EngagementDetail | null;
  isLoading: boolean;
  isError: boolean;
  overlays: ReadonlyArray<SiteMapOverlay>;
}) {
  const geocode = engagement?.site?.geocode ?? null;
  const address = engagement?.site?.address ?? engagement?.address ?? null;
  const { url, attribution } = getMapTileConfig();

  return (
    <div
      data-testid="engagement-context-site-map"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        minHeight: 320,
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        background: "var(--surface-1, transparent)",
        padding: 8,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: "var(--text-secondary)",
          letterSpacing: 0.2,
        }}
      >
        Geographic context
      </div>
      {geocode ? (
        <Suspense
          fallback={
            <div
              data-testid="engagement-context-site-map-suspense"
              style={{
                flex: 1,
                minHeight: 280,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                color: "var(--text-muted)",
              }}
            >
              Loading map…
            </div>
          }
        >
          <SiteMap
            latitude={geocode.latitude}
            longitude={geocode.longitude}
            addressLabel={address ?? undefined}
            tileUrl={url}
            tileAttribution={attribution}
            height={300}
            overlays={overlays}
          />
        </Suspense>
      ) : (
        <div
          data-testid="engagement-context-site-map-empty"
          style={{
            flex: 1,
            minHeight: 280,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            fontSize: 12,
            color: "var(--text-muted)",
            padding: 12,
          }}
        >
          {isLoading
            ? "Loading parcel location…"
            : isError
              ? "Couldn't load the parcel location for this engagement."
              : "No parcel location on file. Once an architect adds a geocoded address to this engagement, it will appear here on a map."}
        </div>
      )}
      {address && (
        <div
          data-testid="engagement-context-site-map-address"
          style={{ fontSize: 11, color: "var(--text-muted)" }}
        >
          {address}
        </div>
      )}
    </div>
  );
}
