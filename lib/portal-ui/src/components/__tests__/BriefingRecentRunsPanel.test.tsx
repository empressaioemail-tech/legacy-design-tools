/**
 * BriefingRecentRunsPanel — Task #305 highlight props.
 *
 * The shared design-tools test (`artifacts/design-tools/src/pages/__
 * tests__/BriefingRecentRunsPanel.test.tsx`) already exhaustively
 * pins the disclosure's collapse/expand and per-state rendering via
 * the page-level wiring. This focused test pins ONLY the new
 * highlight props introduced by the reviewer-context refactor:
 *
 *   - `currentGenerationId` highlights the matching run row, tags
 *     it with a "Current" pill, and stamps `data-current="true"`.
 *   - `producingGenerationId` similarly tags + stamps a "Submitted"
 *     pill on the matching row.
 *   - When both ids are present and DIFFERENT, the disclosure
 *     header surfaces a `drifted` summary pill so the auditor sees
 *     the drift without expanding any row.
 *   - When both ids are present and EQUAL, the same header pill
 *     surfaces an `in-sync` summary instead.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

const hoisted = vi.hoisted(() => ({
  runs: {
    data: undefined as
      | {
          runs: Array<{
            generationId: string;
            state: "pending" | "completed" | "failed";
            startedAt: string;
            completedAt: string | null;
            error: string | null;
            invalidCitationCount: number | null;
          }>;
        }
      | undefined,
    isLoading: false,
    isError: false,
  },
}));

vi.mock("@workspace/api-client-react", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/api-client-react")>(
      "@workspace/api-client-react",
    );
  return {
    ...actual,
    useListEngagementBriefingGenerationRuns: () => hoisted.runs,
    getListEngagementBriefingGenerationRunsQueryKey: (id: string) => [
      "/engagements",
      id,
      "briefing",
      "generation-runs",
    ],
    // Task #314 — the panel now also reads the briefing's current
    // narrative to power the per-A–G prior-vs-current diff.
    // These tests don't exercise that branch (no priorNarrative is
    // ever passed), so a no-op stub that returns an empty result is
    // enough to satisfy the hook contract.
    useGetEngagementBriefing: () => ({
      data: undefined,
      isLoading: false,
      isError: false,
    }),
    getGetEngagementBriefingQueryKey: (id: string) => [
      "/engagements",
      id,
      "briefing",
    ],
  };
});

const { BriefingRecentRunsPanel } = await import(
  "../BriefingRecentRunsPanel"
);

beforeEach(() => {
  // Task #303 B.6 persists the disclosure's open/closed state to
  // `?recentRunsOpen=…`. Without resetting the URL between tests
  // the value bleeds across cases — a previous test that opened
  // the disclosure leaves `?recentRunsOpen=1` behind, so the next
  // test starts already-open and `fireEvent.click(toggle)` flips
  // it to CLOSED instead of opening it. Reset to a clean URL each
  // test to keep these focused unit tests independent.
  window.history.replaceState(null, "", "/");
  hoisted.runs.data = {
    runs: [
      {
        generationId: "gen-A",
        state: "completed",
        startedAt: "2026-01-02T09:00:00.000Z",
        completedAt: "2026-01-02T09:05:00.000Z",
        error: null,
        invalidCitationCount: 0,
      },
      {
        generationId: "gen-B",
        state: "completed",
        startedAt: "2026-01-01T09:00:00.000Z",
        completedAt: "2026-01-01T09:05:00.000Z",
        error: null,
        invalidCitationCount: 0,
      },
    ],
  };
  hoisted.runs.isLoading = false;
  hoisted.runs.isError = false;
});

describe("BriefingRecentRunsPanel — Task #305 highlight props", () => {
  it("highlights the current run and tags it 'Current'", () => {
    render(
      <BriefingRecentRunsPanel
        engagementId="eng-1"
        currentGenerationId="gen-A"
      />,
    );
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    const row = screen.getByTestId("briefing-run-gen-A");
    expect(row.getAttribute("data-current")).toBe("true");
    expect(
      within(row).getByTestId("briefing-run-role-badge-current"),
    ).toBeInTheDocument();
    // The other row stays unhighlighted.
    expect(
      screen.getByTestId("briefing-run-gen-B").getAttribute("data-current"),
    ).toBeNull();
  });

  it("highlights the producing run and tags it 'Submitted'", () => {
    render(
      <BriefingRecentRunsPanel
        engagementId="eng-1"
        producingGenerationId="gen-B"
      />,
    );
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    const row = screen.getByTestId("briefing-run-gen-B");
    expect(row.getAttribute("data-producing")).toBe("true");
    expect(
      within(row).getByTestId("briefing-run-role-badge-submitted"),
    ).toBeInTheDocument();
  });

  it("renders the 'drifted' header pill when current ≠ submitted", () => {
    render(
      <BriefingRecentRunsPanel
        engagementId="eng-1"
        currentGenerationId="gen-A"
        producingGenerationId="gen-B"
      />,
    );
    expect(
      screen.getByTestId("briefing-recent-runs-drift-drifted"),
    ).toHaveTextContent(/current ≠ submitted/i);
  });

  it("renders the 'in-sync' header pill when current = submitted", () => {
    render(
      <BriefingRecentRunsPanel
        engagementId="eng-1"
        currentGenerationId="gen-A"
        producingGenerationId="gen-A"
      />,
    );
    expect(
      screen.getByTestId("briefing-recent-runs-drift-in-sync"),
    ).toHaveTextContent(/current = submitted/i);
  });

  it("renders no drift pill when only one of the ids is provided", () => {
    render(
      <BriefingRecentRunsPanel
        engagementId="eng-1"
        currentGenerationId="gen-A"
      />,
    );
    expect(
      screen.queryByTestId("briefing-recent-runs-drift-in-sync"),
    ).toBeNull();
    expect(
      screen.queryByTestId("briefing-recent-runs-drift-drifted"),
    ).toBeNull();
  });

  it("falls back to its prior behaviour when neither prop is passed (no highlights, no drift pill)", () => {
    render(<BriefingRecentRunsPanel engagementId="eng-1" />);
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    expect(
      screen.getByTestId("briefing-run-gen-A").getAttribute("data-current"),
    ).toBeNull();
    expect(
      screen.queryByTestId("briefing-run-role-badge-current"),
    ).toBeNull();
    expect(
      screen.queryByTestId("briefing-run-role-badge-submitted"),
    ).toBeNull();
  });
});
