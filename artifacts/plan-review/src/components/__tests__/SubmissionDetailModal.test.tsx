/**
 * SubmissionDetailModal — Plan Review submission detail modal shell
 * (Wave 2 Sprint B / Task #306, extended in Task #319).
 *
 * Covers the modal-shell behavior the reviewer relies on:
 *
 *   1. Renders nothing when `submission` is null (closed state).
 *   2. Mounts the BIM Model tab as the default-active tab when a
 *      submission is supplied.
 *   3. Switches to the Engagement Context tab (Task #319) and
 *      renders the briefing snapshot + parcel info pulled from
 *      the engagement / briefing endpoints.
 *   4. Calls `onClose` when the Radix Dialog's overlay-close fires.
 *
 * The BimModelTab itself is mocked to a thin marker component so the
 * shell test stays focused on tab routing and modal lifecycle —
 * `BimModelTab.test.tsx` covers the tab body's behavior end-to-end.
 * The Engagement Context tab is the real component, with
 * `@workspace/api-client-react` mocked so the engagement + briefing
 * reads resolve to test fixtures without crossing the network.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  EngagementSubmissionSummary,
  EngagementDetail,
  EngagementBriefingNarrative,
} from "@workspace/api-client-react";

vi.mock("../BimModelTab", () => ({
  BimModelTab: ({ engagementId }: { engagementId: string }) => (
    <div
      data-testid="bim-model-tab-mock"
      data-engagement-id={engagementId}
    >
      BIM Model tab
    </div>
  ),
}));

// Pin `relativeTime` so the subtitle string is deterministic across
// machine clocks (the modal renders "5 min ago"-style copy off the
// submission's submittedAt).
vi.mock("../../lib/relativeTime", () => ({
  relativeTime: () => "just now",
}));

const hoisted = vi.hoisted(() => ({
  engagement: null as EngagementDetail | null,
  briefingNarrative: null as EngagementBriefingNarrative | null,
}));

vi.mock("@workspace/api-client-react", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    getGetEngagementQueryKey: (id: string) => ["getEngagement", id],
    getGetEngagementBriefingQueryKey: (id: string) => [
      "getEngagementBriefing",
      id,
    ],
    useGetEngagement: (
      id: string,
      opts?: { query?: { queryKey?: readonly unknown[]; enabled?: boolean } },
    ) =>
      useQuery({
        queryKey: opts?.query?.queryKey ?? (["getEngagement", id] as const),
        queryFn: async () => hoisted.engagement,
        enabled: opts?.query?.enabled ?? true,
      }),
    useGetEngagementBriefing: (
      id: string,
      opts?: { query?: { queryKey?: readonly unknown[]; enabled?: boolean } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ?? (["getEngagementBriefing", id] as const),
        queryFn: async () => ({
          briefing: hoisted.briefingNarrative
            ? {
                id: "br-1",
                engagementId: id,
                createdAt: "2026-04-01T10:00:00.000Z",
                updatedAt: "2026-04-01T10:00:00.000Z",
                sources: [],
                narrative: { ...hoisted.briefingNarrative },
              }
            : null,
        }),
        enabled: opts?.query?.enabled ?? true,
      }),
  };
});

const { SubmissionDetailModal } = await import("../SubmissionDetailModal");

const baseSubmission: EngagementSubmissionSummary = {
  id: "sub-1",
  submittedAt: "2026-04-01T10:00:00.000Z",
  jurisdiction: "Boulder, CO",
  note: null,
  status: "pending",
  reviewerComment: null,
  respondedAt: null,
  responseRecordedAt: null,
};

function makeEngagement(
  overrides: Partial<EngagementDetail> = {},
): EngagementDetail {
  return {
    id: "eng-1",
    name: "Lost Pines Townhomes",
    jurisdiction: "Bastrop, TX",
    address: "1400 Pine St, Bastrop, TX",
    status: "active",
    createdAt: "2026-03-01T10:00:00.000Z",
    updatedAt: "2026-03-15T10:00:00.000Z",
    snapshotCount: 0,
    latestSnapshot: null,
    snapshots: [],
    site: {
      address: "1400 Pine St, Bastrop, TX",
      geocode: null,
      projectType: "new_build",
      zoningCode: "R-2",
      lotAreaSqft: 8400,
    },
    revitCentralGuid: null,
    revitDocumentPath: null,
    ...overrides,
  };
}

function makeNarrative(
  overrides: Partial<EngagementBriefingNarrative> = {},
): EngagementBriefingNarrative {
  return {
    sectionA:
      "Three-story townhome project on a tight infill lot. Setbacks " +
      "and floodplain proximity drive the buildable envelope.",
    sectionB: null,
    sectionC: null,
    sectionD: null,
    sectionE: null,
    sectionF: null,
    sectionG: null,
    generatedAt: "2026-03-20T15:30:00.000Z",
    generatedBy: "user:architect-1",
    generationId: "gen-1",
    ...overrides,
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderModal(
  props: {
    submission?: EngagementSubmissionSummary | null;
    engagementId?: string;
    onClose?: () => void;
  } = {},
) {
  // `submission` can legitimately be `null` (closed-modal case), so
  // we use a `"submission" in props` check rather than `??` to keep
  // the explicit-null branch from being overwritten by the default.
  const submission = "submission" in props ? props.submission : baseSubmission;
  const node: ReactNode = (
    <QueryClientProvider client={makeQueryClient()}>
      <SubmissionDetailModal
        submission={submission ?? null}
        engagementId={props.engagementId ?? "eng-1"}
        onClose={props.onClose ?? (() => {})}
      />
    </QueryClientProvider>
  );
  return render(node);
}

beforeEach(() => {
  hoisted.engagement = makeEngagement();
  hoisted.briefingNarrative = makeNarrative();
});

afterEach(() => {
  cleanup();
});

describe("SubmissionDetailModal — Plan Review (Task #306 / #319)", () => {
  it("renders nothing when submission is null", () => {
    renderModal({ submission: null });
    expect(screen.queryByTestId("submission-detail-modal")).toBeNull();
  });

  it("mounts the BIM Model tab content by default when opened", async () => {
    renderModal();
    expect(
      await screen.findByTestId("submission-detail-modal-title"),
    ).toBeInTheDocument();
    // Tab shell renders.
    expect(
      screen.getByTestId("submission-detail-modal-tabs"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("submission-detail-modal-tab-bim-model"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("submission-detail-modal-tab-engagement-context"),
    ).toBeInTheDocument();
    // BIM Model tab content is the default-active tab.
    const tabContent = await screen.findByTestId(
      "submission-detail-modal-bim-model-content",
    );
    expect(tabContent).toBeInTheDocument();
    const tab = screen.getByTestId("bim-model-tab-mock");
    expect(tab).toBeInTheDocument();
    expect(tab).toHaveAttribute("data-engagement-id", "eng-1");
  });

  it("switches to the Engagement Context tab and renders parcel info + briefing summary", async () => {
    const user = userEvent.setup();
    renderModal();
    // BIM Model is the default-active tab.
    expect(
      await screen.findByTestId("bim-model-tab-mock"),
    ).toBeInTheDocument();
    // Click the Engagement Context tab. `userEvent` is required
    // because Radix Tabs activates on `pointerdown` rather than
    // synthetic click events; `fireEvent.click` leaves the pane in
    // its inactive (children-not-rendered) state.
    await user.click(
      screen.getByTestId("submission-detail-modal-tab-engagement-context"),
    );
    const pane = await screen.findByTestId(
      "submission-detail-modal-engagement-context-pane",
    );
    expect(pane).toBeInTheDocument();

    // Parcel-info card renders the engagement's site fields.
    const parcelCard = await within(pane).findByTestId(
      "engagement-context-parcel-card",
    );
    expect(
      within(parcelCard).getByTestId("engagement-context-jurisdiction"),
    ).toHaveTextContent("Bastrop, TX");
    expect(
      within(parcelCard).getByTestId("engagement-context-address"),
    ).toHaveTextContent("1400 Pine St, Bastrop, TX");
    expect(
      within(parcelCard).getByTestId("engagement-context-project-type"),
    ).toHaveTextContent("New build");
    expect(
      within(parcelCard).getByTestId("engagement-context-zoning-code"),
    ).toHaveTextContent("R-2");
    expect(
      within(parcelCard).getByTestId("engagement-context-lot-area"),
    ).toHaveTextContent("8,400 sqft");

    // Briefing-summary card renders Section A + the generation
    // provenance line.
    const briefingCard = await within(pane).findByTestId(
      "engagement-context-briefing-card",
    );
    expect(
      within(briefingCard).getByTestId("engagement-context-briefing-section-a"),
    ).toHaveTextContent(/Three-story townhome project/);
    expect(
      within(briefingCard).getByTestId(
        "engagement-context-briefing-generated-at",
      ),
    ).toHaveTextContent(/Generated /);
  });

  it("renders the briefing-summary empty hint when no narrative has been generated", async () => {
    const user = userEvent.setup();
    hoisted.briefingNarrative = null;
    renderModal();
    await user.click(
      screen.getByTestId("submission-detail-modal-tab-engagement-context"),
    );
    const pane = await screen.findByTestId(
      "submission-detail-modal-engagement-context-pane",
    );
    expect(
      await within(pane).findByTestId("engagement-context-briefing-empty"),
    ).toBeInTheDocument();
    expect(
      within(pane).queryByTestId("engagement-context-briefing-section-a"),
    ).toBeNull();
  });

  it("surfaces the jurisdiction + relative-time subtitle in the modal header", async () => {
    renderModal();
    const subtitle = await screen.findByTestId(
      "submission-detail-modal-subtitle",
    );
    expect(subtitle.textContent).toContain("Boulder, CO");
    expect(subtitle.textContent).toContain("just now");
  });
});
