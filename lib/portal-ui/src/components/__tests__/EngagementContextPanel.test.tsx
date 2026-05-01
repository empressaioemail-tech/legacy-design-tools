/**
 * EngagementContextPanel — Task #305 (Wave 2 Sprint A).
 *
 * Pins the read-only reviewer parity surface that mounts inside
 * plan-review's SubmissionDetailModal "Engagement Context" tab:
 *
 *   - loading / error / empty branches render the matching testids
 *     so the modal can wire skeleton + retry chrome around them
 *     consistently;
 *   - the populated path renders the parcel-briefing card, the
 *     tier-grouped source list (Federal / State / Local / Manual),
 *     the A–G narrative, the prior-narrative comparison disclosure,
 *     the recent-runs panel with the matching `currentGenerationId`
 *     highlighted, and the 3D site-context viewer;
 *   - none of the architect-only mutate affordances ("Re-run stale",
 *     "Upload source", "Regenerate") leak into the read-only panel.
 *
 * Setup mirrors `BriefingSourceDetails.test.tsx` (Task #261) — mock
 * the generated React Query hooks with hoisted state so each test
 * can swap the briefing/runs payload without spinning a real
 * QueryClient or MSW.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type {
  EngagementBriefing,
  EngagementBriefingSource,
} from "@workspace/api-client-react";

const hoisted = vi.hoisted(() => ({
  briefing: {
    data: undefined as { briefing: EngagementBriefing | null } | undefined,
    isLoading: false,
    isError: false,
  },
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
          priorNarrative: null | {
            sectionA: string | null;
            sectionB: string | null;
            sectionC: string | null;
            sectionD: string | null;
            sectionE: string | null;
            sectionF: string | null;
            sectionG: string | null;
            generatedAt: string | null;
            generatedBy: string | null;
          };
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
    useGetEngagementBriefing: () => hoisted.briefing,
    getGetEngagementBriefingQueryKey: (id: string) => [
      "/engagements",
      id,
      "briefing",
    ],
    useListEngagementBriefingGenerationRuns: () => hoisted.runs,
    getListEngagementBriefingGenerationRunsQueryKey: (id: string) => [
      "/engagements",
      id,
      "briefing",
      "generation-runs",
    ],
    // The setback hook is dragged in by BriefingSourceDetails when a
    // local-adapter source row is expanded. None of these tests open
    // that expander, so the stub just needs to exist.
    useGetLocalSetbackTable: () => ({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    }),
    getGetLocalSetbackTableQueryKey: (k: string) => ["/local/setbacks", k],
  };
});

const { EngagementContextPanel } = await import("../EngagementContextPanel");

function mkSource(
  over: Partial<EngagementBriefingSource> &
    Pick<EngagementBriefingSource, "id" | "sourceKind">,
): EngagementBriefingSource {
  return {
    id: over.id,
    layerKind: over.layerKind ?? "zoning",
    sourceKind: over.sourceKind,
    provider: over.provider ?? null,
    snapshotDate: over.snapshotDate ?? "2026-01-01T00:00:00.000Z",
    note: over.note ?? null,
    uploadObjectPath: over.uploadObjectPath ?? "",
    uploadOriginalFilename: over.uploadOriginalFilename ?? "",
    uploadContentType: over.uploadContentType ?? "",
    uploadByteSize: over.uploadByteSize ?? 0,
    dxfObjectPath: over.dxfObjectPath ?? null,
    glbObjectPath: over.glbObjectPath ?? null,
    conversionStatus: over.conversionStatus ?? null,
    conversionError: over.conversionError ?? null,
    payload: over.payload ?? {},
    createdAt: over.createdAt ?? "2026-01-02T00:00:00.000Z",
    supersededAt: over.supersededAt ?? null,
    supersededById: over.supersededById ?? null,
  } as EngagementBriefingSource;
}

function mkBriefing(over: Partial<EngagementBriefing> = {}): EngagementBriefing {
  return {
    id: over.id ?? "brf-1",
    engagementId: over.engagementId ?? "eng-1",
    createdAt: over.createdAt ?? "2026-01-01T10:00:00.000Z",
    updatedAt: over.updatedAt ?? "2026-01-02T10:00:00.000Z",
    sources: over.sources ?? [],
    narrative:
      over.narrative === undefined
        ? {
            sectionA: "Section A body.",
            sectionB: "Section B body.",
            sectionC: null,
            sectionD: null,
            sectionE: null,
            sectionF: null,
            sectionG: null,
            generatedAt: "2026-01-02T10:00:00.000Z",
            generatedBy: "u-arch",
            generationId: "gen-current",
          }
        : over.narrative,
  } as EngagementBriefing;
}

beforeEach(() => {
  // Task #303 B.6 persists the recent-runs disclosure's open/closed
  // state to `?recentRunsOpen=…`. Reset the URL between tests so a
  // previous test that opened the disclosure doesn't leave the next
  // test starting already-open (which would flip on `click(toggle)`).
  window.history.replaceState(null, "", "/");
  hoisted.briefing.data = undefined;
  hoisted.briefing.isLoading = false;
  hoisted.briefing.isError = false;
  hoisted.runs.data = undefined;
  hoisted.runs.isLoading = false;
  hoisted.runs.isError = false;
});

describe("EngagementContextPanel", () => {
  it("renders the loading state while the briefing query is in-flight", () => {
    hoisted.briefing.isLoading = true;
    render(<EngagementContextPanel engagementId="eng-1" />);
    expect(
      screen.getByTestId("engagement-context-panel-loading"),
    ).toBeInTheDocument();
  });

  it("renders the error state when the briefing query rejects", () => {
    hoisted.briefing.isError = true;
    render(<EngagementContextPanel engagementId="eng-1" />);
    expect(
      screen.getByTestId("engagement-context-panel-error"),
    ).toBeInTheDocument();
  });

  it("renders the empty state when no briefing exists, but still mounts the runs disclosure", () => {
    hoisted.briefing.data = { briefing: null };
    render(<EngagementContextPanel engagementId="eng-1" />);
    expect(
      screen.getByTestId("engagement-context-panel-empty"),
    ).toBeInTheDocument();
    // Runs disclosure stays available even with no briefing — the
    // auditor may still want to see prior failed runs that explain
    // why no briefing was ever materialised.
    expect(screen.getByTestId("briefing-recent-runs")).toBeInTheDocument();
  });

  it("renders the parcel-briefing card with id, generation status, and source count", () => {
    hoisted.briefing.data = {
      briefing: mkBriefing({
        id: "brf-abc",
        sources: [
          mkSource({ id: "s1", sourceKind: "federal-adapter" }),
          mkSource({ id: "s2", sourceKind: "state-adapter" }),
        ],
      }),
    };
    render(<EngagementContextPanel engagementId="eng-1" />);
    const card = screen.getByTestId("engagement-context-parcel-briefing-card");
    expect(within(card).getByTestId("parcel-briefing-id")).toHaveTextContent(
      "brf-abc",
    );
    expect(
      within(card).getByTestId("parcel-briefing-narrative-status"),
    ).toHaveTextContent(/Generated/i);
    expect(card).toHaveTextContent("2");
  });

  it("renders the parcel-briefing card with a 'Not yet generated' status when narrative is null", () => {
    hoisted.briefing.data = {
      briefing: mkBriefing({ narrative: null, sources: [] }),
    };
    render(<EngagementContextPanel engagementId="eng-1" />);
    expect(
      screen.getByTestId("parcel-briefing-narrative-status"),
    ).toHaveTextContent(/Not yet generated/i);
  });

  it("tier-groups sources into Federal / State / Local / Manual buckets in that order", () => {
    hoisted.briefing.data = {
      briefing: mkBriefing({
        sources: [
          mkSource({ id: "loc", sourceKind: "local-adapter" }),
          mkSource({ id: "man", sourceKind: "manual-upload" }),
          mkSource({ id: "fed", sourceKind: "federal-adapter" }),
          mkSource({ id: "sta", sourceKind: "state-adapter" }),
        ],
      }),
    };
    render(<EngagementContextPanel engagementId="eng-1" />);
    expect(
      screen.getByTestId("engagement-context-tier-federal"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("engagement-context-tier-state"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("engagement-context-tier-local"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("engagement-context-tier-manual"),
    ).toBeInTheDocument();

    // Each source row stamps the testid the citation pills scroll to
    // and lives inside the tier group its sourceKind maps to.
    const federalGroup = screen.getByTestId("engagement-context-tier-federal");
    expect(within(federalGroup).getByTestId("briefing-source-fed")).toBeInTheDocument();
    const stateGroup = screen.getByTestId("engagement-context-tier-state");
    expect(within(stateGroup).getByTestId("briefing-source-sta")).toBeInTheDocument();
    const manualGroup = screen.getByTestId("engagement-context-tier-manual");
    expect(within(manualGroup).getByTestId("briefing-source-man")).toBeInTheDocument();
  });

  it("renders an empty-sources placeholder when the briefing has zero sources", () => {
    hoisted.briefing.data = { briefing: mkBriefing({ sources: [] }) };
    render(<EngagementContextPanel engagementId="eng-1" />);
    expect(
      screen.getByTestId("engagement-context-sources-empty"),
    ).toBeInTheDocument();
  });

  it("renders only the populated A–G sections, skipping nulls", () => {
    hoisted.briefing.data = { briefing: mkBriefing() };
    render(<EngagementContextPanel engagementId="eng-1" />);
    expect(
      screen.getByTestId("engagement-context-narrative-sectionA"),
    ).toHaveTextContent(/Section A body/);
    expect(
      screen.getByTestId("engagement-context-narrative-sectionB"),
    ).toHaveTextContent(/Section B body/);
    expect(
      screen.queryByTestId("engagement-context-narrative-sectionC"),
    ).toBeNull();
  });

  it("renders the empty-narrative placeholder when narrative is null", () => {
    hoisted.briefing.data = {
      briefing: mkBriefing({ narrative: null, sources: [] }),
    };
    render(<EngagementContextPanel engagementId="eng-1" />);
    expect(
      screen.getByTestId("engagement-context-narrative-empty"),
    ).toBeInTheDocument();
  });

  it("forwards the briefing's current generationId to BriefingRecentRunsPanel as the highlighted current run", () => {
    hoisted.briefing.data = { briefing: mkBriefing({ sources: [] }) };
    hoisted.runs.data = {
      runs: [
        {
          generationId: "gen-current",
          state: "completed",
          startedAt: "2026-01-02T09:55:00.000Z",
          completedAt: "2026-01-02T10:00:00.000Z",
          error: null,
          invalidCitationCount: 0,
        },
        {
          generationId: "gen-old",
          state: "completed",
          startedAt: "2026-01-01T08:00:00.000Z",
          completedAt: "2026-01-01T08:05:00.000Z",
          error: null,
          invalidCitationCount: 0,
        },
      ],
      priorNarrative: null,
    };
    render(<EngagementContextPanel engagementId="eng-1" />);
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    const currentRow = screen.getByTestId("briefing-run-gen-current");
    expect(currentRow.getAttribute("data-current")).toBe("true");
    expect(
      within(currentRow).getByTestId("briefing-run-role-badge-current"),
    ).toBeInTheDocument();
    const oldRow = screen.getByTestId("briefing-run-gen-old");
    expect(oldRow.getAttribute("data-current")).toBeNull();
  });

  it("forwards the producingGenerationId prop and tags the matching run as 'Submitted'", () => {
    hoisted.briefing.data = { briefing: mkBriefing({ sources: [] }) };
    hoisted.runs.data = {
      runs: [
        {
          generationId: "gen-current",
          state: "completed",
          startedAt: "2026-01-02T09:55:00.000Z",
          completedAt: "2026-01-02T10:00:00.000Z",
          error: null,
          invalidCitationCount: 0,
        },
        {
          generationId: "gen-submitted",
          state: "completed",
          startedAt: "2026-01-01T08:00:00.000Z",
          completedAt: "2026-01-01T08:05:00.000Z",
          error: null,
          invalidCitationCount: 0,
        },
      ],
      priorNarrative: null,
    };
    render(
      <EngagementContextPanel
        engagementId="eng-1"
        producingGenerationId="gen-submitted"
      />,
    );
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    expect(
      screen.getByTestId("briefing-recent-runs-drift-drifted"),
    ).toBeInTheDocument();
    const submittedRow = screen.getByTestId("briefing-run-gen-submitted");
    expect(submittedRow.getAttribute("data-producing")).toBe("true");
    expect(
      within(submittedRow).getByTestId("briefing-run-role-badge-submitted"),
    ).toBeInTheDocument();
  });

  it("renders the prior-narrative comparison disclosure with body text when the runs envelope carries one", () => {
    hoisted.briefing.data = { briefing: mkBriefing({ sources: [] }) };
    hoisted.runs.data = {
      runs: [],
      priorNarrative: {
        sectionA: "Old A body.",
        sectionB: null,
        sectionC: null,
        sectionD: null,
        sectionE: null,
        sectionF: null,
        sectionG: null,
        generatedAt: "2025-12-31T10:00:00.000Z",
        generatedBy: "u-arch-prior",
      },
    };
    render(<EngagementContextPanel engagementId="eng-1" />);
    fireEvent.click(
      screen.getByTestId("engagement-context-prior-narrative-toggle"),
    );
    expect(
      screen.getByTestId("engagement-context-prior-narrative-body"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("engagement-context-prior-narrative-sectionA"),
    ).toHaveTextContent(/Old A body/);
  });

  it("renders the prior-narrative empty hint when no priorNarrative is on the wire", () => {
    hoisted.briefing.data = { briefing: mkBriefing({ sources: [] }) };
    hoisted.runs.data = { runs: [], priorNarrative: null };
    render(<EngagementContextPanel engagementId="eng-1" />);
    fireEvent.click(
      screen.getByTestId("engagement-context-prior-narrative-toggle"),
    );
    expect(
      screen.getByTestId("engagement-context-prior-narrative-empty"),
    ).toBeInTheDocument();
  });

  it("does NOT render any architect-only mutate affordance (re-run / upload / regenerate)", () => {
    hoisted.briefing.data = {
      briefing: mkBriefing({
        sources: [
          mkSource({
            id: "s1",
            sourceKind: "federal-adapter",
          }),
        ],
      }),
    };
    render(<EngagementContextPanel engagementId="eng-1" />);
    // None of these labels should appear on a read-only reviewer
    // surface — they belong to the architect-side EngagementDetail
    // page in design-tools, not here.
    expect(screen.queryByText(/Re-run stale/i)).toBeNull();
    expect(screen.queryByText(/Upload source/i)).toBeNull();
    expect(screen.queryByText(/Regenerate/i)).toBeNull();
    expect(screen.queryByText(/Generate Layers/i)).toBeNull();
  });

  it("mounts the 3D site context viewer section in the populated path", () => {
    hoisted.briefing.data = { briefing: mkBriefing({ sources: [] }) };
    render(<EngagementContextPanel engagementId="eng-1" />);
    expect(
      screen.getByTestId("engagement-context-site-viewer"),
    ).toBeInTheDocument();
  });
});
