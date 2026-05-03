/**
 * `DisciplineFilterChipBar` — Track 1.
 *
 * Pins the four affordances reviewer-side surfaces depend on:
 *  - clicking a chip toggles via the supplied callback,
 *  - selected chips advertise `data-selected="true"` so surface tests
 *    can assert which subset is active without reading inline styles,
 *  - "Show all" only renders when narrowing is in effect,
 *  - "Reset to mine" only renders when the active selection diverges
 *    from the reviewer's configured set.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DisciplineFilterChipBar } from "../DisciplineFilterChipBar";

const ALL = [
  "building",
  "electrical",
  "mechanical",
  "plumbing",
  "residential",
  "fire-life-safety",
  "accessibility",
] as const;

describe("DisciplineFilterChipBar", () => {
  it("renders nothing when hidden", () => {
    const { container } = render(
      <DisciplineFilterChipBar
        selected={new Set()}
        allDisciplines={ALL}
        isShowingAll
        onToggle={() => {}}
        onShowAll={() => {}}
        onResetToMine={() => {}}
        userDisciplines={[]}
        hidden
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders all seven chips with the right selected state", () => {
    render(
      <DisciplineFilterChipBar
        selected={new Set(["electrical", "fire-life-safety"])}
        allDisciplines={ALL}
        isShowingAll={false}
        onToggle={() => {}}
        onShowAll={() => {}}
        onResetToMine={() => {}}
        userDisciplines={["electrical", "fire-life-safety"]}
      />,
    );
    expect(
      screen.getByTestId("discipline-filter-chip-electrical"),
    ).toHaveAttribute("data-selected", "true");
    expect(
      screen.getByTestId("discipline-filter-chip-fire-life-safety"),
    ).toHaveAttribute("data-selected", "true");
    expect(
      screen.getByTestId("discipline-filter-chip-building"),
    ).toHaveAttribute("data-selected", "false");
  });

  it("calls onToggle with the right discipline value", () => {
    const onToggle = vi.fn();
    render(
      <DisciplineFilterChipBar
        selected={new Set(["electrical"])}
        allDisciplines={ALL}
        isShowingAll={false}
        onToggle={onToggle}
        onShowAll={() => {}}
        onResetToMine={() => {}}
        userDisciplines={["electrical"]}
      />,
    );
    fireEvent.click(screen.getByTestId("discipline-filter-chip-mechanical"));
    expect(onToggle).toHaveBeenCalledWith("mechanical");
  });

  it("hides the Show all affordance when already showing everything", () => {
    render(
      <DisciplineFilterChipBar
        selected={new Set()}
        allDisciplines={ALL}
        isShowingAll
        onToggle={() => {}}
        onShowAll={() => {}}
        onResetToMine={() => {}}
        userDisciplines={[]}
      />,
    );
    expect(
      screen.queryByTestId("discipline-filter-show-all"),
    ).not.toBeInTheDocument();
  });

  it("hides Reset to mine when the active selection equals the user's configured set", () => {
    render(
      <DisciplineFilterChipBar
        selected={new Set(["electrical", "fire-life-safety"])}
        allDisciplines={ALL}
        isShowingAll={false}
        onToggle={() => {}}
        onShowAll={() => {}}
        onResetToMine={() => {}}
        userDisciplines={["electrical", "fire-life-safety"]}
      />,
    );
    expect(
      screen.queryByTestId("discipline-filter-reset-mine"),
    ).not.toBeInTheDocument();
  });

  it("shows Reset to mine once the active set diverges from the user's configured set", () => {
    const onResetToMine = vi.fn();
    render(
      <DisciplineFilterChipBar
        selected={new Set(["electrical"])}
        allDisciplines={ALL}
        isShowingAll={false}
        onToggle={() => {}}
        onShowAll={() => {}}
        onResetToMine={onResetToMine}
        userDisciplines={["electrical", "fire-life-safety"]}
      />,
    );
    const reset = screen.getByTestId("discipline-filter-reset-mine");
    fireEvent.click(reset);
    expect(onResetToMine).toHaveBeenCalledTimes(1);
  });

  it("invokes onShowAll when the Show all button is clicked", () => {
    const onShowAll = vi.fn();
    render(
      <DisciplineFilterChipBar
        selected={new Set(["electrical"])}
        allDisciplines={ALL}
        isShowingAll={false}
        onToggle={() => {}}
        onShowAll={onShowAll}
        onResetToMine={() => {}}
        userDisciplines={["electrical"]}
      />,
    );
    fireEvent.click(screen.getByTestId("discipline-filter-show-all"));
    expect(onShowAll).toHaveBeenCalledTimes(1);
  });
});
