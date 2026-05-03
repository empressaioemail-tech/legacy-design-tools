/**
 * SubmissionDetailModal — Plan Review submission detail modal shell
 * (Wave 2 Sprint A / Task #305 + #319, Sprint B / Task #306).
 *
 * Covers the modal-shell behavior the reviewer relies on:
 *
 *   1. Renders nothing when `submission` is null (closed state).
 *   2. Mounts the Note tab as the default-active tab when a
 *      submission is supplied (Task #305 — preserves the previous
 *      one-click read affordance).
 *   3. Switches into the Engagement Context tab and mounts BOTH the
 *      `EngagementContextTab` (parcel info + briefing snapshot from
 *      Task #319) AND the shared `EngagementContextPanel` from
 *      `@workspace/portal-ui` (richer briefing sources / recent runs
 *      from Task #305).
 *   4. Renders the briefing-summary empty hint when no narrative has
 *      been generated yet.
 *   5. Switches into the BIM Model tab (Task #306) and mounts the
 *      bim-model + briefing-divergences feedback loop.
 *
 * `BimModelTab` and the shared `EngagementContextPanel` are mocked
 * to thin marker components so this shell test stays focused on tab
 * routing and modal lifecycle — `BimModelTab.test.tsx` and
 * `EngagementContextPanel.test.tsx` cover the panel bodies'
 * behavior end-to-end. `EngagementContextTab` is rendered for real
 * with `@workspace/api-client-react` mocked so the engagement +
 * briefing reads resolve to test fixtures without crossing the
 * network.
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
import { useState, type ReactNode } from "react";
import type {
  EngagementSubmissionSummary,
  EngagementDetail,
  EngagementBriefingNarrative,
} from "@workspace/api-client-react";

vi.mock("../BimModelTab", () => ({
  BimModelTab: ({
    engagementId,
    highlightToken,
  }: {
    engagementId: string;
    highlightToken?: { ref: string; nonce: number } | null;
  }) => (
    <div
      data-testid="bim-model-tab-mock"
      data-engagement-id={engagementId}
      data-highlight-element-ref={highlightToken?.ref ?? ""}
      data-highlight-nonce={
        highlightToken ? String(highlightToken.nonce) : ""
      }
    >
      BIM Model tab
    </div>
  ),
}));

// FindingsTab is mocked to a thin marker that surfaces the
// `onShowInViewer` host wire-up — the real Findings tab pulls in
// the findingsMock store and is fully covered by FindingsTab.test.
// Here we only need to verify the modal's cross-tab jump (Task
// #343): clicking the marker calls `onShowInViewer(elementRef)`
// and the modal switches tabs + threads the ref into BimModelTab.
vi.mock("../findings/FindingsTab", () => ({
  FindingsTab: ({
    submissionId,
    onShowInViewer,
  }: {
    submissionId: string;
    selectedFindingId?: string | null;
    onSelectFinding?: (id: string | null) => void;
    onShowInViewer?: (elementRef: string) => void;
  }) => (
    <div
      data-testid="findings-tab-mock"
      data-submission-id={submissionId}
    >
      <button
        type="button"
        data-testid="findings-tab-mock-show-in-viewer"
        onClick={() => onShowInViewer?.("wall:north-side-l2")}
      >
        Show in 3D viewer (mock)
      </button>
    </div>
  ),
}));

vi.mock("@workspace/portal-ui", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/portal-ui")>(
      "@workspace/portal-ui",
    );
  return {
    ...actual,
    EngagementContextPanel: ({ engagementId }: { engagementId: string }) => (
      <div
        data-testid="engagement-context-panel-mock"
        data-engagement-id={engagementId}
      >
        Engagement Context panel
      </div>
    ),
    // RenderGallery is mocked at the modal-shell level (Task #428)
    // so the Renders tab can be activated without firing the real
    // `useListEngagementRenders` query — `RenderGallery.test.tsx`
    // already covers the gallery body's behavior end-to-end.
    RenderGallery: ({
      engagementId,
      canCancel,
      emptyStateHint,
    }: {
      engagementId: string;
      canCancel?: boolean;
      emptyStateHint?: string;
    }) => (
      <div
        data-testid="render-gallery-mock"
        data-engagement-id={engagementId}
        data-can-cancel={String(canCancel ?? true)}
        data-empty-state-hint={emptyStateHint ?? ""}
      >
        Render gallery
      </div>
    ),
  };
});

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
    // Track 1 — SubmissionDetailModal now reads the latest decision's
    // `pdfArtifactRef` to gate the "Issued PDF" reviewer-side download
    // link (PLR-11). Unmocked, the import would throw and every test
    // in this file would fail at module load. Default-empty list so
    // the gating branch reads "no decision yet" without test churn.
    getListSubmissionDecisionsQueryKey: (id: string) => [
      "listSubmissionDecisions",
      id,
    ],
    useListSubmissionDecisions: (
      submissionId: string,
      opts?: { query?: { queryKey?: readonly unknown[]; enabled?: boolean } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ??
          (["listSubmissionDecisions", submissionId] as const),
        queryFn: async () => ({ items: [] }),
        enabled: opts?.query?.enabled ?? true,
      }),
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
  note: "Please review the parcel briefing before approving.",
  discipline: null,
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
    applicantFirm: null,
    architectOfRecord: null,
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

describe("SubmissionDetailModal — Plan Review (Tasks #305, #306, #319)", () => {
  it("renders nothing when submission is null", () => {
    renderModal({ submission: null });
    expect(screen.queryByTestId("submission-detail-modal")).toBeNull();
  });

  it("mounts the Note tab content by default when opened (Task #305)", async () => {
    renderModal();
    expect(
      await screen.findByTestId("submission-detail-modal-title"),
    ).toBeInTheDocument();
    // Tab shell renders all three triggers.
    expect(
      screen.getByTestId("submission-detail-modal-tabs"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("submission-detail-modal-tab-note"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("submission-detail-modal-tab-engagement-context"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("submission-detail-modal-tab-bim-model"),
    ).toBeInTheDocument();
    // Note tab content is the default-active tab.
    const notePane = await screen.findByTestId(
      "submission-detail-modal-note-content",
    );
    expect(notePane).toBeInTheDocument();
    // The note body surfaces the architect's outbound note.
    expect(
      await screen.findByTestId("submission-detail-note"),
    ).toHaveTextContent(
      "Please review the parcel briefing before approving.",
    );
  });

  it("switches to the Engagement Context tab and renders parcel info + briefing summary + the shared portal-ui panel", async () => {
    // Radix Tabs activates on `pointerdown` rather than synthetic
    // click events, so we drive the trigger through `userEvent`
    // (which delivers pointerDown/pointerUp + click). `fireEvent.click`
    // alone leaves the pane in its inactive (children-not-rendered)
    // state.
    const user = userEvent.setup();
    renderModal();
    await user.click(
      screen.getByTestId("submission-detail-modal-tab-engagement-context"),
    );
    const pane = await screen.findByTestId(
      "submission-detail-modal-engagement-context-pane",
    );
    expect(pane).toBeInTheDocument();

    // Task #319 surface — parcel-info card renders the engagement's
    // site fields.
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

    // Task #319 surface — briefing-summary card renders Section A +
    // the generation provenance line.
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

    // Task #305 surface — the shared `EngagementContextPanel` from
    // `@workspace/portal-ui` is stacked beneath the Task #319 cards
    // so the reviewer also sees the richer briefing sources +
    // recent-runs disclosure without bouncing across to design-tools.
    const sharedPanel = await within(pane).findByTestId(
      "engagement-context-panel-mock",
    );
    expect(sharedPanel).toBeInTheDocument();
    expect(sharedPanel).toHaveAttribute("data-engagement-id", "eng-1");
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

  // Task #348 — the briefing summary card now exposes a deep-link
  // back into the engagement page's full briefing surface so the
  // reviewer doesn't have to close the modal and hunt for the page
  // themselves. The link is hidden when there's no executive
  // summary to anchor against (briefing not yet generated → the
  // empty-state hint is the only honest affordance), and clicking
  // it must close the modal so the reviewer actually sees the
  // briefing panel they were just sent to.
  it("renders a 'View full briefing' deep-link in the briefing summary card", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(
      screen.getByTestId("submission-detail-modal-tab-engagement-context"),
    );
    const briefingCard = await screen.findByTestId(
      "engagement-context-briefing-card",
    );
    const link = within(briefingCard).getByTestId(
      "engagement-context-briefing-view-full",
    );
    expect(link).toHaveTextContent(/View full briefing/);
    // The href routes back to the engagement detail page, opens the
    // recent-runs disclosure (?recentRunsOpen=1), and anchors to the
    // briefing wrapper (#briefing) so the panel is what the reviewer
    // lands on rather than the top of the page.
    expect(link.getAttribute("href")).toBe(
      "/engagements/eng-1?recentRunsOpen=1#briefing",
    );
  });

  it("hides the 'View full briefing' deep-link when no narrative has been generated", async () => {
    const user = userEvent.setup();
    hoisted.briefingNarrative = null;
    renderModal();
    await user.click(
      screen.getByTestId("submission-detail-modal-tab-engagement-context"),
    );
    const briefingCard = await screen.findByTestId(
      "engagement-context-briefing-card",
    );
    expect(
      within(briefingCard).queryByTestId(
        "engagement-context-briefing-view-full",
      ),
    ).toBeNull();
  });

  it("closes the modal when the 'View full briefing' deep-link is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderModal({ onClose });
    await user.click(
      screen.getByTestId("submission-detail-modal-tab-engagement-context"),
    );
    const link = await screen.findByTestId(
      "engagement-context-briefing-view-full",
    );
    await user.click(link);
    expect(onClose).toHaveBeenCalled();
  });

  // Task #343 — clicking "Show in 3D viewer" on a Findings drill-in
  // must (a) switch the modal to the BIM Model tab and (b) thread
  // the finding's `elementRef` down into BimModelTab so the
  // materializable-elements list can highlight + scroll. We cover
  // both the uncontrolled (default) and controlled (parent-driven)
  // tab modes.
  it("uncontrolled mode: switches to BIM Model and threads elementRef when Findings fires onShowInViewer", async () => {
    const user = userEvent.setup();
    renderModal();
    // Switch to the Findings tab to expose the mocked drill-in.
    await user.click(screen.getByTestId("submission-tab-findings"));
    const trigger = await screen.findByTestId(
      "findings-tab-mock-show-in-viewer",
    );
    await user.click(trigger);
    // The BIM Model tab content is now active and the mock surfaces
    // the highlight ref the modal forwarded.
    const bimTab = await screen.findByTestId("bim-model-tab-mock");
    expect(bimTab).toHaveAttribute(
      "data-highlight-element-ref",
      "wall:north-side-l2",
    );
  });

  it("controlled mode: calls onTabChange('bim-model') and forwards highlight ref to BimModelTab", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    // Controlled-mode harness: keep the active tab parent-managed
    // so we can verify both the callback firing and the eventual
    // re-render with `tab="bim-model"` populates the highlight.
    function Harness() {
      const [tab, setTab] = useState<
        | "bim-model"
        | "engagement-context"
        | "note"
        | "findings"
        | "renders"
        | "sheets"
      >("findings");
      return (
        <QueryClientProvider client={makeQueryClient()}>
          <SubmissionDetailModal
            submission={baseSubmission}
            engagementId="eng-1"
            onClose={() => {}}
            tab={tab}
            onTabChange={(next) => {
              onTabChange(next);
              setTab(next);
            }}
            selectedFindingId={null}
            onSelectFinding={() => {}}
          />
        </QueryClientProvider>
      );
    }
    render(<Harness />);
    await user.click(
      await screen.findByTestId("findings-tab-mock-show-in-viewer"),
    );
    expect(onTabChange).toHaveBeenCalledWith("bim-model");
    const bimTab = await screen.findByTestId("bim-model-tab-mock");
    expect(bimTab).toHaveAttribute(
      "data-highlight-element-ref",
      "wall:north-side-l2",
    );
  });

  // Task #371 — clicking the *same* finding's "Show in 3D viewer"
  // button twice in a row must re-fire the highlight effect downstream
  // even though the elementRef hasn't changed. The modal does this by
  // bumping a monotonically-increasing nonce inside the highlight
  // token, so BimModelTab observes a fresh prop value on every click.
  it("bumps the highlight token's nonce on every Show-in-3D-viewer click so re-clicks re-fire", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(screen.getByTestId("submission-tab-findings"));
    const trigger = await screen.findByTestId(
      "findings-tab-mock-show-in-viewer",
    );
    await user.click(trigger);
    let bimTab = await screen.findByTestId("bim-model-tab-mock");
    expect(bimTab).toHaveAttribute(
      "data-highlight-element-ref",
      "wall:north-side-l2",
    );
    expect(bimTab).toHaveAttribute("data-highlight-nonce", "1");

    // Bounce back to Findings and click the same trigger again — the
    // ref is identical but the nonce must have advanced.
    await user.click(screen.getByTestId("submission-tab-findings"));
    await user.click(
      await screen.findByTestId("findings-tab-mock-show-in-viewer"),
    );
    bimTab = await screen.findByTestId("bim-model-tab-mock");
    expect(bimTab).toHaveAttribute(
      "data-highlight-element-ref",
      "wall:north-side-l2",
    );
    expect(bimTab).toHaveAttribute("data-highlight-nonce", "2");
  });

  it("clears the highlight when the reviewer leaves the BIM Model tab", async () => {
    const user = userEvent.setup();
    renderModal();
    // Trigger the jump to seed a highlight.
    await user.click(screen.getByTestId("submission-tab-findings"));
    await user.click(
      await screen.findByTestId("findings-tab-mock-show-in-viewer"),
    );
    expect(
      await screen.findByTestId("bim-model-tab-mock"),
    ).toHaveAttribute("data-highlight-element-ref", "wall:north-side-l2");
    // Switch away to Engagement Context.
    await user.click(
      screen.getByTestId("submission-detail-modal-tab-engagement-context"),
    );
    // Switch back. The mock should now show an empty highlight ref.
    await user.click(screen.getByTestId("submission-detail-modal-tab-bim-model"));
    expect(
      await screen.findByTestId("bim-model-tab-mock"),
    ).toHaveAttribute("data-highlight-element-ref", "");
  });

  it("switches into the BIM Model tab and mounts the bim-model panel (Task #306)", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(
      screen.getByTestId("submission-detail-modal-tab-bim-model"),
    );
    const tab = await screen.findByTestId("bim-model-tab-mock");
    expect(tab).toBeInTheDocument();
    expect(tab).toHaveAttribute("data-engagement-id", "eng-1");
  });

  // The shadcn Dialog primitive renders the X-icon close affordance
  // inside `DialogContent` with an `sr-only` "Close" label. Clicking
  // it fires `onOpenChange(false)`, which the modal routes through
  // its `onClose` callback so the parent can clear its selection
  // state. This is the user's only built-in chrome dismissal — the
  // task spec calls it out explicitly.
  it("fires onClose when the dialog's built-in close (X) button is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderModal({ onClose });
    await screen.findByTestId("submission-detail-modal");
    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Task #428 — the modal exposes a "Renders" tab trigger.
  // Activating Renders mounts the (mocked) `RenderGallery` with
  // `canCancel={false}` and a reviewer-tuned empty hint.
  it("activates the Renders tab and mounts RenderGallery with reviewer-safe props (Task #428)", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(screen.getByTestId("submission-detail-modal-tab-renders"));
    const gallery = await screen.findByTestId("render-gallery-mock");
    expect(gallery).toHaveAttribute("data-engagement-id", "eng-1");
    expect(gallery).toHaveAttribute("data-can-cancel", "false");
    expect(
      gallery.getAttribute("data-empty-state-hint") ?? "",
    ).toMatch(/architect/i);
  });

  it("surfaces the jurisdiction + relative-time subtitle in the modal header", async () => {
    renderModal();
    const subtitle = await screen.findByTestId(
      "submission-detail-modal-subtitle",
    );
    expect(subtitle.textContent).toContain("Boulder, CO");
    expect(subtitle.textContent).toContain("just now");
  });

  describe("SubmissionActionHeader", () => {
    it("renders the three-button header with status pills", async () => {
      renderModal();
      const header = await screen.findByTestId("submission-action-header");
      expect(header).toBeInTheDocument();
      expect(
        within(header).getByTestId("submission-action-review"),
      ).toBeInTheDocument();
      expect(
        within(header).getByTestId("submission-action-communicate"),
      ).toBeInTheDocument();
      expect(
        within(header).getByTestId("submission-action-decide"),
      ).toBeInTheDocument();
      expect(
        within(header).getByTestId("submission-action-review-status").textContent,
      ).toMatch(/findings/i);
      expect(
        within(header).getByTestId("submission-action-communicate-status")
          .textContent,
      ).toMatch(/Never sent/i);
      expect(
        within(header).getByTestId("submission-action-decide-status").textContent,
      ).toMatch(/Pending/i);
    });

    it("Review button switches the active tab to Findings", async () => {
      const user = userEvent.setup();
      renderModal();
      await user.click(await screen.findByTestId("submission-action-review"));
      expect(
        await screen.findByTestId("findings-tab-mock"),
      ).toBeInTheDocument();
    });

    it("Communicate button is disabled when no handler is provided", async () => {
      renderModal();
      const btn = await screen.findByTestId("submission-action-communicate");
      expect(btn).toBeDisabled();
    });

    it("Communicate button fires the supplied handler when wired", async () => {
      const user = userEvent.setup();
      const onCommunicate = vi.fn();
      render(
        <QueryClientProvider client={makeQueryClient()}>
          <SubmissionDetailModal
            submission={baseSubmission}
            engagementId="eng-1"
            onClose={() => {}}
            onCommunicate={onCommunicate}
          />
        </QueryClientProvider>,
      );
      await user.click(
        await screen.findByTestId("submission-action-communicate"),
      );
      expect(onCommunicate).toHaveBeenCalledTimes(1);
    });

    it("Decide button is disabled when no handler is provided", async () => {
      renderModal();
      const btn = await screen.findByTestId("submission-action-decide");
      expect(btn).toBeDisabled();
    });

    it("Decide button fires the supplied handler when wired", async () => {
      const user = userEvent.setup();
      const onDecide = vi.fn();
      render(
        <QueryClientProvider client={makeQueryClient()}>
          <SubmissionDetailModal
            submission={baseSubmission}
            engagementId="eng-1"
            onClose={() => {}}
            onDecide={onDecide}
          />
        </QueryClientProvider>,
      );
      await user.click(await screen.findByTestId("submission-action-decide"));
      expect(onDecide).toHaveBeenCalledTimes(1);
    });
  });
});
