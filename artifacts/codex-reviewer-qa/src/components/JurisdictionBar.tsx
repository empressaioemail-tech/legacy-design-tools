/**
 * Codex Reviewer QA — jurisdiction context bar (CDX-5).
 *
 * CDX-5 is the engagement/submission switcher (planner ruling
 * 2026-05-21): jurisdiction follows the engagement, so this bar makes
 * the code corpus a review pass is judged against *visible* rather
 * than implicit. It surfaces the engagement's jurisdiction, the
 * indexed-corpus stats it matches, and — when a submission was filed
 * under a now-stale jurisdiction — a divergence warning.
 *
 * Read-only. CDX-5 deliberately adds no jurisdiction override: the
 * cross-jurisdiction "what-if" (running a submission against an
 * arbitrary jurisdiction) is logged as a possible Phase 3 capability.
 */
import type { CSSProperties } from "react";
import type {
  EngagementSubmissionSummary,
  EngagementSummary,
  JurisdictionSummary,
} from "@workspace/api-client-react";
import {
  describeCorpus,
  matchJurisdiction,
  resolveJurisdictionContext,
} from "../lib/jurisdiction";

export interface JurisdictionBarProps {
  /** The engagement currently in view. The bar renders nothing when
   *  none is selected. */
  engagement: Pick<EngagementSummary, "jurisdiction"> | null;
  /** The submission currently in view, if any — drives the snapshot
   *  divergence check. */
  submission: Pick<EngagementSubmissionSummary, "jurisdiction"> | null;
  /** The indexed code corpora (`GET /api/codes/jurisdictions`). */
  jurisdictions: ReadonlyArray<JurisdictionSummary>;
  /** True while the corpus list is still loading — keeps the bar from
   *  claiming "no corpus" before the list has arrived. */
  corpusLoading?: boolean;
}

const barStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid var(--border-subtle)",
  background: "var(--surface-2, var(--bg-elevated))",
};

const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
};

const noteStyle: CSSProperties = {
  fontSize: 12,
  borderRadius: 6,
  padding: "6px 8px",
};

export function JurisdictionBar({
  engagement,
  submission,
  jurisdictions,
  corpusLoading,
}: JurisdictionBarProps) {
  // Nothing to anchor a jurisdiction to until an engagement is picked.
  if (engagement === null) return null;

  const { engagementLabel, submissionLabel, snapshotDiverged } =
    resolveJurisdictionContext(engagement, submission);

  const corpus =
    engagementLabel !== null
      ? matchJurisdiction(engagementLabel, jurisdictions)
      : null;
  // Only claim a corpus verdict once the list has actually loaded — a
  // best-effort label match against an empty list would falsely warn.
  const corpusKnown =
    corpusLoading !== true && jurisdictions.length > 0;

  return (
    <section data-testid="jurisdiction-bar" style={barStyle}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <span style={labelStyle}>Jurisdiction</span>
        <span
          data-testid="jurisdiction-name"
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          {engagementLabel ?? "Not recorded"}
        </span>
        {corpus !== null ? (
          <span
            data-testid="jurisdiction-corpus"
            style={{ fontSize: 12, color: "var(--text-secondary)" }}
          >
            · {describeCorpus(corpus)}
          </span>
        ) : null}
      </div>

      <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
        Findings are judged against the engagement&rsquo;s jurisdiction.
        Switch the engagement to review another.
      </p>

      {engagementLabel === null ? (
        <div
          data-testid="jurisdiction-empty"
          style={{
            ...noteStyle,
            background: "var(--warning-dim)",
            color: "var(--warning-text)",
          }}
        >
          No jurisdiction is recorded on this engagement — the engine has
          no code corpus to resolve, so a pass may return findings with
          no code citations.
        </div>
      ) : corpusKnown && corpus === null ? (
        <div
          data-testid="jurisdiction-corpus-missing"
          style={{
            ...noteStyle,
            background: "var(--warning-dim)",
            color: "var(--warning-text)",
          }}
        >
          No indexed code corpus matches this jurisdiction label. The
          engine resolves the corpus server-side from the engagement&rsquo;s
          location; if it cannot, the pass returns findings without code
          citations.
        </div>
      ) : null}

      {snapshotDiverged ? (
        <div
          role="alert"
          data-testid="jurisdiction-snapshot-warning"
          style={{
            ...noteStyle,
            background: "var(--warning-dim)",
            color: "var(--warning-text)",
          }}
        >
          This submission was filed under{" "}
          <strong>{submissionLabel}</strong>, but the engagement now
          records <strong>{engagementLabel}</strong>. A new review pass
          judges against the engagement&rsquo;s current jurisdiction.
        </div>
      ) : null}
    </section>
  );
}
