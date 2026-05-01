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
 * Composition: a submission's only declared child edge is
 * `reviewer-annotation` (Spec 307) — the threaded reviewer scratch
 * notes anchored against this submission. The edge is `forwardRef:
 * true` because the data hydration deliberately lives in the
 * dedicated `/submissions/:id/reviewer-annotations` route (which is
 * audience-gated to internal reviewers); the resolver silently
 * produces zero children whenever `parentData.reviewerAnnotations`
 * is absent, so an external (architect) caller hitting this atom's
 * `contextSummary` never sees the reviewer-only thread.
 *
 * The parent engagement's composition declares the submission atom
 * as its `submission` child edge (no longer a forward ref now that
 * this registration exists).
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
import { hydrateActors as defaultHydrateActors } from "../lib/userLookup";

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
 *   - `submission.status-changed` — emitted alongside
 *     `submission.response-recorded` whenever a flow updates the
 *     submission's `status` column. Distinct from
 *     `response-recorded` so the timeline UI can read a clean stream
 *     of status transitions (`{fromStatus, toStatus, note}`) without
 *     having to derive transitions from the heterogeneous
 *     `response-recorded` payload. Today the only producer is the
 *     response-recording route (Task #93); a future "admin manually
 *     overrides status" producer would emit this same event without
 *     needing to also emit `response-recorded`.
 */
export const SUBMISSION_EVENT_TYPES = [
  "submission.response-recorded",
  "submission.status-changed",
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
 * Single entry in {@link SubmissionTypedPayload.statusHistory} — the
 * status-timeline series the FE renders below the per-submission
 * "Related event" panel (Task #93). Each entry corresponds to one
 * status transition emitted on the submission's atom-event chain
 * (event type `submission.status-changed`), plus a synthetic
 * "Submitted" seed entry the atom prepends from the row's
 * `submittedAt` column so a brand-new pending submission still
 * surfaces a timeline without requiring an explicit status-changed
 * event for the initial pending state.
 *
 * Fields:
 *   - `status` — the canonical status the submission transitioned
 *     INTO at this point. Always present; for the seed entry this is
 *     always `"pending"`.
 *   - `occurredAt` — ISO timestamp the transition happened. For the
 *     seed entry this is the row's `submittedAt`; for transition
 *     events this is the event's `occurredAt` (which the response
 *     route stamps with the resolved `respondedAt`).
 *   - `actor` — the recorded actor of the transition (system /
 *     agent / user kind + id). The seed entry uses the actor of the
 *     matching `engagement.submitted` event when one is available,
 *     and falls back to the dedicated `submission-ingest` system
 *     actor otherwise so the FE always has *something* to show.
 *   - `note` — the optional reviewer-comment / status-change note
 *     copied off the event payload. `null` when the producer didn't
 *     supply one (the schema treats blank/whitespace as `null`).
 *   - `eventId` — the originating atom-event id when the entry came
 *     from a real `submission.status-changed` event. `null` for the
 *     synthetic "Submitted" seed entry. Lets the FE/key off a stable
 *     id when iterating the timeline.
 */
export interface SubmissionStatusHistoryEntry {
  status: SubmissionStatus;
  occurredAt: string;
  /**
   * Recorded actor of the transition. The optional `displayName` /
   * `email` / `avatarUrl` fields are populated by the same
   * `hydrateActors` lookup the `/atoms/:slug/:id/history` endpoint
   * uses, so user-kind actors carry profile metadata pulled from the
   * `users` table when one exists. Absent for `agent` / `system`
   * actors (those have no profile row by design) and for user actors
   * whose id has no matching profile (deleted account, ad-hoc dev id,
   * etc.) — UIs fall back to "Unknown user" in that case.
   */
  actor: {
    kind: "user" | "agent" | "system";
    id: string;
    displayName?: string;
    email?: string;
    avatarUrl?: string;
  };
  note: string | null;
  eventId: string | null;
}

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
 *
 * `statusHistory` (Task #93) is the status-transition timeline the
 * FE renders below the modal's "Related event" panel. Always set
 * (never omitted) on a found row so consumers can iterate without a
 * presence check; for a brand-new pending submission this is a
 * single-entry array carrying the synthetic "Submitted" seed entry.
 * Order is oldest → newest so the FE can render a vertical timeline
 * top-to-bottom without re-sorting. Omitted entirely on the
 * not-found shape — there's no row to derive a timeline from.
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
  responseRecordedAt?: string | null;
  createdAt?: string;
  statusHistory?: SubmissionStatusHistoryEntry[];
}

/**
 * Dependencies of {@link makeSubmissionAtom}. `db` and `history`
 * mirror the {@link import("./sheet.atom").SheetAtomDeps} contract.
 *
 * `hydrateActors` is injectable purely for testability — production
 * callers should rely on the default, which delegates to the same
 * `users`-table lookup the `/atoms/:slug/:id/history` endpoint uses.
 * Tests that exercise the in-memory event service can swap in a stub
 * (or pass through unchanged) so they don't need a `users` row to
 * cover the non-hydration code path.
 */
export interface SubmissionAtomDeps {
  db: typeof ProdDb;
  history?: EventAnchoringService;
  hydrateActors?: typeof defaultHydrateActors;
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
    composition: [
      {
        childEntityType: "reviewer-annotation",
        childMode: "compact",
        dataKey: "reviewerAnnotations",
        forwardRef: true,
      },
    ],
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
          responseRecordedAt: submissions.responseRecordedAt,
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
      // chain — same fallback contract as sheet/snapshot.
      //
      // Today the canonical lifecycle event is `engagement.submitted`,
      // which the create-submission route appends against the *parent*
      // engagement (not the submission entity). Submission-scoped
      // events like `submission.response-recorded` do land on the
      // submission entity, so once a response is recorded the
      // submission-scoped `latestEvent` lookup will return it.
      //
      // For the original send-off, to still surface the audit trail
      // entry that corresponds to *this* submission, we additionally
      // scan the engagement's recent history for an
      // `engagement.submitted` event whose payload carries our
      // `submissionId`. When found, that event's id and `occurredAt`
      // become the historyProvenance — so the per-submission detail
      // view can render an inline pointer to the matching audit entry
      // without a second round trip.
      //
      // Order of preference (first non-null wins):
      //   1. submission-scoped latest event (e.g. response-recorded)
      //   2. matching `engagement.submitted` event on the engagement
      //   3. fallback to the row's `submittedAt`
      //
      // Bounded scan: 50 events is more than enough for any real
      // engagement's submission cadence and matches the
      // `HISTORY_MAX_LIMIT` already enforced on the public history
      // endpoint, so we never touch an unbounded slice of the chain.
      let latestEventId = "";
      let latestEventAt = row.submittedAt.toISOString();
      // Status timeline (Task #93). Always seeded with the synthetic
      // "Submitted" entry from the row's `submittedAt` so a brand-new
      // pending submission still has a single-entry timeline; real
      // `submission.status-changed` events get appended in
      // chronological order below. Actor for the seed entry is best-
      // effort: we prefer the actor of the matching
      // `engagement.submitted` event when one is found (so the seed
      // attributes the send-off to *who* submitted it), and fall back
      // to the dedicated `submission-ingest` system actor otherwise.
      // Note semantics for the seed entry are intentional and worth
      // calling out: it carries the submission's own `row.note`
      // (the plan-review package note recorded at submit time),
      // *not* a reviewer/status comment — those don't exist yet
      // for a brand-new submission. Subsequent status-changed
      // entries in the timeline carry their own
      // (reviewer-supplied) `note` from the response payload. The
      // FE renders both the same way; the contextual difference
      // is naturally read from each row's status label.
      const seedEntry: SubmissionStatusHistoryEntry = {
        status: "pending",
        occurredAt: row.submittedAt.toISOString(),
        actor: { kind: "system", id: "submission-ingest" },
        note: row.note,
        eventId: null,
      };
      const statusHistory: SubmissionStatusHistoryEntry[] = [seedEntry];

      if (deps.history) {
        // Read the submission's own history once and use it for both
        // (a) `latestEvent` provenance and (b) building the
        // status-changed timeline. Going through `readHistory` instead
        // of `latestEvent` lets us pull the event payloads in a single
        // round trip — `latestEvent` returns just the metadata.
        let submissionEvents: Awaited<
          ReturnType<EventAnchoringService["readHistory"]>
        > = [];
        try {
          submissionEvents = await deps.history.readHistory(
            { kind: "atom", entityType: "submission", entityId },
            { limit: 50, reverse: true },
          );
        } catch {
          // History is best-effort here — fallback already populated.
        }
        if (submissionEvents.length > 0) {
          const newest = submissionEvents[0];
          if (newest) {
            latestEventId = newest.id;
            latestEventAt = newest.occurredAt.toISOString();
          }
          // Append every `submission.status-changed` event in
          // chronological order (oldest → newest). `readHistory` returns
          // newest-first because of `reverse: true`, so we walk the
          // slice backwards to flip the order for the FE timeline.
          //
          // History is intentionally bounded at the 50-event read above
          // — the same cap the `latestEvent`-style consumers use. For
          // typical plan-review submissions a handful of status
          // transitions is the norm, so 50 is comfortably more than
          // enough; if a future product surface needs the full,
          // unbounded audit trail (e.g. compliance export), it should
          // page through `readHistory` directly rather than promote
          // this surface to unbounded reads.
          for (let i = submissionEvents.length - 1; i >= 0; i--) {
            const ev = submissionEvents[i];
            if (!ev) continue;
            if (ev.eventType !== "submission.status-changed") continue;
            const toRaw = ev.payload?.["toStatus"];
            const toStatus =
              typeof toRaw === "string" &&
              (SUBMISSION_STATUS_LABELS as Record<string, string>)[toRaw]
                ? (toRaw as SubmissionStatus)
                : null;
            if (!toStatus) continue;
            const noteRaw = ev.payload?.["note"];
            const noteValue =
              typeof noteRaw === "string" && noteRaw.length > 0
                ? noteRaw
                : null;
            statusHistory.push({
              status: toStatus,
              occurredAt: ev.occurredAt.toISOString(),
              actor: { kind: ev.actor.kind, id: ev.actor.id },
              note: noteValue,
              eventId: ev.id,
            });
          }
        }
        if (!latestEventId) {
          try {
            const engagementEvents = await deps.history.readHistory(
              {
                kind: "atom",
                entityType: "engagement",
                entityId: row.engagementId,
              },
              { limit: 50, reverse: true },
            );
            const match = engagementEvents.find(
              (e) =>
                e.eventType === "engagement.submitted" &&
                typeof e.payload?.["submissionId"] === "string" &&
                e.payload["submissionId"] === entityId,
            );
            if (match) {
              latestEventId = match.id;
              latestEventAt = match.occurredAt.toISOString();
              // Promote the matched event's actor onto the seed entry
              // so the timeline attributes the initial "Submitted"
              // step to the human / system that recorded the send-off
              // instead of the generic ingest fallback. Mutating the
              // already-pushed seed entry in place keeps a single
              // source of truth for the array order.
              seedEntry.actor = { kind: match.actor.kind, id: match.actor.id };
            }
          } catch {
            // Best-effort — fallback already populated above.
          }
        } else {
          // The submission has its own events — still try to attribute
          // the seed entry to the matching `engagement.submitted`
          // actor for a richer timeline. Failure here is silently
          // ignored: the seed entry already has the ingest fallback.
          try {
            const engagementEvents = await deps.history.readHistory(
              {
                kind: "atom",
                entityType: "engagement",
                entityId: row.engagementId,
              },
              { limit: 50, reverse: true },
            );
            const match = engagementEvents.find(
              (e) =>
                e.eventType === "engagement.submitted" &&
                typeof e.payload?.["submissionId"] === "string" &&
                e.payload["submissionId"] === entityId,
            );
            if (match) {
              seedEntry.actor = { kind: match.actor.kind, id: match.actor.id };
            }
          } catch {
            // Seed actor stays as the ingest fallback.
          }
        }
      }

      // Hydrate user-kind actors with profile metadata from the
      // `users` table (Task #130) so the FE timeline can render
      // "Jane Doe approved this submission" instead of
      // "user:u_abc123 …". Mirrors the hydration the
      // `/atoms/:slug/:id/history` endpoint applies to atom-event
      // actors. Best-effort: a transient lookup failure leaves the
      // raw actors in place — the UI's "Unknown user" fallback is
      // less informative than a real name but still correct, and we
      // never want a profile-table hiccup to 500 a summary read.
      // Agent / system actors are passed through unchanged by
      // `hydrateActors` itself, so the seed entry's
      // `submission-ingest` system fallback (or the promoted user
      // attribution copied off `engagement.submitted`) participates
      // in the same single batched lookup as the
      // `submission.status-changed` entries.
      const hydrate = deps.hydrateActors ?? defaultHydrateActors;
      try {
        const rawActors = statusHistory.map((entry) => entry.actor);
        const hydrated = await hydrate(rawActors);
        for (let i = 0; i < statusHistory.length; i++) {
          const entry = statusHistory[i];
          const next = hydrated[i];
          if (entry && next) {
            entry.actor = next;
          }
        }
      } catch {
        // Best-effort — raw actors already populated above.
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
        responseRecordedAt: row.responseRecordedAt
          ? row.responseRecordedAt.toISOString()
          : null,
        createdAt: row.createdAt.toISOString(),
        statusHistory,
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
