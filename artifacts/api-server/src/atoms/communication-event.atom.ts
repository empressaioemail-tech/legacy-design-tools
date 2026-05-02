/**
 * The `communication-event` atom registration — PLR-5.
 *
 * One row in `submission_communications` representing an AI-drafted
 * comment letter the reviewer sent from the Communicate composer.
 * Identity is the row's `atom_id` text column carrying the prefixed
 * grammar `communication-event:{submissionId}:{rowUuid}` so URL
 * deep-links can derive the parent submission without a server
 * round-trip (mirrors `finding.atom.ts`).
 *
 * Composition: the only declared child edge is the parent
 * `submission`. The findings the letter cited are kept on the row's
 * `findingAtomIds` snapshot column for audit purposes — they are
 * NOT modeled as composition edges so a later override / deletion of
 * a cited finding does not retroactively invalidate the letter.
 *
 * Event types:
 *   - `communication-event.sent` — appended exactly once at insert
 *     time. The route layer in `routes/communications.ts` is the
 *     only producer.
 */

import { eq } from "drizzle-orm";
import {
  submissionCommunications,
  type SubmissionCommunication,
} from "@workspace/db";
import {
  type AtomComposition,
  type AtomRegistration,
  type ContextSummary,
  type EventAnchoringService,
  type KeyMetric,
} from "@workspace/empressa-atom";
import type { db as ProdDb } from "@workspace/db";

export const COMMUNICATION_EVENT_PROSE_MAX_CHARS = 600;

export const COMMUNICATION_EVENT_SUPPORTED_MODES = [
  "inline",
  "compact",
  "card",
  "expanded",
  "focus",
] as const;

export type CommunicationEventSupportedModes =
  typeof COMMUNICATION_EVENT_SUPPORTED_MODES;

export const COMMUNICATION_EVENT_TYPES = [
  "communication-event.sent",
] as const;

export type CommunicationEventType = (typeof COMMUNICATION_EVENT_TYPES)[number];

export interface CommunicationEventTypedPayload {
  id: string;
  found: boolean;
  submissionId?: string;
  subject?: string;
  recipientCount?: number;
  findingCount?: number;
  sentAt?: string;
}

export interface CommunicationEventAtomDeps {
  db: typeof ProdDb;
  history?: EventAnchoringService;
}

export function makeCommunicationEventAtom(
  deps: CommunicationEventAtomDeps,
): AtomRegistration<
  "communication-event",
  CommunicationEventSupportedModes
> {
  const composition: ReadonlyArray<AtomComposition> = [
    {
      childEntityType: "submission",
      childMode: "compact",
      dataKey: "submission",
    },
  ];

  return {
    entityType: "communication-event",
    domain: "plan-review",
    supportedModes: COMMUNICATION_EVENT_SUPPORTED_MODES,
    defaultMode: "card",
    composition,
    eventTypes: COMMUNICATION_EVENT_TYPES,
    async contextSummary(
      entityId: string,
    ): Promise<ContextSummary<"communication-event">> {
      let latestEventId = "";
      let latestEventAt = new Date(0).toISOString();
      if (deps.history) {
        try {
          const latest = await deps.history.latestEvent({
            kind: "atom",
            entityType: "communication-event",
            entityId,
          });
          if (latest) {
            latestEventId = latest.id;
            latestEventAt = latest.occurredAt.toISOString();
          }
        } catch {
          // History best-effort.
        }
      }

      let row: SubmissionCommunication | undefined;
      try {
        const found = await deps.db
          .select()
          .from(submissionCommunications)
          .where(eq(submissionCommunications.atomId, entityId))
          .limit(1);
        row = found[0];
      } catch {
        // Fall through to not-found.
      }

      if (!row) {
        const proseRaw = `Communication event ${entityId} could not be found.`;
        const prose =
          proseRaw.length > COMMUNICATION_EVENT_PROSE_MAX_CHARS
            ? proseRaw.slice(0, COMMUNICATION_EVENT_PROSE_MAX_CHARS - 1) + "…"
            : proseRaw;
        return {
          prose,
          typed: {
            id: entityId,
            found: false,
          } satisfies CommunicationEventTypedPayload as unknown as Record<
            string,
            unknown
          >,
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: { latestEventId, latestEventAt },
          scopeFiltered: false,
        };
      }

      const recipientIds = Array.isArray(row.recipientUserIds)
        ? (row.recipientUserIds as unknown[])
        : [];
      const findingIds = Array.isArray(row.findingAtomIds)
        ? (row.findingAtomIds as unknown[])
        : [];

      const proseRaw =
        `Comment letter sent on ${row.sentAt.toISOString()} for submission ${row.submissionId}: ${row.subject}`.trim();
      const prose =
        proseRaw.length > COMMUNICATION_EVENT_PROSE_MAX_CHARS
          ? proseRaw.slice(0, COMMUNICATION_EVENT_PROSE_MAX_CHARS - 1) + "…"
          : proseRaw;

      const keyMetrics: KeyMetric[] = [
        { label: "Recipients", value: String(recipientIds.length) },
        { label: "Findings cited", value: String(findingIds.length) },
        { label: "Sent at", value: row.sentAt.toISOString() },
      ];

      const typed: CommunicationEventTypedPayload = {
        id: row.atomId,
        found: true,
        submissionId: row.submissionId,
        subject: row.subject,
        recipientCount: recipientIds.length,
        findingCount: findingIds.length,
        sentAt: row.sentAt.toISOString(),
      };

      if (!latestEventId) {
        latestEventAt = row.sentAt.toISOString();
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
}
