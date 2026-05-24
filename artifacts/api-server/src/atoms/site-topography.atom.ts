/**
 * The `site-topography` atom registration — 2D-site-context sprint
 * Phase 2D.1.3, shape-only.
 *
 * Per `40d_cortex_site_context_sprint.md`, a *site-topography* atom is
 * the per-engagement DEM ingest + derived contour-line record. Identity
 * is engagement-scoped:
 *
 *   site-topography:{engagementId}
 *
 * Sprint scope (Phase 2D.1.3) is registration-only. The DEM ingest
 * worker that emits `site-topography.ingested` events lands in
 * Phase 2D.1.2 (next PR — depends on the USGS 3DEP client in PR #98).
 * Until then `contextSummary` returns the not-found envelope. The atom
 * shape exists now so the chat inline-reference resolver and the
 * downstream contour-overlay UI (Phase 2D.1.5) can recognize the type.
 *
 * Composition:
 *   - `engagement` (1, concrete) — every site-topography atom belongs
 *     to exactly one engagement; the parent registers in sprint A3 and
 *     is already present in the boot registry before this atom is
 *     added. No forwardRef needed.
 *
 * Access policy: **`tenant-private`** per ADR-017
 * (`80_adrs/adr_017_atom_access_control.md`). DEM + contour data is
 * derived from the parcel + upstream catchment and is treated as
 * engagement-private — it leaks the parcel identity, the architect's
 * scope, and (via the contour density) the terrain detail Cortex
 * computed for the engagement. The producer in Phase 2D.1.2 enforces
 * tenant scoping; the atom registration declares the intent in the
 * file docstring so the policy is discoverable from the atom-catalog.
 *
 * `aiOrigin`: false / `computedOrigin`: true per ADR-001
 * (`80_adrs/adr_001_atom_architecture.md`). The DEM raster and the
 * derived contour-line GeoJSON are deterministic geospatial
 * computation (`gdal_contour`-style 1D contour extraction from a
 * GeoTIFF), not LLM generation; the producer sets the provenance
 * markers on the ingested event payload.
 *
 * supportedModes is **all five** per Spec 20 §10 anti-pattern.
 * `defaultMode: "card"` — a site-topography card surfaces the DEM
 * source + acquisition date + contour interval + parcel-vs-catchment
 * bbox extents, mirroring the briefing-source presentation pattern.
 *
 * Event types (this sprint's vocabulary):
 *   - `site-topography.ingested` — initial DEM fetch + clip + contour
 *     derivation; payload carries the DEM GCS reference, contour
 *     GeoJSON, parcel + catchment bbox, DEM source label + resolution,
 *     acquisition date, computedOrigin marker.
 *   - `site-topography.refreshed` — re-ingest because the parcel
 *     boundary changed (Phase 2D.4 address auto-resolve) or the
 *     operator force-refreshed; payload carries the same shape as
 *     `ingested` plus a `previousAtomEventId` pointer for the
 *     supersession chain.
 *   - `site-topography.superseded` — explicit retirement marker when
 *     the operator deletes the engagement's topography (rare; the
 *     refresh path is the common idempotent supersede). Mirrors the
 *     supersession-via-event pattern from materializable-element
 *     follow-on (ADR-011), preferred over a delete because the atom
 *     history is append-only per ADR-001.
 *
 * VDA wrapping (`wrapForStorage`) intentionally not invoked — matches
 * the snapshot / engagement / intent convention.
 */

import {
  type AtomComposition,
  type AtomRegistration,
  type ContextSummary,
  type EventAnchoringService,
} from "@hauska/atom-contract";

/** Hard cap on the prose summary so the rendered card respects token budget. */
export const SITE_TOPOGRAPHY_PROSE_MAX_CHARS = 400;

/** All five Spec 20 §5 render modes — registration-level contract. */
export const SITE_TOPOGRAPHY_SUPPORTED_MODES = [
  "inline",
  "compact",
  "card",
  "expanded",
  "focus",
] as const;

export type SiteTopographySupportedModes =
  typeof SITE_TOPOGRAPHY_SUPPORTED_MODES;

/**
 * Single source of truth for site-topography-domain event types. The
 * Phase 2D.1.2 ingest worker imports this constant rather than
 * open-coding the event name strings, mirroring the convention used by
 * `INTENT_EVENT_TYPES`, `BRIEFING_SOURCE_EVENT_TYPES`, etc.
 */
export const SITE_TOPOGRAPHY_EVENT_TYPES = [
  "site-topography.ingested",
  "site-topography.refreshed",
  "site-topography.superseded",
] as const;

export type SiteTopographyEventType =
  (typeof SITE_TOPOGRAPHY_EVENT_TYPES)[number];

/**
 * Typed payload returned by `site-topography`'s `contextSummary.typed`.
 * Phase 2D.x PR3 widens the shape now that the ingest worker emits
 * real event payloads — `found: true` returns DEM provenance + contour
 * metadata pulled off the latest `site-topography.ingested` /
 * `.refreshed` event.
 */
export interface SiteTopographyTypedPayload {
  id: string;
  found: boolean;
  demSource?: string;
  demResolutionMeters?: number;
  demFetchedAt?: string;
  contourCount?: number;
  contourIntervalMeters?: number;
  parcelOrigin?: string;
}

export interface SiteTopographyAtomDeps {
  history?: EventAnchoringService;
}

/**
 * Build the site-topography atom registration. Shape-only in Phase
 * 2D.1.3; the Phase 2D.1.2 ingest worker writes the actual provenance
 * + contour-GeoJSON payload onto `site-topography.ingested` events
 * through the same `EventAnchoringService` instance the registry
 * shares with every other atom factory.
 */
export function makeSiteTopographyAtom(
  deps: SiteTopographyAtomDeps = {},
): AtomRegistration<"site-topography", SiteTopographySupportedModes> {
  // `engagement` is a CONCRETE edge — the engagement atom registers
  // earlier in `getAtomRegistry()` and is guaranteed present at
  // validate() time. No forwardRef needed.
  const composition: ReadonlyArray<AtomComposition> = [
    {
      childEntityType: "engagement",
      childMode: "compact",
      dataKey: "engagement",
    },
  ];

  const registration: AtomRegistration<
    "site-topography",
    SiteTopographySupportedModes
  > = {
    entityType: "site-topography",
    domain: "plan-review",
    supportedModes: SITE_TOPOGRAPHY_SUPPORTED_MODES,
    defaultMode: "card",
    composition,
    eventTypes: SITE_TOPOGRAPHY_EVENT_TYPES,
    async contextSummary(
      entityId: string,
      _scope,
    ): Promise<ContextSummary<"site-topography">> {
      let latestEventId = "";
      let latestEventAt = new Date(0).toISOString();
      let latestPayload: Record<string, unknown> | null = null;
      let latestEventType: string | null = null;
      if (deps.history) {
        try {
          const latest = await deps.history.latestEvent({
            kind: "atom",
            entityType: "site-topography",
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
          // Best-effort — a transient history outage cannot fail the
          // catalog lookup. Same convention as intent / briefing-source.
        }
      }

      // Phase 2D.x PR3 — when the ingest worker has appended at least
      // one event, surface DEM + contour provenance off the latest
      // payload so the card renders something useful.
      const found = latestPayload !== null && latestEventType !== "site-topography.superseded";
      let typedPayload: SiteTopographyTypedPayload;
      let prose: string;
      const keyMetrics: ContextSummary<"site-topography">["keyMetrics"] = [];
      if (found && latestPayload) {
        const demRaw = latestPayload.dem as Record<string, unknown> | undefined;
        const contoursRaw = latestPayload.contours as
          | Record<string, unknown>
          | undefined;
        const parcelRaw = latestPayload.parcel as
          | Record<string, unknown>
          | undefined;
        const demSource =
          typeof demRaw?.source === "string" ? demRaw.source : undefined;
        const demResolutionMeters =
          typeof demRaw?.resolutionMeters === "number"
            ? (demRaw.resolutionMeters as number)
            : undefined;
        const demFetchedAt =
          typeof demRaw?.fetchedAt === "string" ? demRaw.fetchedAt : undefined;
        const contourCount =
          typeof contoursRaw?.featureCount === "number"
            ? (contoursRaw.featureCount as number)
            : undefined;
        const contourIntervalMeters =
          typeof contoursRaw?.intervalMeters === "number"
            ? (contoursRaw.intervalMeters as number)
            : undefined;
        const parcelOrigin =
          typeof parcelRaw?.origin === "string" ? parcelRaw.origin : undefined;
        typedPayload = {
          id: entityId,
          found: true,
          demSource,
          demResolutionMeters,
          demFetchedAt,
          contourCount,
          contourIntervalMeters,
          parcelOrigin,
        };
        if (typeof contourCount === "number") {
          keyMetrics.push({
            label: "Contour features",
            value: String(contourCount),
          });
        }
        if (typeof contourIntervalMeters === "number") {
          keyMetrics.push({
            label: "Interval (m)",
            value: String(contourIntervalMeters),
          });
        }
        if (typeof demResolutionMeters === "number") {
          keyMetrics.push({
            label: "DEM resolution (m)",
            value: String(demResolutionMeters),
          });
        }
        const proseRaw =
          `Site topography for engagement ${entityId}: ${contourCount ?? "?"} contour features at ` +
          `${contourIntervalMeters ?? "?"}m interval derived from ${demSource ?? "USGS 3DEP"} ` +
          `(${demResolutionMeters ?? "?"}m resolution). Parcel boundary from ${parcelOrigin ?? "?"}.`;
        prose =
          proseRaw.length > SITE_TOPOGRAPHY_PROSE_MAX_CHARS
            ? proseRaw.slice(0, SITE_TOPOGRAPHY_PROSE_MAX_CHARS - 1) + "…"
            : proseRaw;
      } else {
        typedPayload = { id: entityId, found: false };
        const proseRaw =
          `Site topography ${entityId}: no DEM ingest has been triggered yet. ` +
          `Hit POST /api/engagements/${entityId}/site-topography/refresh to derive contours ` +
          `from USGS 3DEP for the engagement's parcel boundary.`;
        prose =
          proseRaw.length > SITE_TOPOGRAPHY_PROSE_MAX_CHARS
            ? proseRaw.slice(0, SITE_TOPOGRAPHY_PROSE_MAX_CHARS - 1) + "…"
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
