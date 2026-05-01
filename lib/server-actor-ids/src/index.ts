/**
 * Stable identifiers for the non-user "actors" the API server stamps on
 * audit-trail / timeline events (snapshot ingest, engagement edits,
 * bim-model writes, briefing-source uploads, …).
 *
 * These ids are part of the wire contract: they round-trip through
 * `events.actor.id` columns, atom history projections, and the
 * design-tools `FRIENDLY_AGENT_LABELS` map that turns them into
 * operator-facing labels. Renaming a value here is a breaking change.
 *
 * The shared lib exists so:
 *   - Each api-server route file imports the constant instead of
 *     hand-typing the id string, so a typo on a new caller is a
 *     compile error rather than a silently-mis-attributed event.
 *   - The design-tools `actorLabel` test imports {@link SERVER_ACTOR_IDS}
 *     and fails CI when a new entry is added without a matching
 *     friendly label, instead of relying on a hand-maintained list
 *     that drifted whenever a server route added a new producer.
 *
 * Each constant carries a JSDoc that points to the producer route
 * file so future readers can find the emission site without grepping.
 */

/** Snapshot ingest path — `routes/snapshots.ts`. */
export const SNAPSHOT_INGEST_ACTOR_ID = "snapshot-ingest";

/** Engagement PATCH / regeocode path — `lib/engagementEvents.ts`. */
export const ENGAGEMENT_EDIT_ACTOR_ID = "engagement-edit";

/** Submission send-off — `lib/engagementEvents.ts`. */
export const SUBMISSION_INGEST_ACTOR_ID = "submission-ingest";

/** Submission response-recorded — `lib/engagementEvents.ts`. */
export const SUBMISSION_RESPONSE_ACTOR_ID = "submission-response";

/** design-tools-driven bim-model writes — `routes/bimModels.ts`. */
export const BIM_MODEL_PUSH_ACTOR_ID = "bim-model-push";

/** Bim-model refresh-diff polling path — `routes/bimModels.ts`. */
export const BIM_MODEL_REFRESH_ACTOR_ID = "bim-model-refresh";

/** Divergences the C# add-in records — `routes/bimModels.ts`. */
export const BIM_MODEL_DIVERGENCE_ACTOR_ID = "bim-model-divergence";

/**
 * Operator-resolve fallback when the request did not carry a
 * session-bound requestor — `routes/bimModels.ts`.
 */
export const BIM_MODEL_DIVERGENCE_RESOLVE_ACTOR_ID =
  "bim-model-divergence-resolve";

/** Manual briefing-source upload — `routes/parcelBriefings.ts`. */
export const BRIEFING_MANUAL_UPLOAD_ACTOR_ID = "briefing-manual-upload";

/** Engine-driven generation events — `routes/parcelBriefings.ts`. */
export const BRIEFING_ENGINE_ACTOR_ID = "briefing-engine";

/**
 * Reviewer-annotation create / reply path —
 * `routes/reviewerAnnotations.ts`. Stamped on
 * `reviewer-annotation.created` / `.replied` events when the
 * session does not carry a requestor id (defensive — the route
 * gates on a session-bound requestor today, but the actor exists
 * so the audit trail still attributes a write to *something*
 * stable in the unlikely fallback path).
 */
export const REVIEWER_ANNOTATION_AUTHOR_ACTOR_ID = "reviewer-annotation-author";

/**
 * Reviewer-annotation promotion path —
 * `routes/reviewerAnnotations.ts`. Stamped on
 * `reviewer-annotation.promoted` events when promotion was performed
 * via the bulk-promote endpoint without a session-bound requestor.
 */
export const REVIEWER_ANNOTATION_PROMOTE_ACTOR_ID =
  "reviewer-annotation-promote";

/**
 * Every stable server-side actor id, in declaration order. Consumers
 * iterate this array (e.g. the design-tools actorLabel test) to assert
 * each emitted id has a matching operator-facing label, so a new server
 * actor that forgets to add a friendly label fails CI rather than
 * silently rendering the raw id in the audit trail.
 *
 * `as const` so the element type is the literal-id union, not just
 * `string` — any consumer that needs a discriminated set (a switch,
 * a `Record<ServerActorId, …>`) gets the literal types for free.
 */
export const SERVER_ACTOR_IDS = [
  SNAPSHOT_INGEST_ACTOR_ID,
  ENGAGEMENT_EDIT_ACTOR_ID,
  SUBMISSION_INGEST_ACTOR_ID,
  SUBMISSION_RESPONSE_ACTOR_ID,
  BIM_MODEL_PUSH_ACTOR_ID,
  BIM_MODEL_REFRESH_ACTOR_ID,
  BIM_MODEL_DIVERGENCE_ACTOR_ID,
  BIM_MODEL_DIVERGENCE_RESOLVE_ACTOR_ID,
  BRIEFING_MANUAL_UPLOAD_ACTOR_ID,
  BRIEFING_ENGINE_ACTOR_ID,
  REVIEWER_ANNOTATION_AUTHOR_ACTOR_ID,
  REVIEWER_ANNOTATION_PROMOTE_ACTOR_ID,
] as const;

/** Literal-id union of {@link SERVER_ACTOR_IDS}. */
export type ServerActorId = (typeof SERVER_ACTOR_IDS)[number];
