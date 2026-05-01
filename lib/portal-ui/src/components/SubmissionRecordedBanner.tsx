import { useMemo } from "react";

/**
 * Format an ISO timestamp as a short relative string ("just now",
 * "5 min ago", etc). Mirrors the per-artifact `relativeTime` helpers
 * in `artifacts/plan-review/src/lib/relativeTime.ts` and
 * `artifacts/design-tools/src/lib/relativeTime.ts` so the banner
 * renders identical copy on both surfaces without forcing those
 * pages to forward a formatter prop.
 */
function formatRelative(input: string | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return String(input);

  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.round(diffMs / 1000);

  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

export interface SubmissionRecordedBannerProps {
  /**
   * Server-issued submission timestamp from the {@link SubmissionReceipt}
   * surfaced by `SubmitToJurisdictionDialog`'s `onSubmitted` callback.
   * Accepts a `Date` for parity with the plan-review surface, which
   * snapshots the receipt as-is.
   */
  submittedAt: string | Date;
  /**
   * Jurisdiction snapshot captured at submit-time by the parent so a
   * same-session edit to the engagement's jurisdiction does not
   * retroactively rewrite the banner copy. Falls back to the literal
   * word "jurisdiction" when null so the sentence still reads.
   */
  jurisdiction: string | null;
  onDismiss: () => void;
}

/**
 * Non-blocking confirmation banner shown after a successful
 * "Submit to jurisdiction" action. The dialog itself already closes
 * on success, so this banner is the only post-submit affordance
 * reassuring the user that the package was actually recorded — it
 * pairs the human-friendly relative time (e.g. "just now") with the
 * absolute timestamp on hover so a teammate can verify exactly when
 * the submission landed.
 *
 * Originally lived as a copy-pasted local component on both
 * `artifacts/plan-review/src/pages/EngagementDetail.tsx` (Task #100,
 * pinned by Task #112) and
 * `artifacts/design-tools/src/pages/EngagementDetail.tsx` (Task #126).
 * Promoted to portal-ui by Task #138 so a future copy/palette/dismiss
 * tweak on one surface cannot silently disagree with the other again;
 * the existing page-level tests on both sides keep both surfaces
 * pinned against this single source of truth.
 *
 * Auto-dismiss timing and the close handler stay with the parent so
 * this component remains presentational.
 */
export function SubmissionRecordedBanner({
  submittedAt,
  jurisdiction,
  onDismiss,
}: SubmissionRecordedBannerProps) {
  const absolute = useMemo(() => {
    const d = submittedAt instanceof Date ? submittedAt : new Date(submittedAt);
    return Number.isNaN(d.getTime())
      ? String(submittedAt)
      : d.toLocaleString();
  }, [submittedAt]);
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="submit-jurisdiction-success-banner"
      className="sc-card flex items-center justify-between flex-shrink-0"
      style={{
        padding: "10px 14px",
        background: "var(--info-dim)",
        borderColor: "var(--info-text)",
        color: "var(--text-primary)",
      }}
    >
      <div className="flex items-center gap-2" style={{ fontSize: 13 }}>
        <span aria-hidden style={{ color: "var(--info-text)", fontWeight: 600 }}>
          ✓
        </span>
        <span>
          Submitted to{" "}
          <strong>{jurisdiction ?? "jurisdiction"}</strong> ·{" "}
          <span title={absolute} style={{ color: "var(--text-secondary)" }}>
            {formatRelative(submittedAt)}
          </span>
        </span>
      </div>
      <button
        type="button"
        className="sc-btn-ghost"
        onClick={onDismiss}
        aria-label="Dismiss submission confirmation"
        data-testid="submit-jurisdiction-success-dismiss"
        style={{ padding: "2px 8px", fontSize: 12 }}
      >
        Dismiss
      </button>
    </div>
  );
}
