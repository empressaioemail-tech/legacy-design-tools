/**
 * The `site-drainage` atom registration — 2D-site-context sprint
 * Phase 2D.2/2D.3.
 *
 * Per `40d_cortex_site_context_sprint.md`, a *site-drainage* atom is
 * the per-engagement hydrology + rainfall simulation record:
 *
 *   site-drainage:{engagementId}
 *
 * Composes `site-topography` (concrete, ADR-011 version pin) and
 * `engagement` (concrete). Access policy: **tenant-private** per
 * ADR-017.
 *
 * Event types:
 *   - `site-drainage.computed` — initial drainage + optional rainfall
 *   - `site-drainage.refreshed` — re-run with new forcing/parameters
 *   - `site-drainage.superseded` — explicit retirement
 */

import {
  type AtomComposition,
  type AtomRegistration,
  type ContextSummary,
  type EventAnchoringService,
} from "@hauska/atom-contract";

export const SITE_DRAINAGE_PROSE_MAX_CHARS = 400;

export const SITE_DRAINAGE_SUPPORTED_MODES = [
  "inline",
  "compact",
  "card",
  "expanded",
  "focus",
] as const;

export type SiteDrainageSupportedModes = typeof SITE_DRAINAGE_SUPPORTED_MODES;

export const SITE_DRAINAGE_EVENT_TYPES = [
  "site-drainage.computed",
  "site-drainage.refreshed",
  "site-drainage.superseded",
] as const;

export type SiteDrainageEventType = (typeof SITE_DRAINAGE_EVENT_TYPES)[number];

export interface SiteDrainageTypedPayload {
  id: string;
  found: boolean;
  library?: string;
  libraryVersion?: string;
  routing?: string;
  rainfallDepthInches?: number;
  forcingSource?: string;
  flowLineCount?: number;
  drainageZoneCount?: number;
  siteTopographyEventId?: string;
}

export interface SiteDrainageAtomDeps {
  history?: EventAnchoringService;
}

export function makeSiteDrainageAtom(
  deps: SiteDrainageAtomDeps = {},
): AtomRegistration<"site-drainage", SiteDrainageSupportedModes> {
  const composition: ReadonlyArray<AtomComposition> = [
    {
      childEntityType: "engagement",
      childMode: "compact",
      dataKey: "engagement",
    },
    {
      childEntityType: "site-topography",
      childMode: "compact",
      dataKey: "siteTopography",
    },
  ];

  const registration: AtomRegistration<
    "site-drainage",
    SiteDrainageSupportedModes
  > = {
    entityType: "site-drainage",
    domain: "plan-review",
    supportedModes: SITE_DRAINAGE_SUPPORTED_MODES,
    defaultMode: "card",
    composition,
    eventTypes: SITE_DRAINAGE_EVENT_TYPES,
    async contextSummary(
      entityId: string,
      _scope,
    ): Promise<ContextSummary<"site-drainage">> {
      let latestEventId = "";
      let latestEventAt = new Date(0).toISOString();
      let latestPayload: Record<string, unknown> | null = null;
      let latestEventType: string | null = null;
      if (deps.history) {
        try {
          const latest = await deps.history.latestEvent({
            kind: "atom",
            entityType: "site-drainage",
            entityId,
          });
          if (latest) {
            latestEventId = latest.id;
            latestEventAt = latest.occurredAt.toISOString();
            latestEventType = latest.eventType;
            if (
              latest.payload &&
              typeof latest.payload === "object" &&
              !Array.isArray(latest.payload)
            ) {
              latestPayload = latest.payload as Record<string, unknown>;
            }
          }
        } catch {
          // Best-effort
        }
      }

      const found =
        latestPayload !== null && latestEventType !== "site-drainage.superseded";
      let typedPayload: SiteDrainageTypedPayload;
      let prose: string;
      const keyMetrics: ContextSummary<"site-drainage">["keyMetrics"] = [];

      if (found && latestPayload) {
        const hydrology = latestPayload.hydrology as
          | Record<string, unknown>
          | undefined;
        const rainfall = latestPayload.rainfall as
          | Record<string, unknown>
          | undefined;
        const topoRef = latestPayload.siteTopography as
          | Record<string, unknown>
          | undefined;
        const library =
          typeof hydrology?.library === "string" ? hydrology.library : undefined;
        const libraryVersion =
          typeof hydrology?.libraryVersion === "string"
            ? hydrology.libraryVersion
            : undefined;
        const routing =
          typeof hydrology?.routing === "string" ? hydrology.routing : undefined;
        const depthIn =
          typeof rainfall?.depthInches === "number"
            ? (rainfall.depthInches as number)
            : undefined;
        const forcingSource =
          typeof rainfall?.forcingSource === "string"
            ? rainfall.forcingSource
            : undefined;
        const flowLineCount =
          typeof hydrology?.flowLineCount === "number"
            ? (hydrology.flowLineCount as number)
            : undefined;
        const drainageZoneCount =
          typeof hydrology?.drainageZoneCount === "number"
            ? (hydrology.drainageZoneCount as number)
            : undefined;
        const siteTopographyEventId =
          typeof topoRef?.atomEventId === "string"
            ? topoRef.atomEventId
            : undefined;

        typedPayload = {
          id: entityId,
          found: true,
          library,
          libraryVersion,
          routing,
          rainfallDepthInches: depthIn,
          forcingSource,
          flowLineCount,
          drainageZoneCount,
          siteTopographyEventId,
        };
        if (typeof flowLineCount === "number") {
          keyMetrics.push({ label: "Flow lines", value: String(flowLineCount) });
        }
        if (typeof depthIn === "number") {
          keyMetrics.push({ label: "Rainfall (in)", value: String(depthIn) });
        }
        const proseRaw =
          `Site drainage for ${entityId}: ${library ?? "?"} ${routing ?? ""} ` +
          `with ${flowLineCount ?? "?"} flow lines` +
          (typeof depthIn === "number" ? ` at ${depthIn} in rainfall` : "") +
          `. Forcing: ${forcingSource ?? "none"}.`;
        prose =
          proseRaw.length > SITE_DRAINAGE_PROSE_MAX_CHARS
            ? proseRaw.slice(0, SITE_DRAINAGE_PROSE_MAX_CHARS - 1) + "…"
            : proseRaw;
      } else {
        typedPayload = { id: entityId, found: false };
        const proseRaw =
          `Site drainage ${entityId}: no hydrology run yet. ` +
          `POST /api/engagements/${entityId}/site-drainage/refresh after site-topography ingest.`;
        prose =
          proseRaw.length > SITE_DRAINAGE_PROSE_MAX_CHARS
            ? proseRaw.slice(0, SITE_DRAINAGE_PROSE_MAX_CHARS - 1) + "…"
            : proseRaw;
      }

      return {
        prose,
        typed: typedPayload as unknown as Record<string, unknown>,
        keyMetrics,
        relatedAtoms: [],
        historyProvenance: { latestEventId, latestEventAt },
        scopeFiltered: false,
      };
    },
  };

  return registration;
}
