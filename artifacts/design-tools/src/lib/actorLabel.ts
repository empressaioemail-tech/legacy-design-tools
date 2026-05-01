/**
 * Re-export of the shared actor-label helper that now lives in
 * `@workspace/portal-ui`.
 *
 * The implementation moved out of design-tools so the
 * snapshot-history sheet cards in plan-review (Task #282) can render
 * the same "Site-context automation" / "Engagement editor" / …
 * friendly labels without duplicating the {@link FRIENDLY_AGENT_LABELS}
 * map per-artifact.
 *
 * This re-export is preserved so the existing in-artifact imports
 * (e.g. `SubmissionDetailModal.tsx`, `EngagementDetail.tsx`) and the
 * companion `__tests__/actorLabel.test.ts` suite (which still owns
 * the `SERVER_ACTOR_IDS`-driven tripwire from Task #283) keep
 * working without a wide-ranging import sweep — both paths resolve
 * to the same symbols from the shared lib.
 */
export {
  FRIENDLY_AGENT_LABELS,
  friendlyAgentLabel,
  formatActorLabel,
  type ActorLike,
} from "@workspace/portal-ui";
