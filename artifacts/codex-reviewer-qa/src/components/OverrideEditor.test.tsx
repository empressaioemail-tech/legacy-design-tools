import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OverrideEditor } from "./OverrideEditor";
import { makeFinding } from "../__fixtures__/findings";

describe("OverrideEditor", () => {
  it("pre-fills the form from the finding", () => {
    const finding = makeFinding({
      text: "Original engine text.",
      severity: "blocker",
    });
    render(
      <OverrideEditor finding={finding} onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(
      screen.getByTestId<HTMLTextAreaElement>("override-text").value,
    ).toBe("Original engine text.");
    expect(
      screen.getByTestId<HTMLSelectElement>("override-severity").value,
    ).toBe("blocker");
  });

  it("disables submit until a reason is given", () => {
    render(
      <OverrideEditor
        finding={makeFinding()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId<HTMLButtonElement>("override-submit").disabled,
    ).toBe(true);
    fireEvent.change(screen.getByTestId("override-comment"), {
      target: { value: "Setback was misread." },
    });
    expect(
      screen.getByTestId<HTMLButtonElement>("override-submit").disabled,
    ).toBe(false);
  });

  it("submits the edited draft", () => {
    const onSubmit = vi.fn();
    render(
      <OverrideEditor
        finding={makeFinding()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("override-text"), {
      target: { value: "Corrected text." },
    });
    fireEvent.change(screen.getByTestId("override-severity"), {
      target: { value: "concern" },
    });
    fireEvent.change(screen.getByTestId("override-comment"), {
      target: { value: "Downgraded to concern." },
    });
    fireEvent.click(screen.getByTestId("override-submit"));
    expect(onSubmit).toHaveBeenCalledWith({
      text: "Corrected text.",
      severity: "concern",
      category: "setback",
      reviewerComment: "Downgraded to concern.",
    });
  });

  it("cancels without submitting", () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    render(
      <OverrideEditor
        finding={makeFinding()}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByTestId("override-cancel"));
    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
