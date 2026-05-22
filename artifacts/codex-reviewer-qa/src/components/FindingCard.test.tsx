import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FindingCard } from "./FindingCard";
import { makeActor, makeFinding } from "../__fixtures__/findings";

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

describe("FindingCard — adjudication actions (CDX-4)", () => {
  const handlers = () => ({
    onAccept: vi.fn(),
    onReject: vi.fn(),
    onOverride: vi.fn(),
  });

  it("renders no action row when no handlers are supplied (read-only)", () => {
    render(<FindingCard finding={makeFinding()} />);
    expect(screen.queryByTestId("finding-actions")).toBeNull();
  });

  it("fires onAccept with the finding id", () => {
    const h = handlers();
    render(<FindingCard finding={makeFinding({ id: "f-1" })} {...h} />);
    fireEvent.click(screen.getByTestId("finding-accept"));
    expect(h.onAccept).toHaveBeenCalledWith("f-1");
  });

  it("fires onReject with the finding id", () => {
    const h = handlers();
    render(<FindingCard finding={makeFinding({ id: "f-1" })} {...h} />);
    fireEvent.click(screen.getByTestId("finding-reject"));
    expect(h.onReject).toHaveBeenCalledWith("f-1");
  });

  it("opens the override editor on Edit and submits an override", () => {
    const h = handlers();
    render(<FindingCard finding={makeFinding({ id: "f-1" })} {...h} />);
    expect(screen.queryByTestId("override-editor")).toBeNull();
    fireEvent.click(screen.getByTestId("finding-edit"));
    expect(screen.getByTestId("override-editor")).toBeTruthy();
    fireEvent.change(screen.getByTestId("override-comment"), {
      target: { value: "Reworded for clarity." },
    });
    fireEvent.click(screen.getByTestId("override-submit"));
    expect(h.onOverride).toHaveBeenCalledTimes(1);
    expect(h.onOverride.mock.calls[0][0]).toBe("f-1");
  });

  it("shows the server-stamped adjudication attribution", () => {
    render(
      <FindingCard
        finding={makeFinding({
          status: "accepted",
          acceptedBy: makeActor({ displayName: "Dana Cole" }),
          acceptedAt: "2026-05-21T09:00:00.000Z",
        })}
      />,
    );
    expect(screen.getByTestId("finding-adjudication").textContent).toContain(
      "Accepted by Dana Cole",
    );
  });

  it("surfaces an override error", () => {
    render(
      <FindingCard
        finding={makeFinding()}
        {...handlers()}
        overrideError="This finding has already been overridden once."
      />,
    );
    expect(
      screen.getByTestId("finding-override-error").textContent,
    ).toContain("already been overridden");
  });
});
