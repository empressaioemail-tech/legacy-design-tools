/**
 * PLR-9 — Server-Sent Events channel for per-submission live
 * updates. Backs the reviewer-cohort presence chips and the live
 * finding-stream that lets multiple reviewers watch generation /
 * accept / reject / override flow in real time.
 *
 * Wire:
 *   GET /api/submissions/:submissionId/events
 *
 * Reviewer-only (`session.audience === "internal"`). Each connection
 * gets a unique subscriber id and is registered with the in-memory
 * broker (`lib/submissionLiveEvents.ts`) which fans out:
 *
 *   - presence.joined / presence.left when reviewers connect or
 *     drop (one chip per distinct user — multiple tabs from the
 *     same reviewer collapse).
 *   - finding.added / finding.accepted / finding.rejected /
 *     finding.overridden published by the findings router after
 *     each successful mutation.
 *
 * EventSource cannot send custom headers, so reviewer identity is
 * resolved from the same `req.session.requestor` shape every other
 * route uses. In dev/test the session is populated via the
 * `pr_session` cookie or the `x-audience` / `x-requestor` override
 * headers; in production a verified-auth layer would have stamped
 * `req.session.requestor` before this handler runs (see
 * `middlewares/session.ts` for the fail-closed posture).
 *
 * Display names are looked up via the `users` table on connect.
 * Failures fall back to `displayName: null` so the FE can render
 * its own "Unknown reviewer" placeholder.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger";
import { db, submissions, users } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  subscribeToSubmission,
  type SubmissionLiveEvent,
  type SubmissionPresenceUser,
} from "../lib/submissionLiveEvents";

const router: IRouter = Router();

function requireReviewerAudience(req: Request, res: Response): boolean {
  if (req.session.audience === "internal") return false;
  res.status(403).json({ error: "submission_events_require_internal_audience" });
  return true;
}

async function loadDisplayName(userId: string): Promise<string | null> {
  try {
    const rows = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0]?.displayName ?? null;
  } catch (err) {
    logger.warn(
      { err, userId },
      "submissionEvents: user displayName lookup failed",
    );
    return null;
  }
}

/**
 * Format one event as an SSE frame. The `event:` line lets the FE
 * register handlers per-type via `EventSource.addEventListener`,
 * while `data:` carries the JSON payload.
 */
function formatSseFrame(event: SubmissionLiveEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

router.get(
  "/submissions/:submissionId/events",
  async (req: Request, res: Response): Promise<void> => {
    if (requireReviewerAudience(req, res)) return;

    const submissionIdRaw = req.params["submissionId"];
    const submissionId =
      typeof submissionIdRaw === "string" ? submissionIdRaw : "";
    if (!submissionId || submissionId.length === 0) {
      res.status(400).json({ error: "invalid_submission_id" });
      return;
    }

    const requestor = req.session.requestor;
    if (!requestor || requestor.kind !== "user" || !requestor.id) {
      res.status(400).json({ error: "missing_session_requestor" });
      return;
    }

    // Verify submission exists before opening the long-lived stream
    // so a typo'd id doesn't accumulate orphaned subscriptions.
    try {
      const subRows = await db
        .select({ id: submissions.id })
        .from(submissions)
        .where(eq(submissions.id, submissionId))
        .limit(1);
      if (subRows.length === 0) {
        res.status(404).json({ error: "submission_not_found" });
        return;
      }
    } catch (err) {
      logger.error(
        { err, submissionId },
        "submissionEvents: submission existence check failed",
      );
      res.status(500).json({ error: "Failed to open events channel" });
      return;
    }

    const displayName = await loadDisplayName(requestor.id);
    const user: SubmissionPresenceUser = {
      id: requestor.id,
      displayName,
    };

    // SSE handshake. Disable proxy buffering so frames flush
    // immediately. `flushHeaders` ships the 200 + headers before
    // any frame is written — without it some intermediaries hold
    // the response open until the first body chunk arrives, which
    // delays the FE's `onopen` event.
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // Random per-connection id so the broker can scope unsubscribe
    // to this specific tab (the same reviewer may have several open).
    const subscriberId = `sub_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 10)}`;

    const send = (event: SubmissionLiveEvent): void => {
      // Best-effort write; if the socket is half-closed, `write`
      // returns false and the close handler below will run shortly
      // and clean up.
      res.write(formatSseFrame(event));
    };

    const unsubscribe = subscribeToSubmission({
      submissionId,
      subscriberId,
      user,
      send,
    });

    // Keep-alive comment every 25s prevents idle proxies from
    // killing the connection. SSE spec ignores `:`-prefixed lines.
    const keepAlive = setInterval(() => {
      try {
        res.write(`: keep-alive ${Date.now()}\n\n`);
      } catch {
        // Write failure means the socket is gone; close handler
        // will run.
      }
    }, 25_000);

    const cleanup = (): void => {
      clearInterval(keepAlive);
      unsubscribe();
    };

    req.on("close", cleanup);
    req.on("aborted", cleanup);
    res.on("close", cleanup);
  },
);

export default router;
