/**
 * `DisciplineFilterChipBar` — Track 1.
 *
 * Horizontal chip strip that lives above each list (Inbox queue,
 * FindingsTab, CannedFindings, OutstandingRequests). Each chip is a
 * `ReviewerDisciplineBadge` wrapped in a `<button>`; selected chips
 * render in full color, unselected ones at ~60% opacity. Trailing
 * "Show all" / "Reset to mine" affordances let the reviewer broaden
 * or recover their default narrowing.
 *
 * The bar is purely presentational — all state and persistence lives
 * in `useReviewerDisciplineFilter`; this component receives the
 * resolved bag and surfaces it.
 */
import {
  type PlanReviewDiscipline,
  PLAN_REVIEW_DISCIPLINE_LABELS,
} from "../lib/planReviewDiscipline";
import { ReviewerDisciplineBadge } from "./ReviewerDisciplineBadge";

export interface DisciplineFilterChipBarProps {
  selected: ReadonlySet<PlanReviewDiscipline>;
  allDisciplines: ReadonlyArray<PlanReviewDiscipline>;
  isShowingAll: boolean;
  onToggle: (d: PlanReviewDiscipline) => void;
  onShowAll: () => void;
  onResetToMine: () => void;
  /**
   * The reviewer's configured disciplines, used to enable / disable
   * the "Reset to mine" button. When empty the affordance is hidden
   * (there's nothing to reset to).
   */
  userDisciplines: ReadonlyArray<PlanReviewDiscipline>;
  /** Hide the bar entirely (e.g. admin / no-disciplines reviewer). */
  hidden?: boolean;
  /**
   * Optional surface label rendered ahead of the chip row, e.g.
   * "Showing:" or "Filter:". Defaults to "Showing:".
   */
  label?: string;
  "data-testid"?: string;
}

export function DisciplineFilterChipBar({
  selected,
  allDisciplines,
  isShowingAll,
  onToggle,
  onShowAll,
  onResetToMine,
  userDisciplines,
  hidden,
  label = "Showing:",
  "data-testid": testId = "discipline-filter-chip-bar",
}: DisciplineFilterChipBarProps) {
  if (hidden) return null;

  const userDisciplineSet = new Set(userDisciplines);
  const isAtUserDefault =
    selected.size === userDisciplineSet.size &&
    [...selected].every((d) => userDisciplineSet.has(d));

  return (
    <div
      data-testid={testId}
      data-showing-all={isShowingAll ? "true" : "false"}
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 6,
        padding: "6px 0",
      }}
    >
      <span
        className="sc-label"
        style={{ fontSize: 10, color: "var(--text-secondary)" }}
      >
        {label}
      </span>
      {allDisciplines.map((d) => {
        const isSelected = selected.has(d);
        const isMine = userDisciplineSet.has(d);
        return (
          <button
            key={d}
            type="button"
            onClick={() => onToggle(d)}
            data-testid={`discipline-filter-chip-${d}`}
            data-selected={isSelected ? "true" : "false"}
            data-mine={isMine ? "true" : "false"}
            aria-pressed={isSelected}
            aria-label={`${
              isSelected ? "Remove" : "Add"
            } ${PLAN_REVIEW_DISCIPLINE_LABELS[d]} from filter`}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
              opacity: isSelected ? 1 : 0.55,
            }}
          >
            <ReviewerDisciplineBadge discipline={d} size="sm" />
          </button>
        );
      })}
      {!isShowingAll && (
        <button
          type="button"
          className="sc-link sc-mono-sm"
          onClick={onShowAll}
          data-testid="discipline-filter-show-all"
          style={{
            background: "transparent",
            border: "none",
            padding: "0 4px",
            cursor: "pointer",
            color: "var(--cyan-text)",
            fontSize: 11,
          }}
        >
          Show all
        </button>
      )}
      {userDisciplines.length > 0 && !isAtUserDefault && (
        <button
          type="button"
          className="sc-link sc-mono-sm"
          onClick={onResetToMine}
          data-testid="discipline-filter-reset-mine"
          style={{
            background: "transparent",
            border: "none",
            padding: "0 4px",
            cursor: "pointer",
            color: "var(--text-secondary)",
            fontSize: 11,
          }}
        >
          Reset to mine
        </button>
      )}
    </div>
  );
}
