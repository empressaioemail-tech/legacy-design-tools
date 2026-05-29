/**
 * Property Brief `property-workspace` atom — shape-only until workspace DB
 * lookup ships. Event vocabulary matches @hauska/atom-contract/workspace 1.3.
 */

import {
  type AtomComposition,
  type AtomRegistration,
  type ContextSummary,
  type EventAnchoringService,
} from "@hauska/atom-contract";

export const PROPERTY_WORKSPACE_SUPPORTED_MODES = [
  "inline",
  "compact",
  "card",
  "expanded",
  "focus",
] as const;

export type PropertyWorkspaceSupportedModes =
  typeof PROPERTY_WORKSPACE_SUPPORTED_MODES;

export const PROPERTY_WORKSPACE_EVENT_TYPES = [
  "property-workspace.created",
  "property-workspace.updated",
] as const;

export interface PropertyWorkspaceAtomDeps {
  history?: EventAnchoringService;
}

export function makePropertyWorkspaceAtom(
  deps: PropertyWorkspaceAtomDeps = {},
): AtomRegistration<"property-workspace", PropertyWorkspaceSupportedModes> {
  const composition: ReadonlyArray<AtomComposition> = [
    {
      childEntityType: "brief-run",
      childMode: "compact",
      dataKey: "briefRuns",
      forwardRef: true,
    },
    {
      childEntityType: "place-layer-regrid",
      childMode: "compact",
      dataKey: "placeLayersRegrid",
      forwardRef: true,
    },
    {
      childEntityType: "place-layer-fema",
      childMode: "compact",
      dataKey: "placeLayersFema",
      forwardRef: true,
    },
  ];

  return {
    entityType: "property-workspace",
    domain: "brokerage",
    supportedModes: PROPERTY_WORKSPACE_SUPPORTED_MODES,
    defaultMode: "card",
    composition,
    eventTypes: PROPERTY_WORKSPACE_EVENT_TYPES,
    async contextSummary(
      entityId: string,
    ): Promise<ContextSummary<"property-workspace">> {
      let latestEventId = "";
      let latestEventAt = new Date(0).toISOString();
      if (deps.history) {
        try {
          const latest = await deps.history.latestEvent({
            kind: "atom",
            entityType: "property-workspace",
            entityId,
          });
          if (latest) {
            latestEventId = latest.id;
            latestEventAt = latest.occurredAt.toISOString();
          }
        } catch {
          // Best-effort.
        }
      }

      return {
        prose: `Property workspace ${entityId} is registered for Property Brief projections.`,
        typed: { id: entityId, found: latestEventId !== "" },
        keyMetrics: [],
        relatedAtoms: [],
        historyProvenance: { latestEventId, latestEventAt },
        scopeFiltered: false,
      };
    },
  };
}
