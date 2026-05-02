import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Finding } from "@workspace/api-client-react";
import { FindingDetailPanel } from "../FindingDetailPanel";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "finding:sub-1:01",
    submissionId: "sub-1",
    severity: "blocker",
    category: "egress",
    status: "ai-produced",
    text: "Door clearance fails per [[CODE:11B-404.2.4]] at corridor.",
    citations: [
      { kind: "code-section", atomId: "11B-404.2.4" },
      {
        kind: "briefing-source",
        id: "src-1",
        label: "BIM model: door at L2",
      },
    ],
    confidence: 0.92,
    lowConfidence: false,
    reviewerStatusBy: null,
    reviewerStatusChangedAt: null,
    reviewerComment: null,
    elementRef: "door:l2-corridor-9",
    sourceRef: null,
    aiGeneratedAt: "2026-05-01T00:00:00Z",
    revisionOf: null,
    ...overrides,
  };
}

describe("FindingDetailPanel", () => {
  afterEach(() => cleanup());

  it("does not show the addressed-confirmation indicator before any override attempt", () => {
    const finding = makeFinding();
    render(
      <FindingDetailPanel
        finding={finding}
        codeLibraryBase="/design-tools/code-library"
        onAddressWithRevision={() => {}}
        isAddressing={false}
      />,
    );
    expect(
      screen.queryByTestId("architect-finding-detail-addressed-confirmation"),
    ).toBeNull();
  });

  it("renders the empty state when finding is null", () => {
    render(
      <FindingDetailPanel
        finding={null}
        codeLibraryBase="/design-tools/code-library"
        onAddressWithRevision={() => {}}
        isAddressing={false}
      />,
    );
    expect(screen.getByTestId("architect-finding-detail-empty")).toBeTruthy();
  });

  it("renders body, citations, CAD ref, and AI attribution", () => {
    const finding = makeFinding();
    render(
      <FindingDetailPanel
        finding={finding}
        codeLibraryBase="/design-tools/code-library"
        onAddressWithRevision={() => {}}
        isAddressing={false}
      />,
    );
    expect(
      screen.getByTestId(`architect-finding-detail-${finding.id}`),
    ).toBeTruthy();
    expect(
      screen.getByTestId("architect-finding-detail-attribution").textContent,
    ).toBe("AI-produced");
    expect(
      screen.getByTestId("architect-finding-detail-cad-ref").textContent,
    ).toContain("door:l2-corridor-9");
    expect(
      screen.getByTestId("architect-finding-citation-code-11B-404.2.4"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("architect-finding-citation-source-src-1"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("architect-finding-detail-body").textContent,
    ).toContain("Door clearance fails");
  });

  it("renders Reviewer-promoted attribution for reviewer-touched rows", () => {
    const finding = makeFinding({
      reviewerStatusBy: {
        kind: "user",
        id: "u-1",
        displayName: "Rita Reviewer",
      },
    });
    render(
      <FindingDetailPanel
        finding={finding}
        codeLibraryBase="/design-tools/code-library"
        onAddressWithRevision={() => {}}
        isAddressing={false}
      />,
    );
    expect(
      screen.getByTestId("architect-finding-detail-attribution").textContent,
    ).toBe("Reviewer-promoted");
    expect(
      screen.getByTestId("architect-finding-detail-meta").textContent,
    ).toContain("Rita Reviewer");
  });

  it("fires onAddressWithRevision with the active finding on click", () => {
    const finding = makeFinding();
    const onAddress = vi.fn();
    render(
      <FindingDetailPanel
        finding={finding}
        codeLibraryBase="/design-tools/code-library"
        onAddressWithRevision={onAddress}
        isAddressing={false}
      />,
    );
    fireEvent.click(
      screen.getByTestId("architect-finding-detail-address-button"),
    );
    expect(onAddress).toHaveBeenCalledTimes(1);
    expect(onAddress).toHaveBeenCalledWith(finding);
  });

  it("disables the button and shows Addressing… while in flight", () => {
    const finding = makeFinding();
    render(
      <FindingDetailPanel
        finding={finding}
        codeLibraryBase="/design-tools/code-library"
        onAddressWithRevision={() => {}}
        isAddressing={true}
      />,
    );
    const btn = screen.getByTestId(
      "architect-finding-detail-address-button",
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("Addressing");
  });

  it("disables the button and shows Addressed for overridden rows", () => {
    const finding = makeFinding({ status: "overridden" });
    render(
      <FindingDetailPanel
        finding={finding}
        codeLibraryBase="/design-tools/code-library"
        onAddressWithRevision={() => {}}
        isAddressing={false}
      />,
    );
    const btn = screen.getByTestId(
      "architect-finding-detail-address-button",
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("Addressed");
  });

  it("surfaces addressError inline", () => {
    const finding = makeFinding();
    render(
      <FindingDetailPanel
        finding={finding}
        codeLibraryBase="/design-tools/code-library"
        onAddressWithRevision={() => {}}
        isAddressing={false}
        addressError="Override failed: 503"
      />,
    );
    expect(
      screen.getByTestId("architect-finding-detail-error").textContent,
    ).toContain("Override failed");
  });

  it("renders code-section citations as a CodeAtomPill linking to the Code Library", () => {
    const finding = makeFinding();
    render(
      <FindingDetailPanel
        finding={finding}
        codeLibraryBase="/design-tools/code-library"
        onAddressWithRevision={() => {}}
        isAddressing={false}
      />,
    );
    const li = screen.getByTestId(
      "architect-finding-citation-code-11B-404.2.4",
    );
    const link = li.querySelector("a");
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe(
      "/design-tools/code-library?atom=11B-404.2.4",
    );
  });

  it("fires onRetry with the active finding when the inline retry button is clicked", () => {
    const finding = makeFinding();
    const onRetry = vi.fn();
    render(
      <FindingDetailPanel
        finding={finding}
        codeLibraryBase="/design-tools/code-library"
        onAddressWithRevision={() => {}}
        isAddressing={false}
        addressError="Override failed: 503"
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByTestId("architect-finding-detail-retry"));
    expect(onRetry).toHaveBeenCalledWith(finding);
  });

  describe("addressed-confirmation indicator", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("appears when isAddressing transitions true → false with no error and auto-dismisses after 8s", () => {
      const finding = makeFinding();
      const { rerender } = render(
        <FindingDetailPanel
          finding={finding}
          codeLibraryBase="/design-tools/code-library"
          onAddressWithRevision={() => {}}
          isAddressing={true}
        />,
      );
      expect(
        screen.queryByTestId(
          "architect-finding-detail-addressed-confirmation",
        ),
      ).toBeNull();

      // Mutation settles successfully — finding flips to overridden.
      rerender(
        <FindingDetailPanel
          finding={makeFinding({ status: "overridden" })}
          codeLibraryBase="/design-tools/code-library"
          onAddressWithRevision={() => {}}
          isAddressing={false}
        />,
      );
      const indicator = screen.getByTestId(
        "architect-finding-detail-addressed-confirmation",
      );
      expect(indicator.textContent).toContain("Marked addressed");
      expect(indicator.getAttribute("role")).toBe("status");
      expect(indicator.getAttribute("aria-live")).toBe("polite");

      act(() => {
        vi.advanceTimersByTime(7999);
      });
      expect(
        screen.queryByTestId(
          "architect-finding-detail-addressed-confirmation",
        ),
      ).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(2);
      });
      expect(
        screen.queryByTestId(
          "architect-finding-detail-addressed-confirmation",
        ),
      ).toBeNull();
    });

    it("does not appear when the override settles with an error", () => {
      const finding = makeFinding();
      const { rerender } = render(
        <FindingDetailPanel
          finding={finding}
          codeLibraryBase="/design-tools/code-library"
          onAddressWithRevision={() => {}}
          isAddressing={true}
        />,
      );
      rerender(
        <FindingDetailPanel
          finding={finding}
          codeLibraryBase="/design-tools/code-library"
          onAddressWithRevision={() => {}}
          isAddressing={false}
          addressError="Override failed: 503"
        />,
      );
      expect(
        screen.queryByTestId(
          "architect-finding-detail-addressed-confirmation",
        ),
      ).toBeNull();
    });

    it("clears the indicator when the user navigates to a different finding", () => {
      const a = makeFinding({ id: "finding:sub-1:01" });
      const b = makeFinding({ id: "finding:sub-1:02" });
      const { rerender } = render(
        <FindingDetailPanel
          finding={a}
          codeLibraryBase="/design-tools/code-library"
          onAddressWithRevision={() => {}}
          isAddressing={true}
        />,
      );
      rerender(
        <FindingDetailPanel
          finding={a}
          codeLibraryBase="/design-tools/code-library"
          onAddressWithRevision={() => {}}
          isAddressing={false}
        />,
      );
      expect(
        screen.queryByTestId(
          "architect-finding-detail-addressed-confirmation",
        ),
      ).not.toBeNull();

      rerender(
        <FindingDetailPanel
          finding={b}
          codeLibraryBase="/design-tools/code-library"
          onAddressWithRevision={() => {}}
          isAddressing={false}
        />,
      );
      expect(
        screen.queryByTestId(
          "architect-finding-detail-addressed-confirmation",
        ),
      ).toBeNull();
    });
  });

  it("renders elementRef as a clickable link and fires onElementRefClick with the raw ref", () => {
    const finding = makeFinding();
    const onElementRefClick = vi.fn();
    render(
      <FindingDetailPanel
        finding={finding}
        codeLibraryBase="/design-tools/code-library"
        onAddressWithRevision={() => {}}
        isAddressing={false}
        onElementRefClick={onElementRefClick}
      />,
    );
    const link = screen.getByTestId("architect-finding-detail-cad-ref-link");
    expect(link.tagName).toBe("BUTTON");
    expect(link.textContent).toContain("door:l2-corridor-9");
    fireEvent.click(link);
    expect(onElementRefClick).toHaveBeenCalledTimes(1);
    expect(onElementRefClick).toHaveBeenCalledWith("door:l2-corridor-9");
  });

  it("renders elementRef as plain text when onElementRefClick is not wired", () => {
    const finding = makeFinding();
    render(
      <FindingDetailPanel
        finding={finding}
        codeLibraryBase="/design-tools/code-library"
        onAddressWithRevision={() => {}}
        isAddressing={false}
      />,
    );
    expect(
      screen.queryByTestId("architect-finding-detail-cad-ref-link"),
    ).toBeNull();
    expect(
      screen.getByTestId("architect-finding-detail-cad-ref").textContent,
    ).toContain("door:l2-corridor-9");
  });

  it("does not render the CAD-element block when elementRef is null, even with onElementRefClick wired", () => {
    const finding = makeFinding({ elementRef: null });
    const onElementRefClick = vi.fn();
    render(
      <FindingDetailPanel
        finding={finding}
        codeLibraryBase="/design-tools/code-library"
        onAddressWithRevision={() => {}}
        isAddressing={false}
        onElementRefClick={onElementRefClick}
      />,
    );
    expect(
      screen.queryByTestId("architect-finding-detail-cad-ref"),
    ).toBeNull();
    expect(
      screen.queryByTestId("architect-finding-detail-cad-ref-link"),
    ).toBeNull();
    expect(onElementRefClick).not.toHaveBeenCalled();
  });

  it("dismisses the active finding via Escape and renders a close button when onClose is wired", () => {
    const finding = makeFinding();
    const onClose = vi.fn();
    render(
      <FindingDetailPanel
        finding={finding}
        codeLibraryBase="/design-tools/code-library"
        onAddressWithRevision={() => {}}
        isAddressing={false}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId("architect-finding-detail-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
