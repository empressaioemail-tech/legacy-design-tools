/**
 * The `materializable-element` atom registration — DA-PI-5 / Spec
 * 51a §2.4, Spec 53 §4.
 *
 * A *materializable element* is one piece of geometry the C# Revit
 * add-in materializes into the architect's active model — a Toposolid
 * surface, a setback plane, a buildable-envelope mass, etc. The
 * briefing engine (DA-PI-3) emits one row per geometric feature it
 * derives from the parcel briefing's sourced overlays; the C# side
 * reads them via `GET /api/engagements/:id/bim-model` to drive
 * materialization passes.
 *
 * Identity is the row UUID (Spec 51a §2.4 chose UUID over a content
 * hash here because the engine may regenerate identical geometry
 * with a different label/lock-state, and the audit trail wants
 * those as distinct rows).
 *
 * Composition (Spec 51a §2.4):
 *   - `parcel-briefing` (1, dataKey: briefing) — the briefing this
 *     element was derived from. Concrete (parcel-briefing already
 *     registered in DA-PI-1).
 *   - `briefing-source` (0..1, dataKey: source) — the cited source
 *     the geometry was derived from, when one exists. Concrete
 *     (briefing-source already registered in DA-PI-1).
 *   - `briefing-divergence` (many, forwardRef-style) — divergences
 *     against this element. Declared as a non-forward edge because
 *     `briefing-divergence` registers in this same sprint.
 *
 * supportedModes: all five per Spec 20 §10. `defaultMode: "compact"`
 * — a materializable element primarily appears as a line item inside
 * its parent bim-model's element list (mirroring briefing-source's
 * "compact in source list" choice).
 *
 * Event types per Spec 51a §2.4:
 *   - `materializable-element.emitted`   — the engine produced it
 *   - `materializable-element.refreshed` — the engine regenerated it
 *      against an updated briefing
 *
 * VDA wrapping (`wrapForStorage`) intentionally not invoked.
 */

import { eq } from "drizzle-orm";
import { materializableElements } from "@workspace/db";
import {
  type AtomComposition,
  type AtomRegistration,
  type ContextSummary,
  type EventAnchoringService,
  type KeyMetric,
} from "@workspace/empressa-atom";
import type { db as ProdDb } from "@workspace/db";

/** Hard cap on the prose summary. */
export const MATERIALIZABLE_ELEMENT_PROSE_MAX_CHARS = 400;

/** All five Spec 20 §5 render modes — registration-level contract. */
export const MATERIALIZABLE_ELEMENT_SUPPORTED_MODES = [
  "inline",
  "compact",
  "card",
  "expanded",
  "focus",
] as const;

export type MaterializableElementSupportedModes =
  typeof MATERIALIZABLE_ELEMENT_SUPPORTED_MODES;

/**
 * Single source of truth for materializable-element-domain event
 * types. The briefing engine in DA-PI-3 / Task #175 imports this
 * constant when it emits per-element events from the
 * briefing-generate route, and the design-tools materialization
 * pipeline (DA-PI-5 / Spec 51a §2.4) appends to the same atom.
 *
 * `*.identified` is kept at index 0 because the briefing-generate
 * route resolves the emit eventType via
 * `MATERIALIZABLE_ELEMENT_EVENT_TYPES[0]` — reordering here would
 * silently change what that route emits.
 */
export const MATERIALIZABLE_ELEMENT_EVENT_TYPES = [
  "materializable-element.identified",
  "materializable-element.materialized",
  "materializable-element.emitted",
  "materializable-element.refreshed",
] as const;

export type MaterializableElementEventType =
  (typeof MATERIALIZABLE_ELEMENT_EVENT_TYPES)[number];

/**
 * Typed payload returned by `materializable-element`'s
 * `contextSummary.typed`.
 */
export interface MaterializableElementTypedPayload {
  id: string;
  found: boolean;
  /**
   * Null on as-built-ifc / as-built-ifc-bundle rows (Track B sprint).
   * Optional+nullable so the typed payload stays a permissive union.
   */
  briefingId?: string | null;
  briefingSourceId?: string | null;
  elementKind?: string;
  /**
   * Provenance lens: 'briefing-derived' | 'as-built-ifc' | 'as-built-ifc-bundle'.
   * Surfaced in prose to disambiguate "design requirement" from "as-built IFC".
   */
  sourceKind?: string;
  /** Engagement scope. Always set on IFC rows; nullable on legacy briefing rows. */
  engagementId?: string | null;
  label?: string | null;
  locked?: boolean;
  glbObjectPath?: string | null;
  /** IFC GUID — set only on as-built-ifc / as-built-ifc-bundle rows. */
  ifcGlobalId?: string | null;
  /** IFC entity type — set only on as-built-ifc / as-built-ifc-bundle rows. */
  ifcType?: string | null;
}

export interface MaterializableElementAtomDeps {
  db: typeof ProdDb;
  history?: EventAnchoringService;
}

/**
 * Build the materializable-element atom registration.
 */
export function makeMaterializableElementAtom(
  deps: MaterializableElementAtomDeps,
): AtomRegistration<
  "materializable-element",
  MaterializableElementSupportedModes
> {
  const composition: ReadonlyArray<AtomComposition> = [
    {
      childEntityType: "parcel-briefing",
      childMode: "compact",
      dataKey: "briefing",
    },
    {
      childEntityType: "briefing-source",
      childMode: "compact",
      dataKey: "source",
    },
    {
      childEntityType: "briefing-divergence",
      childMode: "compact",
      dataKey: "divergences",
    },
  ];

  const registration: AtomRegistration<
    "materializable-element",
    MaterializableElementSupportedModes
  > = {
    entityType: "materializable-element",
    domain: "plan-review",
    supportedModes: MATERIALIZABLE_ELEMENT_SUPPORTED_MODES,
    defaultMode: "compact",
    composition,
    eventTypes: MATERIALIZABLE_ELEMENT_EVENT_TYPES,
    async contextSummary(
      entityId: string,
      _scope,
    ): Promise<ContextSummary<"materializable-element">> {
      const rows = await deps.db
        .select()
        .from(materializableElements)
        .where(eq(materializableElements.id, entityId))
        .limit(1);
      const row = rows[0];

      let latestEventId = "";
      let latestEventAt = new Date(0).toISOString();
      if (deps.history) {
        try {
          const latest = await deps.history.latestEvent({
            kind: "atom",
            entityType: "materializable-element",
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

      if (!row) {
        return {
          prose: `Materializable element ${entityId} could not be found. The briefing engine may not have emitted it yet, or it was superseded by a refreshed briefing.`,
          typed: {
            id: entityId,
            found: false,
          } satisfies MaterializableElementTypedPayload as unknown as Record<
            string,
            unknown
          >,
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: { latestEventId, latestEventAt },
          scopeFiltered: false,
        };
      }

      const labelFragment = row.label ? ` "${row.label}"` : "";
      const lockedFragment = row.locked
        ? "locked"
        : "advisory (architect may modify without divergence)";
      // Provenance fragment disambiguates briefing-derived design
      // requirements from as-built IFC rows ingested from a Revit export.
      const provenanceFragment =
        row.sourceKind === "as-built-ifc"
          ? `As-built IFC ${row.ifcType ?? "<unknown type>"} (GUID ${row.ifcGlobalId ?? "<missing>"}).`
          : row.sourceKind === "as-built-ifc-bundle"
            ? "Consolidated as-built IFC bundle (carries glTF for the viewer)."
            : `Derived from briefing ${row.briefingId ?? "<unknown>"}.`;
      const proseRaw =
        `Materializable element ${row.id} (kind: ${row.elementKind}, source: ${row.sourceKind})${labelFragment} — ${lockedFragment}. ` +
        provenanceFragment;
      const prose =
        proseRaw.length > MATERIALIZABLE_ELEMENT_PROSE_MAX_CHARS
          ? proseRaw.slice(0, MATERIALIZABLE_ELEMENT_PROSE_MAX_CHARS - 1) + "…"
          : proseRaw;

      const keyMetrics: KeyMetric[] = [
        { label: "Kind", value: row.elementKind },
        { label: "Source", value: row.sourceKind },
        { label: "Locked", value: row.locked ? "yes" : "no" },
      ];
      if (row.glbObjectPath) {
        keyMetrics.push({ label: "Glb artifact", value: row.glbObjectPath });
      }
      if (row.ifcType) {
        keyMetrics.push({ label: "IFC type", value: row.ifcType });
      }

      const typed = {
        id: row.id,
        found: true,
        briefingId: row.briefingId,
        briefingSourceId: row.briefingSourceId,
        elementKind: row.elementKind,
        sourceKind: row.sourceKind,
        engagementId: row.engagementId,
        label: row.label,
        locked: row.locked,
        glbObjectPath: row.glbObjectPath,
        ifcGlobalId: row.ifcGlobalId,
        ifcType: row.ifcType,
      } satisfies MaterializableElementTypedPayload;

      if (!latestEventId) {
        latestEventAt = row.updatedAt.toISOString();
      }

      return {
        prose,
        typed: typed as unknown as Record<string, unknown>,
        keyMetrics,
        relatedAtoms: [],
        historyProvenance: { latestEventId, latestEventAt },
        scopeFiltered: false,
      };
    },
  };

  return registration;
}
