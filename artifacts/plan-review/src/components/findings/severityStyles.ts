/**
 * Per-severity styling tokens for the AIR-2 Findings tab.
 *
 * Reuses the SmartCity theme tokens (see
 * `lib/portal-ui/src/styles/smartcity-themes.css`) so the palette
 * picks up dark/light mode automatically:
 *   - blocker → danger (red)
 *   - concern → warning (amber)
 *   - advisory → info (blue)
 *
 * Status palette mirrors the row-level submission status badge
 * pattern in `EngagementDetail.tsx` so the two surfaces feel
 * of-a-piece.
 */
import type {
  FindingSeverity,
  FindingStatus,
} from "../../lib/findingsApi";

export const SEVERITY_PALETTE: Record<
  FindingSeverity,
  { bg: string; fg: string }
> = {
  blocker: { bg: "var(--danger-dim)", fg: "var(--danger-text)" },
  concern: { bg: "var(--warning-dim)", fg: "var(--warning-text)" },
  advisory: { bg: "var(--info-dim)", fg: "var(--info-text)" },
};

export const STATUS_PALETTE: Record<
  FindingStatus,
  { bg: string; fg: string }
> = {
  "ai-produced": { bg: "var(--info-dim)", fg: "var(--info-text)" },
  accepted: { bg: "var(--success-dim)", fg: "var(--success-text)" },
  rejected: { bg: "var(--danger-dim)", fg: "var(--danger-text)" },
  overridden: { bg: "var(--warning-dim)", fg: "var(--warning-text)" },
  "promoted-to-architect": {
    bg: "var(--success-dim)",
    fg: "var(--success-text)",
  },
};
