/**
 * BriefingNarrativePanel (lib/portal-ui) — Task #316.
 *
 * Pins the lifted shared narrative card. Coverage:
 *
 *   - the empty-narrative + populated branches render the matching
 *     testids the parent surfaces depend on;
 *   - only the populated A–G sections are rendered, with the
 *     DA-PI-3 default expansion applied (A always open, B/E open
 *     only when populated, C/D/F/G collapsed);
 *   - the `recentRunsSlot` render-prop is mounted between the
 *     header and the section list so design-tools and plan-review
 *     can wire their respective `BriefingRecentRunsPanel` props
 *     into the same chrome;
 *   - the `baseUrl` prop anchors the Export PDF link to the
 *     artifact's path-prefixed proxy mount.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { EngagementBriefingNarrative } from "@workspace/api-client-react";

const hoisted = vi.hoisted(() => ({
  generateMutate: vi.fn(),
  status: { state: "idle" as const },
  runs: { data: undefined as undefined | { runs: unknown[] } },
}));

vi.mock("@workspace/api-client-react", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/api-client-react")>(
      "@workspace/api-client-react",
    );
  return {
    ...actual,
    useGenerateEngagementBriefing: () => ({
      mutate: hoisted.generateMutate,
      isPending: false,
    }),
    useGetEngagementBriefingGenerationStatus: () => ({
      data: hoisted.status,
      isLoading: false,
      isError: false,
    }),
    useListEngagementBriefingGenerationRuns: () => ({
      data: hoisted.runs.data,
      isLoading: false,
      isError: false,
    }),
    getGetEngagementBriefingQueryKey: (id: string) => [
      "getEngagementBriefing",
      id,
    ],
    getGetEngagementBriefingGenerationStatusQueryKey: (id: string) => [
      "getEngagementBriefingGenerationStatus",
      id,
    ],
    getListEngagementBriefingGenerationRunsQueryKey: (id: string) => [
      "listEngagementBriefingGenerationRuns",
      id,
    ],
  };
});

const { BriefingNarrativePanel } = await import("../BriefingNarrativePanel");

function mkNarrative(
  over: Partial<EngagementBriefingNarrative> = {},
): EngagementBriefingNarrative {
  return {
    sectionA: over.sectionA ?? "Executive summary body.",
    sectionB: over.sectionB ?? null,
    sectionC: over.sectionC ?? null,
    sectionD: over.sectionD ?? null,
    sectionE: over.sectionE ?? null,
    sectionF: over.sectionF ?? null,
    sectionG: over.sectionG ?? null,
    generatedAt: over.generatedAt ?? "2026-01-02T10:00:00.000Z",
    generatedBy: over.generatedBy ?? "u-arch",
    generationId: over.generationId ?? "gen-1",
  } as EngagementBriefingNarrative;
}

function renderPanel(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

beforeEach(() => {
  hoisted.generateMutate.mockReset();
  hoisted.status = { state: "idle" as const };
  hoisted.runs.data = undefined;
});

afterEach(() => {
  cleanup();
});

describe("BriefingNarrativePanel (portal-ui)", () => {
  it("renders the empty-narrative placeholder when narrative is null and no sources are on file", () => {
    renderPanel(
      <BriefingNarrativePanel
        engagementId="eng-1"
        narrative={null}
        sourceCount={0}
        sources={[]}
        onJumpToSource={() => {}}
      />,
    );
    expect(
      screen.getByTestId("briefing-narrative-empty"),
    ).toBeInTheDocument();
    // No section cards should mount when narrative is null.
    expect(
      screen.queryByTestId("briefing-narrative-sections"),
    ).not.toBeInTheDocument();
  });

  it("renders only the populated A–G sections, with DA-PI-3 default expansion", () => {
    renderPanel(
      <BriefingNarrativePanel
        engagementId="eng-1"
        narrative={mkNarrative({
          sectionA: "Executive summary body.",
          sectionB: "Threshold issues body.",
          sectionC: null,
        })}
        sourceCount={3}
        sources={[]}
        onJumpToSource={() => {}}
      />,
    );
    // A always open by default.
    expect(
      screen.getByTestId("briefing-section-body-a"),
    ).toBeInTheDocument();
    // B open because populated.
    expect(
      screen.getByTestId("briefing-section-body-b"),
    ).toBeInTheDocument();
    // C/D/F/G collapsed by default; the toggle exists, the body
    // does not.
    expect(
      screen.getByTestId("briefing-section-toggle-c"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("briefing-section-body-c"),
    ).not.toBeInTheDocument();
  });

  it("mounts the supplied recentRunsSlot between the header and the section list", () => {
    renderPanel(
      <BriefingNarrativePanel
        engagementId="eng-1"
        narrative={mkNarrative()}
        sourceCount={2}
        sources={[]}
        onJumpToSource={() => {}}
        recentRunsSlot={
          <div data-testid="test-recent-runs-slot">recent runs here</div>
        }
      />,
    );
    expect(
      screen.getByTestId("test-recent-runs-slot"),
    ).toBeInTheDocument();
  });

  it("anchors the Export PDF link to the supplied baseUrl when a narrative exists", () => {
    renderPanel(
      <BriefingNarrativePanel
        engagementId="eng-42"
        narrative={mkNarrative()}
        sourceCount={1}
        sources={[]}
        onJumpToSource={() => {}}
        baseUrl="/design-tools/"
      />,
    );
    const link = screen.getByTestId(
      "briefing-export-pdf-button",
    ) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      "/design-tools/api/engagements/eng-42/briefing/export.pdf",
    );
  });

  it("disables the Export PDF link when no narrative exists yet", () => {
    renderPanel(
      <BriefingNarrativePanel
        engagementId="eng-42"
        narrative={null}
        sourceCount={1}
        sources={[]}
        onJumpToSource={() => {}}
        baseUrl="/design-tools/"
      />,
    );
    const link = screen.getByTestId("briefing-export-pdf-button");
    expect(link.getAttribute("aria-disabled")).toBe("true");
    expect(link.getAttribute("href")).toBeNull();
  });

  it("renders all seven A–G section labels with a 'Section pending' placeholder when bodies are null (M2-A)", () => {
    renderPanel(
      <BriefingNarrativePanel
        engagementId="eng-1"
        narrative={{
          sectionA: null,
          sectionB: null,
          sectionC: null,
          sectionD: null,
          sectionE: null,
          sectionF: null,
          sectionG: null,
          generatedAt: "2026-01-02T10:00:00.000Z",
          generatedBy: "u-arch",
          generationId: "gen-pending",
        } as EngagementBriefingNarrative}
        sourceCount={1}
        sources={[]}
        onJumpToSource={() => {}}
      />,
    );
    for (const key of ["a", "b", "c", "d", "e", "f", "g"] as const) {
      expect(
        screen.getByTestId(`briefing-section-${key}`),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId(`briefing-section-toggle-${key}`),
      ).toBeInTheDocument();
    }
    // A and (would-be) E/B default-expand even when empty; their
    // bodies should render the pending placeholder.
    const pendingA = screen.getByTestId("briefing-section-pending-a");
    expect(pendingA.textContent).toMatch(/Section pending/i);
    // Expand a collapsed section (D) and verify it also renders the
    // placeholder rather than being silently hidden.
    fireEvent.click(screen.getByTestId("briefing-section-toggle-d"));
    expect(
      screen.getByTestId("briefing-section-pending-d").textContent,
    ).toMatch(/Section pending/i);
  });

  it("renders an amber 'may be stale' chip on a section when one of its cited sources is upstream-stale (M2-A)", () => {
    const cacheInfo = new Map<
      string,
      { upstreamFreshness: { status: "fresh" | "stale" | "unknown" } | null }
    >([
      [
        "src-stale-1",
        { upstreamFreshness: { status: "stale" } },
      ],
      ["src-fresh-1", { upstreamFreshness: { status: "fresh" } }],
    ]);
    renderPanel(
      <BriefingNarrativePanel
        engagementId="eng-1"
        narrative={mkNarrative({
          sectionD:
            "Water main runs along {{atom|briefing-source|src-stale-1|TWDB Layer}}; sewer per {{atom|briefing-source|src-fresh-1|City GIS}}.",
          sectionC:
            "Standard zoning per {{atom|briefing-source|src-fresh-1|City GIS}}.",
        })}
        sourceCount={2}
        sources={[
          { id: "src-stale-1" } as never,
          { id: "src-fresh-1" } as never,
        ]}
        onJumpToSource={() => {}}
        cacheInfoBySourceId={cacheInfo}
      />,
    );
    const chip = screen.getByTestId("briefing-section-stale-d");
    expect(chip.textContent).toMatch(/1 source may be stale/i);
    // Section C only cites a fresh source — no chip there.
    expect(
      screen.queryByTestId("briefing-section-stale-c"),
    ).not.toBeInTheDocument();
  });

  it("invokes onJumpToSource when a citation pill inside section D is clicked (M2-A)", () => {
    const onJump = vi.fn();
    renderPanel(
      <BriefingNarrativePanel
        engagementId="eng-1"
        narrative={mkNarrative({
          sectionD:
            "Power served via {{atom|briefing-source|src-power|CPS Energy}}.",
        })}
        sourceCount={1}
        sources={[{ id: "src-power" } as never]}
        onJumpToSource={onJump}
      />,
    );
    // Section D is collapsed by default — open it first.
    fireEvent.click(screen.getByTestId("briefing-section-toggle-d"));
    const pill = screen.getByTestId("briefing-citation-pill-src-power");
    fireEvent.click(pill);
    expect(onJump).toHaveBeenCalledWith("src-power");
  });

  it("flips the kickoff button label between 'Generate Briefing' and 'Regenerate Briefing'", () => {
    const { rerender } = renderPanel(
      <BriefingNarrativePanel
        engagementId="eng-1"
        narrative={null}
        sourceCount={1}
        sources={[]}
        onJumpToSource={() => {}}
      />,
    );
    expect(
      screen.getByTestId("briefing-generate-button").textContent,
    ).toBe("Generate Briefing");
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    rerender(
      <QueryClientProvider client={client}>
        <BriefingNarrativePanel
          engagementId="eng-1"
          narrative={mkNarrative()}
          sourceCount={1}
          sources={[]}
          onJumpToSource={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.getByTestId("briefing-generate-button").textContent,
    ).toBe("Regenerate Briefing");
  });
});
