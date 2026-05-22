import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FindingCard } from "./FindingCard";
import { makeFinding } from "../__fixtures__/findings";

/**
 * FindingCard is the structural-commitment-1 surface: it must sell the
 * engine's reasoning, never a bare verdict. These tests pin that every
 * finding renders its full text, every citation, the confidence score,
 * and the generation timestamp.
 */
describe("FindingCard", () => {
  it("renders the engine's full finding text", () => {
    const finding = makeFinding({
      text: "Front setback is 12 ft; the R-1 district requires 25 ft.",
    });
    render(<FindingCard finding={finding} />);
    expect(
      screen.getByText(/Front setback is 12 ft; the R-1 district requires 25 ft\./),
    ).toBeTruthy();
  });

  it("renders every source citation", () => {
    const finding = makeFinding({
      citations: [
        { kind: "code-section", atomId: "code-section:r1-setbacks" },
        { kind: "briefing-source", id: "bs-1", label: "Boundary survey" },
      ],
    });
    render(<FindingCard finding={finding} />);
    expect(screen.getAllByTestId("finding-citation")).toHaveLength(2);
    expect(screen.getByText("code-section:r1-setbacks")).toBeTruthy();
    expect(screen.getByText("Boundary survey")).toBeTruthy();
  });

  it("shows the confidence score and the generation timestamp", () => {
    const finding = makeFinding({ confidence: 0.82 });
    render(<FindingCard finding={finding} />);
    expect(screen.getByTestId("finding-confidence").textContent).toContain(
      "82%",
    );
    expect(screen.getByTestId("finding-timestamp").textContent).toMatch(
      /Generated/,
    );
  });

  it("flags a low-confidence finding", () => {
    const finding = makeFinding({ confidence: 0.4, lowConfidence: true });
    render(<FindingCard finding={finding} />);
    expect(screen.getByTestId("finding-confidence").textContent).toContain(
      "flagged low",
    );
  });

  it("renders the severity and status", () => {
    const finding = makeFinding({ severity: "concern", status: "accepted" });
    render(<FindingCard finding={finding} />);
    expect(screen.getByTestId("finding-severity").textContent).toBe("Concern");
    expect(screen.getByTestId("finding-status").textContent).toBe("Accepted");
  });
});
