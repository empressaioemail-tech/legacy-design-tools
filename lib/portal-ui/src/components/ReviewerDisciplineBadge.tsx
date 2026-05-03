/**
 * `ReviewerDisciplineBadge` — Track 1 / addendum D1.
 *
 * Renders an ICC-aligned reviewer discipline using the existing
 * `.sc-dept-badge` + `dept-*` tokens from
 * `styles/plan-review-disciplines.css`. Sibling to the older
 * `DisciplineBadge` (which takes a loose `string`) so the loose
 * call sites can keep their existing wiring while the new triage
 * surfaces consume the strict enum.
 */
import {
  type PlanReviewDiscipline,
  PLAN_REVIEW_DISCIPLINE_DEPT_TOKEN,
  PLAN_REVIEW_DISCIPLINE_LABELS,
} from "../lib/planReviewDiscipline";

export interface ReviewerDisciplineBadgeProps {
  discipline: PlanReviewDiscipline;
  /** `sm` collapses padding for compact contexts (e.g. queue row chip strip). */
  size?: "default" | "sm";
  "data-testid"?: string;
}

export function ReviewerDisciplineBadge({
  discipline,
  size = "default",
  "data-testid": testId,
}: ReviewerDisciplineBadgeProps) {
  const dept = PLAN_REVIEW_DISCIPLINE_DEPT_TOKEN[discipline];
  const label = PLAN_REVIEW_DISCIPLINE_LABELS[discipline];
  const className = `sc-dept-badge ${dept}`;
  const style: React.CSSProperties | undefined =
    size === "sm" ? { padding: "1px 5px", fontSize: 8 } : undefined;
  return (
    <span
      className={className}
      style={style}
      data-discipline={discipline}
      data-testid={testId ?? `reviewer-discipline-badge-${discipline}`}
    >
      {label}
    </span>
  );
}
