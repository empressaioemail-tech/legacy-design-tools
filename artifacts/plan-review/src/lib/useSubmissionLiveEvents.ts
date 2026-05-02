/**
 * PLR-9 — React hook that subscribes to the per-submission SSE
 * channel exposed by `GET /api/submissions/:id/events` and:
 *
 *   1. Tracks presence (which reviewers currently have the modal
 *      open) so `<PresenceChips />` can render the cohort.
 *   2. Invalidates the findings list query on every
 *      `finding.added` / `finding.accepted` / `finding.rejected` /
 *      `finding.overridden` event so the row list refetches without
 *      a manual reload.
 *
 * Only opens the stream when `enabled` is true — callers gate on
 * audience (reviewer-only) and on the modal being open. Reconnects
 * are handled by EventSource's built-in retry; on disconnect we
 * surface `connected: false` so the chips can grey out.
 */

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listSubmissionFindingsKey } from "./findingsApi";
import { getListSubmissionFindingsQueryKey } from "@workspace/api-client-react";

export interface PresenceUser {
  id: string;
  displayName: string | null;
}

export type SubmissionFindingEventType =
  | "finding.added"
  | "finding.accepted"
  | "finding.rejected"
  | "finding.overridden";

export type SubmissionPresenceEventType =
  | "presence.joined"
  | "presence.left";

export interface UseSubmissionLiveEventsResult {
  /** Distinct reviewers currently subscribed to the same submission. */
  presence: PresenceUser[];
  /** True iff the EventSource is open. False while reconnecting. */
  connected: boolean;
}

/**
 * Resolve the SSE URL relative to the artifact's BASE_URL so the
 * shared proxy routes the request to the api-server.
 */
function buildEventsUrl(submissionId: string): string {
  const base = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
  return `${base}/api/submissions/${encodeURIComponent(submissionId)}/events`;
}

interface PresenceFrame {
  type: SubmissionPresenceEventType;
  user: PresenceUser;
  presence: PresenceUser[];
}

interface FindingFrame {
  type: SubmissionFindingEventType;
}

export function useSubmissionLiveEvents(
  submissionId: string | null,
  enabled: boolean,
): UseSubmissionLiveEventsResult {
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [connected, setConnected] = useState(false);
  const qc = useQueryClient();
  // Keep the latest invalidate callback in a ref so the effect's
  // dependency array stays minimal — re-running the effect on every
  // re-render would tear down and re-open the EventSource.
  const invalidateRef = useRef<() => void>(() => {});
  invalidateRef.current = () => {
    if (!submissionId) return;
    // Invalidate BOTH key shapes: the legacy mock key still backs
    // the list hook today, and the generated Orval key is what the
    // post-swap hook will read. Hitting both is a no-op for the
    // shape that isn't currently in use.
    qc.invalidateQueries({ queryKey: listSubmissionFindingsKey(submissionId) });
    qc.invalidateQueries({
      queryKey: getListSubmissionFindingsQueryKey(submissionId),
    });
  };

  useEffect(() => {
    if (!enabled || !submissionId) {
      setPresence([]);
      setConnected(false);
      return;
    }

    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      // SSR / jsdom-without-eventsource. Hook becomes a no-op.
      return;
    }

    const url = buildEventsUrl(submissionId);
    const es = new EventSource(url, { withCredentials: true });

    const onOpen = () => setConnected(true);
    const onError = () => setConnected(false);

    const onPresence = (raw: MessageEvent) => {
      try {
        const frame = JSON.parse(raw.data) as PresenceFrame;
        if (Array.isArray(frame.presence)) {
          setPresence(frame.presence);
        }
      } catch {
        // ignore malformed frame
      }
    };

    const onFinding = (_raw: MessageEvent) => {
      invalidateRef.current();
    };

    es.addEventListener("open", onOpen);
    es.addEventListener("error", onError);
    es.addEventListener("presence.joined", onPresence as EventListener);
    es.addEventListener("presence.left", onPresence as EventListener);
    es.addEventListener("finding.added", onFinding as EventListener);
    es.addEventListener("finding.accepted", onFinding as EventListener);
    es.addEventListener("finding.rejected", onFinding as EventListener);
    es.addEventListener("finding.overridden", onFinding as EventListener);

    return () => {
      es.removeEventListener("open", onOpen);
      es.removeEventListener("error", onError);
      es.removeEventListener("presence.joined", onPresence as EventListener);
      es.removeEventListener("presence.left", onPresence as EventListener);
      es.removeEventListener("finding.added", onFinding as EventListener);
      es.removeEventListener("finding.accepted", onFinding as EventListener);
      es.removeEventListener("finding.rejected", onFinding as EventListener);
      es.removeEventListener("finding.overridden", onFinding as EventListener);
      es.close();
      setPresence([]);
      setConnected(false);
    };
  }, [enabled, submissionId]);

  return { presence, connected };
}
