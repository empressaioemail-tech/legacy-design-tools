/**
 * Architect-side in-app notification surface.
 *
 *   - `GET  /me/notifications` — newest-first list of recent
 *     submission status changes and reviewer-requests across every
 *     engagement, materialised on the fly from `atom_events`. The
 *     response carries an `unreadCount` and the architect's
 *     persisted `lastReadAt` watermark so the side-nav badge can
 *     render without a follow-up call.
 *
 *   - `POST /me/notifications/mark-read` — bumps the architect's
 *     `lastReadAt` watermark to "now". Subsequent GETs report
 *     `unreadCount: 0` until a fresh event lands.
 *
 * Source events
 * -------------
 *   - `submission.status-changed`      (entityType `submission`)
 *   - `reviewer-request.<kind>.requested` (entityType `reviewer-request`)
 *
 * `submission.response-recorded` is intentionally NOT included even
 * though it carries the reviewer's free-text comment — the same
 * UPDATE in `routes/engagements.ts` emits a companion
 * `submission.status-changed` event that already carries the comment
 * in its `note` payload, so surfacing both would double-notify the
 * architect for one reviewer reply. The status-changed event is the
 * canonical row in this surface.
 *
 * Visibility model
 * ----------------
 * The engagements table has no per-user owner column today, and the
 * sibling `GET /engagements` route returns every row to any signed-
 * in caller. This surface intentionally inherits that visibility
 * model rather than inventing a scoping rule that would diverge from
 * the canonical engagement list — the FE's deep links would be
 * useless if a reviewer-request notification pointed at an
 * engagement the same architect could not open. When/if engagement
 * ownership lands, BOTH this query and the engagements list should
 * gain the same scoping filter in lockstep.
 *
 * Read-state
 * ----------
 * Persisted via `architect_notification_reads` — a single row per
 * architect carrying a `lastReadAt` watermark. The list stamps
 * `read: occurredAt <= lastReadAt` per row and `unreadCount` is the
 * count of unread items in the returned page.
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import {
  db,
  atomEvents,
  engagements,
  submissions,
  architectNotificationReads,
} from "@workspace/db";
import { and, desc, eq, inArray, like, or } from "drizzle-orm";
import type { Logger } from "pino";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const STATUS_CHANGED_EVENT_TYPE = "submission.status-changed";

interface NotificationItemWire {
  id: string;
  kind: "submission-status-changed" | "reviewer-request-filed";
  title: string;
  body: string | null;
  occurredAt: string;
  recordedAt: string;
  read: boolean;
  engagementId: string | null;
  engagementName: string | null;
  submissionId: string | null;
  reviewerRequestId: string | null;
}

interface ListNotificationsResponse {
  items: NotificationItemWire[];
  unreadCount: number;
  lastReadAt: string | null;
}

function statusChangeTitle(payload: Record<string, unknown>): string {
  const to = String(payload["toStatus"] ?? "");
  switch (to) {
    case "approved":
      return "Submission approved";
    case "rejected":
      return "Submission rejected";
    case "corrections_requested":
      return "Corrections requested";
    default:
      return `Submission status: ${to || "updated"}`;
  }
}

function reviewerRequestTitle(eventType: string): string {
  // `reviewer-request.<kind>.requested` → human-readable kind.
  const match = eventType.match(/^reviewer-request\.([^.]+)\.requested$/);
  if (!match) return "New reviewer request";
  switch (match[1]) {
    case "refresh-briefing-source":
      return "Reviewer requested briefing-source refresh";
    case "refresh-bim-model":
      return "Reviewer requested BIM model refresh";
    case "regenerate-briefing":
      return "Reviewer requested briefing regeneration";
    default:
      return "New reviewer request";
  }
}

router.get(
  "/me/notifications",
  async (req: Request, res: Response): Promise<void> => {
    const requestor = req.session?.requestor;
    if (!requestor || requestor.kind !== "user") {
      res
        .status(401)
        .json({ error: "Notifications require a signed-in user session" });
      return;
    }
    const reqLog: Logger =
      (req as Request & { log?: Logger }).log ?? logger;

    const rawLimit = Number(req.query["limit"]);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
        : DEFAULT_LIMIT;

    try {
      const readRows = await db
        .select()
        .from(architectNotificationReads)
        .where(eq(architectNotificationReads.userId, requestor.id))
        .limit(1);
      const lastReadAt = readRows[0]?.lastReadAt ?? null;

      // Two event-type families participate; a single OR'd query is
      // cheaper than two round-trips.
      const eventRows = await db
        .select()
        .from(atomEvents)
        .where(
          or(
            and(
              eq(atomEvents.entityType, "submission"),
              eq(atomEvents.eventType, STATUS_CHANGED_EVENT_TYPE),
            ),
            and(
              eq(atomEvents.entityType, "reviewer-request"),
              like(atomEvents.eventType, "reviewer-request.%.requested"),
            ),
          ),
        )
        .orderBy(desc(atomEvents.occurredAt))
        .limit(limit);

      // Hydrate engagement labels in one pass. Submission events
      // carry the engagementId in their payload but we re-derive it
      // from the submissions row so a payload-shape change does not
      // silently break the deep link.
      const submissionIds = new Set<string>();
      const engagementIds = new Set<string>();
      for (const row of eventRows) {
        if (row.entityType === "submission") {
          submissionIds.add(row.entityId);
        } else if (row.entityType === "reviewer-request") {
          const eId = (row.payload as Record<string, unknown>)[
            "engagementId"
          ];
          if (typeof eId === "string") engagementIds.add(eId);
        }
      }

      const submissionEngagementMap = new Map<string, string>();
      if (submissionIds.size > 0) {
        const subRows = await db
          .select({ id: submissions.id, engagementId: submissions.engagementId })
          .from(submissions)
          .where(inArray(submissions.id, Array.from(submissionIds)));
        for (const r of subRows) {
          submissionEngagementMap.set(r.id, r.engagementId);
          engagementIds.add(r.engagementId);
        }
      }

      const engagementNameMap = new Map<string, string>();
      if (engagementIds.size > 0) {
        const engRows = await db
          .select({ id: engagements.id, name: engagements.name })
          .from(engagements)
          .where(inArray(engagements.id, Array.from(engagementIds)));
        for (const r of engRows) engagementNameMap.set(r.id, r.name);
      }

      const items: NotificationItemWire[] = eventRows.map((row) => {
        const occurredAt = row.occurredAt;
        const read =
          lastReadAt !== null && occurredAt.getTime() <= lastReadAt.getTime();
        const payload = row.payload as Record<string, unknown>;
        if (row.entityType === "submission") {
          const submissionId = row.entityId;
          const engagementId =
            submissionEngagementMap.get(submissionId) ??
            (typeof payload["engagementId"] === "string"
              ? (payload["engagementId"] as string)
              : null);
          return {
            id: row.id,
            kind: "submission-status-changed",
            title: statusChangeTitle(payload),
            body:
              typeof payload["note"] === "string"
                ? (payload["note"] as string)
                : null,
            occurredAt: occurredAt.toISOString(),
            recordedAt: row.recordedAt.toISOString(),
            read,
            engagementId,
            engagementName: engagementId
              ? (engagementNameMap.get(engagementId) ?? null)
              : null,
            submissionId,
            reviewerRequestId: null,
          };
        }
        const engagementId =
          typeof payload["engagementId"] === "string"
            ? (payload["engagementId"] as string)
            : null;
        return {
          id: row.id,
          kind: "reviewer-request-filed",
          title: reviewerRequestTitle(row.eventType),
          body:
            typeof payload["reason"] === "string"
              ? (payload["reason"] as string)
              : null,
          occurredAt: occurredAt.toISOString(),
          recordedAt: row.recordedAt.toISOString(),
          read,
          engagementId,
          engagementName: engagementId
            ? (engagementNameMap.get(engagementId) ?? null)
            : null,
          submissionId: null,
          reviewerRequestId: row.entityId,
        };
      });

      const unreadCount = items.reduce((acc, i) => acc + (i.read ? 0 : 1), 0);

      const response: ListNotificationsResponse = {
        items,
        unreadCount,
        lastReadAt: lastReadAt ? lastReadAt.toISOString() : null,
      };
      res.json(response);
    } catch (err) {
      reqLog.error(
        { err, userId: requestor.id },
        "list notifications failed",
      );
      res.status(500).json({ error: "Failed to list notifications" });
    }
  },
);

router.post(
  "/me/notifications/mark-read",
  async (req: Request, res: Response): Promise<void> => {
    const requestor = req.session?.requestor;
    if (!requestor || requestor.kind !== "user") {
      res
        .status(401)
        .json({ error: "Notifications require a signed-in user session" });
      return;
    }
    const reqLog: Logger =
      (req as Request & { log?: Logger }).log ?? logger;

    const now = new Date();
    try {
      // Upsert the watermark — first call inserts, subsequent calls
      // overwrite. Idempotent so a double-click on the inbox does
      // not error out.
      await db
        .insert(architectNotificationReads)
        .values({
          userId: requestor.id,
          lastReadAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: architectNotificationReads.userId,
          set: { lastReadAt: now, updatedAt: now },
        });
      res.json({ lastReadAt: now.toISOString() });
    } catch (err) {
      reqLog.error(
        { err, userId: requestor.id },
        "mark notifications read failed",
      );
      res.status(500).json({ error: "Failed to mark notifications read" });
    }
  },
);

export default router;
