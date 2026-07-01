/**
 * Codex Reviewer QA — one rendered finding (CDX-3 + CDX-4).
 *
 * Structural commitment 1 — sell reasoning, not data. This card never
 * collapses a finding to a bare pass/fail verdict: it always shows the
 * engine's full finding text, every source citation, the confidence
 * score, and the generation timestamp, visibly.
 *
 * Divergence note (verified against the cortex-api L-surface): the
 * finding wire carries NO separately-structured "reasoning chain"
 * field. The engine's reasoning IS the finding `text` — free-text with
 * inline citation tokens, already validator-stripped of unresolvable
 * ids. The card renders `text` in full as the reasoning surface.
 *
 * CDX-4 — when the adjudication handlers are supplied the card also
 * renders the accept / edit / reject action row, the inline override
 * editor, and the server-stamped adjudication attribution + timestamp.
 * A card with no handlers is read-only (used by the FindingCard tests).
 */
import { useState, type CSSProperties } from "react";
import type { Finding, FindingSeverity } from "@workspace/api-client-react";
import {
  CATEGORY_LABELS,
  SEVERITY_LABELS,
  STATUS_LABELS,
  citationLabel,
  describeAdjudication,
  formatConfidence,
  resolveFindingConfidence,
  type OverrideDraft,
} from "../lib/findings";
import { OverrideEditor } from "./OverrideEditor";

const SEVERITY_COLORS: Record<FindingSeverity, { bg: string; fg: string }> = {
  blocker: { bg: "var(--danger-dim)", fg: "var(--danger-text)" },
  concern: { bg: "var(--warning-dim)", fg: "var(--warning-text)" },
  advisory: { bg: "var(--info-dim)", fg: "var(--info-text)" },
};

const badge: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  padding: "2px 8px",
  borderRadius: 4,
  whiteSpace: "nowrap",
};

const actionButton: CSSProperties = {
  padding: "5px 12px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  border: "1px solid var(--border-subtle)",
};

export interface FindingCardProps {
  finding: Finding;
  /** CDX-4 — accept the finding. When omitted the card is read-only. */
  onAccept?: (findingId: string) => void;
  /** CDX-4 — reject the finding. */
  onReject?: (findingId: string) => void;
  /** CDX-4 — override (edit) the finding. */
  onOverride?: (findingId: string, draft: OverrideDraft) => void;
  /** True while an adjudication mutation for this finding is in flight. */
  busy?: boolean;
  /** Override-failure message for this finding, if any. */
  overrideError?: string | null;
}

export function FindingCard({
  finding,
  onAccept,
  onReject,
  onOverride,
  busy,
  overrideError,
}: FindingCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const severity = SEVERITY_COLORS[finding.severity];
  const hasActions = Boolean(onAccept && onReject && onOverride);
  const adjudication = describeAdjudication(finding);

  return (
    <article
      data-testid="finding-card"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 14,
        borderRadius: 8,
        border: "1px solid var(--border-subtle)",
        background: "var(--surface-2, var(--bg-elevated))",
      }}
    >
      <header style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span
          data-testid="finding-severity"
          style={{ ...badge, background: severity.bg, color: severity.fg }}
        >
          {SEVERITY_LABELS[finding.severity]}
        </span>
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          {CATEGORY_LABELS[finding.category]}
        </span>
        <span
          data-testid="finding-status"
          style={{
            marginLeft: "auto",
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          {STATUS_LABELS[finding.status]}
        </span>
      </header>

      {/* The engine's finding statement — its reasoning, in full. */}
      <p
        data-testid="finding-text"
        style={{
          margin: 0,
          fontSize: 13,
          lineHeight: 1.55,
          color: "var(--text-primary)",
          whiteSpace: "pre-wrap",
        }}
      >
        {finding.text}
      </p>

      {/* Source citations — always shown, never collapsed away. */}
      <div
        data-testid="finding-citations"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          alignItems: "baseline",
        }}
      >
        <span
          style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}
        >
          Cites
        </span>
        {finding.citations.length === 0 ? (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            — no code citations on this finding
          </span>
        ) : (
          finding.citations.map((citation, i) => (
            <code
              key={`${citation.kind}-${i}`}
              data-testid="finding-citation"
              style={{
                fontSize: 11,
                fontFamily: '"IBM Plex Mono", monospace',
                padding: "2px 6px",
                borderRadius: 4,
                background: "var(--info-dim)",
                color: "var(--info-text)",
              }}
            >
              {citationLabel(citation)}
            </code>
          ))
        )}
      </div>

      {/* Provenance — confidence, timestamp, element, origin. */}
      <footer
        data-testid="finding-provenance"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          fontSize: 12,
          color: "var(--text-muted)",
        }}
      >
        <span data-testid="finding-confidence">
          Confidence {formatConfidence(resolveFindingConfidence(finding))}
          {finding.lowConfidence ? " · flagged low" : ""}
        </span>
        <span data-testid="finding-timestamp">
          Generated {new Date(finding.aiGeneratedAt).toLocaleString()}
        </span>
        {finding.elementRef ? (
          <span data-testid="finding-element">
            Element {finding.elementRef}
          </span>
        ) : null}
        <span>{finding.aiGenerated ? "AI-generated" : "Reviewer-authored"}</span>
      </footer>

      {/* CDX-4 — server-stamped adjudication attribution + timestamp. */}
      {adjudication ? (
        <div
          data-testid="finding-adjudication"
          style={{
            fontSize: 12,
            color: "var(--text-secondary)",
            borderTop: "1px solid var(--border-subtle)",
            paddingTop: 8,
          }}
        >
          {adjudication}
          {finding.reviewerComment ? (
            <span
              data-testid="finding-reviewer-comment"
              style={{ display: "block", marginTop: 2, color: "var(--text-muted)" }}
            >
              “{finding.reviewerComment}”
            </span>
          ) : null}
        </div>
      ) : null}

      {overrideError ? (
        <div
          role="alert"
          data-testid="finding-override-error"
          style={{
            fontSize: 12,
            padding: "6px 8px",
            borderRadius: 4,
            background: "var(--danger-dim)",
            color: "var(--danger-text)",
          }}
        >
          {overrideError}
        </div>
      ) : null}

      {/* CDX-4 — accept / edit / reject. */}
      {hasActions && isEditing ? (
        <OverrideEditor
          finding={finding}
          busy={busy}
          onSubmit={(draft) => {
            onOverride?.(finding.id, draft);
            setIsEditing(false);
          }}
          onCancel={() => setIsEditing(false)}
        />
      ) : hasActions ? (
        <div
          data-testid="finding-actions"
          style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}
        >
          <button
            type="button"
            data-testid="finding-accept"
            onClick={() => onAccept?.(finding.id)}
            disabled={busy === true}
            style={{
              ...actionButton,
              background: "var(--success-dim, var(--info-dim))",
              color: "var(--success-text, var(--info-text))",
              opacity: busy === true ? 0.5 : 1,
            }}
          >
            Accept
          </button>
          <button
            type="button"
            data-testid="finding-edit"
            onClick={() => setIsEditing(true)}
            disabled={busy === true}
            style={{
              ...actionButton,
              background: "transparent",
              color: "var(--text-secondary)",
              opacity: busy === true ? 0.5 : 1,
            }}
          >
            Edit
          </button>
          <button
            type="button"
            data-testid="finding-reject"
            onClick={() => onReject?.(finding.id)}
            disabled={busy === true}
            style={{
              ...actionButton,
              background: "var(--danger-dim)",
              color: "var(--danger-text)",
              opacity: busy === true ? 0.5 : 1,
            }}
          >
            Reject
          </button>
        </div>
      ) : null}
    </article>
  );
}
