/**
 * `ReviewerDisciplineBadge` — Track 1 / addendum D1.
 *
 * Pins the seven-value label map, the dept-token mapping (so a future
 * sprint that splits MEP into electrical / mechanical / plumbing can
 * land its own CSS without us silently rewriting the chip palette),
 * and the `data-discipline` attribute that surface tests filter on.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReviewerDisciplineBadge } from "../ReviewerDisciplineBadge";

const CASES: Array<{
  discipline:
    | "building"
    | "electrical"
    | "mechanical"
    | "plumbing"
    | "residential"
    | "fire-life-safety"
    | "accessibility";
  label: string;
  deptClass: string;
}> = [
  { discipline: "building", label: "Building", deptClass: "dept-architectural" },
  { discipline: "electrical", label: "Electrical", deptClass: "dept-mep" },
  { discipline: "mechanical", label: "Mechanical", deptClass: "dept-mep" },
  { discipline: "plumbing", label: "Plumbing", deptClass: "dept-mep" },
  {
    discipline: "residential",
    label: "Residential",
    deptClass: "dept-architectural",
  },
  {
    discipline: "fire-life-safety",
    label: "Fire/Life Safety",
    deptClass: "dept-fire-life-safety",
  },
  {
    discipline: "accessibility",
    label: "Accessibility",
    deptClass: "dept-architectural",
  },
];

describe("ReviewerDisciplineBadge", () => {
  for (const c of CASES) {
    it(`renders ${c.discipline} with label "${c.label}" and the ${c.deptClass} CSS token`, () => {
      render(<ReviewerDisciplineBadge discipline={c.discipline} />);
      const badge = screen.getByTestId(
        `reviewer-discipline-badge-${c.discipline}`,
      );
      expect(badge).toHaveTextContent(c.label);
      expect(badge).toHaveAttribute("data-discipline", c.discipline);
      expect(badge.classList.contains("sc-dept-badge")).toBe(true);
      expect(badge.classList.contains(c.deptClass)).toBe(true);
    });
  }

  it("respects the size='sm' prop with a smaller padding/font", () => {
    render(<ReviewerDisciplineBadge discipline="electrical" size="sm" />);
    const badge = screen.getByTestId("reviewer-discipline-badge-electrical");
    // The smaller variant just sets inline styles — pin those so a
    // future refactor that drops them can't silently regress the
    // chip-bar layout.
    expect(badge.style.padding).toBe("1px 5px");
    expect(badge.style.fontSize).toBe("8px");
  });

  it("honors a custom data-testid override", () => {
    render(
      <ReviewerDisciplineBadge
        discipline="building"
        data-testid="custom-id"
      />,
    );
    expect(screen.getByTestId("custom-id")).toBeInTheDocument();
  });
});
