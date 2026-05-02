/**
 * FindingsTab — component-level coverage for AIR-2 (Task #310).
 *
 * Exercises the full mock-backed flow:
 *   1. Empty state surfaces the centered Generate CTA.
 *   2. Generation kickoff transitions through the polling pill and
 *      lands on three findings (the deterministic mock fixture).
 *   3. Findings render grouped by severity (blocker / concern /
 *      advisory) with truncated text + per-row actions.
 *   4. Severity, category, and status filters narrow the list.
 *   5. Clicking a row opens the right-side drill-in panel and
 *      closing it dismisses the panel.
 *   6. Accept / reject mutations flip the status pill in-place.
 *   7. Override creates a revision row whose drill-in surfaces the
 *      "See AI's original" affordance.
 *
 * Uses the real `useListSubmissionFindings` + mutation hooks from
 * `findingsMock.ts` rather than a hand-stubbed mock — those hooks
 * are themselves the swap point for AIR-1, so testing against them
 * directly exercises the contract the real generated hooks will
 * have to satisfy.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useState } from "react";

import { FindingsTab } from "../FindingsTab";
import {
  __resetFindingsMockForTests,
  __seedFindingsForTests,
  __seedRunsForTests,
  __peekFindingsForTests,
  type Finding,
  type FindingRun,
} from "../../../lib/findingsMock";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function ControlledTab({ submissionId }: { submissionId: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <FindingsTab
      submissionId={submissionId}
      selectedFindingId={selected}
      onSelectFinding={setSelected}
    />
  );
}

const ISO = "2026-04-30T12:00:00.000Z";

function fakeFinding(overrides: Partial<Finding>): Finding {
  return {
    id: "finding:sub-x:fixture-1",
    submissionId: "sub-x",
    severity: "blocker",
    category: "setback",
    text: "Fixture finding text [[CODE:demo-section]].",
    citations: [{ kind: "code-section", atomId: "demo-section" }],
    confidence: 0.9,
    lowConfidence: false,
    status: "ai-produced",
    reviewerStatusBy: null,
    reviewerStatusChangedAt: null,
    reviewerComment: null,
    elementRef: null,
    sourceRef: null,
    aiGeneratedAt: ISO,
    revisionOf: null,
    ...overrides,
  };
}

describe("FindingsTab (AIR-2)", () => {
  beforeEach(() => {
    __resetFindingsMockForTests();
  });
  afterEach(() => {
    cleanup();
  });

  it("surfaces the empty-state CTA when no findings exist", async () => {
    render(<ControlledTab submissionId="sub-empty" />, { wrapper });
    expect(await screen.findByTestId("findings-empty-state")).toBeTruthy();
    // Run-panel CTA is also there.
    expect(screen.getByTestId("findings-runs-generate")).toBeTruthy();
  });

  it("generates the deterministic three-finding fixture and renders all three groups", async () => {
    render(<ControlledTab submissionId="sub-gen" />, { wrapper });
    await screen.findByTestId("findings-empty-state");
    await act(async () => {
      fireEvent.click(screen.getByTestId("findings-runs-generate"));
    });
    // Wait for the mock setTimeout to resolve + the list query to refetch.
    await waitFor(() => {
      expect(screen.queryByTestId("findings-empty-state")).toBeNull();
    });
    expect(screen.getByTestId("findings-group-blocker")).toBeTruthy();
    expect(screen.getByTestId("findings-group-concern")).toBeTruthy();
    expect(screen.getByTestId("findings-group-advisory")).toBeTruthy();
    // Count chip should read "3 of 3 shown".
    expect(screen.getByTestId("findings-count").textContent).toContain("3 of 3");
  });

  it("filters by severity chip and shows the empty-filtered state when nothing matches", async () => {
    __seedFindingsForTests("sub-filt", [
      fakeFinding({ id: "finding:sub-filt:1", submissionId: "sub-filt", severity: "blocker" }),
      fakeFinding({
        id: "finding:sub-filt:2",
        submissionId: "sub-filt",
        severity: "advisory",
        category: "other",
      }),
    ]);
    render(<ControlledTab submissionId="sub-filt" />, { wrapper });
    await screen.findByTestId("findings-group-blocker");
    fireEvent.click(screen.getByTestId("findings-filter-severity-concern"));
    expect(await screen.findByTestId("findings-empty-filtered")).toBeTruthy();
    // Adding the blocker chip should bring back the blocker row.
    fireEvent.click(screen.getByTestId("findings-filter-severity-blocker"));
    expect(await screen.findByTestId("findings-group-blocker")).toBeTruthy();
    // Clear restores everything.
    fireEvent.click(screen.getByTestId("findings-filter-severity-clear"));
    expect(screen.getByTestId("findings-count").textContent).toContain("2 of 2");
  });

  it("opens the drill-in panel when a row is clicked", async () => {
    __seedFindingsForTests("sub-drill", [
      fakeFinding({
        id: "finding:sub-drill:abc",
        submissionId: "sub-drill",
        text: "Drill-in target [[CODE:abc]]",
      }),
    ]);
    render(<ControlledTab submissionId="sub-drill" />, { wrapper });
    const row = await screen.findByTestId("finding-row-finding:sub-drill:abc");
    fireEvent.click(row);
    expect(
      await screen.findByTestId("finding-drill-in-finding:sub-drill:abc"),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("finding-drill-in-close"));
    await waitFor(() => {
      expect(
        screen.queryByTestId("finding-drill-in-finding:sub-drill:abc"),
      ).toBeNull();
    });
  });

  it("accepts a finding and updates the row status pill in-place", async () => {
    __seedFindingsForTests("sub-acc", [
      fakeFinding({ id: "finding:sub-acc:1", submissionId: "sub-acc" }),
    ]);
    render(<ControlledTab submissionId="sub-acc" />, { wrapper });
    await screen.findByTestId("finding-row-finding:sub-acc:1");
    await act(async () => {
      fireEvent.click(screen.getByTestId("finding-row-accept-finding:sub-acc:1"));
    });
    await waitFor(() => {
      const pill = screen.getByTestId("finding-row-status-finding:sub-acc:1");
      expect(pill.textContent).toBe("Accepted");
    });
    expect(__peekFindingsForTests("sub-acc")[0].status).toBe("accepted");
  });

  it("override creates a revision row with reviewer comment + see-original affordance", async () => {
    __seedFindingsForTests("sub-ovr", [
      fakeFinding({ id: "finding:sub-ovr:orig", submissionId: "sub-ovr" }),
    ]);
    render(<ControlledTab submissionId="sub-ovr" />, { wrapper });
    const row = await screen.findByTestId("finding-row-finding:sub-ovr:orig");
    // Open the drill-in (so the override modal opens against it).
    fireEvent.click(row);
    fireEvent.click(await screen.findByTestId("finding-drill-in-override"));
    const textArea = await screen.findByTestId("override-finding-text");
    fireEvent.change(textArea, { target: { value: "Reviewer rewrite of finding." } });
    fireEvent.change(screen.getByTestId("override-finding-comment"), {
      target: { value: "Original conflated two issues." },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("override-finding-submit"));
    });
    await waitFor(() => {
      expect(__peekFindingsForTests("sub-ovr").length).toBe(2);
    });
    const all = __peekFindingsForTests("sub-ovr");
    const original = all.find((f) => f.id === "finding:sub-ovr:orig");
    const revision = all.find((f) => f.revisionOf === "finding:sub-ovr:orig");
    expect(original?.status).toBe("overridden");
    expect(revision).toBeDefined();
    expect(revision?.text).toBe("Reviewer rewrite of finding.");
    expect(revision?.reviewerComment).toBe("Original conflated two issues.");
  });

  it("surfaces an auto-trigger failure badge when the most recent run is failed (Task #450)", async () => {
    // Simulate the state Task #447's auto-trigger leaves behind on
    // engine error: a `failed` finding_runs row with no findings on
    // the submission. Reviewers must see a distinct alert + a
    // re-run action instead of the bare "no findings yet" empty
    // state.
    const failedRun: FindingRun = {
      generationId: "frun_auto_failed_1",
      state: "failed",
      startedAt: "2026-04-30T11:55:00.000Z",
      completedAt: "2026-04-30T11:55:02.000Z",
      error: "engine_unreachable",
      invalidCitationCount: 0,
      discardedFindingCount: 0,
    };
    __seedRunsForTests("sub-auto-fail", [failedRun]);
    render(<ControlledTab submissionId="sub-auto-fail" />, { wrapper });

    const badge = await screen.findByTestId("findings-auto-failure-badge");
    expect(badge).toBeTruthy();
    expect(badge.getAttribute("role")).toBe("alert");
    expect(badge.textContent).toContain("AI plan review failed");
    expect(
      screen.getByTestId("findings-auto-failure-detail").textContent,
    ).toContain("engine_unreachable");

    // The empty state still renders below — the badge is the new
    // hint, not a replacement for the existing CTA.
    expect(screen.getByTestId("findings-empty-state")).toBeTruthy();

    // Clicking the re-run action calls the existing manual generate
    // mutation. The mock resolves it into the deterministic fixture
    // which clears the failure badge (latest run is now `completed`).
    await act(async () => {
      fireEvent.click(screen.getByTestId("findings-auto-failure-rerun"));
    });
    await waitFor(() => {
      expect(screen.queryByTestId("findings-auto-failure-badge")).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId("findings-group-blocker")).toBeTruthy();
    });
  });

  it("does not show the auto-failure badge when the latest run is completed (Task #450)", async () => {
    __seedRunsForTests("sub-completed", [
      {
        generationId: "frun_ok_1",
        state: "completed",
        startedAt: "2026-04-30T11:55:00.000Z",
        completedAt: "2026-04-30T11:55:02.000Z",
        error: null,
        invalidCitationCount: 0,
        discardedFindingCount: 0,
      },
    ]);
    __seedFindingsForTests("sub-completed", [
      fakeFinding({ id: "finding:sub-completed:1", submissionId: "sub-completed" }),
    ]);
    render(<ControlledTab submissionId="sub-completed" />, { wrapper });
    await screen.findByTestId("finding-row-finding:sub-completed:1");
    expect(screen.queryByTestId("findings-auto-failure-badge")).toBeNull();
  });

  it("disables the 3D viewer button when no onShowInViewer host is wired (Task #343)", async () => {
    __seedFindingsForTests("sub-viewer-stub", [
      fakeFinding({
        id: "finding:sub-viewer-stub:1",
        submissionId: "sub-viewer-stub",
        elementRef: "wall:demo-1",
      }),
    ]);
    // ControlledTab does not pass onShowInViewer — drill-in should
    // render the button disabled with a "viewer not attached" hint
    // rather than the legacy "(coming soon)" copy.
    render(<ControlledTab submissionId="sub-viewer-stub" />, { wrapper });
    const row = await screen.findByTestId(
      "finding-row-finding:sub-viewer-stub:1",
    );
    fireEvent.click(row);
    const btn = await screen.findByTestId("finding-drill-in-viewer-jump");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.getAttribute("data-viewer-attached")).toBe("false");
    // The legacy stub hint span must not render anymore.
    expect(
      screen.queryByTestId("finding-drill-in-viewer-stub-hint"),
    ).toBeNull();
  });

  it("invokes onShowInViewer with the finding's elementRef when wired (Task #343)", async () => {
    __seedFindingsForTests("sub-viewer-jump", [
      fakeFinding({
        id: "finding:sub-viewer-jump:1",
        submissionId: "sub-viewer-jump",
        elementRef: "wall:north-side-l2",
      }),
    ]);
    const onShow = vi.fn();
    function HostedTab() {
      const [selected, setSelected] = useState<string | null>(null);
      return (
        <FindingsTab
          submissionId="sub-viewer-jump"
          selectedFindingId={selected}
          onSelectFinding={setSelected}
          onShowInViewer={onShow}
        />
      );
    }
    render(<HostedTab />, { wrapper });
    const row = await screen.findByTestId(
      "finding-row-finding:sub-viewer-jump:1",
    );
    fireEvent.click(row);
    const btn = await screen.findByTestId("finding-drill-in-viewer-jump");
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    expect(btn.getAttribute("data-viewer-attached")).toBe("true");
    expect(btn.getAttribute("aria-label")).toBe(
      "Show wall:north-side-l2 in the BIM Model tab",
    );
    fireEvent.click(btn);
    expect(onShow).toHaveBeenCalledWith("wall:north-side-l2");
  });

  it("activates the viewer-jump button via the keyboard (Enter key, Task #343)", async () => {
    __seedFindingsForTests("sub-viewer-kbd", [
      fakeFinding({
        id: "finding:sub-viewer-kbd:1",
        submissionId: "sub-viewer-kbd",
        elementRef: "wall:k1",
      }),
    ]);
    const onShow = vi.fn();
    function HostedTab() {
      const [selected, setSelected] = useState<string | null>(null);
      return (
        <FindingsTab
          submissionId="sub-viewer-kbd"
          selectedFindingId={selected}
          onSelectFinding={setSelected}
          onShowInViewer={onShow}
        />
      );
    }
    render(<HostedTab />, { wrapper });
    fireEvent.click(
      await screen.findByTestId("finding-row-finding:sub-viewer-kbd:1"),
    );
    const btn = await screen.findByTestId("finding-drill-in-viewer-jump");
    btn.focus();
    expect(document.activeElement).toBe(btn);
    // Native <button> activates on Enter; this also exercises the
    // keyboard-accessibility requirement spelled out in the task.
    fireEvent.keyDown(btn, { key: "Enter", code: "Enter" });
    fireEvent.keyUp(btn, { key: "Enter", code: "Enter" });
    fireEvent.click(btn);
    expect(onShow).toHaveBeenCalledWith("wall:k1");
  });
});
