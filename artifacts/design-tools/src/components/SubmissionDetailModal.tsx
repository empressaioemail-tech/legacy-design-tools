import { useMemo } from "react";
import {
  getGetAtomHistoryQueryKey,
  getGetAtomSummaryQueryKey,
  useGetAtomHistory,
  useGetAtomSummary,
  type AtomEventActor,
  type AtomHistoryEvent,
  type AtomSummary,
  type SubmissionStatus,
} from "@workspace/api-client-react";
import { ReviewerComment, SubmissionCommentThread } from "@workspace/portal-ui";
import { relativeTime } from "../lib/relativeTime";
import { backfillAnnotation } from "../lib/submissionBackfill";
import { friendlyAgentLabel } from "../lib/actorLabel";

/**
 * Status the submission's atom-event chain may surface in
 * `statusHistory` entries. Re-uses the generated `SubmissionStatus`
 * enum from the API client so the modal reads from the same
 * source-of-truth values the row badge / record-response dialog do.
 */
type StatusHistoryStatus = SubmissionStatus;

/**
 * One entry in `submission` atom's `typed.statusHistory` array
 * (added in Task #93). Mirror of the server-side
 * `SubmissionStatusHistoryEntry` interface in
 * `artifacts/api-server/src/atoms/submission.atom.ts` — kept narrow
 * here so the modal's typed-payload local cast stays self-contained
 * (the AtomSummary's `typed` field is open-shaped on the wire). When
 * the server contract grows fields the modal doesn't render, those
 * fields are silently ignored — adding them later is non-breaking.
 */
interface SubmissionStatusHistoryEntry {
  status: StatusHistoryStatus;
  occurredAt: string;
  actor: AtomEventActor;
  note: string | null;
  eventId: string | null;
}

/**
 * Human-readable label for each status surfaced in the timeline.
 * Mirrors the same map in
 * `artifacts/design-tools/src/pages/EngagementDetail.tsx` so the
 * detail modal and the row badge read the same way.
 */
const STATUS_LABELS: Record<StatusHistoryStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  corrections_requested: "Corrections requested",
  rejected: "Rejected",
};

/**
 * Per-status palette for the timeline dot. Reuses the same
 * SmartCity theme tokens the row-level badge uses (see
 * `SUBMISSION_STATUS_COLORS` in `EngagementDetail.tsx`) so the two
 * surfaces stay visually consistent. The "pending" seed entry uses
 * the same info palette as the row badge — it represents "package
 * sent, awaiting reply" rather than a transitional state.
 */
const STATUS_DOT: Record<StatusHistoryStatus, string> = {
  pending: "var(--info-text)",
  approved: "var(--success-text)",
  corrections_requested: "var(--warning-text)",
  rejected: "var(--danger-text)",
};

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
    reviewerComment?: string | null;
    found?: boolean;
    statusHistory?: SubmissionStatusHistoryEntry[];
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

              {typed.reviewerComment && (
                <Section label="REVIEWER COMMENT">
                  <ReviewerComment
                    submissionId={submissionId ?? ""}
                    comment={typed.reviewerComment}
                  />
                  {typed.respondedAt && (
                    <span
                      className="sc-meta"
                      data-testid="submission-detail-reviewer-responded-at"
                      title={new Date(typed.respondedAt).toLocaleString()}
                      style={{
                        color: "var(--text-secondary)",
                        fontSize: 11,
                        marginTop: 4,
                      }}
                    >
                      Responded {relativeTime(typed.respondedAt)}
                    </span>
                  )}
                </Section>
              )}

              {/*
                * Task #431 — architect-facing reply thread under the
                * reviewer comment. Mounted only when the submission
                * has a reviewer comment to reply *to* (otherwise
                * there's no conversation seed and the surface is
                * confusing). The seed itself renders above in the
                * REVIEWER COMMENT section, so we pass `null` here to
                * suppress the duplicate render inside the thread
                * component.
                */}
              {typed.reviewerComment && submissionId && (
                <Section label="CONVERSATION">
                  <SubmissionCommentThread
                    submissionId={submissionId}
                    authorRole="architect"
                    seedReviewerComment={null}
                  />
                </Section>
              )}

              <Section label="RELATED EVENT">
                <RelatedEventBlock
                  summary={summary}
                  matched={matchedEvent}
                  loading={historyQuery.isLoading}
                />
              </Section>

              <Section label="STATUS HISTORY">
                <StatusHistoryBlock
                  entries={typed.statusHistory ?? []}
                  loading={summaryQuery.isLoading}
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
 * Display label for an event actor.
 *
 * `user` actors show the hydrated display name (falling back to a
 * generic "Unknown user" string when the API hasn't / couldn't
 * hydrate the profile — distinct from the divergence-resolver
 * surface, which prefers the raw id over a generic label so an
 * audit row never collapses to anonymous copy).
 *
 * `agent` / `system` actors look up a friendly label in
 * {@link FRIENDLY_AGENT_LABELS} so e.g. `snapshot-ingest` reads as
 * "Site-context automation" instead of leaking the raw code-side
 * id. Unknown ids degrade to the historical `kind:id` convention
 * `SheetCard` already uses on the sheet timeline so the two
 * surfaces still read the same way for any producer that hasn't
 * been added to the friendly-label map yet.
 */
function actorLabel(actor: AtomEventActor): string {
  if (actor.kind === "user") {
    return actor.displayName ?? "Unknown user";
  }
  const friendly = friendlyAgentLabel(actor.id);
  if (friendly) return friendly;
  return `${actor.kind}:${actor.id}`;
}

/**
 * Vertical status timeline (Task #93) rendered below the modal's
 * "Related event" panel. Reads from the submission atom's
 * `typed.statusHistory` array, which the server builds by walking
 * the submission's atom-event chain (`submission.status-changed`
 * events plus a synthetic "Submitted" seed entry for the row's
 * `submittedAt`).
 *
 * Layout is a left-rail dotted timeline — a colored dot per entry
 * (color keyed off the status palette) connected by a faint vertical
 * line — with status label, relative time, actor attribution, and
 * an optional note row per entry. Mirrors the visual treatment of
 * other audit-trail timelines in design-tools so the surface feels
 * consistent.
 *
 * Empty / loading states:
 *   - While the summary query is loading, render a placeholder so
 *     the section doesn't pop in under the related-event panel.
 *   - An empty `entries` array (best-effort fallback when the
 *     server omits the field — older atom server versions, history
 *     outage) renders a hint rather than an empty box, so the
 *     section is never completely blank for a real submission.
 */
function StatusHistoryBlock({
  entries,
  loading,
}: {
  entries: SubmissionStatusHistoryEntry[];
  loading: boolean;
}) {
  if (loading && entries.length === 0) {
    return (
      <div
        className="sc-body opacity-60"
        data-testid="submission-status-history-loading"
        style={{ fontSize: 12 }}
      >
        Loading status history…
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div
        className="sc-body opacity-60"
        data-testid="submission-status-history-empty"
        style={{ fontSize: 12 }}
      >
        No status history is available for this submission yet.
      </div>
    );
  }
  return (
    <div
      data-testid="submission-status-history"
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
    >
      {entries.map((entry, idx) => {
        const label = STATUS_LABELS[entry.status] ?? entry.status;
        const dotColor = STATUS_DOT[entry.status] ?? "var(--text-secondary)";
        const isLast = idx === entries.length - 1;
        // React key: prefer the originating event id when present,
        // fall back to status+timestamp for the synthetic seed entry
        // (whose `eventId` is null by contract).
        const key = entry.eventId ?? `${entry.status}-${entry.occurredAt}`;
        return (
          <div
            key={key}
            data-testid={`submission-status-history-entry-${idx}`}
            style={{ display: "flex", gap: 10, alignItems: "stretch" }}
          >
            {/* Left rail: colored dot + connector line. The connector
                is omitted on the final row so the timeline ends at
                the dot rather than trailing a stub line. */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                paddingTop: 4,
                width: 12,
              }}
            >
              <div
                aria-hidden
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background: dotColor,
                  flex: "none",
                }}
              />
              {!isLast && (
                <div
                  aria-hidden
                  style={{
                    flex: 1,
                    width: 2,
                    background: "var(--border-default)",
                    marginTop: 4,
                  }}
                />
              )}
            </div>
            {/* Right column: status label + relative timestamp on the
                top row, actor attribution on the second row, the
                optional note last (rendered with the same border-left
                accent the row-level reviewer comment uses so the two
                surfaces feel of-a-piece). */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                flex: 1,
                minWidth: 0,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span
                  data-testid={`submission-status-history-status-${idx}`}
                  style={{
                    color: "var(--text-primary)",
                    fontSize: 12.5,
                    fontWeight: 600,
                  }}
                >
                  {label}
                </span>
                <span
                  className="sc-meta"
                  title={new Date(entry.occurredAt).toLocaleString()}
                  style={{ color: "var(--text-secondary)", fontSize: 11 }}
                >
                  {relativeTime(entry.occurredAt)}
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
                <span data-testid={`submission-status-history-actor-${idx}`}>
                  {actorLabel(entry.actor)}
                </span>
              </div>
              {entry.note && (
                <div
                  className="sc-body"
                  data-testid={`submission-status-history-note-${idx}`}
                  style={{
                    color: "var(--text-primary)",
                    fontSize: 12,
                    whiteSpace: "pre-wrap",
                    borderLeft: "2px solid var(--border-active)",
                    paddingLeft: 8,
                    marginTop: 2,
                  }}
                >
                  {entry.note}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
