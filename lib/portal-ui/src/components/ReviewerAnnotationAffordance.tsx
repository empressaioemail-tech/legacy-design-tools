/**
 * ReviewerAnnotationAffordance — compact "open annotation panel"
 * trigger surfaced next to any target atom render.
 *
 * Wave 2 Sprint C / Spec 307 atom #12. The affordance is the
 * reviewer-only entry point into the threaded scratch-note panel:
 * a single icon button with an annotation-count badge that fetches
 * the per-target list lazily (the parent decides when to mount it,
 * so the list endpoint isn't called for every row in a list view).
 *
 * The button itself only shows for `audience === "internal"` —
 * applicants and architects never see the affordance, matching the
 * route-side audience gate (which would 403 the list call anyway).
 *
 * Counts are derived from the existing list query so the badge stays
 * in sync with the panel without a second round trip.
 */

import {
  getListReviewerAnnotationsQueryKey,
  useListReviewerAnnotations,
} from "@workspace/api-client-react";

export interface ReviewerAnnotationAffordanceProps {
  /**
   * Submission the annotations are scoped to. Reviewer annotations
   * are always submission-scoped per Spec 307; the affordance
   * refuses to mount without one.
   */
  submissionId: string;
  /**
   * Target atom this affordance anchors annotations to. Mirrors the
   * server-side enum.
   */
  targetEntityType:
    | "submission"
    | "briefing-source"
    | "materializable-element"
    | "briefing-divergence"
    | "sheet"
    | "parcel-briefing";
  /**
   * Stable id of the target atom row. Pairs with `targetEntityType`
   * to scope the list query.
   */
  targetEntityId: string;
  /**
   * Audience the surrounding artifact is rendering for. The
   * affordance only renders when this is `"internal"` — defensive
   * guard so an applicant-side mount doesn't make a 403'd list call.
   */
  audience: "internal" | "user" | "ai";
  /**
   * Click handler. Receives the same target tuple back so the parent
   * can open a single shared panel keyed by the most-recent target.
   */
  onOpen: (target: {
    submissionId: string;
    targetEntityType: ReviewerAnnotationAffordanceProps["targetEntityType"];
    targetEntityId: string;
  }) => void;
}

/**
 * SVG path for a small "speech bubble" glyph. Inlined (rather than
 * pulling lucide-react) so the affordance has no extra runtime
 * dependency beyond the generated query hook.
 */
const ANNOTATION_ICON_PATH =
  "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z";

export function ReviewerAnnotationAffordance({
  submissionId,
  targetEntityType,
  targetEntityId,
  audience,
  onOpen,
}: ReviewerAnnotationAffordanceProps) {
  const isReviewer = audience === "internal";
  const { data } = useListReviewerAnnotations(
    submissionId,
    { targetEntityType, targetEntityId },
    {
      query: {
        // Don't even fetch when the affordance is not visible —
        // applicants would 403 anyway.
        enabled: isReviewer && !!submissionId && !!targetEntityId,
        // Share the same react-query key the panel uses so opening
        // the panel populates instantly from the affordance's
        // already-cached list (and any panel-side mutation
        // invalidates this badge in lockstep).
        queryKey: getListReviewerAnnotationsQueryKey(submissionId, {
          targetEntityType,
          targetEntityId,
        }),
      },
    },
  );

  if (!isReviewer) return null;

  const count = data?.annotations?.length ?? 0;
  const testId = `reviewer-annotation-affordance-${targetEntityType}-${targetEntityId}`;

  return (
    <button
      type="button"
      data-testid={testId}
      onClick={() =>
        onOpen({ submissionId, targetEntityType, targetEntityId })
      }
      title={
        count > 0
          ? `${count} reviewer annotation${count === 1 ? "" : "s"}`
          : "Add reviewer annotation"
      }
      aria-label={
        count > 0
          ? `Open ${count} reviewer annotation${count === 1 ? "" : "s"}`
          : "Open reviewer annotations"
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 6px",
        background: "transparent",
        border: "1px solid var(--border-default)",
        borderRadius: 4,
        cursor: "pointer",
        color: "var(--text-secondary)",
        fontSize: 11,
        lineHeight: 1.2,
      }}
    >
      <svg
        width={12}
        height={12}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={ANNOTATION_ICON_PATH} />
      </svg>
      {count > 0 ? (
        <span
          data-testid={`${testId}-count`}
          style={{ color: "var(--text-primary)", fontWeight: 600 }}
        >
          {count}
        </span>
      ) : (
        <span style={{ color: "var(--text-muted)" }}>+</span>
      )}
    </button>
  );
}
