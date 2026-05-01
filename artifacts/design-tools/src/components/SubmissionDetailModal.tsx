import { useMemo } from "react";
import {
  getGetAtomHistoryQueryKey,
  getGetAtomSummaryQueryKey,
  useGetAtomHistory,
  useGetAtomSummary,
  type AtomEventActor,
  type AtomHistoryEvent,
  type AtomSummary,
} from "@workspace/api-client-react";
import { relativeTime } from "../lib/relativeTime";
import { backfillAnnotation } from "../lib/submissionBackfill";

export interface SubmissionDetailModalProps {
  /**
   * Submission to detail. When `null` the modal renders nothing —
   * the parent owns selection state, so closing the modal is simply
   * `onClose()` setting this back to `null`.
   */
  submissionId: string | null;
  /**
   * Engagement that owns the submission. Drives the secondary
   * `useGetAtomHistory("engagement", …)` lookup so we can hydrate the
   * matching `engagement.submitted` event with its actor (the atom
   * summary's `historyProvenance` only carries the event id and
   * timestamp, not the actor — that hydration lives on the engagement's
   * history endpoint).
   */
  engagementId: string;
  onClose: () => void;
}

/**
 * Per-submission detail modal opened from the engagement's
 * Submissions tab (Task #84). Reuses the existing `submission` atom
 * registration as the single source of truth for the rendered
 * content: the modal calls `useGetAtomSummary("submission", id)` and
 * derives every field shown — full note, jurisdiction snapshot
 * (city/state/FIPS), submitted-at timestamp, and the related
 * `engagement.submitted` event id/occurredAt — from the four-layer
 * `ContextSummary` returned by that endpoint.
 *
 * The "related event" panel is the inline-view requirement of Task
 * #84: the submission atom's `historyProvenance` now points at the
 * `engagement.submitted` audit row that corresponds to this
 * submission (see `submission.atom.ts`). To avoid leaking only an
 * opaque event id into the UI we additionally fetch the parent
 * engagement's recent atom history and look the event up by id —
 * that fetch is what gives us the actor (display name / avatar) the
 * timeline UIs already expect to render.
 *
 * Modal chrome mirrors `SubmitToJurisdictionDialog`: a fixed-position
 * backdrop, click-outside-to-close, escape-key-to-close, and a
 * single sc-card body. We deliberately don't reach for the shadcn
 * `Dialog` here because the rest of design-tools' modals all use the
 * inline pattern and consistency with `SubmitToJurisdictionDialog`
 * (the modal a reviewer just used to record the submission) makes
 * the visual transition between the two surfaces feel of-a-piece.
 */
export function SubmissionDetailModal(props: SubmissionDetailModalProps) {
  const { submissionId, engagementId, onClose } = props;
  const isOpen = submissionId !== null;

  // Always call hooks in the same order — gate the actual fetch with
  // `enabled` rather than a conditional hook call.
  const summaryQuery = useGetAtomSummary(
    "submission",
    submissionId ?? "",
    undefined,
    {
      query: {
        enabled: isOpen,
        queryKey: getGetAtomSummaryQueryKey("submission", submissionId ?? ""),
        staleTime: 30_000,
      },
    },
  );

  // Fetch a small window of the engagement's recent history so we can
  // hydrate the matching event with its actor. The summary's
  // `historyProvenance.latestEventId` is the join key. We cap at 50
  // (the same hard cap the public history endpoint enforces) so a
  // long-lived engagement with lots of audit rows still finds the
  // submission's event without a separate per-event lookup.
  const historyQuery = useGetAtomHistory(
    "engagement",
    engagementId,
    { limit: 50 },
    {
      query: {
        enabled: isOpen,
        queryKey: getGetAtomHistoryQueryKey("engagement", engagementId, {
          limit: 50,
        }),
        staleTime: 15_000,
      },
    },
  );

  const summary: AtomSummary | undefined = summaryQuery.data;
  const events: AtomHistoryEvent[] = historyQuery.data?.events ?? [];
  const matchedEvent = useMemo<AtomHistoryEvent | null>(() => {
    if (!summary) return null;
    const eventId = summary.historyProvenance.latestEventId;
    if (!eventId) return null;
    return events.find((e) => e.id === eventId) ?? null;
  }, [summary, events]);

  if (!isOpen) return null;

  const typed = (summary?.typed ?? {}) as {
    note?: string | null;
    jurisdiction?: string | null;
    jurisdictionCity?: string | null;
    jurisdictionState?: string | null;
    jurisdictionFips?: string | null;
    submittedAt?: string;
    respondedAt?: string | null;
    responseRecordedAt?: string | null;
    found?: boolean;
  };

  const submittedAt = typed.submittedAt;
  const submittedAbsolute = submittedAt
    ? new Date(submittedAt).toLocaleString()
    : null;
  const jurisdictionLabel =
    typed.jurisdiction ||
    [typed.jurisdictionCity, typed.jurisdictionState]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join(", ") ||
    null;
  // Mirror the engagement timeline (Task #106): when the user-picked
  // `respondedAt` is meaningfully earlier than the server-stamped
  // `responseRecordedAt`, surface the same "backfilled on <date>" cue
  // here too so a row click into a backfilled reply doesn't lose the
  // context. Reuses the shared helper so the threshold and copy stay
  // pinned in one place.
  const backfillNote = backfillAnnotation(
    typed.respondedAt,
    typed.responseRecordedAt,
  );

  return (
    <div
      onClick={onClose}
      data-testid="submission-detail-modal"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        className="sc-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="submission-detail-modal-title"
        style={{
          width: "100%",
          maxWidth: 560,
          maxHeight: "90vh",
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          className="sc-card-header"
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div className="flex flex-col gap-1">
            <span
              id="submission-detail-modal-title"
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: "var(--text-primary)",
              }}
            >
              Submission detail
            </span>
            <span className="sc-meta opacity-70">
              {jurisdictionLabel
                ? `Submitted to ${jurisdictionLabel}`
                : "Jurisdiction not recorded"}
              {submittedAbsolute ? ` · ${submittedAbsolute}` : ""}
            </span>
            {backfillNote && (
              <span
                className="sc-meta"
                data-testid="submission-detail-backfill"
                title={
                  typed.responseRecordedAt
                    ? new Date(typed.responseRecordedAt).toLocaleString()
                    : undefined
                }
                style={{
                  color: "var(--text-secondary)",
                  fontSize: 11,
                  fontStyle: "italic",
                }}
              >
                {backfillNote}
              </span>
            )}
          </div>
          <button
            type="button"
            className="sc-btn-ghost"
            onClick={onClose}
            aria-label="Close submission detail"
            data-testid="submission-detail-close"
            style={{ padding: "2px 8px", fontSize: 12 }}
          >
            Close
          </button>
        </div>

        <div className="p-4 flex flex-col" style={{ gap: 16 }}>
          {summaryQuery.isLoading && (
            <div
              className="sc-body opacity-60"
              data-testid="submission-detail-loading"
            >
              Loading submission…
            </div>
          )}

          {summaryQuery.isError && (
            <div
              className="sc-body"
              data-testid="submission-detail-error"
              style={{ color: "#ef4444" }}
            >
              Couldn't load this submission. It may have been removed.
            </div>
          )}

          {summary && typed.found === false && (
            <div
              className="sc-body opacity-70"
              data-testid="submission-detail-missing"
            >
              {summary.prose}
            </div>
          )}

          {summary && typed.found !== false && (
            <>
              <Section label="JURISDICTION">
                <KvRow
                  label="Label"
                  value={typed.jurisdiction ?? "—"}
                  monoValue={false}
                />
                <KvRow
                  label="City"
                  value={typed.jurisdictionCity ?? "—"}
                  monoValue={false}
                />
                <KvRow
                  label="State"
                  value={typed.jurisdictionState ?? "—"}
                  monoValue={false}
                />
                <KvRow
                  label="FIPS"
                  value={typed.jurisdictionFips ?? "—"}
                  monoValue={true}
                />
              </Section>

              <Section label="NOTE">
                {typed.note ? (
                  <div
                    className="sc-body"
                    data-testid="submission-detail-note"
                    style={{
                      color: "var(--text-primary)",
                      fontSize: 13,
                      whiteSpace: "pre-wrap",
                      lineHeight: 1.5,
                    }}
                  >
                    {typed.note}
                  </div>
                ) : (
                  <div
                    className="sc-body opacity-60"
                    data-testid="submission-detail-note-empty"
                    style={{ fontSize: 12.5, fontStyle: "italic" }}
                  >
                    No note was recorded for this submission.
                  </div>
                )}
              </Section>

              <Section label="RELATED EVENT">
                <RelatedEventBlock
                  summary={summary}
                  matched={matchedEvent}
                  loading={historyQuery.isLoading}
                />
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col" style={{ gap: 8 }}>
      <div
        className="sc-label"
        style={{
          fontSize: 11,
          letterSpacing: "0.05em",
          color: "var(--text-secondary)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          background: "var(--bg-input)",
          border: "1px solid var(--border-default)",
          borderRadius: 4,
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function KvRow({
  label,
  value,
  monoValue,
}: {
  label: string;
  value: string;
  monoValue: boolean;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "100px 1fr",
        gap: 8,
        fontSize: 12,
      }}
    >
      <div style={{ color: "var(--text-secondary)" }}>{label}</div>
      <div
        style={{
          color: "var(--text-primary)",
          fontFamily: monoValue ? "ui-monospace, monospace" : undefined,
          wordBreak: "break-word",
        }}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * Render the inline view of the related `engagement.submitted` audit
 * event. Source of truth is the submission atom's `historyProvenance`
 * — when the atom found a matching engagement-anchored event it
 * populates `latestEventId`, otherwise both fields are empty / set to
 * the row's `submittedAt` and we surface a "no recorded event" hint
 * rather than a raw empty id.
 *
 * The actor row is best-effort: hydration lives on the engagement's
 * history endpoint, so if that secondary fetch is still loading we
 * show a placeholder rather than the raw event id alone. Falling back
 * to the event id only (no actor) when hydration finishes empty keeps
 * the panel useful even for old events whose actor record is gone.
 */
function RelatedEventBlock({
  summary,
  matched,
  loading,
}: {
  summary: AtomSummary;
  matched: AtomHistoryEvent | null;
  loading: boolean;
}) {
  const eventId = summary.historyProvenance.latestEventId;
  const occurredAt = summary.historyProvenance.latestEventAt;

  if (!eventId) {
    return (
      <div
        className="sc-body opacity-60"
        data-testid="submission-detail-event-missing"
        style={{ fontSize: 12 }}
      >
        No <code>engagement.submitted</code> audit event was recorded for
        this submission. Showing the row's <code>submittedAt</code>{" "}
        timestamp instead.
        <div style={{ marginTop: 4, color: "var(--text-secondary)" }}>
          {new Date(occurredAt).toLocaleString()} ·{" "}
          {relativeTime(occurredAt)}
        </div>
      </div>
    );
  }

  const eventType = matched?.eventType ?? "engagement.submitted";
  const occurred = matched?.occurredAt ?? occurredAt;

  return (
    <div
      data-testid="submission-detail-event"
      style={{ display: "flex", flexDirection: "column", gap: 4 }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span
          style={{
            color: "var(--text-primary)",
            fontFamily: "ui-monospace, monospace",
            fontSize: 12,
          }}
        >
          {eventType}
        </span>
        <span
          className="sc-meta"
          title={new Date(occurred).toLocaleString()}
          style={{ color: "var(--text-secondary)", fontSize: 11 }}
        >
          {relativeTime(occurred)}
        </span>
      </div>
      <div
        style={{
          color: "var(--text-secondary)",
          fontSize: 11,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span>by</span>
        {loading && !matched ? (
          <span className="opacity-60">loading actor…</span>
        ) : matched ? (
          <span>{actorLabel(matched.actor)}</span>
        ) : (
          <span className="opacity-60">unknown</span>
        )}
      </div>
      <div
        style={{
          color: "var(--text-muted)",
          fontSize: 10,
          fontFamily: "ui-monospace, monospace",
          wordBreak: "break-all",
        }}
      >
        event id: {eventId}
      </div>
    </div>
  );
}

/**
 * Display label for an event actor. Mirrors the "user shows display
 * name, agents/system show stable kind:id" convention `SheetCard`
 * already uses on the sheet timeline so the two surfaces read the
 * same way.
 */
function actorLabel(actor: AtomEventActor): string {
  if (actor.kind === "user") {
    return actor.displayName ?? "Unknown user";
  }
  return `${actor.kind}:${actor.id}`;
}
