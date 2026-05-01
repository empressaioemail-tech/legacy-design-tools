/**
 * The `parcel-briefing` atom registration — DA-PI-1 sprint shape, DA-PI-3
 * narrative pass-through.
 *
 * Per Spec 51 §5 / Spec 51a §2.10, a *parcel briefing* is the
 * model-readable bundle of parcel facts + cited code sections + sourced
 * overlays produced for a single design intent against a single parcel.
 * Identity is content-addressed:
 *
 *   parcel-briefing:{parcelId}:{intentHash}
 *
 * DA-PI-1 shipped this atom as registration-only with a structurally-
 * complete not-found envelope. DA-PI-3 wires the database lookup —
 * `contextSummary` now reads the engagement's `parcel_briefings` row
 * directly (no parcel/intent lookup yet — those land in DA-PI-4) and
 * surfaces the seven A–G section narrative bodies + generation metadata
 * in Layer 1 prose and Layer 3 keyMetrics. Engagements without a
 * briefing row continue to return the not-found envelope so the chat
 * inline-reference resolver and catalog endpoint do not crash on a
 * never-generated briefing.
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
 * supportedModes is **all five** per Spec 20 §10 anti-pattern. Renderer
 * implementations are out of DA-PI-1/3 scope; the contract surface is
 * what registers. `defaultMode: "card"` per Spec 51a §2.10's primary
 * presentation guidance.
 *
 * Event types per **Spec 51 §5**:
 *
 *   - `parcel-briefing.requested`
 *   - `parcel-briefing.generated`
 *   - `parcel-briefing.materialized-revit`
 *   - `parcel-briefing.regenerated`
 *   - `parcel-briefing.exported`
 *
 * `briefing-divergence` (also produced by the briefing engine) is a
 * separate atom and is deferred to **Spec 53 C-1**, not registered here.
 *
 * VDA wrapping (`wrapForStorage`) intentionally not invoked — matches
 * snapshot/engagement convention.
 */

import {
  type AtomComposition,
  type AtomRegistration,
  type ContextSummary,
  type EventAnchoringService,
  type KeyMetric,
} from "@workspace/empressa-atom";
import { db, parcelBriefings, type ParcelBriefing } from "@workspace/db";
import { eq } from "drizzle-orm";

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
 * Pre-DA-PI-3 only `id` + `found` were populated; the engine now also
 * surfaces the section narrative bodies + generation metadata. Sections
 * are nullable because a briefing row may exist (because uploads have
 * landed via DA-PI-1B) without ever having been generated.
 */
export interface ParcelBriefingTypedPayload {
  id: string;
  found: boolean;
  sectionA: string | null;
  sectionB: string | null;
  sectionC: string | null;
  sectionD: string | null;
  sectionE: string | null;
  sectionF: string | null;
  sectionG: string | null;
  generatedAt: string | null;
  generatedBy: string | null;
}

/**
 * Dependencies of {@link makeParcelBriefingAtom}. `db` is now required
 * to read the briefing row in `contextSummary`; passing it in (rather
 * than importing the singleton inside this module) keeps tests in
 * control of which schema the atom reads from. `history` is best-
 * effort and stays optional.
 */
export interface ParcelBriefingAtomDeps {
  db?: typeof db;
  history?: EventAnchoringService;
}

/**
 * Build the parcel-briefing atom registration. Reads the briefing row
 * by `engagementId` (the route convention treats engagementId as the
 * atom id for parcel-briefing — see DA-PI-1B routing), surfacing the
 * narrative + generation metadata in the typed payload.
 */
export function makeParcelBriefingAtom(
  deps: ParcelBriefingAtomDeps = {},
): AtomRegistration<"parcel-briefing", ParcelBriefingSupportedModes> {
  // Resolve the db lazily on each `contextSummary` call. Doing the
  // `deps.db ?? db` coalesce at construction time would force the
  // singleton `db` import to evaluate even when the caller passed an
  // explicit override — which breaks vi.mock'd test setups that throw
  // on access to the un-set test schema before any test body runs.
  const resolveDb = () => deps.db ?? db;
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
      // History first (best-effort, mirrors DA-PI-1 fallback semantics).
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
          // History is best-effort.
        }
      }

      // Look up by engagementId (the route convention). A briefing row
      // may not exist yet — that's the "no upload has happened" case.
      let row: ParcelBriefing | undefined;
      try {
        const found = await resolveDb()
          .select()
          .from(parcelBriefings)
          .where(eq(parcelBriefings.engagementId, entityId))
          .limit(1);
        row = found[0];
      } catch {
        // DB lookup failure falls through to the not-found envelope so
        // the chat inline-reference resolver does not crash a turn.
      }

      if (!row) {
        const proseRaw =
          `Parcel briefing for engagement ${entityId} has not been generated yet. ` +
          `Upload a manual layer or run the federal adapters, then trigger generation ` +
          `via the Site Context tab.`;
        const prose =
          proseRaw.length > PARCEL_BRIEFING_PROSE_MAX_CHARS
            ? proseRaw.slice(0, PARCEL_BRIEFING_PROSE_MAX_CHARS - 1) + "…"
            : proseRaw;
        return {
          prose,
          typed: {
            id: entityId,
            found: false,
            sectionA: null,
            sectionB: null,
            sectionC: null,
            sectionD: null,
            sectionE: null,
            sectionF: null,
            sectionG: null,
            generatedAt: null,
            generatedBy: null,
          } as unknown as Record<string, unknown>,
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: { latestEventId, latestEventAt },
          scopeFiltered: false,
        };
      }

      const generatedAt = row.generatedAt ? row.generatedAt.toISOString() : null;
      const proseRaw = row.sectionA
        ? `Parcel briefing ${row.id} (engagement ${row.engagementId}). ` +
          `Section A — Executive Summary: ${row.sectionA.replace(/\s+/g, " ").trim()}`
        : `Parcel briefing ${row.id} for engagement ${row.engagementId} ` +
          `exists but the A–G narrative has not been generated yet.`;
      const prose =
        proseRaw.length > PARCEL_BRIEFING_PROSE_MAX_CHARS
          ? proseRaw.slice(0, PARCEL_BRIEFING_PROSE_MAX_CHARS - 1) + "…"
          : proseRaw;

      const keyMetrics: KeyMetric[] = [];
      const sections: ReadonlyArray<{ key: string; body: string | null }> = [
        { key: "section_a_present", body: row.sectionA },
        { key: "section_b_present", body: row.sectionB },
        { key: "section_c_present", body: row.sectionC },
        { key: "section_d_present", body: row.sectionD },
        { key: "section_e_present", body: row.sectionE },
        { key: "section_f_present", body: row.sectionF },
        { key: "section_g_present", body: row.sectionG },
      ];
      for (const s of sections) {
        keyMetrics.push({ label: s.key, value: s.body ? "true" : "false" });
      }
      if (generatedAt) {
        keyMetrics.push({ label: "generated_at", value: generatedAt });
      }
      if (row.generatedBy) {
        keyMetrics.push({ label: "generated_by", value: row.generatedBy });
      }

      return {
        prose,
        typed: {
          id: entityId,
          found: true,
          sectionA: row.sectionA,
          sectionB: row.sectionB,
          sectionC: row.sectionC,
          sectionD: row.sectionD,
          sectionE: row.sectionE,
          sectionF: row.sectionF,
          sectionG: row.sectionG,
          generatedAt,
          generatedBy: row.generatedBy,
        } as unknown as Record<string, unknown>,
        keyMetrics,
        relatedAtoms: [],
        historyProvenance: { latestEventId, latestEventAt },
        scopeFiltered: false,
      };
    },
  };

  return registration;
}
