/**
 * The `finding` atom registration — V1-1 / AIR-1.
 *
 * A *finding* is one compliance issue produced by the AI plan reviewer
 * (or by a human reviewer via override) against a single plan-review
 * submission. The finding-engine in `lib/finding-engine` emits one
 * row per surviving finding; the routes in `routes/findings.ts` cover
 * generation kickoff + reviewer mutations.
 *
 * Identity is the row's `atom_id` text column carrying the prefixed
 * grammar `finding:{submissionId}:{rowUuid}`. The empressa-atom
 * registry hands the `atom_id` to `contextSummary` as `entityId`; the
 * row pk uuid is internal-only. The `findings_atom_id_uniq` unique
 * index makes this lookup cheap.
 *
 * Composition (per Phase 1A approved spec):
 *   - `submission` (1, dataKey: submission, concrete) — the parent
 *     submission. submission registers earlier in registry.ts so this
 *     edge is concrete (not forwardRef).
 *   - `briefing-source` (0..1, dataKey: source, concrete) — the
 *     backing briefing-source row when the finding's `source_ref`
 *     names one. Not every finding has a source (a code-only
 *     citation suffices). briefing-source registers earlier.
 *   - `code-section` (many, forwardRef, dataKey: citedCodeSections) —
 *     the code-section atoms cited in the finding's body. The
 *     code-section atom doesn't yet have a registration shim (it
 *     reads against `code_atoms` directly); declared forwardRef
 *     mirrors `parcel-briefing.atom.ts:159-165`.
 *
 * supportedModes: all five per Spec 20 §10. `defaultMode: "card"`
 * because findings are the FE's primary list-item surface — the
 * Findings tab in plan-review renders one card per row.
 *
 * Event types per Phase 1A approval:
 *   - `finding.generated` — one event per finding the engine emits at
 *     the end of a successful run. Ordering: events are appended in
 *     the same transaction as the row inserts.
 *   - `finding.accepted` / `finding.rejected` — reviewer flipped
 *     status. Idempotent re-actions append additional events so the
 *     audit trail captures every reviewer touch.
 *   - `finding.overridden` — the override route stamped the original
 *     row and inserted a revision. Anchored against the ORIGINAL's
 *     atom id so a drill-in subscribing to the original's history
 *     sees the override land.
 *   - `finding.promoted-to-architect` — reserved for a future
 *     "promote finding into a jurisdiction reply" endpoint
 *     (V1-2/V1-3 scope). Declared here so the boot-log surfaces the
 *     full event vocabulary.
 *
 * VDA wrapping (`wrapForStorage`) intentionally not invoked — matches
 * the surrounding atom registrations.
 */

import { eq } from "drizzle-orm";
import { findings, type Finding } from "@workspace/db";
import {
  type AtomComposition,
  type AtomRegistration,
  type ContextSummary,
  type EventAnchoringService,
  type KeyMetric,
} from "@workspace/empressa-atom";
import type { db as ProdDb } from "@workspace/db";

/** Hard cap on the prose summary so we don't blow up token budget. */
export const FINDING_PROSE_MAX_CHARS = 600;

/** All five Spec 20 §5 render modes — registration-level contract. */
export const FINDING_SUPPORTED_MODES = [
  "inline",
  "compact",
  "card",
  "expanded",
  "focus",
] as const;

export type FindingSupportedModes = typeof FINDING_SUPPORTED_MODES;

/**
 * Single source of truth for finding-domain event types. Producers
 * (the generate route, the accept/reject/override routes) import this
 * constant rather than open-coding the strings.
 *
 * Order is meaningful: producer routes resolve the event type via
 * indexed access (`FINDING_EVENT_TYPES[0]` for `finding.generated`,
 * etc.) so reordering breaks compilation in the route.
 */
export const FINDING_EVENT_TYPES = [
  "finding.generated",
  "finding.accepted",
  "finding.rejected",
  "finding.overridden",
  "finding.promoted-to-architect",
] as const;

export type FindingEventType = (typeof FINDING_EVENT_TYPES)[number];

/**
 * Typed payload returned by `finding`'s `contextSummary.typed`.
 *
 * Mirror of the FE-visible Finding wire shape minus the citations
 * array (citations live on the `relatedAtoms` field via the
 * composition's code-section + briefing-source edges, in keeping
 * with the surrounding atom registrations' "structured payload =
 * primitive identity columns; relations = relatedAtoms" convention).
 */
export interface FindingTypedPayload {
  id: string;
  found: boolean;
  submissionId?: string;
  severity?: string;
  category?: string;
  status?: string;
  confidence?: string | null;
  lowConfidence?: boolean;
  elementRef?: string | null;
  aiGeneratedAt?: string;
  revisionOfAtomId?: string | null;
}

export interface FindingAtomDeps {
  db: typeof ProdDb;
  history?: EventAnchoringService;
}

/**
 * Build the finding atom registration. Reads by `atom_id` (the
 * `entityId` the registry hands us is the prefixed string), surfacing
 * the row's status + attribution metadata in the typed payload and
 * the prose summary.
 */
export function makeFindingAtom(
  deps: FindingAtomDeps,
): AtomRegistration<"finding", FindingSupportedModes> {
  const composition: ReadonlyArray<AtomComposition> = [
    {
      childEntityType: "submission",
      childMode: "compact",
      dataKey: "submission",
    },
    {
      childEntityType: "briefing-source",
      childMode: "compact",
      dataKey: "source",
    },
    {
      childEntityType: "code-section",
      childMode: "compact",
      dataKey: "citedCodeSections",
      forwardRef: true,
    },
  ];

  const registration: AtomRegistration<"finding", FindingSupportedModes> = {
    entityType: "finding",
    domain: "plan-review",
    supportedModes: FINDING_SUPPORTED_MODES,
    defaultMode: "card",
    composition,
    eventTypes: FINDING_EVENT_TYPES,
    async contextSummary(
      entityId: string,
      _scope,
    ): Promise<ContextSummary<"finding">> {
      // History first (best-effort, mirrors the surrounding pattern).
      let latestEventId = "";
      let latestEventAt = new Date(0).toISOString();
      if (deps.history) {
        try {
          const latest = await deps.history.latestEvent({
            kind: "atom",
            entityType: "finding",
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

      // Look up by atom_id (the registry's entityId convention for
      // findings — see lib/db/src/schema/findings.ts column docs).
      let row: Finding | undefined;
      try {
        const found = await deps.db
          .select()
          .from(findings)
          .where(eq(findings.atomId, entityId))
          .limit(1);
        row = found[0];
      } catch {
        // DB lookup failure falls through to not-found so the chat
        // inline-reference resolver does not crash a turn.
      }

      if (!row) {
        const proseRaw = `Finding ${entityId} could not be found. It may have been deleted or the atom id is malformed.`;
        const prose =
          proseRaw.length > FINDING_PROSE_MAX_CHARS
            ? proseRaw.slice(0, FINDING_PROSE_MAX_CHARS - 1) + "…"
            : proseRaw;
        return {
          prose,
          typed: {
            id: entityId,
            found: false,
          } satisfies FindingTypedPayload as unknown as Record<string, unknown>,
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: { latestEventId, latestEventAt },
          scopeFiltered: false,
        };
      }

      const proseRaw =
        `${row.severity.toUpperCase()} finding (${row.category}) on submission ${row.submissionId}: ` +
        `${row.text.replace(/\s+/g, " ").trim()}`;
      const prose =
        proseRaw.length > FINDING_PROSE_MAX_CHARS
          ? proseRaw.slice(0, FINDING_PROSE_MAX_CHARS - 1) + "…"
          : proseRaw;

      const keyMetrics: KeyMetric[] = [
        { label: "Severity", value: row.severity },
        { label: "Category", value: row.category },
        { label: "Status", value: row.status },
        { label: "Confidence", value: row.confidence },
      ];
      if (row.lowConfidence) {
        keyMetrics.push({ label: "Low confidence", value: "true" });
      }
      if (row.elementRef) {
        keyMetrics.push({ label: "BIM element", value: row.elementRef });
      }

      // Look up the revision-of atom id (for the override audit
      // trail) — separate query because the row only carries the
      // row uuid, but the atom-graph-visible id is the atom_id.
      // Skipped on the AI-produced path (revision_of is null).
      let revisionOfAtomId: string | null = null;
      if (row.revisionOf) {
        try {
          const original = await deps.db
            .select({ atomId: findings.atomId })
            .from(findings)
            .where(eq(findings.id, row.revisionOf))
            .limit(1);
          revisionOfAtomId = original[0]?.atomId ?? null;
        } catch {
          // Best-effort — revision-of pointer is observability, not
          // load-bearing for the contextSummary contract.
        }
      }

      const typed = {
        id: row.atomId,
        found: true,
        submissionId: row.submissionId,
        severity: row.severity,
        category: row.category,
        status: row.status,
        confidence: row.confidence,
        lowConfidence: row.lowConfidence,
        elementRef: row.elementRef,
        aiGeneratedAt: row.aiGeneratedAt.toISOString(),
        revisionOfAtomId,
      } satisfies FindingTypedPayload;

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
