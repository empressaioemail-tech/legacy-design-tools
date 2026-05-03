import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "wouter";
import {
  DashboardLayout,
  ReviewerAnnotationAffordance,
  ReviewerAnnotationPanel,
  ReviewerComment,
  RequestRefreshAffordance,
  SubmissionRecordedBanner,
  SubmitToJurisdictionDialog,
  useReviewerRequestIsPending,
} from "@workspace/portal-ui";
import {
  useGetEngagement,
  useGetSession,
  useListEngagementSubmissions,
  useUpdateEngagement,
  getGetEngagementQueryKey,
  getGetSessionQueryKey,
  getListEngagementSubmissionsQueryKey,
  type EngagementSubmissionSummary,
  type SubmissionReceipt,
  type SubmissionStatus,
  type EngagementDetail as EngagementDetailType,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavGroups } from "../components/NavGroups";
import { BriefingRecentRunsPanel } from "@workspace/portal-ui";
import {
  BriefingPriorNarrativeDiff,
  BriefingPriorSnapshotHeader,
} from "@workspace/briefing-prior-snapshot";
import { SubmissionDetailModal } from "../components/SubmissionDetailModal";
import { CommunicateComposer } from "../components/communicate/CommunicateComposer";
import {
  useListSubmissionCommunications,
  getListSubmissionCommunicationsQueryKey,
} from "@workspace/api-client-react";
import { DecideModal } from "../components/DecideModal";
import { relativeTime } from "../lib/relativeTime";
import {
  readFindingFromUrl,
  readSubmissionFromUrl,
  readSubmissionTabFromUrl,
  writeFindingToUrl,
  writeSubmissionTabToUrl,
  writeSubmissionToUrl,
  type SubmissionDetailTab,
} from "../lib/findingUrl";

/**
 * Human-readable label for each {@link SubmissionStatus}, mirroring
 * `SUBMISSION_STATUS_LABELS` in `artifacts/api-server/src/atoms/
 * submission.atom.ts`. Duplicated here (rather than imported) because
 * the api-server package is a server-side workspace and the FE cannot
 * import from it; both sides are kept in lock-step by the
 * `SubmissionStatus` enum's exhaustive `Record` typing.
 */
const SUBMISSION_STATUS_LABELS: Record<SubmissionStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  corrections_requested: "Corrections requested",
  rejected: "Rejected",
};

/**
 * Per-status badge palette, keyed off the existing SmartCity theme
 * tokens (see `lib/portal-ui/src/styles/smartcity-themes.css`) so the
 * pill picks up the correct dark/light contrast automatically:
 *   - approved → success (green)
 *   - corrections_requested → warning (amber)
 *   - rejected → danger (red)
 *   - pending → info (blue) — neutral "awaiting reply" state, kept
 *     visually distinct from the muted body copy so reviewers can
 *     scan the list and spot pending packages at a glance.
 */
const SUBMISSION_STATUS_COLORS: Record<
  SubmissionStatus,
  { bg: string; fg: string }
> = {
  pending: { bg: "var(--info-dim)", fg: "var(--info-text)" },
  approved: { bg: "var(--success-dim)", fg: "var(--success-text)" },
  corrections_requested: {
    bg: "var(--warning-dim)",
    fg: "var(--warning-text)",
  },
  rejected: { bg: "var(--danger-dim)", fg: "var(--danger-text)" },
};

function SubmissionStatusBadge({ status }: { status: SubmissionStatus }) {
  // Defensive narrowing: a forward-compat status value the FE has not
  // shipped a label for yet falls back to the raw enum string so the
  // UI degrades gracefully instead of rendering an empty pill.
  const label = SUBMISSION_STATUS_LABELS[status] ?? status;
  const palette =
    SUBMISSION_STATUS_COLORS[status] ?? SUBMISSION_STATUS_COLORS.pending;
  return (
    <span
      data-testid={`submission-status-badge-${status}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: 999,
        background: palette.bg,
        color: palette.fg,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.2,
        textTransform: "uppercase",
        lineHeight: 1.4,
      }}
    >
      {label}
    </span>
  );
}

/**
 * EngagementDetail — Plan Review's per-engagement surface (Task #83).
 *
 * Task #75 originally asked for the past-submissions list to live on
 * the plan-review side, but plan-review had no engagement detail page
 * (the existing routes are ReviewConsole, Sheets, FindingsLibrary,
 * SubmittalDetail, etc., all keyed off mock submittal IDs rather than
 * server-side engagement IDs). This page is that missing surface: it
 * deep-links by engagement id (`/engagements/:id`) and reuses the
 * generated `useListEngagementSubmissions` hook against
 * `GET /api/engagements/:id/submissions`, so a Plan Review user can
 * see prior packages submitted to a jurisdiction without bouncing to
 * the design-tools artifact.
 *
 * The submission row layout mirrors the `SubmissionsTab` in
 * `design-tools/src/pages/EngagementDetail.tsx` (jurisdiction label,
 * relative-time with a tooltip of the absolute timestamp, optional
 * pre-wrapped note) so the two surfaces stay visually consistent.
 *
 * Task #88 added a parallel "Submit to jurisdiction" action next to
 * the Past Submissions list so reviewers can record a new package
 * without bouncing to design-tools. The dialog is mirrored from the
 * design-tools copy (artifacts never import each other) and reuses
 * the generated `useCreateEngagementSubmission` hook; on success it
 * invalidates `getListEngagementSubmissionsQueryKey(id)` so the new
 * row appears immediately.
 */
/**
 * Closed enum of target atom types a reviewer-annotation may anchor
 * against — mirrors `REVIEWER_ANNOTATION_TARGET_TYPES` in the schema
 * (kept inline here so the page doesn't pull in a server-only import).
 * The deep-link parser uses this set to validate the `targetType=`
 * query string and silently fall back to `submission` for anything
 * unrecognized so a typo'd link doesn't crash the page.
 */
const REVIEWER_ANNOTATION_TARGET_TYPES = [
  "submission",
  "briefing-source",
  "materializable-element",
  "briefing-divergence",
  "sheet",
  "parcel-briefing",
] as const;
type ReviewerAnnotationTargetType =
  (typeof REVIEWER_ANNOTATION_TARGET_TYPES)[number];

function isValidTargetType(
  v: string | null,
): v is ReviewerAnnotationTargetType {
  return (
    v != null &&
    (REVIEWER_ANNOTATION_TARGET_TYPES as readonly string[]).includes(v)
  );
}

/**
 * Parsed `#annotation=<id>&submission=<id>[&targetType=<t>&target=<id>]`
 * deep-link payload. Used by the Wave 2 Sprint C / Spec 307
 * reviewer-annotation panel so a reviewer pasting a link from chat
 * lands directly on the right submission's panel against the right
 * target tuple, with the highlighted annotation ready to scroll into
 * view.
 *
 * `targetType` + `targetEntityId` are optional — when omitted the
 * panel opens against the submission row itself (the original Wave 2
 * Sprint C deep-link shape), so older links keep working.
 */
interface AnnotationDeepLink {
  submissionId: string;
  annotationId: string;
  targetEntityType: ReviewerAnnotationTargetType;
  targetEntityId: string;
}

/**
 * Parse the location hash for a reviewer-annotation deep-link.
 * Returns `null` when the hash is empty / does not carry both
 * required keys (`annotation` + `submission`).
 *
 * Format:
 *   `#annotation=<annotationId>&submission=<submissionId>` (legacy:
 *     opens against the submission row), or
 *   `#annotation=<id>&submission=<id>&targetType=<type>&target=<id>`
 *     (full tuple: opens against a specific target row inside the
 *     submission's panel).
 *
 * The full-tuple form is the shape the side panel emits when the
 * reviewer copies a link off a non-submission target (Spec 307's
 * "right tab, right target, scroll-to-annotation" round-trip);
 * `targetType` is validated against the closed enum so a typo
 * silently falls through to the legacy submission-target shape
 * rather than crashing the page on hydration.
 */
function parseAnnotationDeepLink(): AnnotationDeepLink | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const annotationId = params.get("annotation");
  const submissionId = params.get("submission");
  if (!annotationId || !submissionId) return null;

  const rawTargetType = params.get("targetType");
  const rawTargetId = params.get("target");
  // Both target keys must be present together; if either is missing
  // (or `targetType` is unrecognized), fall back to the submission
  // tuple so the panel still opens against *something* concrete.
  const hasFullTuple =
    isValidTargetType(rawTargetType) &&
    rawTargetId != null &&
    rawTargetId.length > 0;
  return {
    annotationId,
    submissionId,
    targetEntityType: hasFullTuple ? rawTargetType : "submission",
    targetEntityId: hasFullTuple ? rawTargetId : submissionId,
  };
}

export default function EngagementDetail() {
  const navGroups = useNavGroups();
  const params = useParams();
  const id = params.id as string;
  const [submitOpen, setSubmitOpen] = useState(false);
  // Reviewer-annotation panel state. The panel is shared across every
  // submission row's affordance — clicking an affordance opens the
  // panel keyed to the (submissionId, targetEntityType, targetEntityId)
  // tuple of the row that fired. `null` means the panel is closed.
  const [annotationTarget, setAnnotationTarget] = useState<{
    submissionId: string;
    targetEntityType:
      | "submission"
      | "briefing-source"
      | "materializable-element"
      | "briefing-divergence"
      | "sheet"
      | "parcel-briefing";
    targetEntityId: string;
    highlightAnnotationId: string | null;
  } | null>(null);

  // The session response carries `audience` (internal / user / ai) so
  // the reviewer affordance can hide itself for non-reviewer sessions
  // — same gate the route applies, just enforced FE-side so the UI
  // doesn't render a button that would 403 anyway.
  const { data: session } = useGetSession({
    query: { queryKey: getGetSessionQueryKey() },
  });
  const audience = session?.audience ?? "user";

  // Deep-link handler: on first mount, scan the URL hash for a
  // reviewer-annotation deep-link payload and pop the panel open
  // against the parsed target tuple. The annotation row itself is
  // highlighted via `highlightAnnotationId`. When the deep-link
  // omits the target tuple (legacy `#annotation=<id>&submission=<id>`
  // shape) the parser falls back to the submission target so older
  // links keep landing on a concrete row.
  useEffect(() => {
    if (audience !== "internal") return;
    const link = parseAnnotationDeepLink();
    if (!link) return;
    setAnnotationTarget({
      submissionId: link.submissionId,
      targetEntityType: link.targetEntityType,
      targetEntityId: link.targetEntityId,
      highlightAnnotationId: link.annotationId,
    });
  }, [audience]);

  // Task #348 — `#briefing` deep-link auto-scroll. The Engagement
  // Context tab's "View full briefing" link routes here with the
  // hash so the briefing panel is what the reviewer lands on. The
  // browser's native anchor behavior fires only on the very first
  // navigation that establishes the hash; an in-page wouter Link
  // click that just rewrites the URL doesn't re-trigger it. We
  // run the scroll ourselves on every hash change so the link
  // works whether the reviewer lands here from the modal (same
  // page) or pastes the URL into a fresh tab. `requestAnimationFrame`
  // defers the scroll until after the first paint so the briefing
  // wrapper exists in the DOM by the time we look it up.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const scrollIfHashMatches = () => {
      if (window.location.hash !== "#briefing") return;
      window.requestAnimationFrame(() => {
        const node = document.getElementById("briefing");
        if (node) {
          node.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
    };
    scrollIfHashMatches();
    window.addEventListener("hashchange", scrollIfHashMatches);
    return () => {
      window.removeEventListener("hashchange", scrollIfHashMatches);
    };
  }, []);

  // Top-bar search filters the past-submissions list by jurisdiction,
  // status, note, or reviewer comment (Task #111). The query is held
  // here so the layout's `Header` and the list both see the same
  // value, mirroring the wiring in EngagementsList (Task #95).
  const [searchQuery, setSearchQuery] = useState("");
  // Last successful jurisdiction submission, surfaced as a non-blocking
  // confirmation banner above the past-submissions list (Task #100).
  // We keep the full receipt (not just `submittedAt`) so a future
  // "View on timeline" affordance can deep-link by `submissionId`
  // without another round trip — matching the design-tools convention.
  // The `jurisdiction` snapshot is captured separately because the
  // server `SubmissionReceipt` shape does not carry it; pinning the
  // value at submit-time means a same-session edit to the engagement's
  // jurisdiction won't retroactively rewrite the banner copy.
  const [lastSubmission, setLastSubmission] = useState<{
    receipt: SubmissionReceipt;
    jurisdiction: string | null;
  } | null>(null);

  // ── AIR-2 (Task #310) submission-detail modal state ────────────────
  //
  // The modal is fully URL-controlled: opening / closing flips the
  // `?submission=<id>` param, switching tabs flips `?tab=findings`,
  // and the per-finding drill-in flips `?finding=<atomId>`. The
  // mount-time `useEffect` reads the URL once so a paste-link lands
  // on the right submission + tab + drill-in.
  //
  // The modal is layered over the past-submissions list — the user
  // clicks a row to open it. AIR-2 does not change the underlying
  // SubmissionRow chrome (only adds an open-modal click target).
  const [openSubmissionId, setOpenSubmissionId] = useState<string | null>(null);
  const [submissionTab, setSubmissionTab] = useState<SubmissionDetailTab>(
    "note",
  );
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(
    null,
  );
  useEffect(() => {
    const initial = readSubmissionFromUrl();
    if (initial) {
      setOpenSubmissionId(initial);
      setSubmissionTab(readSubmissionTabFromUrl());
      setSelectedFindingId(readFindingFromUrl());
    }
  }, []);
  const openSubmissionModal = (sid: string) => {
    setOpenSubmissionId(sid);
    setSubmissionTab("note");
    setSelectedFindingId(null);
    writeSubmissionToUrl(sid);
    writeSubmissionTabToUrl("note");
    writeFindingToUrl(null);
  };
  const closeSubmissionModal = () => {
    setOpenSubmissionId(null);
    setSelectedFindingId(null);
    setSubmissionTab("note");
    writeSubmissionToUrl(null);
  };
  const handleTabChange = (next: SubmissionDetailTab) => {
    setSubmissionTab(next);
    writeSubmissionTabToUrl(next);
    if (next === "note") {
      // Closing the Findings tab also clears the drill-in URL param
      // so the canonical Note-tab URL doesn't carry a stale
      // `?finding=` reference around.
      setSelectedFindingId(null);
      writeFindingToUrl(null);
    }
  };
  const handleSelectFinding = (id: string | null) => {
    setSelectedFindingId(id);
    writeFindingToUrl(id);
  };
  // Auto-dismiss the banner after 8s so it stays out of the way once
  // the user has seen it. The dialog itself already closed on success,
  // so the banner is the only remaining post-submit affordance. Within
  // an 8s window the relative-time label is always "just now", so no
  // tick interval is needed to keep it fresh.
  useEffect(() => {
    if (!lastSubmission) return;
    const dismiss = window.setTimeout(() => {
      setLastSubmission(null);
    }, 8_000);
    return () => {
      window.clearTimeout(dismiss);
    };
  }, [lastSubmission]);

  const { data: engagement, isLoading: engagementLoading } = useGetEngagement(
    id,
    {
      query: {
        enabled: !!id,
        queryKey: getGetEngagementQueryKey(id),
      },
    },
  );

  const title = engagement?.name ?? `Engagement ${id}`;
  const subtitleParts = [
    engagement?.jurisdiction,
    engagement?.site?.address ?? engagement?.address ?? null,
  ].filter((s): s is string => !!s);

  // The submit affordance only makes sense once the engagement
  // record has loaded — we need its name (and jurisdiction, when
  // present) to title the confirmation dialog. Disable instead of
  // hide so the button keeps its place in the layout while loading.
  const canSubmit = !!engagement && !!id;

  return (
    <DashboardLayout
      title={title}
      navGroups={navGroups}
      brandLabel="SMARTCITY OS"
      brandProductName="Plan Review"
      search={{
        placeholder: "Search submissions...",
        value: searchQuery,
        onChange: setSearchQuery,
      }}
    >
      <div className="flex flex-col gap-6">
        <div>
          <Link
            href="/"
            className="sc-meta"
            style={{ color: "var(--text-secondary)" }}
          >
            ← Back to Inbox
          </Link>
          <h2
            className="text-[22px] font-bold font-['Oxygen'] text-[var(--text-primary)]"
            style={{ marginTop: 8 }}
          >
            {engagementLoading ? "Loading engagement…" : title}
          </h2>
          {subtitleParts.length > 0 && (
            <div className="sc-body mt-1">{subtitleParts.join(" · ")}</div>
          )}
        </div>

        {lastSubmission && (
          <SubmissionRecordedBanner
            submittedAt={lastSubmission.receipt.submittedAt}
            jurisdiction={lastSubmission.jurisdiction}
            onDismiss={() => setLastSubmission(null)}
          />
        )}

        {audience === "internal" && engagement && (
          <ArchitectOfRecordCard engagement={engagement} />
        )}

        <SubmissionsList
          engagementId={id}
          onSubmit={() => setSubmitOpen(true)}
          canSubmit={canSubmit}
          searchQuery={searchQuery}
          audience={audience}
          onOpenAnnotations={(target) =>
            setAnnotationTarget({ ...target, highlightAnnotationId: null })
          }
          onOpenSubmission={openSubmissionModal}
        />

        {/*
          Task #261 — auditor-side mirror of the Design Tools "Recent
          runs" disclosure (Task #230). External reviewers who land in
          Plan Review can now spot a suspicious briefing-generation
          attempt (failed run, completed run with stripped citations)
          without bouncing across to Design Tools to investigate. The
          panel only fetches `/engagements/:id/briefing/runs` once the
          disclosure is actually opened, so a page load that never
          touches it costs zero extra round trips.

          Task #348 — `id="briefing"` is the deep-link anchor the
          Engagement Context tab's "View full briefing" link targets
          (`/engagements/:id?recentRunsOpen=1#briefing`). The wrapper
          is also where the auto-scroll handler below grabs a node
          to center on so the panel is in view immediately on land.
        */}
        {id && (
          <div id="briefing">
            {/*
              Task #429 — reviewer-side "Request briefing regeneration"
              affordance. Sits at the top of the briefing panel so the
              reviewer can file the ask in the same eye-line as the
              run-history disclosure they were inspecting when they
              decided a regeneration was warranted. Wrapped in its own
              component so the per-engagement reviewer-requests query
              hook only runs when `audience === "internal"`.
            */}
            {audience === "internal" && (
              <BriefingRegenerationAffordance
                engagementId={id}
                engagementName={engagement?.name ?? null}
              />
            )}
            <BriefingRecentRunsPanel
              engagementId={id}
              renderPriorSnapshotHeader={({
                runGenerationId,
                priorNarrative,
              }) => (
                <BriefingPriorSnapshotHeader
                  runGenerationId={runGenerationId}
                  priorNarrative={priorNarrative}
                  formatGeneratedAt={(raw: string) => ({
                    text: relativeTime(raw),
                    title: new Date(raw).toLocaleString(),
                  })}
                />
              )}
              renderPriorNarrativeDiff={({
                runGenerationId,
                priorNarrative,
                currentNarrative,
              }) => (
                <BriefingPriorNarrativeDiff
                  runGenerationId={runGenerationId}
                  priorNarrative={priorNarrative}
                  currentNarrative={currentNarrative}
                />
              )}
            />
          </div>
        )}
      </div>

      {/*
        AIR-2 modal lives outside the layout so it can render edge-to-
        edge. We look the open submission up off the cached list rather
        than refetching its row — the submissions list query is the
        same one populating the row the user clicked to open the
        modal, so the data is already in cache.
      */}
      <OpenSubmissionModalRenderer
        engagementId={id}
        openSubmissionId={openSubmissionId}
        submissionTab={submissionTab}
        selectedFindingId={selectedFindingId}
        onTabChange={handleTabChange}
        onSelectFinding={handleSelectFinding}
        onClose={closeSubmissionModal}
        audience={audience}
        onOpenSubmission={openSubmissionModal}
      />

      {engagement && (
        <SubmitToJurisdictionDialog
          engagementId={engagement.id}
          engagementName={engagement.name}
          jurisdiction={engagement.jurisdiction ?? null}
          isOpen={submitOpen}
          onClose={() => setSubmitOpen(false)}
          onSubmitted={(receipt) =>
            setLastSubmission({
              receipt,
              jurisdiction: engagement.jurisdiction ?? null,
            })
          }
        />
      )}
      {annotationTarget && (
        <ReviewerAnnotationPanel
          isOpen={true}
          onClose={() => {
            setAnnotationTarget(null);
            // Clear the deep-link hash so a "Close" doesn't leave a
            // stale URL that would re-open the panel on refresh.
            if (
              typeof window !== "undefined" &&
              window.location.hash.includes("annotation=")
            ) {
              history.replaceState(
                null,
                "",
                window.location.pathname + window.location.search,
              );
            }
          }}
          submissionId={annotationTarget.submissionId}
          targetEntityType={annotationTarget.targetEntityType}
          targetEntityId={annotationTarget.targetEntityId}
          audience={audience}
          highlightAnnotationId={annotationTarget.highlightAnnotationId}
        />
      )}
    </DashboardLayout>
  );
}

function SubmissionsList({
  engagementId,
  onSubmit,
  canSubmit,
  searchQuery,
  audience,
  onOpenAnnotations,
  onOpenSubmission,
}: {
  engagementId: string;
  onSubmit: () => void;
  canSubmit: boolean;
  searchQuery: string;
  audience: "internal" | "user" | "ai";
  onOpenAnnotations: (target: {
    submissionId: string;
    targetEntityType:
      | "submission"
      | "briefing-source"
      | "materializable-element"
      | "briefing-divergence"
      | "sheet"
      | "parcel-briefing";
    targetEntityId: string;
  }) => void;
  onOpenSubmission: (id: string) => void;
}) {
  const { data: submissions, isLoading } = useListEngagementSubmissions(
    engagementId,
    {
      query: {
        enabled: !!engagementId,
        queryKey: getListEngagementSubmissionsQueryKey(engagementId),
      },
    },
  );

  const trimmedQuery = searchQuery.trim().toLowerCase();
  const filteredSubmissions = useMemo(() => {
    if (!submissions) return submissions;
    if (!trimmedQuery) return submissions;
    return submissions.filter((s) => {
      const haystack = [
        s.jurisdiction,
        s.status,
        s.note,
        s.reviewerComment,
      ]
        .filter((v): v is string => !!v)
        .join(" ")
        .toLowerCase();
      return haystack.includes(trimmedQuery);
    });
  }, [submissions, trimmedQuery]);

  if (isLoading) {
    return (
      <div
        className="sc-card p-6 text-center"
        data-testid="submissions-loading"
      >
        <div className="sc-body opacity-60">Loading submissions…</div>
      </div>
    );
  }

  if (!submissions || submissions.length === 0) {
    return (
      <div
        className="sc-card p-6 text-center"
        data-testid="submissions-empty"
        style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}
      >
        <div className="sc-prose opacity-70" style={{ maxWidth: 480 }}>
          No submissions recorded for this engagement yet. Once a
          package is submitted to a jurisdiction, it will appear here.
        </div>
        <button
          type="button"
          className="sc-btn-primary"
          onClick={onSubmit}
          disabled={!canSubmit}
          data-testid="submit-jurisdiction-trigger"
        >
          Submit to jurisdiction
        </button>
      </div>
    );
  }

  const visibleSubmissions = filteredSubmissions ?? [];
  return (
    <SubmissionsCardBody
      submissions={submissions}
      visibleSubmissions={visibleSubmissions}
      trimmedQuery={trimmedQuery}
      searchQuery={searchQuery}
      onSubmit={onSubmit}
      canSubmit={canSubmit}
      audience={audience}
      onOpenAnnotations={onOpenAnnotations}
      onOpenSubmission={onOpenSubmission}
    />
  );
}

/**
 * Inner body of {@link SubmissionsCard} — renders the past-submissions
 * list. Split out so the surrounding card (loading / empty / error
 * rendering) stays a pure derivation of the list query.
 *
 * Wave 2 Sprint B (Task #306): each row is an interactive trigger
 * that opens the {@link SubmissionDetailModal} (BIM Model + Engagement
 * Context + Note + Findings tabs). AIR-2 (Task #310) moved the modal
 * mount up to the page level so the URL-controlled selection state
 * (open submission, active tab, drill-in finding) survives a paste
 * link and stays out of this component's local state.
 */
function SubmissionsCardBody({
  submissions,
  visibleSubmissions,
  trimmedQuery,
  searchQuery,
  onSubmit,
  canSubmit,
  audience,
  onOpenAnnotations,
  onOpenSubmission,
}: {
  submissions: EngagementSubmissionSummary[];
  visibleSubmissions: EngagementSubmissionSummary[];
  trimmedQuery: string;
  searchQuery: string;
  onSubmit: () => void;
  canSubmit: boolean;
  audience: "internal" | "user" | "ai";
  onOpenAnnotations: (target: {
    submissionId: string;
    targetEntityType:
      | "submission"
      | "briefing-source"
      | "materializable-element"
      | "briefing-divergence"
      | "sheet"
      | "parcel-briefing";
    targetEntityId: string;
  }) => void;
  onOpenSubmission: (id: string) => void;
}) {
  return (
    <div className="sc-card flex flex-col" data-testid="submissions-list">
      <div
        className="sc-card-header sc-row-sb"
        style={{ display: "flex", alignItems: "center", gap: 12 }}
      >
        <span className="sc-label">PAST SUBMISSIONS</span>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="sc-meta">
            {trimmedQuery
              ? `${visibleSubmissions.length} of ${submissions.length} items`
              : `${submissions.length} total`}
          </span>
          <button
            type="button"
            className="sc-btn-primary"
            onClick={onSubmit}
            disabled={!canSubmit}
            data-testid="submit-jurisdiction-trigger"
          >
            Submit to jurisdiction
          </button>
        </div>
      </div>
      <div className="flex flex-col">
        {visibleSubmissions.length === 0 ? (
          <div
            className="p-6 text-center sc-body"
            data-testid="submissions-no-matches"
          >
            No submissions match “{searchQuery.trim()}”. Try a different
            jurisdiction, status, or note.
          </div>
        ) : (
          visibleSubmissions.map((s: EngagementSubmissionSummary) => (
            <SubmissionRow
              key={s.id}
              submission={s}
              onOpenDetail={() => onOpenSubmission(s.id)}
              audience={audience}
              onOpenAnnotations={onOpenAnnotations}
            />
          ))
        )}
      </div>
    </div>
  );
}

/**
 * SubmissionRow — single row in the past-submissions list (Task #86).
 *
 * The row is a vertical stack of three optional sections:
 *   1. Header line: jurisdiction label + status badge + relative
 *      "submitted at" timestamp (the badge sits next to the
 *      jurisdiction so reviewers can spot pending vs. responded
 *      packages without scanning the timestamp column).
 *   2. Reviewer comment (when present) — the same muted body style
 *      as the existing submission note. Rendered with `whiteSpace:
 *      pre-wrap` so multi-line replies survive intact.
 *   3. Submission note (the original outbound free-text from the
 *      submitter) — kept underneath the reviewer comment so the
 *      back-and-forth reads top-down (jurisdiction reply, then the
 *      package note that was sent in).
 *
 * The "responded at" timestamp lives on a meta line beneath the
 * reviewer comment when a reply has been recorded. It uses the same
 * `relativeTime()` helper as the "submitted at" stamp so the two
 * timestamps render in matching human-friendly form.
 */
function SubmissionRow({
  submission: s,
  onOpenDetail,
  audience,
  onOpenAnnotations,
}: {
  submission: EngagementSubmissionSummary;
  /**
   * Wave 2 Sprint B (Task #306) + AIR-2 (Task #310) — click handler
   * that opens the submission detail modal. After AIR-2 the modal
   * lives at the page level and is URL-controlled, so this callback
   * is a thin "set the open submission id" trigger rather than a
   * local-state setter. The whole row becomes a button; nested
   * elements stay as spans so they don't get their own button
   * semantics.
   */
  onOpenDetail: () => void;
  /**
   * Wave 2 Sprint C (Task #307) — reviewer audience and the side-
   * panel opener. The `ReviewerAnnotationAffordance` rendered inside
   * the row is gated on `audience === "internal"` and, when clicked,
   * pops the shared annotation panel against this submission row's
   * target tuple. The affordance stops click propagation so the
   * outer row's `onOpenDetail` modal is *not* triggered when a
   * reviewer wants only the annotation panel.
   */
  audience: "internal" | "user" | "ai";
  onOpenAnnotations: (target: {
    submissionId: string;
    targetEntityType:
      | "submission"
      | "briefing-source"
      | "materializable-element"
      | "briefing-divergence"
      | "sheet"
      | "parcel-briefing";
    targetEntityId: string;
  }) => void;
}) {
  // The OpenAPI contract guarantees `status` is always present
  // (defaulted to "pending" by the row schema), so we can drive the
  // badge unconditionally; reviewer comment and respondedAt remain
  // optional and only render when actually populated.
  const status = s.status;
  const hasResponse = status !== "pending" && s.respondedAt != null;
  return (
    <div
      className="sc-card-row"
      data-testid={`submission-row-${s.id}`}
      role="button"
      tabIndex={0}
      onClick={onOpenDetail}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenDetail();
        }
      }}
      style={{
        padding: "12px 16px",
        borderBottom: "1px solid var(--border-default)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        cursor: "pointer",
      }}
    >
      <div
        className="sc-row-sb"
        style={{ display: "flex", alignItems: "center", gap: 12 }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
          }}
        >
          <span
            className="sc-medium"
            style={{ color: "var(--text-primary)", fontSize: 13 }}
          >
            {s.jurisdiction ?? "Jurisdiction not recorded"}
          </span>
          <SubmissionStatusBadge status={status} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ReviewerAnnotationAffordance
            submissionId={s.id}
            targetEntityType="submission"
            targetEntityId={s.id}
            audience={audience}
            onOpen={onOpenAnnotations}
          />
          <span
            className="sc-meta"
            title={new Date(s.submittedAt).toLocaleString()}
            style={{ color: "var(--text-secondary)", fontSize: 11 }}
          >
            {relativeTime(s.submittedAt)}
          </span>
        </div>
      </div>
      {hasResponse && (
        <div
          data-testid={`submission-response-${s.id}`}
          style={{ display: "flex", flexDirection: "column", gap: 2 }}
        >
          {s.reviewerComment && (
            <ReviewerComment
              submissionId={s.id}
              comment={s.reviewerComment}
            />
          )}
          <span
            className="sc-meta"
            data-testid={`submission-responded-at-${s.id}`}
            title={new Date(s.respondedAt!).toLocaleString()}
            style={{ color: "var(--text-secondary)", fontSize: 11 }}
          >
            Responded {relativeTime(s.respondedAt)}
          </span>
        </div>
      )}
      {s.note && (
        <div
          className="sc-body"
          data-testid={`submission-note-${s.id}`}
          style={{
            color: "var(--text-secondary)",
            fontSize: 12,
            whiteSpace: "pre-wrap",
          }}
        >
          {s.note}
        </div>
      )}
    </div>
  );
}

/**
 * OpenSubmissionModalRenderer — small wrapper that looks the open
 * submission up in the cached `useListEngagementSubmissions` query
 * before mounting the modal.
 *
 * Keeping this in its own component (rather than inlining the lookup
 * in `EngagementDetail`) means the cache subscription only re-renders
 * the modal subtree on submissions-list changes — the rest of the
 * page (banner, recent runs disclosure, search bar) is unaffected.
 *
 * Returns `null` when:
 *   - no submission is open
 *   - the submission id from the URL doesn't match any row in the
 *     cached list (stale link / deleted row); in that case we leave
 *     the URL param in place so a future refetch can recover, but we
 *     don't render an empty modal shell.
 */
function OpenSubmissionModalRenderer({
  engagementId,
  openSubmissionId,
  submissionTab,
  selectedFindingId,
  onTabChange,
  onSelectFinding,
  onClose,
  audience,
  onOpenSubmission,
}: {
  engagementId: string;
  openSubmissionId: string | null;
  submissionTab: SubmissionDetailTab;
  selectedFindingId: string | null;
  onTabChange: (tab: SubmissionDetailTab) => void;
  onSelectFinding: (id: string | null) => void;
  onClose: () => void;
  audience: "internal" | "user" | "ai";
  onOpenSubmission: (submissionId: string) => void;
}) {
  const { data: submissions } = useListEngagementSubmissions(engagementId, {
    query: {
      enabled: !!engagementId,
      queryKey: getListEngagementSubmissionsQueryKey(engagementId),
    },
  });
  const { data: engagement } = useGetEngagement(engagementId, {
    query: {
      enabled: !!engagementId,
      queryKey: getGetEngagementQueryKey(engagementId),
    },
  });
  // PLR-5 — feed the SubmissionDetailModal's "Last sent" pill and
  // open the CommunicateComposer. Reviewer-only route; gated by the
  // session middleware on the api-server side.
  const isReviewer = audience === "internal";
  const { data: commsData } = useListSubmissionCommunications(
    openSubmissionId ?? "",
    {
      query: {
        enabled: !!openSubmissionId && isReviewer,
        queryKey: getListSubmissionCommunicationsQueryKey(
          openSubmissionId ?? "",
        ),
      },
    },
  );
  const lastCommunicatedAt = commsData?.communications?.[0]?.sentAt ?? null;
  const [composerOpen, setComposerOpen] = useState(false);

  // PLR-6 / Task #460 — Decide modal mount. Reviewer-only: gated on
  // `audience === "internal"` so the architect / AI audiences fall
  // back to the legacy "switch to Decision tab" path inside
  // `SubmissionDetailModal` (the modal's `handleDecide` does that
  // when no `onDecide` callback is wired).
  const [decideOpen, setDecideOpen] = useState(false);
  if (!openSubmissionId) return null;
  const submission = submissions?.find((s) => s.id === openSubmissionId);
  if (!submission) return null;
  const onDecide =
    audience === "internal" ? () => setDecideOpen(true) : undefined;
  return (
    <>
      <SubmissionDetailModal
        submission={submission}
        engagementId={engagementId}
        tab={submissionTab}
        selectedFindingId={selectedFindingId}
        onTabChange={onTabChange}
        onSelectFinding={onSelectFinding}
        onClose={onClose}
        audience={audience}
        onOpenSubmission={onOpenSubmission}
        onCommunicate={isReviewer ? () => setComposerOpen(true) : undefined}
        lastCommunicatedAt={lastCommunicatedAt}
        onDecide={onDecide}
      />
      {isReviewer && (
        <CommunicateComposer
          open={composerOpen}
          onClose={() => setComposerOpen(false)}
          submissionId={submission.id}
          jurisdictionLabel={
            submission.jurisdiction ?? engagement?.jurisdiction ?? "this jurisdiction"
          }
          applicantFirm={engagement?.applicantFirm ?? null}
          submittedAt={submission.submittedAt}
          architectOfRecord={engagement?.architectOfRecord ?? null}
        />
      )}
      {audience === "internal" && (
        <DecideModal
          submission={submission}
          engagementId={engagementId}
          open={decideOpen}
          onClose={() => setDecideOpen(false)}
        />
      )}
    </>
  );
}

/**
 * Task #429 — small wrapper around `RequestRefreshAffordance` that
 * binds the per-engagement reviewer-requests pending-state lookup to
 * the briefing-regen `(regenerate-briefing, engagementId)` pair.
 *
 * Lives in `EngagementDetail` rather than portal-ui because the
 * "briefing regeneration" target is engagement-scoped (the parcel-
 * briefing atom keyed by engagement id) — no other surface needs
 * the same wiring, so promoting it to portal-ui would just add
 * indirection. The engagement-name fallback is local to plan-review
 * too: design-tools surfaces the regen via its own "Regenerate"
 * button rather than the reviewer-request flow.
 */
/**
 * Task #475 — reviewer-side editor for the engagement's structured
 * architect-of-record contact. Displayed above the past-submissions
 * list so the reviewer can fill in / fix the recipient before opening
 * the Communicate composer. Edits PATCH the engagement and invalidate
 * the engagement query so the composer's recipient row reflects the
 * change immediately.
 *
 * Audience-gated to `internal` at the call site — applicants don't
 * need to (and shouldn't) see or edit the recipient list.
 */
function ArchitectOfRecordCard({
  engagement,
}: {
  engagement: EngagementDetailType;
}) {
  const qc = useQueryClient();
  const contact = engagement.architectOfRecord;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(contact?.name ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [role, setRole] = useState(contact?.role ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) {
      setName(contact?.name ?? "");
      setEmail(contact?.email ?? "");
      setRole(contact?.role ?? "");
      setError(null);
    }
  }, [editing, contact?.name, contact?.email, contact?.role]);

  const mutation = useUpdateEngagement({
    mutation: {
      onSuccess: async () => {
        await qc.invalidateQueries({
          queryKey: getGetEngagementQueryKey(engagement.id),
        });
        setEditing(false);
      },
      onError: (err: unknown) => {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to save the contact — please try again.",
        );
      },
    },
  });

  const saving = mutation.isPending;

  const handleSave = () => {
    setError(null);
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const trimmedRole = role.trim();
    if (!trimmedName || !trimmedEmail) {
      setError(
        "Both name and email are required to capture an architect-of-record contact.",
      );
      return;
    }
    mutation.mutate({
      id: engagement.id,
      data: {
        architectOfRecord: {
          contactId: contact?.contactId ??
            `engagement:${engagement.id}:architect-of-record`,
          name: trimmedName,
          email: trimmedEmail,
          role: trimmedRole.length > 0 ? trimmedRole : null,
        },
      },
    });
  };

  const handleClear = () => {
    setError(null);
    mutation.mutate({
      id: engagement.id,
      data: { architectOfRecord: null },
    });
  };

  return (
    <div
      className="sc-card flex flex-col"
      data-testid="architect-of-record-card"
    >
      <div
        className="sc-card-header sc-row-sb"
        style={{ display: "flex", alignItems: "center", gap: 12 }}
      >
        <span className="sc-label">ARCHITECT OF RECORD</span>
        {!editing && (
          <button
            type="button"
            className="sc-btn-ghost"
            onClick={() => setEditing(true)}
            data-testid="architect-of-record-edit"
            disabled={saving}
          >
            {contact ? "Edit" : "Add contact"}
          </button>
        )}
      </div>
      <div className="p-4" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {!editing && contact && (
          <div data-testid="architect-of-record-display" className="sc-body">
            <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
              {contact.name}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              {contact.email}
              {contact.role ? ` · ${contact.role}` : ""}
            </div>
          </div>
        )}
        {!editing && !contact && (
          <div
            className="sc-body"
            data-testid="architect-of-record-empty"
            style={{ color: "var(--text-secondary)", fontSize: 12 }}
          >
            No architect-of-record contact captured yet. Add one so the
            Communicate composer can populate a real recipient on
            outbound comment letters.
          </div>
        )}
        {editing && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="sc-label" style={{ color: "var(--text-secondary)" }}>
                Name
              </span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={saving}
                data-testid="architect-of-record-name-input"
                className="sc-ui"
                style={aorInputStyle}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="sc-label" style={{ color: "var(--text-secondary)" }}>
                Email
              </span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={saving}
                data-testid="architect-of-record-email-input"
                className="sc-ui"
                style={aorInputStyle}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="sc-label" style={{ color: "var(--text-secondary)" }}>
                Role (optional)
              </span>
              <input
                type="text"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                disabled={saving}
                placeholder="e.g., Architect of record"
                data-testid="architect-of-record-role-input"
                className="sc-ui"
                style={aorInputStyle}
              />
            </label>
            {error && (
              <div
                role="alert"
                data-testid="architect-of-record-error"
                style={{ color: "var(--destructive, #b91c1c)", fontSize: 12 }}
              >
                {error}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              {contact && (
                <button
                  type="button"
                  className="sc-btn-ghost"
                  onClick={handleClear}
                  disabled={saving}
                  data-testid="architect-of-record-clear"
                >
                  Clear contact
                </button>
              )}
              <button
                type="button"
                className="sc-btn-ghost"
                onClick={() => setEditing(false)}
                disabled={saving}
                data-testid="architect-of-record-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                className="sc-btn-primary"
                onClick={handleSave}
                disabled={saving}
                data-testid="architect-of-record-save"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const aorInputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--bg-input)",
  border: "1px solid var(--border-default)",
  color: "var(--text-primary)",
  padding: "6px 10px",
  borderRadius: 4,
  outline: "none",
  fontSize: 12.5,
};

function BriefingRegenerationAffordance({
  engagementId,
  engagementName,
}: {
  engagementId: string;
  engagementName: string | null;
}) {
  const pending = useReviewerRequestIsPending(
    engagementId,
    "regenerate-briefing",
    engagementId,
    true,
  );
  return (
    <div
      data-testid="briefing-regen-affordance-row"
      style={{
        display: "flex",
        justifyContent: "flex-end",
        marginBottom: 12,
      }}
    >
      <RequestRefreshAffordance
        engagementId={engagementId}
        requestKind="regenerate-briefing"
        targetEntityType="parcel-briefing"
        targetEntityId={engagementId}
        targetLabel={engagementName ?? "briefing"}
        pending={pending}
      />
    </div>
  );
}
