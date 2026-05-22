/**
 * Codex Reviewer QA — one rendered finding (CDX-3).
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
 * ids. The card therefore renders `text` in full and unabbreviated as
 * the reasoning surface, alongside the structured `citations`,
 * `confidence`, and `aiGeneratedAt`. A distinct structured
 * reasoning-chain field would require an engine + api-server change —
 * out of scope for a reviewer-surface dispatch; see the CDX-3 report.
 */
import type { Finding, FindingSeverity } from "@workspace/api-client-react";
import {
  CATEGORY_LABELS,
  SEVERITY_LABELS,
  STATUS_LABELS,
  citationLabel,
  formatConfidence,
} from "../lib/findings";

const SEVERITY_COLORS: Record<FindingSeverity, { bg: string; fg: string }> = {
  blocker: { bg: "var(--danger-dim)", fg: "var(--danger-text)" },
  concern: { bg: "var(--warning-dim)", fg: "var(--warning-text)" },
  advisory: { bg: "var(--info-dim)", fg: "var(--info-text)" },
};

const badge: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  padding: "2px 8px",
  borderRadius: 4,
  whiteSpace: "nowrap",
};

export function FindingCard({ finding }: { finding: Finding }) {
  const severity = SEVERITY_COLORS[finding.severity];
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
          Confidence {formatConfidence(finding.confidence)}
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
    </article>
  );
}
