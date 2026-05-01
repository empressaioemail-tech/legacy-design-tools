/**
 * The `submission` atom registration — Spec 20 §4 / sprint A4.
 *
 * A *submission* is one plan-review package handed off to the
 * jurisdiction. The route `POST /api/engagements/:id/submissions`
 * inserts a {@link submissions} row and emits an
 * `engagement.submitted` event against the parent engagement; this
 * atom registration makes the row queryable by id through the same
 * four-layer `ContextSummary` shape every other catalog atom uses.
 *
 * Mirrors the structural choices made by `sheet.atom.ts`:
 *   - factory style so tests can inject a per-schema `db` and an
 *     in-memory `EventAnchoringService`,
 *   - explicit prose-budget constant capping `prose` length,
 *   - explicit supported-modes tuple driving `defaultMode`,
 *   - typed payload interface (`SubmissionTypedPayload`) so consumers
 *     never have to `as`-cast,
 *   - history-provenance fallback to the row's `submittedAt` when the
 *     history service is absent or has no events for this entity yet.
 *
 * Composition: a submission has no children today, so `composition`
 * is empty. The parent engagement's composition declares this atom as
 * the `submission` child edge (no longer a forward ref now that this
 * registration exists).
 */

import { eq } from "drizzle-orm";
import { submissions } from "@workspace/db";
import type {
  AtomReference,
  AtomRegistration,
  ContextSummary,
  EventAnchoringService,
  KeyMetric,
} from "@workspace/empressa-atom";
import type { db as ProdDb } from "@workspace/db";

/** Hard cap on the prose summary length so we don't blow up token budget. */
export const SUBMISSION_PROSE_MAX_CHARS = 600;

/** Modes future render bindings will implement for `submission`. */
export const SUBMISSION_SUPPORTED_MODES = [
  "inline",
  "compact",
  "card",
  "expanded",
] as const;

export type SubmissionSupportedModes = typeof SUBMISSION_SUPPORTED_MODES;

/**
 * Event vocabulary the submission atom is allowed to emit. The
 * canonical lifecycle event today is `engagement.submitted`, which is
 * appended against the *parent* engagement (so the timeline lives on
 * the engagement) — that producer lives in `engagement.atom.ts`'s
 * vocabulary, not here. Submission-scoped events (e.g. status updates
 * once the jurisdiction responds) will land in this constant when
 * those producers are wired.
 */
export const SUBMISSION_EVENT_TYPES = [] as const;

/**
 * Typed payload returned by `submission`'s `contextSummary.typed`.
 * Nullable jurisdiction labels are emitted as `null` (not omitted) so
 * the FE can distinguish "we have no jurisdiction snapshot for this
 * submission" from "the jurisdiction field is missing from the payload
 * shape entirely".
 */
export interface SubmissionTypedPayload {
  id: string;
  found: boolean;
  engagementId?: string;
  jurisdiction?: string | null;
  jurisdictionCity?: string | null;
  jurisdictionState?: string | null;
  jurisdictionFips?: string | null;
  note?: string | null;
  submittedAt?: string;
  createdAt?: string;
}

/**
 * Dependencies of {@link makeSubmissionAtom}. `db` and `history`
 * mirror the {@link import("./sheet.atom").SheetAtomDeps} contract.
 */
export interface SubmissionAtomDeps {
  db: typeof ProdDb;
  history?: EventAnchoringService;
}

/**
 * Build the submission atom registration. Factory style so tests can
 * swap in a per-schema `db` and a deterministic in-memory
 * `EventAnchoringService`.
 */
export function makeSubmissionAtom(
  deps: SubmissionAtomDeps,
): AtomRegistration<"submission", SubmissionSupportedModes> {
  return {
    entityType: "submission",
    domain: "plan-review",
    supportedModes: SUBMISSION_SUPPORTED_MODES,
    defaultMode: "card",
    composition: [],
    eventTypes: SUBMISSION_EVENT_TYPES,
    async contextSummary(
      entityId: string,
      _scope,
    ): Promise<ContextSummary<"submission">> {
      const rows = await deps.db
        .select({
          id: submissions.id,
          engagementId: submissions.engagementId,
          jurisdiction: submissions.jurisdiction,
          jurisdictionCity: submissions.jurisdictionCity,
          jurisdictionState: submissions.jurisdictionState,
          jurisdictionFips: submissions.jurisdictionFips,
          note: submissions.note,
          submittedAt: submissions.submittedAt,
          createdAt: submissions.createdAt,
        })
        .from(submissions)
        .where(eq(submissions.id, entityId))
        .limit(1);

      const row = rows[0];

      // Not-found mirrors sheet/snapshot/engagement: a 200-style
      // return with `typed.found: false` so the chat layer can
      // reference a stale id without crashing the FE on a 404.
      if (!row) {
        return {
          prose: `Submission ${entityId} could not be found. It may have been removed or never existed.`,
          typed: {
            id: entityId,
            found: false,
          } satisfies SubmissionTypedPayload,
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: {
            latestEventId: "",
            latestEventAt: new Date(0).toISOString(),
          },
          scopeFiltered: false,
        };
      }

      // Prefer the denormalized `jurisdiction` label; fall back to a
      // composed "City, ST" if the snapshot only carries the parts;
      // last-resort fallback so prose never reads "submitted to .".
      const composedJurisdiction = [
        row.jurisdictionCity,
        row.jurisdictionState,
      ]
        .filter((s): s is string => typeof s === "string" && s.length > 0)
        .join(", ");
      const jurisdictionLabel =
        row.jurisdiction ||
        composedJurisdiction ||
        "jurisdiction not recorded";
      const noteFragment = row.note ? ` Note: ${row.note}` : "";
      const proseRaw =
        `Plan-review submission to ${jurisdictionLabel}, ` +
        `submitted ${row.submittedAt.toISOString()}.` +
        noteFragment;
      const prose =
        proseRaw.length > SUBMISSION_PROSE_MAX_CHARS
          ? proseRaw.slice(0, SUBMISSION_PROSE_MAX_CHARS - 1) + "…"
          : proseRaw;

      const keyMetrics: KeyMetric[] = [
        { label: "Submitted at", value: row.submittedAt.toISOString() },
      ];
      if (row.jurisdictionCity && row.jurisdictionState) {
        keyMetrics.push({
          label: "Jurisdiction",
          value: `${row.jurisdictionCity}, ${row.jurisdictionState}`,
        });
      } else if (row.jurisdiction) {
        keyMetrics.push({ label: "Jurisdiction", value: row.jurisdiction });
      }

      const engagementRef: AtomReference = {
        kind: "atom",
        entityType: "engagement",
        entityId: row.engagementId,
      };

      // History provenance: best-effort lookup against the atom_event
      // chain — same fallback contract as sheet/snapshot. The current
      // producer appends `engagement.submitted` against the parent
      // engagement (not the submission entity), so until a
      // submission-scoped event lands the lookup will normally return
      // null and we fall back to `submittedAt`.
      let latestEventId = "";
      let latestEventAt = row.submittedAt.toISOString();
      if (deps.history) {
        try {
          const latest = await deps.history.latestEvent({
            kind: "atom",
            entityType: "submission",
            entityId,
          });
          if (latest) {
            latestEventId = latest.id;
            latestEventAt = latest.occurredAt.toISOString();
          }
        } catch {
          // History is best-effort here — fallback already populated.
        }
      }

      const typed: SubmissionTypedPayload = {
        id: row.id,
        found: true,
        engagementId: row.engagementId,
        jurisdiction: row.jurisdiction,
        jurisdictionCity: row.jurisdictionCity,
        jurisdictionState: row.jurisdictionState,
        jurisdictionFips: row.jurisdictionFips,
        note: row.note,
        submittedAt: row.submittedAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      };

      return {
        prose,
        // ContextSummary.typed is `Record<string, unknown>`; our narrow
        // SubmissionTypedPayload doesn't carry an index signature so we
        // route through `unknown` (per ts2352) without leaking the
        // index-signature requirement back into the typed payload.
        typed: typed as unknown as Record<string, unknown>,
        keyMetrics,
        relatedAtoms: [engagementRef],
        historyProvenance: { latestEventId, latestEventAt },
        scopeFiltered: false,
      };
    },
  };
}
