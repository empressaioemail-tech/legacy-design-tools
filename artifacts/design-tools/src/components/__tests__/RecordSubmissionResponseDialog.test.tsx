/**
 * RecordSubmissionResponseDialog — fast component tests for the
 * "record jurisdiction response" flow (Task #85).
 *
 * Mirrors the mock + render pattern established by
 * `SubmitToJurisdictionDialog.test.tsx`: we mock
 * @workspace/api-client-react so we can drive `onSuccess` / `onError`
 * by hand without standing up a real network layer, and we keep a
 * real QueryClient so we can spy on `invalidateQueries` and verify
 * the engagement, atom-history, and submissions caches all get
 * busted on success.
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
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const hoisted = vi.hoisted(() => {
  class MockApiError extends Error {
    readonly name = "ApiError" as const;
    status: number;
    data: unknown;
    constructor(status: number, data: unknown = null, message?: string) {
      super(message ?? `HTTP ${status}`);
      Object.setPrototypeOf(this, MockApiError.prototype);
      this.status = status;
      this.data = data;
    }
  }

  return {
    mutateMock: ((..._args: unknown[]) => {}) as unknown as ReturnType<
      typeof vi.fn
    >,
    capturedOptions: null as null | {
      mutation?: {
        onSuccess?: (
          data: unknown,
          variables: unknown,
          context: unknown,
        ) => Promise<void> | void;
        onError?: (
          err: unknown,
          variables: unknown,
          context: unknown,
        ) => void;
      };
    },
    state: { isPending: false },
    MockApiError,
  };
});

hoisted.mutateMock = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useRecordSubmissionResponse: (
    options: typeof hoisted.capturedOptions,
  ) => {
    hoisted.capturedOptions = options;
    return {
      mutate: hoisted.mutateMock,
      isPending: hoisted.state.isPending,
    };
  },
  getGetEngagementQueryKey: (id: string) => ["getEngagement", id],
  getGetAtomHistoryQueryKey: (scope: string, id: string) => [
    "getAtomHistory",
    scope,
    id,
  ],
  getListEngagementSubmissionsQueryKey: (id: string) => [
    "listEngagementSubmissions",
    id,
  ],
  RecordSubmissionResponseBodyStatus: {
    approved: "approved",
    corrections_requested: "corrections_requested",
    rejected: "rejected",
  },
  ApiError: hoisted.MockApiError,
}));

vi.mock("@workspace/api-zod", () => ({
  recordSubmissionResponseBodyReviewerCommentMax: 4096,
}));

const { RecordSubmissionResponseDialog } = await import(
  "../RecordSubmissionResponseDialog"
);

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderDialog(overrides: {
  isOpen?: boolean;
  onClose?: () => void;
  onRecorded?: (response: unknown) => void;
  engagementId?: string;
  submissionId?: string;
  jurisdiction?: string | null;
  client?: QueryClient;
} = {}) {
  const onClose = overrides.onClose ?? vi.fn();
  const onRecorded = overrides.onRecorded ?? vi.fn();
  const client = overrides.client ?? makeQueryClient();
  const node: ReactNode = (
    <QueryClientProvider client={client}>
      <RecordSubmissionResponseDialog
        engagementId={overrides.engagementId ?? "eng-1"}
        submissionId={overrides.submissionId ?? "sub-1"}
        jurisdiction={
          overrides.jurisdiction === undefined
            ? "Moab, UT"
            : overrides.jurisdiction
        }
        isOpen={overrides.isOpen ?? true}
        onClose={onClose}
        onRecorded={onRecorded}
      />
    </QueryClientProvider>
  );
  const utils = render(node);
  return { ...utils, onClose, onRecorded, client };
}

beforeEach(() => {
  hoisted.mutateMock.mockReset();
  hoisted.capturedOptions = null;
  hoisted.state.isPending = false;
});

afterEach(() => {
  cleanup();
});

describe("RecordSubmissionResponseDialog", () => {
  it("renders nothing when isOpen is false", () => {
    const { container } = renderDialog({ isOpen: false });
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("record-response-dialog")).toBeNull();
  });

  it("renders the jurisdiction label in the dialog header when open", () => {
    renderDialog({ jurisdiction: "Moab, UT" });
    expect(screen.getByTestId("record-response-dialog")).toBeInTheDocument();
    expect(screen.getByText(/from Moab, UT/)).toBeInTheDocument();
  });

  it("offers all three response statuses with Approved selected by default", () => {
    renderDialog();
    expect(
      screen.getByTestId("record-response-status-approved"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("record-response-status-corrections_requested"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("record-response-status-rejected"),
    ).toBeInTheDocument();
    const approvedRadio = screen
      .getByTestId("record-response-status-approved")
      .querySelector("input[type=radio]") as HTMLInputElement;
    expect(approvedRadio.checked).toBe(true);
  });

  it("calls onClose when the backdrop is clicked", () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.click(screen.getByTestId("record-response-dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("updates the comment character counter as the user types", () => {
    renderDialog();
    const textarea = screen.getByTestId(
      "record-response-comment",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "needs egress fix" } });
    expect(
      screen.getByTestId("record-response-comment-count"),
    ).toHaveTextContent("16 / 4096");
  });

  it("disables Record (and keeps Cancel enabled) when the comment exceeds 4 KB", () => {
    renderDialog();
    const textarea = screen.getByTestId(
      "record-response-comment",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "x".repeat(4097) } });

    const submit = screen.getByTestId("record-response-confirm");
    expect(submit).toBeDisabled();

    fireEvent.click(submit);
    expect(hoisted.mutateMock).not.toHaveBeenCalled();

    expect(
      screen.getByRole("button", { name: /^Cancel$/i }),
    ).not.toBeDisabled();
  });

  it("sends only status when the comment is empty", () => {
    renderDialog({ engagementId: "eng-7", submissionId: "sub-9" });
    fireEvent.click(screen.getByTestId("record-response-confirm"));
    expect(hoisted.mutateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.mutateMock).toHaveBeenCalledWith({
      id: "eng-7",
      submissionId: "sub-9",
      data: { status: "approved" },
    });
  });

  it("sends only status when the comment is whitespace-only", () => {
    renderDialog({ engagementId: "eng-7", submissionId: "sub-9" });
    fireEvent.change(screen.getByTestId("record-response-comment"), {
      target: { value: "   \n\t  " },
    });
    fireEvent.click(screen.getByTestId("record-response-confirm"));
    expect(hoisted.mutateMock).toHaveBeenCalledWith({
      id: "eng-7",
      submissionId: "sub-9",
      data: { status: "approved" },
    });
  });

  it("sends the trimmed comment + selected status when the user typed real content", () => {
    renderDialog({ engagementId: "eng-7", submissionId: "sub-9" });
    // Switch to corrections_requested.
    const correctionsRadio = screen
      .getByTestId("record-response-status-corrections_requested")
      .querySelector("input[type=radio]") as HTMLInputElement;
    fireEvent.click(correctionsRadio);

    fireEvent.change(screen.getByTestId("record-response-comment"), {
      target: { value: "  Update egress widths on A2.04 and resubmit.  " },
    });
    fireEvent.click(screen.getByTestId("record-response-confirm"));

    expect(hoisted.mutateMock).toHaveBeenCalledWith({
      id: "eng-7",
      submissionId: "sub-9",
      data: {
        status: "corrections_requested",
        reviewerComment: "Update egress widths on A2.04 and resubmit.",
      },
    });
  });

  it("disables Record / Cancel and flips the button label while pending", () => {
    hoisted.state.isPending = true;
    renderDialog();
    const submit = screen.getByTestId("record-response-confirm");
    expect(submit).toBeDisabled();
    expect(submit).toHaveTextContent(/Recording/i);
    expect(
      screen.getByRole("button", { name: /^Cancel$/i }),
    ).toBeDisabled();
    expect(screen.getByTestId("record-response-comment")).toBeDisabled();

    fireEvent.click(submit);
    expect(hoisted.mutateMock).not.toHaveBeenCalled();
  });

  it("invalidates the engagement, atom-history, and submissions caches and closes on success", async () => {
    const onClose = vi.fn();
    const onRecorded = vi.fn();
    const client = makeQueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    renderDialog({
      onClose,
      onRecorded,
      client,
      engagementId: "eng-99",
      submissionId: "sub-77",
    });

    fireEvent.click(screen.getByTestId("record-response-confirm"));
    expect(hoisted.capturedOptions?.mutation?.onSuccess).toBeDefined();

    const fakeResponse = {
      id: "sub-77",
      engagementId: "eng-99",
      status: "approved",
      reviewerComment: null,
      respondedAt: "2024-01-01T00:00:00.000Z",
      submittedAt: "2024-01-01T00:00:00.000Z",
    };

    await act(async () => {
      await hoisted.capturedOptions!.mutation!.onSuccess!(
        fakeResponse,
        { id: "eng-99", submissionId: "sub-77", data: { status: "approved" } },
        undefined,
      );
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["getEngagement", "eng-99"],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["getAtomHistory", "engagement", "eng-99"],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["getAtomHistory", "submission", "sub-77"],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["listEngagementSubmissions", "eng-99"],
    });
    expect(onRecorded).toHaveBeenCalledWith(fakeResponse);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("maps a 404 to a friendly 'submission no longer exists' message", async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId("record-response-confirm"));
    act(() => {
      hoisted.capturedOptions!.mutation!.onError!(
        new hoisted.MockApiError(404, { detail: "not found" }),
        { id: "eng-1", submissionId: "sub-1", data: { status: "approved" } },
        undefined,
      );
    });

    expect(
      await screen.findByTestId("record-response-error"),
    ).toHaveTextContent(/submission no longer exists/i);
  });

  it("surfaces the server-provided detail for a 400 (e.g. cross-engagement check)", async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId("record-response-confirm"));
    act(() => {
      hoisted.capturedOptions!.mutation!.onError!(
        new hoisted.MockApiError(400, {
          error: "Submission does not belong to this engagement",
        }),
        { id: "eng-1", submissionId: "sub-1", data: { status: "approved" } },
        undefined,
      );
    });
    expect(
      await screen.findByTestId("record-response-error"),
    ).toHaveTextContent(/does not belong to this engagement/i);
  });

  it("falls back to a generic comment-may-be-too-long message for a 400 with no detail", async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId("record-response-confirm"));
    act(() => {
      hoisted.capturedOptions!.mutation!.onError!(
        new hoisted.MockApiError(400, {}),
        { id: "eng-1", submissionId: "sub-1", data: { status: "approved" } },
        undefined,
      );
    });
    expect(
      await screen.findByTestId("record-response-error"),
    ).toHaveTextContent(/Comment may be too long \(max 4096 chars\)/i);
  });

  it("maps any 5xx status to a generic 'server hit a snag' retry message", async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId("record-response-confirm"));
    act(() => {
      hoisted.capturedOptions!.mutation!.onError!(
        new hoisted.MockApiError(503, { detail: "db down" }),
        { id: "eng-1", submissionId: "sub-1", data: { status: "approved" } },
        undefined,
      );
    });
    expect(
      await screen.findByTestId("record-response-error"),
    ).toHaveTextContent(/server hit a snag/i);
  });

  it("clears the previous error when the user resubmits", async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId("record-response-confirm"));
    act(() => {
      hoisted.capturedOptions!.mutation!.onError!(
        new hoisted.MockApiError(503),
        { id: "eng-1", submissionId: "sub-1", data: { status: "approved" } },
        undefined,
      );
    });
    expect(
      await screen.findByTestId("record-response-error"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("record-response-confirm"));
    await waitFor(() => {
      expect(screen.queryByTestId("record-response-error")).toBeNull();
    });
  });
});
