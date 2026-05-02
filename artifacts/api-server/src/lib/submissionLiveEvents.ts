/**
 * PLR-9 — In-memory pub/sub broker for per-submission live events.
 *
 * Backs the SSE channel at `GET /api/submissions/:submissionId/events`.
 * Two responsibilities:
 *
 *   1. Fan out finding mutation events (`finding.added`,
 *      `finding.accepted`, `finding.rejected`, `finding.overridden`)
 *      from any route handler to every currently-connected SSE
 *      subscriber for the same submission.
 *   2. Track presence — which reviewers currently have an open SSE
 *      connection for the submission — and emit `presence.joined` /
 *      `presence.left` events as connections come and go.
 *
 * Presence eviction is connection-driven: when the SSE response
 * stream closes (tab close, network drop), the broker drops the
 * subscriber and emits `presence.left` to the remaining peers. No
 * separate heartbeat is required — the EventSource connection itself
 * is the heartbeat.
 *
 * Single-process scope. A multi-instance deploy would need to back
 * this with Redis pubsub or similar; today the api-server runs as a
 * single replica behind the shared proxy so the in-memory map is
 * sufficient.
 */

export type SubmissionFindingEventType =
  | "finding.added"
  | "finding.accepted"
  | "finding.rejected"
  | "finding.overridden";

export type SubmissionPresenceEventType =
  | "presence.joined"
  | "presence.left";

export interface SubmissionPresenceUser {
  id: string;
  displayName: string | null;
}

export type SubmissionLiveEvent =
  | {
      type: SubmissionFindingEventType;
      submissionId: string;
      occurredAt: string;
      payload: Record<string, unknown>;
    }
  | {
      type: SubmissionPresenceEventType;
      submissionId: string;
      occurredAt: string;
      user: SubmissionPresenceUser;
      presence: SubmissionPresenceUser[];
    };

interface Subscriber {
  subscriberId: string;
  user: SubmissionPresenceUser;
  send: (event: SubmissionLiveEvent) => void;
}

const channels = new Map<string, Map<string, Subscriber>>();

function getChannel(submissionId: string): Map<string, Subscriber> {
  let chan = channels.get(submissionId);
  if (!chan) {
    chan = new Map();
    channels.set(submissionId, chan);
  }
  return chan;
}

/**
 * Snapshot of the current presence list for a submission. Returns
 * one entry per distinct reviewer user id (multiple tabs from the
 * same reviewer collapse into one chip — presence is per-user, not
 * per-connection).
 */
export function getSubmissionPresence(
  submissionId: string,
): SubmissionPresenceUser[] {
  const chan = channels.get(submissionId);
  if (!chan) return [];
  const byUser = new Map<string, SubmissionPresenceUser>();
  for (const sub of chan.values()) {
    if (!byUser.has(sub.user.id)) byUser.set(sub.user.id, sub.user);
  }
  return Array.from(byUser.values());
}

/**
 * Subscribe to a submission's live event stream. Returns an
 * `unsubscribe` callable that the caller MUST invoke on connection
 * close so the broker can drop the subscriber and emit
 * `presence.left` to the remaining peers.
 *
 * The newly-joined subscriber receives an immediate
 * `presence.joined` event with the full current presence snapshot
 * (including itself), so a single-reviewer scenario still produces
 * a render-able payload on first connect. Existing subscribers
 * receive a `presence.joined` when this is the FIRST connection
 * from `user.id` (a second tab from the same reviewer is silent).
 */
export function subscribeToSubmission(args: {
  submissionId: string;
  subscriberId: string;
  user: SubmissionPresenceUser;
  send: (event: SubmissionLiveEvent) => void;
}): () => void {
  const { submissionId, subscriberId, user, send } = args;
  const chan = getChannel(submissionId);

  const wasNewUser = !Array.from(chan.values()).some(
    (s) => s.user.id === user.id,
  );

  chan.set(subscriberId, { subscriberId, user, send });

  const presenceNow = getSubmissionPresence(submissionId);
  const joinedAt = new Date().toISOString();

  // Always send the snapshot to the new subscriber so the FE has a
  // hydrated presence list on first frame.
  try {
    send({
      type: "presence.joined",
      submissionId,
      occurredAt: joinedAt,
      user,
      presence: presenceNow,
    });
  } catch {
    // Send failures during initial frame are non-fatal — the
    // connection's close handler will run shortly and clean up.
  }

  // Tell existing peers only when this is a brand-new user (a
  // second tab from the same reviewer should not flicker the chip).
  if (wasNewUser) {
    for (const sub of chan.values()) {
      if (sub.subscriberId === subscriberId) continue;
      try {
        sub.send({
          type: "presence.joined",
          submissionId,
          occurredAt: joinedAt,
          user,
          presence: presenceNow,
        });
      } catch {
        // Drop on send failure — the offending subscriber's close
        // handler will run; we don't try to be clever here.
      }
    }
  }

  return function unsubscribe() {
    const c = channels.get(submissionId);
    if (!c) return;
    const removed = c.delete(subscriberId);
    if (!removed) return;

    const userStillPresent = Array.from(c.values()).some(
      (s) => s.user.id === user.id,
    );
    if (c.size === 0) channels.delete(submissionId);

    if (!userStillPresent) {
      const presenceAfter = getSubmissionPresence(submissionId);
      const leftAt = new Date().toISOString();
      for (const sub of c.values()) {
        try {
          sub.send({
            type: "presence.left",
            submissionId,
            occurredAt: leftAt,
            user,
            presence: presenceAfter,
          });
        } catch {
          // ignore
        }
      }
    }
  };
}

/**
 * Fan a finding-mutation event out to every subscriber currently
 * attached to the submission. Best-effort: a failing `send` for one
 * subscriber does not affect delivery to peers.
 */
export function publishSubmissionFindingEvent(args: {
  submissionId: string;
  type: SubmissionFindingEventType;
  payload: Record<string, unknown>;
}): void {
  const chan = channels.get(args.submissionId);
  if (!chan || chan.size === 0) return;
  const event: SubmissionLiveEvent = {
    type: args.type,
    submissionId: args.submissionId,
    occurredAt: new Date().toISOString(),
    payload: args.payload,
  };
  for (const sub of chan.values()) {
    try {
      sub.send(event);
    } catch {
      // ignore — subscriber's close handler will clean up
    }
  }
}

/** Test-only: drop every channel. Not exported through any barrel. */
export function __resetSubmissionLiveEventsForTests(): void {
  channels.clear();
}
