/**
 * DecisionTab — Plan Review reviewer-side decision panel + revision
 * history list (Task #428 / Reviewer V1-D).
 *
 * Covers:
 *   1. Audience gate — non-internal sessions see the read-only
 *      notice instead of the action grid + composer.
 *   2. The 4-action grid renders all four buttons.
 *   3. Required-comment guard for "Revision requested" / "Deny" —
 *      submit stays disabled until a non-empty comment is typed.
 *   4. Approve happy-path — POSTs `status: approved` with no
 *      reviewer comment when the textarea is left empty, then
 *      surfaces the recorded banner with the new status copy.
 *   5. Revision-requested — POSTs `corrections_requested` with the
 *      typed comment, and forwarded mutation arguments include the
 *      engagement + submission ids.
 *   6. Revision history — lists prior submissions reverse-chrono
 *      with status badge + reviewer comment, marks the current
 *      submission as "Viewing" (no Open link), and renders a sibling
 *      "Open this submission" deep-link for the other rows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import type {
  EngagementSubmissionSummary,
  SubmissionResponse,
} from "@workspace/api-client-react";

vi.mock("../../lib/relativeTime", () => ({
  relativeTime: () => "just now",
}));

const hoisted = vi.hoisted(() => ({
  history: [] as EngagementSubmissionSummary[],
  recordCalls: [] as Array<{
    id: string;
    submissionId: string;
    data: { status: string; reviewerComment?: string };
  }>,
  recordImpl: null as
    | null
    | ((args: {
        id: string;
        submissionId: string;
        data: { status: string; reviewerComment?: string };
      }) => Promise<SubmissionResponse>),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { useQuery, useMutation } = await import("@tanstack/react-query");
  return {
    getListEngagementSubmissionsQueryKey: (id: string) => [
      "listEngagementSubmissions",
      id,
    ],
    useListEngagementSubmissions: (
      id: string,
      opts?: { query?: { queryKey?: readonly unknown[]; enabled?: boolean } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ??
          (["listEngagementSubmissions", id] as const),
        queryFn: async () => hoisted.history,
        enabled: opts?.query?.enabled ?? true,
      }),
    useRecordSubmissionResponse: (options?: {
      mutation?: {
        onSuccess?: (data: SubmissionResponse) => void;
      };
    }) =>
      useMutation({
        mutationFn: async (args: {
          id: string;
          submissionId: string;
          data: { status: string; reviewerComment?: string };
        }) => {
          hoisted.recordCalls.push(args);
          if (hoisted.recordImpl) return hoisted.recordImpl(args);
          return {
            id: args.submissionId,
            engagementId: args.id,
            status: args.data.status,
            reviewerComment: args.data.reviewerComment ?? null,
            respondedAt: "2026-04-02T10:00:00.000Z",
            responseRecordedAt: "2026-04-02T10:00:00.000Z",
          } as unknown as SubmissionResponse;
        },
        onSuccess: options?.mutation?.onSuccess,
      }),
  };
});

vi.mock("@workspace/api-zod", () => ({
  recordSubmissionResponseBodyReviewerCommentMax: 4096,
}));

const { DecisionTab } = await import("../DecisionTab");

const baseSubmission: EngagementSubmissionSummary = {
  id: "sub-1",
  submittedAt: "2026-04-01T10:00:00.000Z",
  jurisdiction: "Boulder, CO",
  note: "Please review.",
  status: "pending",
  reviewerComment: null,
  respondedAt: null,
  responseRecordedAt: null,
};

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderTab(
  overrides: {
    submission?: EngagementSubmissionSummary;
    audience?: "internal" | "user" | "ai";
    onOpenSubmission?: (submissionId: string) => void;
  } = {},
) {
  return render(
    <Router>
      <QueryClientProvider client={makeQueryClient()}>
        <DecisionTab
          submission={overrides.submission ?? baseSubmission}
          engagementId="eng-1"
          audience={overrides.audience ?? "internal"}
          onOpenSubmission={overrides.onOpenSubmission}
        />
      </QueryClientProvider>
    </Router>,
  );
}

beforeEach(() => {
  hoisted.history = [];
  hoisted.recordCalls = [];
  hoisted.recordImpl = null;
});

afterEach(() => {
  cleanup();
});

describe("DecisionTab — reviewer decision panel (Task #428)", () => {
  it("hides the action grid for non-internal audiences and shows the read-only notice", () => {
    renderTab({ audience: "user" });
    expect(screen.queryByTestId("decision-actions")).toBeNull();
    expect(
      screen.getByTestId("decision-readonly-notice"),
    ).toBeInTheDocument();
  });

  it("renders all four reviewer actions for internal sessions", () => {
    renderTab();
    expect(
      screen.getByTestId("decision-action-comments-posted"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("decision-action-revision-requested"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("decision-action-approve")).toBeInTheDocument();
    expect(screen.getByTestId("decision-action-deny")).toBeInTheDocument();
  });

  it("keeps submit disabled for Revision requested until a comment is entered", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByTestId("decision-action-revision-requested"));
    const submit = await screen.findByTestId("decision-submit");
    expect(submit).toBeDisabled();
    await user.type(
      screen.getByTestId("decision-comment-input"),
      "Resubmit with corrected setbacks please.",
    );
    expect(submit).not.toBeDisabled();
  });

  it("Approve POSTs status=approved with no reviewer comment and surfaces the recorded banner", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByTestId("decision-action-approve"));
    await user.click(screen.getByTestId("decision-submit"));
    await waitFor(() => {
      expect(hoisted.recordCalls).toHaveLength(1);
    });
    expect(hoisted.recordCalls[0]).toEqual({
      id: "eng-1",
      submissionId: "sub-1",
      data: { status: "approved" },
    });
    const banner = await screen.findByTestId("decision-recorded-banner");
    expect(banner).toHaveTextContent(/Approved/);
  });

  it("Revision requested POSTs status=corrections_requested with the typed comment", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByTestId("decision-action-revision-requested"));
    await user.type(
      screen.getByTestId("decision-comment-input"),
      "Please address the egress findings.",
    );
    await user.click(screen.getByTestId("decision-submit"));
    await waitFor(() => {
      expect(hoisted.recordCalls).toHaveLength(1);
    });
    expect(hoisted.recordCalls[0]).toEqual({
      id: "eng-1",
      submissionId: "sub-1",
      data: {
        status: "corrections_requested",
        reviewerComment: "Please address the egress findings.",
      },
    });
  });

  it("renders revision history reverse-chronologically with a 'Viewing' marker on the current row and Open links elsewhere", async () => {
    hoisted.history = [
      {
        id: "sub-0",
        submittedAt: "2026-03-15T10:00:00.000Z",
        jurisdiction: "Boulder, CO",
        note: "First pass.",
        status: "corrections_requested",
        reviewerComment: "Please update site plan.",
        respondedAt: "2026-03-16T10:00:00.000Z",
        responseRecordedAt: "2026-03-16T10:00:00.000Z",
      },
      {
        ...baseSubmission,
      },
    ];
    renderTab();
    const history = await screen.findByTestId("revision-history");
    const rows = await within(history).findAllByTestId(
      /^revision-history-row-/,
    );
    // Reverse-chrono: the current sub-1 (newer) comes first.
    expect(rows[0]).toHaveAttribute("data-testid", "revision-history-row-sub-1");
    expect(rows[1]).toHaveAttribute("data-testid", "revision-history-row-sub-0");
    // Current row has the "Viewing" marker, no Open link.
    expect(
      within(rows[0]).getByTestId("revision-history-current-sub-1"),
    ).toBeInTheDocument();
    expect(within(rows[0]).queryByTestId("revision-history-open-sub-1")).toBeNull();
    // Sibling row exposes the Open deep-link + reviewer comment.
    const openLink = within(rows[1]).getByTestId(
      "revision-history-open-sub-0",
    );
    expect(openLink).toHaveAttribute(
      "href",
      "/engagements/eng-1?submission=sub-0",
    );
    expect(
      within(rows[1]).getByTestId("revision-history-comment-sub-0"),
    ).toHaveTextContent("Please update site plan.");
  });

  it("renders the Open affordance as a button that fires onOpenSubmission when the callback is provided (controlled-modal mode)", async () => {
    const user = userEvent.setup();
    const onOpenSubmission = vi.fn();
    hoisted.history = [
      {
        id: "sub-0",
        submittedAt: "2026-03-15T10:00:00.000Z",
        jurisdiction: "Boulder, CO",
        note: "First pass.",
        status: "corrections_requested",
        reviewerComment: "Please update site plan.",
        respondedAt: "2026-03-16T10:00:00.000Z",
        responseRecordedAt: "2026-03-16T10:00:00.000Z",
      },
      { ...baseSubmission },
    ];
    renderTab({ onOpenSubmission });
    const openBtn = await screen.findByTestId("revision-history-open-sub-0");
    expect(openBtn.tagName).toBe("BUTTON");
    expect(openBtn).not.toHaveAttribute("href");
    await user.click(openBtn);
    expect(onOpenSubmission).toHaveBeenCalledWith("sub-0");
    expect(onOpenSubmission).toHaveBeenCalledTimes(1);
  });
});
