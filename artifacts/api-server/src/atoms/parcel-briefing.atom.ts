/**
 * The `parcel-briefing` atom registration — DA-PI-1 sprint, shape-only.
 *
 * Per Spec 51 §5 / Spec 51a §2.10, a *parcel briefing* is the
 * model-readable bundle of parcel facts + cited code sections + sourced
 * overlays produced for a single design intent against a single parcel.
 * Identity is content-addressed:
 *
 *   parcel-briefing:{parcelId}:{intentHash}
 *
 * Sprint scope (DA-PI-1) is **registration-only**: this file ships the
 * registration contract — entityType, supportedModes, defaultMode,
 * composition edges, event vocabulary — so the registry, catalog
 * endpoint, and chat inline-reference resolver can recognize the type.
 * The data engine that resolves a briefing id to typed payload data
 * lands in **DA-PI-3** per Spec 51 §7's sprint table; until then
 * `contextSummary` returns a structurally-complete not-found envelope
 * that explains the deferral in `prose` and never throws.
 *
 * Composition (Spec 51 wins on the Spec 51 ↔ 51a discrepancy at §2.10
 * — Spec 51 §5 calls the 4th child `code-section`; Spec 51a calls it
 * `materializable-element`; per Spec 51a §1.4 the Spec-51 wording wins):
 *
 *   - `parcel`         (1, forwardRef — registers in DA-PI-2 / DA-PI-4)
 *   - `intent`         (0..1)
 *   - `briefing-source`(many)
 *   - `code-section`   (many, forwardRef — Code Library catalog atom
 *                       not yet registered; backed by the existing
 *                       `code_atoms` table but without an atom shim)
 *
 * supportedModes is **all five** per Spec 20 §10 anti-pattern
 * "Registering an atom type without all 5 render modes". Renderer
 * implementations are out of DA-PI-1 scope; the contract surface is
 * what registers. `defaultMode: "card"` per Spec 51a §2.10's primary
 * presentation guidance.
 *
 * Event types per **Spec 51 §5** (which wins on the Spec 51 ↔ 51a
 * discrepancy: 51a lists `saved`/`shared`; 51 lists `materialized-revit`
 * and omits both — Spec 51 wording is canonical):
 *
 *   - `parcel-briefing.requested`
 *   - `parcel-briefing.generated`
 *   - `parcel-briefing.materialized-revit`
 *   - `parcel-briefing.regenerated`
 *   - `parcel-briefing.exported`
 *
 * `briefing-divergence` (also produced by the briefing engine) is
 * a separate atom and is deferred to **Spec 53 C-1**, not registered
 * here.
 *
 * VDA wrapping (`wrapForStorage`) is intentionally **not** invoked here
 * to match the snapshot/engagement convention — captured as a downstream
 * cleanup item (do every atom in one sweep, not piecemeal).
 */

import {
  type AtomComposition,
  type AtomRegistration,
  type ContextSummary,
  type EventAnchoringService,
} from "@workspace/empressa-atom";

/** Hard cap on the prose summary so we don't blow up token budget. */
export const PARCEL_BRIEFING_PROSE_MAX_CHARS = 600;

/** All five Spec 20 §5 render modes — registration-level contract. */
export const PARCEL_BRIEFING_SUPPORTED_MODES = [
  "inline",
  "compact",
  "card",
  "expanded",
  "focus",
] as const;

export type ParcelBriefingSupportedModes =
  typeof PARCEL_BRIEFING_SUPPORTED_MODES;

/**
 * Single source of truth for parcel-briefing-domain event types. Per
 * Spec 51 §5 (which wins on the Spec 51 ↔ 51a vocabulary discrepancy
 * — see file header for details). Producers in DA-PI-3 and later
 * sprints import this constant rather than open-coding the strings.
 */
export const PARCEL_BRIEFING_EVENT_TYPES = [
  "parcel-briefing.requested",
  "parcel-briefing.generated",
  "parcel-briefing.materialized-revit",
  "parcel-briefing.regenerated",
  "parcel-briefing.exported",
] as const;

export type ParcelBriefingEventType =
  (typeof PARCEL_BRIEFING_EVENT_TYPES)[number];

/**
 * Typed payload returned by `parcel-briefing`'s `contextSummary.typed`.
 * In DA-PI-1 only the `id` + `found` discriminator are populated — the
 * data engine that fills the rest ships in DA-PI-3.
 */
export interface ParcelBriefingTypedPayload {
  id: string;
  found: boolean;
}

/**
 * Dependencies of {@link makeParcelBriefingAtom}. Only `history` is
 * accepted in DA-PI-1 — there is no DB lookup yet. DA-PI-3 will add a
 * `db` dep (and likely a parcel-fetch + code-retrieval service) when
 * the engine wires up.
 */
export interface ParcelBriefingAtomDeps {
  history?: EventAnchoringService;
}

/**
 * Build the parcel-briefing atom registration. Shape-only in DA-PI-1;
 * `contextSummary` always returns the structural not-found envelope.
 */
export function makeParcelBriefingAtom(
  deps: ParcelBriefingAtomDeps = {},
): AtomRegistration<"parcel-briefing", ParcelBriefingSupportedModes> {
  // Composition edges per Spec 51 §5 / Spec 51a §2.10.
  //   - `parcel`: forwardRef — the parcel atom registers in DA-PI-2
  //     / DA-PI-4 (county GIS adapters). Declaring it as a forward
  //     ref means the framework's `validate()` step does not crash on
  //     the missing child registration; `resolveComposition` returns
  //     zero parcel children at lookup time until that atom registers.
  //   - `intent`, `briefing-source`: registered alongside this atom in
  //     DA-PI-1, so these are concrete edges that validate at boot.
  //   - `code-section`: forwardRef — Code Library has a `code_atoms`
  //     table today but no atom shim. Spec 51 names it `code-section`;
  //     a future sprint registers the atom and this edge becomes
  //     concrete without changing the composition shape here.
  const composition: ReadonlyArray<AtomComposition> = [
    {
      childEntityType: "parcel",
      childMode: "compact",
      dataKey: "parcel",
      forwardRef: true,
    },
    {
      childEntityType: "intent",
      childMode: "card",
      dataKey: "intent",
    },
    {
      childEntityType: "briefing-source",
      childMode: "compact",
      dataKey: "sources",
    },
    {
      childEntityType: "code-section",
      childMode: "compact",
      dataKey: "citedCodeSections",
      forwardRef: true,
    },
  ];

  const registration: AtomRegistration<
    "parcel-briefing",
    ParcelBriefingSupportedModes
  > = {
    entityType: "parcel-briefing",
    domain: "plan-review",
    supportedModes: PARCEL_BRIEFING_SUPPORTED_MODES,
    defaultMode: "card",
    composition,
    eventTypes: PARCEL_BRIEFING_EVENT_TYPES,
    async contextSummary(
      entityId: string,
      _scope,
    ): Promise<ContextSummary<"parcel-briefing">> {
      // History is best-effort even pre-engine: a producer in DA-PI-3
      // may emit a `parcel-briefing.requested` event before the data
      // engine can return a typed payload, and that event should still
      // surface on the timeline. Falls back to epoch when no events
      // exist.
      let latestEventId = "";
      let latestEventAt = new Date(0).toISOString();
      if (deps.history) {
        try {
          const latest = await deps.history.latestEvent({
            kind: "atom",
            entityType: "parcel-briefing",
            entityId,
          });
          if (latest) {
            latestEventId = latest.id;
            latestEventAt = latest.occurredAt.toISOString();
          }
        } catch {
          // History is best-effort; structural fallback above keeps
          // the chat path working when the anchoring service is down.
        }
      }

      const proseRaw =
        `Parcel briefing ${entityId} is registered as a catalog atom but the briefing engine that resolves it ` +
        `is not implemented yet (ships in DA-PI-3). The composition edges (parcel, intent, briefing-source, code-section) ` +
        `and event vocabulary are declared so producers and the chat inline-reference resolver can recognize this type.`;
      const prose =
        proseRaw.length > PARCEL_BRIEFING_PROSE_MAX_CHARS
          ? proseRaw.slice(0, PARCEL_BRIEFING_PROSE_MAX_CHARS - 1) + "…"
          : proseRaw;

      return {
        prose,
        // Cast through `unknown` per the snapshot.atom convention:
        // `ParcelBriefingTypedPayload` deliberately has no index
        // signature, so a direct assignment to `Record<string, unknown>`
        // would fail TS2322; the cast is the established escape hatch.
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
