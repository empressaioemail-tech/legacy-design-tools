/**
 * `ReviewerQueueTriageStrip` — Track 1.
 *
 * Per-row triage chip group on the Inbox queue. Renders four
 * pieces of context the reviewer scans before clicking into the
 * submission detail:
 *   1. Project-type chip (e.g. "single-family-residence").
 *   2. Discipline chips (one ReviewerDisciplineBadge per
 *      classification.disciplines value).
 *   3. Severity-rollup pill ("12 findings: 3 blockers, 7 concerns,
 *      2 advisory" — pluralization handled).
 *   4. Applicant-history pill with a Hovercard listing the prior
 *      submissions (most recent first, max 5 per the addendum D3).
 *
 * Each block degrades gracefully when the corresponding wire field
 * is absent (Pass A's contract-first lock — every new field is
 * optional until BE backfills). When all four blocks are absent
 * the strip renders an empty container (no `null` return) so the
 * row layout stays stable.
 */
import {
  Hovercard,
  ReviewerDisciplineBadge,
  type PlanReviewDiscipline,
} from "@workspace/portal-ui";
import type {
  ApplicantHistory,
  ApplicantHistoryPriorSubmission,
  ReviewerSeverityRollup,
  SubmissionClassification,
} from "@workspace/api-client-react";
import { relativeTime } from "../lib/relativeTime";

export interface ReviewerQueueTriageStripProps {
  classification?: SubmissionClassification | null;
  severityRollup?: ReviewerSeverityRollup;
  applicantHistory?: ApplicantHistory;
  /** Test id prefix; defaults to `reviewer-queue-triage`. */
  testIdPrefix?: string;
}

export function ReviewerQueueTriageStrip({
  classification,
  severityRollup,
  applicantHistory,
  testIdPrefix = "reviewer-queue-triage",
}: ReviewerQueueTriageStripProps) {
  return (
    <div
      data-testid={testIdPrefix}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        flexWrap: "wrap",
      }}
    >
      {classification ? (
        <ClassificationChips
          classification={classification}
          testIdPrefix={testIdPrefix}
        />
      ) : null}
      {severityRollup ? (
        <SeverityRollupPill
          rollup={severityRollup}
          testId={`${testIdPrefix}-severity`}
        />
      ) : null}
      {applicantHistory ? (
        <ApplicantHistoryPill
          history={applicantHistory}
          testIdPrefix={testIdPrefix}
        />
      ) : null}
    </div>
  );
}

function ClassificationChips({
  classification,
  testIdPrefix,
}: {
  classification: SubmissionClassification;
  testIdPrefix: string;
}) {
  const disciplines = classification.disciplines as PlanReviewDiscipline[];
  return (
    <>
      <span
        className="sc-pill sc-pill-muted"
        data-testid={`${testIdPrefix}-project-type`}
      >
        {classification.projectType}
      </span>
      {disciplines.map((d) => (
        <ReviewerDisciplineBadge
          key={d}
          discipline={d}
          size="sm"
          data-testid={`${testIdPrefix}-discipline-${d}`}
        />
      ))}
    </>
  );
}

function SeverityRollupPill({
  rollup,
  testId,
}: {
  rollup: ReviewerSeverityRollup;
  testId: string;
}) {
  if (rollup.total === 0) {
    return (
      <span
        className="sc-pill sc-pill-muted"
        data-testid={testId}
        data-rollup-total="0"
      >
        No findings yet
      </span>
    );
  }
  // Severity copy: build "12 findings: 3 blockers, 7 concerns, 2
  // advisory" with each non-zero bucket pluralized. Buckets that are
  // zero are dropped from the suffix so a clean submission with only
  // advisory items doesn't read "0 blockers, 0 concerns, 2 advisory".
  const parts: string[] = [];
  if (rollup.blockers > 0) {
    parts.push(`${rollup.blockers} blocker${rollup.blockers === 1 ? "" : "s"}`);
  }
  if (rollup.concerns > 0) {
    parts.push(`${rollup.concerns} concern${rollup.concerns === 1 ? "" : "s"}`);
  }
  if (rollup.advisory > 0) {
    parts.push(`${rollup.advisory} advisory`);
  }
  const findingsNoun = rollup.total === 1 ? "finding" : "findings";
  // Severity-driven pill class: blocker-heavy reads red, concern-heavy
  // reads amber, advisory-only reads cyan. Single-pill so the strip
  // stays compact.
  const pillClass =
    rollup.blockers > 0
      ? "sc-pill sc-pill-red"
      : rollup.concerns > 0
        ? "sc-pill sc-pill-amber"
        : "sc-pill sc-pill-cyan";
  return (
    <span
      className={pillClass}
      data-testid={testId}
      data-rollup-total={rollup.total}
      data-rollup-blockers={rollup.blockers}
      data-rollup-concerns={rollup.concerns}
      data-rollup-advisory={rollup.advisory}
    >
      {`${rollup.total} ${findingsNoun}: ${parts.join(", ")}`}
    </span>
  );
}

function ApplicantHistoryPill({
  history,
  testIdPrefix,
}: {
  history: ApplicantHistory;
  testIdPrefix: string;
}) {
  const pillTestId = `${testIdPrefix}-applicant-history`;
  const triggerLabel =
    history.totalPrior === 0
      ? "First submission from this applicant"
      : `${history.totalPrior} prior · ${history.approved} approved · ${history.returned} returned`;
  const pillClass =
    history.totalPrior === 0 ? "sc-pill sc-pill-cyan" : "sc-pill sc-pill-muted";
  const trigger = (
    <span
      className={pillClass}
      data-testid={pillTestId}
      data-total-prior={history.totalPrior}
    >
      {triggerLabel}
    </span>
  );
  if (history.totalPrior === 0) {
    // No prior submissions — the hovercard would be empty. Render
    // the bare pill so we don't trap focus on an information-free
    // tooltip.
    return trigger;
  }
  return (
    <Hovercard
      trigger={trigger}
      placement="bottom"
      width={320}
      data-testid={`${testIdPrefix}-applicant-history-card`}
    >
      <PriorSubmissionsList
        priorSubmissions={history.priorSubmissions ?? []}
        lastReturnReason={history.lastReturnReason}
        testIdPrefix={testIdPrefix}
      />
    </Hovercard>
  );
}

function PriorSubmissionsList({
  priorSubmissions,
  lastReturnReason,
  testIdPrefix,
}: {
  priorSubmissions: ApplicantHistoryPriorSubmission[];
  lastReturnReason: string | null;
  testIdPrefix: string;
}) {
  if (priorSubmissions.length === 0) {
    return (
      <div
        className="sc-meta"
        data-testid={`${testIdPrefix}-applicant-history-empty`}
      >
        Prior submissions not available.
        {lastReturnReason ? (
          <div style={{ marginTop: 4 }}>
            Last return reason: {lastReturnReason}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <ul
      data-testid={`${testIdPrefix}-applicant-history-list`}
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {priorSubmissions.map((p) => {
        const verdictPillClass =
          p.verdict === "approved"
            ? "sc-pill sc-pill-green"
            : p.verdict === "returned"
              ? "sc-pill sc-pill-red"
              : "sc-pill sc-pill-amber";
        return (
          <li
            key={p.submissionId}
            data-testid={`${testIdPrefix}-applicant-history-row-${p.submissionId}`}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                justifyContent: "space-between",
              }}
            >
              <span className="sc-medium" style={{ fontSize: 12 }}>
                {p.engagementName}
              </span>
              <span className={verdictPillClass}>{p.verdict}</span>
            </div>
            <div className="sc-meta" style={{ fontSize: 10 }}>
              {relativeTime(p.submittedAt)}
              {p.verdict === "returned" && p.returnReason
                ? ` · ${truncate(p.returnReason, 80)}`
                : ""}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
