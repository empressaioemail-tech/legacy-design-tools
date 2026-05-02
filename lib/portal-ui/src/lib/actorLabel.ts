import {
  BIM_MODEL_DIVERGENCE_ACTOR_ID,
  BIM_MODEL_DIVERGENCE_RESOLVE_ACTOR_ID,
  BIM_MODEL_PUSH_ACTOR_ID,
  BIM_MODEL_REFRESH_ACTOR_ID,
  BRIEFING_ENGINE_ACTOR_ID,
  BRIEFING_MANUAL_UPLOAD_ACTOR_ID,
  ENGAGEMENT_EDIT_ACTOR_ID,
  FINDING_ENGINE_ACTOR_ID,
  REVIEWER_ANNOTATION_AUTHOR_ACTOR_ID,
  REVIEWER_ANNOTATION_PROMOTE_ACTOR_ID,
  SNAPSHOT_INGEST_ACTOR_ID,
  SUBMISSION_INGEST_ACTOR_ID,
  SUBMISSION_RESPONSE_ACTOR_ID,
} from "@workspace/server-actor-ids";

/**
 * Friendly labels for non-user actor identities the API surfaces on
 * audit-trail / timeline rows (Resolved divergences attribution,
 * snapshot history, atom history, submission status timeline, …).
 *
 * Both `kind === "agent"` and `kind === "system"` actor ids share
 * this map because the underlying ids are globally-unique stable
 * strings (e.g. `"snapshot-ingest"`, `"engagement-edit"`,
 * `"bim-model-push"`) and the operator-facing label should not depend
 * on whether the back-end stamped the event with `agent` or `system`.
 *
 * Keys come from `@workspace/server-actor-ids` so a typo on either
 * side is a compile error, and the actorLabel test in design-tools
 * asserts every id in `SERVER_ACTOR_IDS` is present here — a new
 * server-side actor that forgets to add a friendly label fails CI
 * rather than silently rendering the raw id in the audit trail
 * (Task #283). A missing entry still degrades gracefully at runtime:
 * callers fall back to the raw id so a newly-introduced producer
 * still attributes itself, just with a less polished label until the
 * mapping lands.
 *
 * Lives in `@workspace/portal-ui` so every artifact that renders an
 * audit-trail surface (design-tools' Resolved divergences panel and
 * submission status timeline, plan-review's snapshot history sheet
 * cards, …) shares a single source of truth instead of duplicating
 * the map per-artifact.
 */
export const FRIENDLY_AGENT_LABELS: Readonly<Record<string, string>> = {
  // snapshot lifecycle (routes/snapshots.ts)
  [SNAPSHOT_INGEST_ACTOR_ID]: "Site-context automation",
  // engagement lifecycle (lib/engagementEvents.ts)
  [ENGAGEMENT_EDIT_ACTOR_ID]: "Engagement editor",
  [SUBMISSION_INGEST_ACTOR_ID]: "Submission ingest",
  [SUBMISSION_RESPONSE_ACTOR_ID]: "Submission response",
  // bim-model lifecycle (routes/bimModels.ts)
  [BIM_MODEL_PUSH_ACTOR_ID]: "Push-to-Revit automation",
  [BIM_MODEL_REFRESH_ACTOR_ID]: "Revit refresh automation",
  [BIM_MODEL_DIVERGENCE_ACTOR_ID]: "Revit divergence automation",
  [BIM_MODEL_DIVERGENCE_RESOLVE_ACTOR_ID]: "Revit divergence acknowledgement",
  // briefing-source lifecycle (routes/parcelBriefings.ts)
  [BRIEFING_MANUAL_UPLOAD_ACTOR_ID]: "Manual briefing upload",
  [BRIEFING_ENGINE_ACTOR_ID]: "Briefing engine",
  // reviewer-annotation lifecycle (routes/reviewerAnnotations.ts) —
  // Wave 2 Sprint C / Spec 307. Stamped on the rare path where the
  // session does not carry a requestor id (the route gates on a
  // session-bound requestor today, but the actor exists so a future
  // service-to-service call has a stable label rather than rendering
  // the raw `reviewer-annotation-author` slug in the audit trail).
  [REVIEWER_ANNOTATION_AUTHOR_ACTOR_ID]: "Reviewer annotation author",
  [REVIEWER_ANNOTATION_PROMOTE_ACTOR_ID]: "Reviewer annotation promotion",
  // V1-1 / AIR-1 — finding-engine generation events.
  [FINDING_ENGINE_ACTOR_ID]: "Finding engine",
};

/**
 * Minimal actor shape the formatter understands. Matches both the
 * generated `AtomEventActor` (atom timelines) and the `RequestorRefWire`
 * the bim-model divergence endpoint surfaces, so callers on either
 * side can hand their value straight in without an adapter.
 */
export interface ActorLike {
  kind: string;
  id: string;
  displayName?: string;
}

/**
 * Resolve a friendly label for a non-user actor id, or `null` if
 * the id is not in the {@link FRIENDLY_AGENT_LABELS} map. Exposed
 * so callers that want a custom fallback (e.g. SubmissionDetailModal's
 * `kind:id` fallback) can decide what to render when the id is
 * unknown rather than going through {@link formatActorLabel}.
 */
export function friendlyAgentLabel(id: string): string | null {
  return FRIENDLY_AGENT_LABELS[id] ?? null;
}

/**
 * Render a short "who did this" label for an audit-trail actor.
 *
 *   - `user` actors prefer their hydrated `displayName`, falling back
 *     to the raw id when the API hasn't (or couldn't) hydrate it.
 *     This matches the existing `formatResolvedAttribution` posture
 *     so the user-side rendering does not regress when callers
 *     migrate.
 *   - `agent` / `system` actors are looked up in
 *     {@link FRIENDLY_AGENT_LABELS} so e.g. `"snapshot-ingest"` reads
 *     as "Site-context automation" instead of a code-side identifier.
 *     Unknown ids degrade to the raw id so a newly-introduced
 *     producer still attributes itself.
 */
export function formatActorLabel(actor: ActorLike): string {
  if (actor.kind === "user") {
    const name = actor.displayName?.trim();
    return name && name.length > 0 ? name : actor.id;
  }
  return friendlyAgentLabel(actor.id) ?? actor.id;
}
