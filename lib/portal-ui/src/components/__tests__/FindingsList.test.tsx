import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Finding } from "@workspace/api-client-react";
import {
  FindingsList,
  countUnaddressedFindings,
} from "../FindingsList";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "finding:sub-1:01",
    submissionId: "sub-1",
    severity: "advisory",
    category: "egress",
    status: "ai-produced",
    text: "Body",
    citations: [],
    confidence: 0.8,
    lowConfidence: false,
    reviewerStatusBy: null,
    reviewerStatusChangedAt: null,
    reviewerComment: null,
    elementRef: null,
    sourceRef: null,
    aiGeneratedAt: "2026-05-01T00:00:00Z",
    revisionOf: null,
    ...overrides,
  };
}

describe("FindingsList", () => {
  afterEach(() => cleanup());

  it("sorts blocker before concern before advisory, oldest first within bucket", () => {
    const findings: Finding[] = [
      makeFinding({
        id: "f-advisory",
        severity: "advisory",
        aiGeneratedAt: "2026-05-01T00:00:00Z",
      }),
      makeFinding({
        id: "f-blocker-newer",
        severity: "blocker",
        aiGeneratedAt: "2026-05-02T00:00:00Z",
      }),
      makeFinding({
        id: "f-concern",
        severity: "concern",
        aiGeneratedAt: "2026-05-01T00:00:00Z",
      }),
      makeFinding({
        id: "f-blocker-older",
        severity: "blocker",
        aiGeneratedAt: "2026-05-01T00:00:00Z",
      }),
    ];
    render(
      <FindingsList
        findings={findings}
        selectedFindingId={null}
        onSelect={() => {}}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "architect-findings-row-f-blocker-older",
      "architect-findings-row-f-blocker-newer",
      "architect-findings-row-f-concern",
      "architect-findings-row-f-advisory",
    ]);
  });

  it("marks the selected row and fires onSelect with the row id on click", () => {
    const onSelect = vi.fn();
    const findings = [
      makeFinding({ id: "f-1", severity: "blocker" }),
      makeFinding({ id: "f-2", severity: "concern" }),
    ];
    render(
      <FindingsList
        findings={findings}
        selectedFindingId="f-2"
        onSelect={onSelect}
      />,
    );
    expect(
      screen.getByTestId("architect-findings-row-f-2").getAttribute(
        "data-selected",
      ),
    ).toBe("true");
    expect(
      screen.getByTestId("architect-findings-row-f-1").getAttribute(
        "data-selected",
      ),
    ).toBe("false");
    fireEvent.click(screen.getByTestId("architect-findings-row-f-1"));
    expect(onSelect).toHaveBeenCalledWith("f-1");
  });

  it("dims addressed (overridden) rows and renders the addressed tag", () => {
    const findings = [
      makeFinding({ id: "f-open", severity: "blocker" }),
      makeFinding({
        id: "f-done",
        severity: "blocker",
        status: "overridden",
        aiGeneratedAt: "2026-04-30T00:00:00Z",
      }),
    ];
    render(
      <FindingsList
        findings={findings}
        selectedFindingId={null}
        onSelect={() => {}}
      />,
    );
    const done = screen.getByTestId("architect-findings-row-f-done");
    const open = screen.getByTestId("architect-findings-row-f-open");
    expect(done.getAttribute("data-addressed")).toBe("true");
    expect(open.getAttribute("data-addressed")).toBe("false");
    expect(done.style.opacity).toBe("0.55");
    expect(
      screen.getByTestId("architect-findings-row-f-done-addressed-tag"),
    ).toBeTruthy();
  });

  it("flags reviewer-promoted rows (promoted-to-architect, reviewer actor, revision)", () => {
    const findings = [
      makeFinding({ id: "f-ai", severity: "blocker" }),
      makeFinding({
        id: "f-promoted",
        severity: "blocker",
        status: "promoted-to-architect",
        aiGeneratedAt: "2026-05-01T00:00:01Z",
      }),
      makeFinding({
        id: "f-reviewer-actor",
        severity: "blocker",
        reviewerStatusBy: {
          kind: "user",
          id: "u-1",
          displayName: "Rita Reviewer",
        },
        aiGeneratedAt: "2026-05-01T00:00:02Z",
      }),
      makeFinding({
        id: "f-revision",
        severity: "blocker",
        revisionOf: "finding:sub-1:00",
        aiGeneratedAt: "2026-05-01T00:00:03Z",
      }),
    ];
    render(
      <FindingsList
        findings={findings}
        selectedFindingId={null}
        onSelect={() => {}}
      />,
    );
    expect(
      screen.getByTestId("architect-findings-row-f-ai-attribution")
        .textContent,
    ).toBe("AI");
    expect(
      screen.getByTestId("architect-findings-row-f-promoted-attribution")
        .textContent,
    ).toBe("Reviewer");
    expect(
      screen.getByTestId(
        "architect-findings-row-f-reviewer-actor-attribution",
      ).textContent,
    ).toBe("Reviewer");
    expect(
      screen.getByTestId("architect-findings-row-f-revision-attribution")
        .textContent,
    ).toBe("Reviewer");
  });

  it("countUnaddressedFindings excludes overridden rows", () => {
    const findings = [
      makeFinding({ id: "a", status: "ai-produced" }),
      makeFinding({ id: "b", status: "promoted-to-architect" }),
      makeFinding({ id: "c", status: "overridden" }),
      makeFinding({ id: "d", status: "accepted" }),
    ];
    expect(countUnaddressedFindings(findings)).toBe(3);
  });
});
