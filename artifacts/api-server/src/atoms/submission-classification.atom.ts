/**
 * The `submission-classification` atom registration — Track 1.
 *
 * A *submission-classification* is the project-type / disciplines /
 * applicable-code-books triple emitted by the auto-classifier on
 * `submission.created` (and overwritten by reviewer correction via the
 * reclassify route). One-to-one with submissions — the row's PK is the
 * submission id.
 *
 * Identity convention: the registry's `entityId` is the prefixed string
 * `classification:{submissionId}`, mirroring the
 * `finding:{submissionId}:{rowUuid}` grammar from `finding.atom.ts`.
 * The row's PK is just the submission UUID — the prefix exists so chat
 * inline-references and FE deep-links don't collide with raw submission
 * ids.
 *
 * Composition:
 *   - `submission` (1, dataKey: submission, concrete) — the parent
 *     submission. submission registers earlier in registry.ts so this
 *     edge is concrete (not forwardRef).
 *
 * Event vocabulary:
 *   - `submission-classification.set` — atom-level "row was written"
 *     event, anchored against the classification entity. Emitted on both
 *     auto-classifier and reclassify writes so the atom's own history
 *     surface stays self-contained.
 *
 * The route-layer-emitted `submission.classified` and
 * `submission.reclassified` events live on the SUBMISSION entity chain
 * (see `submission.atom.ts`'s `SUBMISSION_EVENT_TYPES`) so they appear
 * on the existing per-submission timeline alongside
 * `submission.status-changed`. The split is deliberate — atom-level
 * audit trail vs. submission-timeline UX.
 */

import { eq } from "drizzle-orm";
import {
  submissionClassifications,
  type SubmissionClassification,
} from "@workspace/db";
import type {
  AtomRegistration,
  ContextSummary,
  EventAnchoringService,
  KeyMetric,
} from "@workspace/empressa-atom";
import type { db as ProdDb } from "@workspace/db";

/** Hard cap on the prose summary. */
export const SUBMISSION_CLASSIFICATION_PROSE_MAX_CHARS = 400;

export const SUBMISSION_CLASSIFICATION_SUPPORTED_MODES = [
  "inline",
  "compact",
  "card",
  "expanded",
] as const;

export type SubmissionClassificationSupportedModes =
  typeof SUBMISSION_CLASSIFICATION_SUPPORTED_MODES;

export const SUBMISSION_CLASSIFICATION_EVENT_TYPES = [
  "submission-classification.set",
] as const;

export type SubmissionClassificationEventType =
  (typeof SUBMISSION_CLASSIFICATION_EVENT_TYPES)[number];

/** Prefixed entityId grammar — see file header. */
export function classificationAtomId(submissionId: string): string {
  return `classification:${submissionId}`;
}

/** Inverse: parse `classification:{uuid}` → uuid. Returns null on miss. */
export function submissionIdFromClassificationAtomId(
  atomId: string,
): string | null {
  const prefix = "classification:";
  if (!atomId.startsWith(prefix)) return null;
  const rest = atomId.slice(prefix.length);
  if (!rest) return null;
  return rest;
}

export interface SubmissionClassificationTypedPayload {
  id: string;
  found: boolean;
  submissionId?: string;
  projectType?: string | null;
  disciplines?: string[];
  applicableCodeBooks?: string[];
  confidence?: number | null;
  source?: "auto" | "reviewer";
  classifiedAt?: string;
  classifiedBy?: { kind: string; id: string } | null;
}

export interface SubmissionClassificationAtomDeps {
  db: typeof ProdDb;
  history?: EventAnchoringService;
}

export function makeSubmissionClassificationAtom(
  deps: SubmissionClassificationAtomDeps,
): AtomRegistration<
  "submission-classification",
  SubmissionClassificationSupportedModes
> {
  return {
    entityType: "submission-classification",
    domain: "plan-review",
    supportedModes: SUBMISSION_CLASSIFICATION_SUPPORTED_MODES,
    defaultMode: "compact",
    composition: [
      {
        childEntityType: "submission",
        childMode: "compact",
        dataKey: "submission",
      },
    ],
    eventTypes: SUBMISSION_CLASSIFICATION_EVENT_TYPES,
    async contextSummary(
      entityId: string,
      _scope,
    ): Promise<ContextSummary<"submission-classification">> {
      let latestEventId = "";
      let latestEventAt = new Date(0).toISOString();
      if (deps.history) {
        try {
          const latest = await deps.history.latestEvent({
            kind: "atom",
            entityType: "submission-classification",
            entityId,
          });
          if (latest) {
            latestEventId = latest.id;
            latestEventAt = latest.occurredAt.toISOString();
          }
        } catch {
          // History is best-effort — fall through.
        }
      }

      const submissionId = submissionIdFromClassificationAtomId(entityId);
      if (!submissionId) {
        return {
          prose: `Classification ${entityId} could not be parsed — atom id grammar is "classification:{submissionId}".`,
          typed: {
            id: entityId,
            found: false,
          } satisfies SubmissionClassificationTypedPayload as unknown as Record<
            string,
            unknown
          >,
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: { latestEventId, latestEventAt },
          scopeFiltered: false,
        };
      }

      let row: SubmissionClassification | undefined;
      try {
        const found = await deps.db
          .select()
          .from(submissionClassifications)
          .where(eq(submissionClassifications.submissionId, submissionId))
          .limit(1);
        row = found[0];
      } catch {
        // Fall through to not-found.
      }

      if (!row) {
        return {
          prose: `Submission ${submissionId} has not been classified yet.`,
          typed: {
            id: entityId,
            found: false,
            submissionId,
          } satisfies SubmissionClassificationTypedPayload as unknown as Record<
            string,
            unknown
          >,
          keyMetrics: [],
          relatedAtoms: [
            {
              kind: "atom",
              entityType: "submission",
              entityId: submissionId,
            },
          ],
          historyProvenance: { latestEventId, latestEventAt },
          scopeFiltered: false,
        };
      }

      const disciplinesLabel =
        row.disciplines.length > 0 ? row.disciplines.join(", ") : "none";
      const codesLabel =
        row.applicableCodeBooks.length > 0
          ? row.applicableCodeBooks.join(", ")
          : "none";
      const proseRaw =
        `${row.source === "reviewer" ? "Reviewer-corrected" : "Auto-classified"} ` +
        `as ${row.projectType ?? "unspecified project type"}. ` +
        `Disciplines: ${disciplinesLabel}. Codes: ${codesLabel}.`;
      const prose =
        proseRaw.length > SUBMISSION_CLASSIFICATION_PROSE_MAX_CHARS
          ? proseRaw.slice(
              0,
              SUBMISSION_CLASSIFICATION_PROSE_MAX_CHARS - 1,
            ) + "…"
          : proseRaw;

      const keyMetrics: KeyMetric[] = [
        { label: "Project type", value: row.projectType ?? "—" },
        { label: "Disciplines", value: disciplinesLabel },
        { label: "Codes", value: codesLabel },
        { label: "Source", value: row.source },
      ];
      if (row.confidence != null) {
        keyMetrics.push({
          label: "Confidence",
          value: Number(row.confidence).toFixed(2),
        });
      }

      const classifiedBy =
        row.classifiedBy && typeof row.classifiedBy === "object"
          ? (row.classifiedBy as { kind: string; id: string })
          : null;

      const typed: SubmissionClassificationTypedPayload = {
        id: entityId,
        found: true,
        submissionId: row.submissionId,
        projectType: row.projectType,
        disciplines: row.disciplines,
        applicableCodeBooks: row.applicableCodeBooks,
        confidence: row.confidence == null ? null : Number(row.confidence),
        source: row.source as "auto" | "reviewer",
        classifiedAt: row.classifiedAt.toISOString(),
        classifiedBy,
      };

      // Fall back to the row's classifiedAt when no atom-event has been
      // recorded yet (e.g. tests that bypass the route layer).
      if (!latestEventId) {
        latestEventAt = row.classifiedAt.toISOString();
      }

      return {
        prose,
        typed: typed as unknown as Record<string, unknown>,
        keyMetrics,
        relatedAtoms: [
          {
            kind: "atom",
            entityType: "submission",
            entityId: row.submissionId,
          },
        ],
        historyProvenance: { latestEventId, latestEventAt },
        scopeFiltered: false,
      };
    },
  };
}
