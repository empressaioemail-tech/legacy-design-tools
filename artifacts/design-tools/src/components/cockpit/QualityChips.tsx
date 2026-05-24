import type { ReactNode } from "react";
import { AlertTriangle, FileText, Sparkles } from "lucide-react";

/**
 * Quality-bar primitives for any AI-filled / synthesized surface in the
 * design-tools UI. Mirrors the QA-27 guardrails: anything an agent
 * produced is shown with a `Draft` badge, every value an agent
 * synthesized from a source is labeled with a `SourceChip`, and any
 * field the agent couldn't verify gets an `Unverified` tag so the
 * architect knows not to copy/paste it without a glance.
 *
 * All colors resolve through the existing smartcity tokens. No
 * hex / rgba literals.
 */

export interface DraftBadgeProps {
  /** Tooltip / aria-label override. Defaults to a generic copy. */
  hint?: string;
  testId?: string;
}

export function DraftBadge({
  hint = "Agent-drafted — review before sending",
  testId,
}: DraftBadgeProps) {
  return (
    <span
      className="quality-draft-badge"
      role="status"
      aria-label={hint}
      title={hint}
      data-testid={testId}
    >
      <Sparkles size={11} aria-hidden="true" />
      Draft
    </span>
  );
}

export interface SourceChipProps {
  label: ReactNode;
  /** Optional kind label for the leading mono kicker ("FEMA", "ICC-ES", "PDF p. 12"). */
  kind?: string;
  onClick?: () => void;
  testId?: string;
}

export function SourceChip({ label, kind, onClick, testId }: SourceChipProps) {
  const Tag = (onClick ? "button" : "span") as "button" | "span";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      className={`quality-source-chip${onClick ? " quality-source-chip-button" : ""}`}
      onClick={onClick}
      data-testid={testId}
    >
      <FileText size={11} aria-hidden="true" />
      {kind ? <span className="quality-source-chip-kind">{kind}</span> : null}
      <span className="quality-source-chip-label">{label}</span>
    </Tag>
  );
}

export interface UnverifiedTagProps {
  hint?: string;
  testId?: string;
}

export function UnverifiedTag({
  hint = "Agent could not verify this from a primary source",
  testId,
}: UnverifiedTagProps) {
  return (
    <span
      className="quality-unverified-tag"
      role="status"
      aria-label={hint}
      title={hint}
      data-testid={testId}
    >
      <AlertTriangle size={11} aria-hidden="true" />
      Unverified
    </span>
  );
}
