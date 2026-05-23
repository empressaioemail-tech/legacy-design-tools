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
 * Only `id` + `found` are populated in Phase 2D.1.3 (registration-only);
 * the producer in 2D.1.2 will widen this to surface DEM source +
 * resolution + acquisition date + contour count once the event payload
 * is being read at lookup time.
 */
export interface SiteTopographyTypedPayload {
  id: string;
  found: boolean;
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
          }
        } catch {
          // Best-effort — a transient history outage cannot fail the
          // catalog lookup. Same convention as intent / briefing-source.
        }
      }

      const proseRaw =
        `Site topography ${entityId} is registered as a catalog atom but the DEM ingest + contour ` +
        `derivation layer is not implemented yet (ships with the Phase 2D.1.2 ingest worker built on ` +
        `the USGS 3DEP client landed in PR #98). The atom shape (engagement composition edge, ` +
        `event vocabulary) is declared so producers and the inline-reference resolver can recognize ` +
        `this type.`;
      const prose =
        proseRaw.length > SITE_TOPOGRAPHY_PROSE_MAX_CHARS
          ? proseRaw.slice(0, SITE_TOPOGRAPHY_PROSE_MAX_CHARS - 1) + "…"
          : proseRaw;

      return {
        prose,
        typed: { id: entityId, found: false } as unknown as Record<
          string,
          unknown
        >,
        keyMetrics: [],
        relatedAtoms: [],
        historyProvenance: { latestEventId, latestEventAt },
        scopeFiltered: false,
      };
    },
  };

  return registration;
}
