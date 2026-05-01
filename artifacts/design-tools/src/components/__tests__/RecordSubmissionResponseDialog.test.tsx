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
import {
  MockApiError,
  createMutationCapture,
  createQueryKeyStubs,
  makeCapturingMutationHook,
} from "@workspace/portal-ui/test-utils";

// Module-level capture shared with the mock (Task #382). `vi.mock` is
// hoisted but its FACTORY runs lazily on `await import(...)` below,
// so the closure over `hoisted` is initialised by the time it runs.
const hoisted = createMutationCapture();

vi.mock("@workspace/api-client-react", () => ({
  useRecordSubmissionResponse: makeCapturingMutationHook(hoisted),
  ...createQueryKeyStubs([
    "getGetEngagementQueryKey",
    "getGetAtomHistoryQueryKey",
    "getGetAtomSummaryQueryKey",
    "getListEngagementSubmissionsQueryKey",
  ] as const),
  RecordSubmissionResponseBodyStatus: {
    approved: "approved",
    corrections_requested: "corrections_requested",
    rejected: "rejected",
  },
  ApiError: MockApiError,
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
  submittedAt?: string | null;
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
        submittedAt={overrides.submittedAt}
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
  hoisted.reset();
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
    expect(hoisted.mutate).not.toHaveBeenCalled();

    expect(
      screen.getByRole("button", { name: /^Cancel$/i }),
    ).not.toBeDisabled();
  });

  it("sends only status when the comment is empty", () => {
    renderDialog({ engagementId: "eng-7", submissionId: "sub-9" });
    fireEvent.click(screen.getByTestId("record-response-confirm"));
    expect(hoisted.mutate).toHaveBeenCalledTimes(1);
    expect(hoisted.mutate).toHaveBeenCalledWith({
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
    expect(hoisted.mutate).toHaveBeenCalledWith({
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

    expect(hoisted.mutate).toHaveBeenCalledWith({
      id: "eng-7",
      submissionId: "sub-9",
      data: {
        status: "corrections_requested",
        reviewerComment: "Update egress widths on A2.04 and resubmit.",
      },
    });
  });

  it("omits respondedAt by default so the server stamps its own clock", () => {
    renderDialog({ engagementId: "eng-7", submissionId: "sub-9" });
    // Even though the field is pre-filled with the current local time as
    // a visual hint, the user hasn't touched it so the request body must
    // *not* include `respondedAt` — we want the server clock to be
    // authoritative whenever the dialog wasn't being used to backfill.
    fireEvent.click(screen.getByTestId("record-response-confirm"));
    expect(hoisted.mutate).toHaveBeenCalledTimes(1);
    const call = hoisted.mutate.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(call.data).toEqual({ status: "approved" });
    expect("respondedAt" in call.data).toBe(false);
  });

  it("sends the picked respondedAt as ISO when the user backfills a past time", () => {
    renderDialog({ engagementId: "eng-7", submissionId: "sub-9" });

    // Pick "last Tuesday" — pin a fixed local-time string the input would
    // produce so the assertion is deterministic regardless of the test's
    // wall clock. `new Date("YYYY-MM-DDTHH:mm")` parses as local time.
    const localValue = "2024-03-12T14:30";
    fireEvent.change(screen.getByTestId("record-response-responded-at"), {
      target: { value: localValue },
    });
    fireEvent.click(screen.getByTestId("record-response-confirm"));

    expect(hoisted.mutate).toHaveBeenCalledTimes(1);
    const call = hoisted.mutate.mock.calls[0]?.[0] as {
      data: { status: string; respondedAt?: string };
    };
    expect(call.data.status).toBe("approved");
    // The dialog converts the local-time picker value to an ISO string
    // before sending it to the API.
    expect(call.data.respondedAt).toBe(
      new Date(localValue).toISOString(),
    );
  });

  it("rejects a future respondedAt with a clear inline error and does not submit", () => {
    renderDialog();

    // 10 minutes in the future, formatted for datetime-local in the
    // user's local timezone.
    const future = new Date(Date.now() + 10 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const localFuture =
      `${future.getFullYear()}-${pad(future.getMonth() + 1)}-` +
      `${pad(future.getDate())}T${pad(future.getHours())}:` +
      `${pad(future.getMinutes())}`;

    fireEvent.change(screen.getByTestId("record-response-responded-at"), {
      target: { value: localFuture },
    });
    fireEvent.click(screen.getByTestId("record-response-confirm"));

    expect(hoisted.mutate).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("record-response-responded-at-help"),
    ).toHaveTextContent(/can't be in the future/i);
  });

  it("treats a cleared (touched-then-empty) field as unset and omits respondedAt", () => {
    renderDialog({ engagementId: "eng-7", submissionId: "sub-9" });

    // Touch the field with a real value, then wipe it back to "".
    // Since the field is genuinely optional, this should fall back to
    // server-clock semantics — i.e. omit `respondedAt` entirely
    // rather than blocking submit on "Enter a valid date and time".
    fireEvent.change(screen.getByTestId("record-response-responded-at"), {
      target: { value: "2024-03-12T14:30" },
    });
    fireEvent.change(screen.getByTestId("record-response-responded-at"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("record-response-confirm"));

    expect(hoisted.mutate).toHaveBeenCalledTimes(1);
    const call = hoisted.mutate.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(call.data).toEqual({ status: "approved" });
    expect("respondedAt" in call.data).toBe(false);
    // Help copy should be back to the default, not a validation error.
    expect(
      screen.getByTestId("record-response-responded-at-help"),
    ).toHaveTextContent(/Defaults to now/i);
  });

  it("clears the future-date error once the user picks a valid past time", () => {
    renderDialog();

    const future = new Date(Date.now() + 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const localFuture =
      `${future.getFullYear()}-${pad(future.getMonth() + 1)}-` +
      `${pad(future.getDate())}T${pad(future.getHours())}:` +
      `${pad(future.getMinutes())}`;
    fireEvent.change(screen.getByTestId("record-response-responded-at"), {
      target: { value: localFuture },
    });
    fireEvent.click(screen.getByTestId("record-response-confirm"));
    expect(
      screen.getByTestId("record-response-responded-at-help"),
    ).toHaveTextContent(/can't be in the future/i);

    // Correcting to a clearly-past time should drop the inline error
    // back to the help copy and let the request go out.
    fireEvent.change(screen.getByTestId("record-response-responded-at"), {
      target: { value: "2024-01-01T09:00" },
    });
    expect(
      screen.getByTestId("record-response-responded-at-help"),
    ).toHaveTextContent(/Defaults to now/i);

    fireEvent.click(screen.getByTestId("record-response-confirm"));
    expect(hoisted.mutate).toHaveBeenCalledTimes(1);
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
    expect(hoisted.mutate).not.toHaveBeenCalled();
  });

  it("invalidates the engagement, atom-history, atom-summary, and submissions caches and closes on success", async () => {
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
    // Task #93: the SubmissionDetailModal's status-history timeline
    // is keyed off the submission atom's contextSummary, so the
    // dialog must bust that cache too — otherwise the timeline shows
    // stale data when the modal is reopened after a recording.
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["getAtomSummary", "submission", "sub-77"],
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
        new MockApiError(404, { detail: "not found" }),
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
        new MockApiError(400, {
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
        new MockApiError(400, {}),
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
        new MockApiError(503, { detail: "db down" }),
        { id: "eng-1", submissionId: "sub-1", data: { status: "approved" } },
        undefined,
      );
    });
    expect(
      await screen.findByTestId("record-response-error"),
    ).toHaveTextContent(/server hit a snag/i);
  });

  it("rejects a respondedAt earlier than submittedAt with an inline error and does not submit (Task #119)", () => {
    // Package was sent on Jan 15 2024, and the reviewer accidentally
    // picks Jan 10 2024 — a clear pre-submission date. The dialog
    // should mirror the server's lower-bound guard and surface the
    // problem inline rather than letting the request go out and bounce
    // off a 400.
    renderDialog({ submittedAt: "2024-01-15T12:00:00.000Z" });

    fireEvent.change(screen.getByTestId("record-response-responded-at"), {
      target: { value: "2024-01-10T09:00" },
    });
    fireEvent.click(screen.getByTestId("record-response-confirm"));

    expect(hoisted.mutate).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("record-response-responded-at-help"),
    ).toHaveTextContent(/can't be before the package was sent/i);
  });

  it("exposes submittedAt as the picker's `min` attribute so the native control prevents pre-submission picks", () => {
    renderDialog({ submittedAt: "2024-01-15T12:00:00.000Z" });
    const input = screen.getByTestId(
      "record-response-responded-at",
    ) as HTMLInputElement;
    // The exact string is locale-formatted ("YYYY-MM-DDTHH:mm" in the
    // user's local timezone), so we just assert the attribute is
    // present rather than pinning the formatted value.
    expect(input).toHaveAttribute("min");
    expect(input.getAttribute("min")).not.toBe("");
  });

  it("omits the picker's `min` attribute when no submittedAt is supplied", () => {
    renderDialog({ submittedAt: null });
    const input = screen.getByTestId(
      "record-response-responded-at",
    ) as HTMLInputElement;
    expect(input).not.toHaveAttribute("min");
  });

  it("accepts a respondedAt that exactly equals submittedAt as a boundary case (Task #119)", () => {
    // Sent yesterday at 14:30 local — replying at the same instant is
    // unusual but permissible (the server's guard is "earlier than",
    // not "<=", so the dialog must match).
    const submittedDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    submittedDate.setSeconds(0, 0);
    const submittedIso = submittedDate.toISOString();
    const pad = (n: number) => String(n).padStart(2, "0");
    const localValue =
      `${submittedDate.getFullYear()}-${pad(submittedDate.getMonth() + 1)}-` +
      `${pad(submittedDate.getDate())}T${pad(submittedDate.getHours())}:` +
      `${pad(submittedDate.getMinutes())}`;

    renderDialog({
      engagementId: "eng-7",
      submissionId: "sub-9",
      submittedAt: submittedIso,
    });

    fireEvent.change(screen.getByTestId("record-response-responded-at"), {
      target: { value: localValue },
    });
    fireEvent.click(screen.getByTestId("record-response-confirm"));

    expect(hoisted.mutate).toHaveBeenCalledTimes(1);
  });

  it("skips the lower-bound check when no submittedAt is supplied (graceful degradation)", () => {
    // Caller didn't wire up `submittedAt`. The dialog should fall back
    // to the existing future-date check only, leaving the server as
    // the authoritative lower-bound enforcer.
    renderDialog({
      engagementId: "eng-7",
      submissionId: "sub-9",
      submittedAt: null,
    });
    fireEvent.change(screen.getByTestId("record-response-responded-at"), {
      target: { value: "2010-01-01T09:00" },
    });
    fireEvent.click(screen.getByTestId("record-response-confirm"));
    expect(hoisted.mutate).toHaveBeenCalledTimes(1);
  });

  it("clears the lower-bound error once the user picks a valid post-submission time", () => {
    renderDialog({ submittedAt: "2024-01-15T12:00:00.000Z" });

    fireEvent.change(screen.getByTestId("record-response-responded-at"), {
      target: { value: "2024-01-10T09:00" },
    });
    fireEvent.click(screen.getByTestId("record-response-confirm"));
    expect(
      screen.getByTestId("record-response-responded-at-help"),
    ).toHaveTextContent(/can't be before the package was sent/i);

    // Bumping to a clearly-after-submission time should drop the error
    // back to help copy and let the request go out.
    fireEvent.change(screen.getByTestId("record-response-responded-at"), {
      target: { value: "2024-01-20T09:00" },
    });
    expect(
      screen.getByTestId("record-response-responded-at-help"),
    ).toHaveTextContent(/Defaults to now/i);

    fireEvent.click(screen.getByTestId("record-response-confirm"));
    expect(hoisted.mutate).toHaveBeenCalledTimes(1);
  });

  it("reactively disables Record while the picked respondedAt is in the future (Task #127)", () => {
    // Mirrors the "comment too long" UX: the reviewer should not have
    // to click Record to discover the date is bad. The button must
    // disable on input change, before any submit attempt.
    renderDialog();

    // Sanity-check: with no input touched yet, Record is enabled.
    const submit = screen.getByTestId(
      "record-response-confirm",
    ) as HTMLButtonElement;
    expect(submit).not.toBeDisabled();

    const future = new Date(Date.now() + 10 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const localFuture =
      `${future.getFullYear()}-${pad(future.getMonth() + 1)}-` +
      `${pad(future.getDate())}T${pad(future.getHours())}:` +
      `${pad(future.getMinutes())}`;

    fireEvent.change(screen.getByTestId("record-response-responded-at"), {
      target: { value: localFuture },
    });

    // No click required — the disabled state must flip purely from the
    // input change.
    expect(submit).toBeDisabled();
    // The inline error renders too, in lockstep with the disabled flag.
    expect(
      screen.getByTestId("record-response-responded-at-help"),
    ).toHaveTextContent(/can't be in the future/i);

    // And clicking the (now-disabled) button must not start a request.
    fireEvent.click(submit);
    expect(hoisted.mutate).not.toHaveBeenCalled();

    // Correcting to a clearly-past time re-enables Record without a
    // round trip.
    fireEvent.change(screen.getByTestId("record-response-responded-at"), {
      target: { value: "2024-01-01T09:00" },
    });
    expect(submit).not.toBeDisabled();
  });

  it("reactively disables Record while the picked respondedAt is earlier than submittedAt (Task #127)", () => {
    // Same UX as the future-date case, but for the lower-bound guard
    // wired up in Task #119. Picking a pre-submission date must
    // disable Record on input change, not on submit attempt.
    renderDialog({ submittedAt: "2024-01-15T12:00:00.000Z" });

    const submit = screen.getByTestId(
      "record-response-confirm",
    ) as HTMLButtonElement;
    expect(submit).not.toBeDisabled();

    fireEvent.change(screen.getByTestId("record-response-responded-at"), {
      target: { value: "2024-01-10T09:00" },
    });

    expect(submit).toBeDisabled();
    expect(
      screen.getByTestId("record-response-responded-at-help"),
    ).toHaveTextContent(/can't be before the package was sent/i);

    fireEvent.click(submit);
    expect(hoisted.mutate).not.toHaveBeenCalled();

    // Bumping to a post-submission date re-enables the button reactively.
    fireEvent.change(screen.getByTestId("record-response-responded-at"), {
      target: { value: "2024-01-20T09:00" },
    });
    expect(submit).not.toBeDisabled();
  });

  it("clears the previous error when the user resubmits", async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId("record-response-confirm"));
    act(() => {
      hoisted.capturedOptions!.mutation!.onError!(
        new MockApiError(503),
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
