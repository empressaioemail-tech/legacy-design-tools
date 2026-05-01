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
import {
  submissions,
  type SubmissionStatus,
} from "@workspace/db";
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
 * canonical lifecycle event for the *outbound* package
 * (`engagement.submitted`) is appended against the *parent* engagement
 * — that producer lives in `engagement.atom.ts`'s vocabulary, not
 * here.
 *
 * Submission-scoped events live on this list:
 *   - `submission.response-recorded` — emitted by
 *     `routes/engagements.ts`'s POST
 *     `/engagements/:id/submissions/:submissionId/response` handler
 *     when the jurisdiction's reply is recorded against a submission.
 *     Scoped to the submission entity (not the parent engagement) so
 *     the back-and-forth lives on the submission's own history chain.
 */
export const SUBMISSION_EVENT_TYPES = [
  "submission.response-recorded",
] as const;

export type SubmissionEventType = (typeof SUBMISSION_EVENT_TYPES)[number];

/**
 * Human-readable label for each `SubmissionStatus`. Used by the
 * `keyMetrics` "Status" entry and the `prose` response sentence so
 * the chat layer / FE card never have to translate snake_case enum
 * values themselves. Kept exhaustive (typed by `Record<...>`) so a
 * new status added to {@link SUBMISSION_STATUS_VALUES} fails to
 * compile here until a label is provided.
 */
export const SUBMISSION_STATUS_LABELS: Record<SubmissionStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  corrections_requested: "Corrections requested",
  rejected: "Rejected",
};

/**
 * Typed payload returned by `submission`'s `contextSummary.typed`.
 * Nullable jurisdiction labels are emitted as `null` (not omitted) so
 * the FE can distinguish "we have no jurisdiction snapshot for this
 * submission" from "the jurisdiction field is missing from the payload
 * shape entirely".
 *
 * Response fields (`status`, `reviewerComment`, `respondedAt`) follow
 * the same convention — nullable values are emitted as `null` rather
 * than omitted. `status` is always present (defaulted to `"pending"`
 * by the row schema), so the FE can rely on it to drive the response
 * UI without a presence check.
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
  status?: SubmissionStatus;
  reviewerComment?: string | null;
  respondedAt?: string | null;
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
          status: submissions.status,
          reviewerComment: submissions.reviewerComment,
          respondedAt: submissions.respondedAt,
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
      // Narrow the row's text-typed status into the canonical enum.
      // Falls back to `"pending"` for forward-compat with rows that
      // somehow carry an unknown value (the schema constrains writes
      // but DB-level migrations could in principle land arbitrary
      // text), so the prose / keyMetric never crash on bad data.
      const status: SubmissionStatus = (
        SUBMISSION_STATUS_LABELS as Record<string, string>
      )[row.status]
        ? (row.status as SubmissionStatus)
        : "pending";
      const statusLabel = SUBMISSION_STATUS_LABELS[status];
      // Response fragment — appended to prose so a single read gives
      // the full back-and-forth (send-off + reviewer reply). Stays
      // empty for pending submissions so the prose still reads
      // cleanly when no response exists yet.
      let responseFragment = "";
      if (status !== "pending" && row.respondedAt) {
        const reviewerCommentFragment = row.reviewerComment
          ? ` Reviewer: ${row.reviewerComment}`
          : "";
        responseFragment =
          ` Jurisdiction response: ${statusLabel} on ` +
          `${row.respondedAt.toISOString()}.${reviewerCommentFragment}`;
      }
      const proseRaw =
        `Plan-review submission to ${jurisdictionLabel}, ` +
        `submitted ${row.submittedAt.toISOString()}.` +
        noteFragment +
        responseFragment;
      const prose =
        proseRaw.length > SUBMISSION_PROSE_MAX_CHARS
          ? proseRaw.slice(0, SUBMISSION_PROSE_MAX_CHARS - 1) + "…"
          : proseRaw;

      const keyMetrics: KeyMetric[] = [
        { label: "Submitted at", value: row.submittedAt.toISOString() },
        { label: "Status", value: statusLabel },
      ];
      if (row.respondedAt) {
        keyMetrics.push({
          label: "Responded at",
          value: row.respondedAt.toISOString(),
        });
      }
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
      // chain — same fallback contract as sheet/snapshot. The engagement-
      // scoped `engagement.submitted` event (appended against the parent
      // engagement, not the submission entity) doesn't surface here;
      // submission-scoped events like `submission.response-recorded`
      // do, so once a response is recorded the latest-event lookup
      // returns it. Falls back to `submittedAt` when no submission-
      // scoped event exists yet.
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
        status,
        reviewerComment: row.reviewerComment,
        respondedAt: row.respondedAt ? row.respondedAt.toISOString() : null,
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
