/**
 * Property Brief `brief-run` atom — shape-only registration for MCP/graph.
 */

import {
  type AtomComposition,
  type AtomRegistration,
  type ContextSummary,
  type EventAnchoringService,
} from "@hauska/atom-contract";

export const BRIEF_RUN_SUPPORTED_MODES = [
  "inline",
  "compact",
  "card",
  "expanded",
  "focus",
] as const;

export type BriefRunSupportedModes = typeof BRIEF_RUN_SUPPORTED_MODES;

export const BRIEF_RUN_EVENT_TYPES = [
  "brief-run.generated",
  "brief-run.updated",
] as const;

export interface BriefRunAtomDeps {
  history?: EventAnchoringService;
}

export function makeBriefRunAtom(
  deps: BriefRunAtomDeps = {},
): AtomRegistration<"brief-run", BriefRunSupportedModes> {
  const composition: ReadonlyArray<AtomComposition> = [
    {
      childEntityType: "property-workspace",
      childMode: "compact",
      dataKey: "workspace",
      forwardRef: true,
    },
    {
      childEntityType: "code-section",
      childMode: "inline",
      dataKey: "citations",
      forwardRef: true,
    },
  ];

  return {
    entityType: "brief-run",
    domain: "brokerage",
    supportedModes: BRIEF_RUN_SUPPORTED_MODES,
    defaultMode: "card",
    composition,
    eventTypes: BRIEF_RUN_EVENT_TYPES,
    async contextSummary(
      entityId: string,
    ): Promise<ContextSummary<"brief-run">> {
      let latestEventId = "";
      let latestEventAt = new Date(0).toISOString();
      if (deps.history) {
        try {
          const latest = await deps.history.latestEvent({
            kind: "atom",
            entityType: "brief-run",
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
        prose: `Brief run ${entityId} is registered for Property Brief projections.`,
        typed: { id: entityId, found: latestEventId !== "" },
        keyMetrics: [],
        relatedAtoms: [],
        historyProvenance: { latestEventId, latestEventAt },
        scopeFiltered: false,
      };
    },
  };
}
