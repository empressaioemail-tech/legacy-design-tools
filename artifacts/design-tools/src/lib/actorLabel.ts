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
 * Keep this map in lockstep with the `id:` constants the API server
 * declares for its system / agent actors:
 *   - `artifacts/api-server/src/routes/snapshots.ts`
 *   - `artifacts/api-server/src/routes/bimModels.ts`
 *   - `artifacts/api-server/src/routes/parcelBriefings.ts`
 *   - `artifacts/api-server/src/lib/engagementEvents.ts`
 *
 * A missing entry degrades gracefully: callers fall back to the raw
 * id so a newly-introduced producer still attributes itself, just
 * with a less polished label until we add the mapping here.
 */
export const FRIENDLY_AGENT_LABELS: Readonly<Record<string, string>> = {
  // snapshot lifecycle (routes/snapshots.ts)
  "snapshot-ingest": "Site-context automation",
  // engagement lifecycle (lib/engagementEvents.ts)
  "engagement-edit": "Engagement editor",
  "submission-ingest": "Submission ingest",
  "submission-response": "Submission response",
  // bim-model lifecycle (routes/bimModels.ts)
  "bim-model-push": "Push-to-Revit automation",
  "bim-model-refresh": "Revit refresh automation",
  "bim-model-divergence": "Revit divergence automation",
  // briefing-source lifecycle (routes/parcelBriefings.ts)
  "briefing-manual-upload": "Manual briefing upload",
  "briefing-engine": "Briefing engine",
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
