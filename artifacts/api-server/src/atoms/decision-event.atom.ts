/**
 * The `decision-event` atom registration — PLR-6 / Task #460.
 *
 * A *decision-event* is an immutable, reviewer-authored verdict
 * recorded against a single plan-review submission via the
 * `POST /submissions/:submissionId/decisions` route. The verdict is
 * one of `approve`, `approve_with_conditions`, or `return_for_revision`
 * (the three Decide-button options on the submission detail header).
 *
 * Storage: decision-events live as rows in the `atom_events` table
 * keyed by `(entity_type='decision-event', entity_id=<row uuid>)`, and
 * the recording event-type is `decision-event.recorded`. There is no
 * separate `decisions` table — locked decision #5 ("rows are source of
 * truth, events are observability") still holds: the *submission*
 * row's `status` column is the source of truth for the submission's
 * current state, and the decision-event chain is the audit trail of
 * the verdicts that drove it.
 *
 * Composition: a decision-event always belongs to exactly one
 * submission (concrete edge, dataKey `submission`). The route layer
 * additionally updates the parent submission's `status` /
 * `reviewerComment` columns and emits a companion
 * `submission.status-changed` event whenever the verdict changes the
 * submission's status — that companion lives on the submission's own
 * event chain via `emitSubmissionStatusChangedEvent`.
 */

import { and, eq } from "drizzle-orm";
import { atomEvents, decisionPdfArtifacts } from "@workspace/db";
import type {
  AtomReference,
  AtomRegistration,
  ContextSummary,
  EventAnchoringService,
  KeyMetric,
} from "@workspace/empressa-atom";
import type { db as ProdDb } from "@workspace/db";

/** Hard cap on the prose summary length so we don't blow up token budget. */
export const DECISION_EVENT_PROSE_MAX_CHARS = 400;

/** Modes future render bindings will implement for `decision-event`. */
export const DECISION_EVENT_SUPPORTED_MODES = [
  "inline",
  "compact",
  "card",
  "expanded",
] as const;

export type DecisionEventSupportedModes =
  typeof DECISION_EVENT_SUPPORTED_MODES;

/**
 * Single source of truth for the verdict tuple. The route's request-
 * body schema in OpenAPI mirrors this list verbatim; the FE's three
 * Decide-button options also bind to these constants.
 */
export const DECISION_VERDICT_VALUES = [
  "approve",
  "approve_with_conditions",
  "return_for_revision",
] as const;

export type DecisionVerdict = (typeof DECISION_VERDICT_VALUES)[number];

export const DECISION_VERDICT_LABELS: Record<DecisionVerdict, string> = {
  approve: "Approve",
  approve_with_conditions: "Approve with conditions",
  return_for_revision: "Return for revision",
};

/**
 * Single source of truth for the decision-event vocabulary. Today
 * only the recording event exists; future producers (e.g. an
 * "amend" verb that does not change the submission status) would
 * land additional entries here.
 */
export const DECISION_EVENT_EVENT_TYPES = [
  "decision-event.recorded",
] as const;

export type DecisionEventEventType =
  (typeof DECISION_EVENT_EVENT_TYPES)[number];

/**
 * Wire shape the decisions route returns from POST + the items
 * returned from GET. Mirrors the FE's `Decision` schema generated
 * from OpenAPI so consumers don't have to translate at the seam.
 */
export interface DecisionWire {
  id: string;
  submissionId: string;
  verdict: DecisionVerdict;
  comment: string | null;
  recordedAt: string;
  recordedBy: { kind: "user" | "agent" | "system"; id: string };
  /**
   * `/objects/<uuid>` of the city-seal-stamped issued plan-set PDF
   * rendered with this verdict (PLR-11). Null on non-approval
   * verdicts and on render/upload failure — the FE gates the
   * "Download stamped PDF" link on this being non-null.
   */
  pdfArtifactRef: string | null;
  /** Tenant-scoped permit number stamped on the issued PDF (or null). */
  permitNumber: string | null;
}

export interface DecisionEventTypedPayload {
  id: string;
  found: boolean;
  submissionId?: string;
  verdict?: DecisionVerdict;
  comment?: string | null;
  recordedAt?: string;
  recordedBy?: { kind: "user" | "agent" | "system"; id: string };
  /** PLR-11 — derived from `decision_pdf_artifacts`; null until rendered. */
  pdfArtifactRef?: string | null;
  permitNumber?: string | null;
  approverName?: string | null;
}

export interface DecisionEventAtomDeps {
  db: typeof ProdDb;
  history?: EventAnchoringService;
}

/**
 * Build the decision-event atom registration. Factory style so tests
 * can swap in a per-schema `db`.
 */
export function makeDecisionEventAtom(
  deps: DecisionEventAtomDeps,
): AtomRegistration<"decision-event", DecisionEventSupportedModes> {
  return {
    entityType: "decision-event",
    domain: "plan-review",
    supportedModes: DECISION_EVENT_SUPPORTED_MODES,
    defaultMode: "compact",
    composition: [
      {
        childEntityType: "submission",
        childMode: "compact",
        dataKey: "submission",
      },
    ],
    eventTypes: DECISION_EVENT_EVENT_TYPES,
    async contextSummary(
      entityId: string,
      _scope,
    ): Promise<ContextSummary<"decision-event">> {
      // The decision-event row is the `atom_events` row whose
      // `(entity_type, entity_id)` is `('decision-event', entityId)`
      // and whose `event_type` is `decision-event.recorded`. There is
      // exactly one such row per decision (the chain is append-only
      // but a decision is one atomic write).
      const rows = await deps.db
        .select({
          id: atomEvents.id,
          entityId: atomEvents.entityId,
          actor: atomEvents.actor,
          payload: atomEvents.payload,
          occurredAt: atomEvents.occurredAt,
        })
        .from(atomEvents)
        .where(
          and(
            eq(atomEvents.entityType, "decision-event"),
            eq(atomEvents.entityId, entityId),
            eq(atomEvents.eventType, "decision-event.recorded"),
          ),
        )
        .limit(1);
      const row = rows[0];

      if (!row) {
        return {
          prose: `Decision-event ${entityId} could not be found.`,
          typed: {
            id: entityId,
            found: false,
          } satisfies DecisionEventTypedPayload as unknown as Record<
            string,
            unknown
          >,
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: {
            latestEventId: "",
            latestEventAt: new Date(0).toISOString(),
          },
          scopeFiltered: false,
        };
      }

      const payload = row.payload as Record<string, unknown>;
      const submissionId =
        typeof payload["submissionId"] === "string"
          ? (payload["submissionId"] as string)
          : "";
      const verdictRaw = payload["verdict"];
      const verdict: DecisionVerdict = (
        DECISION_VERDICT_VALUES as readonly string[]
      ).includes(verdictRaw as string)
        ? (verdictRaw as DecisionVerdict)
        : "approve";
      const commentRaw = payload["comment"];
      const comment =
        typeof commentRaw === "string" && commentRaw.length > 0
          ? commentRaw
          : null;
      const actor = row.actor as { kind: string; id: string };

      const verdictLabel = DECISION_VERDICT_LABELS[verdict];
      const commentFragment = comment ? ` Note: ${comment}` : "";
      const proseRaw =
        `Decision recorded for submission ${submissionId}: ` +
        `${verdictLabel} on ${row.occurredAt.toISOString()} by ` +
        `${actor.kind}:${actor.id}.${commentFragment}`;
      const prose =
        proseRaw.length > DECISION_EVENT_PROSE_MAX_CHARS
          ? proseRaw.slice(0, DECISION_EVENT_PROSE_MAX_CHARS - 1) + "…"
          : proseRaw;

      const keyMetrics: KeyMetric[] = [
        { label: "Verdict", value: verdictLabel },
        { label: "Recorded at", value: row.occurredAt.toISOString() },
      ];

      const relatedAtoms: AtomReference[] = submissionId
        ? [
            {
              kind: "atom",
              entityType: "submission",
              entityId: submissionId,
              mode: "compact",
            },
          ]
        : [];

      const artifactRows = await deps.db
        .select({
          pdfArtifactRef: decisionPdfArtifacts.pdfArtifactRef,
          permitNumber: decisionPdfArtifacts.permitNumber,
          approverName: decisionPdfArtifacts.approverName,
        })
        .from(decisionPdfArtifacts)
        .where(eq(decisionPdfArtifacts.decisionId, entityId))
        .limit(1);
      const artifact = artifactRows[0];

      const typed: DecisionEventTypedPayload = {
        id: row.entityId,
        found: true,
        submissionId,
        verdict,
        comment,
        recordedAt: row.occurredAt.toISOString(),
        recordedBy: {
          kind: actor.kind as "user" | "agent" | "system",
          id: actor.id,
        },
        pdfArtifactRef: artifact?.pdfArtifactRef ?? null,
        permitNumber: artifact?.permitNumber ?? null,
        approverName: artifact?.approverName ?? null,
      };

      return {
        prose,
        typed: typed as unknown as Record<string, unknown>,
        keyMetrics,
        relatedAtoms,
        historyProvenance: {
          latestEventId: row.id,
          latestEventAt: row.occurredAt.toISOString(),
        },
        scopeFiltered: false,
      };
    },
  };
}
