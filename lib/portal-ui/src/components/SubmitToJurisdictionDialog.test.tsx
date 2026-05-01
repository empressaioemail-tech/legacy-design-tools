/**
 * Component-level tests for the shared `SubmitToJurisdictionDialog`.
 *
 * Lives next to the component (Task #367, following Task #362's
 * portal-ui vitest harness) so the dialog's open/close gating, note
 * trim+coercion, character-counter, in-flight disabling, success
 * cache-invalidation fan-out, and ApiError → operator-copy mapping
 * are exercised against the rendered DOM without the design-tools
 * `EngagementDetail` scaffolding around it. The duplicated coverage
 * over on `artifacts/design-tools/src/components/__tests__/
 * SubmitToJurisdictionDialog.test.tsx` (Task #76) stays valid as
 * integration cover from the consumer side, but a refactor that
 * touches only the shared dialog can no longer ship without ever
 * running a portal-ui-scoped test.
 *
 * `@workspace/api-client-react` is mocked so we can:
 *   - control what the (otherwise generated)
 *     `useCreateEngagementSubmission` hook returns (mutate spy +
 *     isPending flag),
 *   - capture the mutation options the component registered, so we
 *     can drive `onSuccess` / `onError` manually instead of standing
 *     up a fake network layer,
 *   - export a real `ApiError` class with the same shape the
 *     component branches on (`instanceof ApiError`, `.status`,
 *     `.data`).
 *
 * A real `QueryClient` is wired in so we can spy on
 * `invalidateQueries` and verify the engagement + atom-history +
 * past-submissions caches are busted on success.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
} from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// ── Hoisted state shared with the mocks ────────────────────────────
//
// `mutateMock` is the spy the component's submit button drives, and
// `capturedOptions` is the mutation-options object the component
// passed into `useCreateEngagementSubmission` — we reach into it to
// fire `onSuccess` / `onError` without needing a real network round-
// trip. `state.isPending` lets a test flip the in-flight branch.
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
  useCreateEngagementSubmission: (options: typeof hoisted.capturedOptions) => {
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
  ApiError: hoisted.MockApiError,
}));

// 2 KB note ceiling — match the real generated constant so the over-
// limit boundary line up with the component's threshold.
vi.mock("@workspace/api-zod", () => ({
  createEngagementSubmissionBodyNoteMax: 2048,
}));

const { SubmitToJurisdictionDialog } = await import(
  "./SubmitToJurisdictionDialog"
);

// ── Render helpers ─────────────────────────────────────────────────

function makeQueryClient() {
  // Retry off so any failure surfaces immediately without backoff.
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderDialog(
  overrides: {
    isOpen?: boolean;
    onClose?: () => void;
    onSubmitted?: (receipt: unknown) => void;
    engagementId?: string;
    engagementName?: string;
    jurisdiction?: string | null;
    client?: QueryClient;
  } = {},
) {
  const onClose = overrides.onClose ?? vi.fn();
  const onSubmitted = overrides.onSubmitted;
  const client = overrides.client ?? makeQueryClient();
  const node: ReactNode = (
    <QueryClientProvider client={client}>
      <SubmitToJurisdictionDialog
        engagementId={overrides.engagementId ?? "eng-1"}
        engagementName={overrides.engagementName ?? "Seguin Residence"}
        jurisdiction={
          overrides.jurisdiction === undefined
            ? "Moab, UT"
            : overrides.jurisdiction
        }
        isOpen={overrides.isOpen ?? true}
        onClose={onClose}
        onSubmitted={onSubmitted}
      />
    </QueryClientProvider>
  );
  const utils = render(node);
  return { ...utils, onClose, client };
}

beforeEach(() => {
  hoisted.mutateMock.mockReset();
  hoisted.capturedOptions = null;
  hoisted.state.isPending = false;
});

describe("SubmitToJurisdictionDialog", () => {
  it("renders nothing when isOpen is false", () => {
    const { container } = renderDialog({ isOpen: false });
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("submit-jurisdiction-dialog")).toBeNull();
  });

  it("renders the engagement name and jurisdiction in the header when open", () => {
    renderDialog({
      engagementName: "Seguin Residence",
      jurisdiction: "Moab, UT",
    });
    expect(
      screen.getByTestId("submit-jurisdiction-dialog"),
    ).toBeInTheDocument();
    expect(screen.getByText("Seguin Residence")).toBeInTheDocument();
    // Jurisdiction is concatenated into the meta line so the
    // operator can confirm where the package lands before clicking.
    expect(screen.getByText(/to Moab, UT\.?/)).toBeInTheDocument();
  });

  it("omits the jurisdiction phrase when no jurisdiction is provided", () => {
    // The dialog still has to render even when the engagement isn't
    // bound to a jurisdiction yet — the operator can still log the
    // submission. The "to <jurisdiction>" phrase must drop entirely
    // rather than rendering "to ." or an empty trailing space.
    renderDialog({ jurisdiction: null });
    const dialog = screen.getByTestId("submit-jurisdiction-dialog");
    // The header copy only ever ends with "…has been sent." (no
    // dangling " to .") when no jurisdiction is set.
    expect(dialog.textContent).toMatch(/has been sent\./);
    expect(dialog.textContent).not.toMatch(/has been sent to/);
  });

  it("calls onClose when the backdrop is clicked", () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.click(screen.getByTestId("submit-jurisdiction-dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Cancel is clicked", () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when the dialog body itself is clicked (stopPropagation)", () => {
    // The card stops propagation so clicks inside the form don't
    // count as backdrop clicks — otherwise typing a long note and
    // accidentally clicking on the textarea wrapper would close the
    // dialog and lose the draft.
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.click(screen.getByTestId("submit-jurisdiction-note"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("updates the character counter as the note grows", () => {
    renderDialog();
    const textarea = screen.getByTestId(
      "submit-jurisdiction-note",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hello world" } });
    expect(
      screen.getByTestId("submit-jurisdiction-note-count"),
    ).toHaveTextContent("11 / 2048");
  });

  it("disables Submit (and keeps Cancel enabled) when the note exceeds 2 KB", () => {
    renderDialog();
    const textarea = screen.getByTestId(
      "submit-jurisdiction-note",
    ) as HTMLTextAreaElement;
    // One character past the ceiling.
    fireEvent.change(textarea, { target: { value: "x".repeat(2049) } });

    const submit = screen.getByTestId("submit-jurisdiction-confirm");
    expect(submit).toBeDisabled();
    expect(
      screen.getByTestId("submit-jurisdiction-note-count"),
    ).toHaveTextContent("2049 / 2048");

    // Clicking the disabled-by-overlimit button must NOT fire mutate.
    fireEvent.click(submit);
    expect(hoisted.mutateMock).not.toHaveBeenCalled();

    // Cancel stays available so users can back out without first
    // trimming the note down.
    expect(
      screen.getByRole("button", { name: /^Cancel$/i }),
    ).not.toBeDisabled();
  });

  it("sends an empty body when the note is empty", () => {
    renderDialog({ engagementId: "eng-42" });
    fireEvent.click(screen.getByTestId("submit-jurisdiction-confirm"));
    expect(hoisted.mutateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.mutateMock).toHaveBeenCalledWith({
      id: "eng-42",
      data: {},
    });
  });

  it("sends an empty body when the note is whitespace-only (trim coercion)", () => {
    renderDialog({ engagementId: "eng-42" });
    const textarea = screen.getByTestId("submit-jurisdiction-note");
    fireEvent.change(textarea, { target: { value: "   \n\t  " } });
    fireEvent.click(screen.getByTestId("submit-jurisdiction-confirm"));
    expect(hoisted.mutateMock).toHaveBeenCalledWith({
      id: "eng-42",
      data: {},
    });
  });

  it("sends the trimmed note when the user typed real content", () => {
    renderDialog({ engagementId: "eng-7" });
    const textarea = screen.getByTestId("submit-jurisdiction-note");
    fireEvent.change(textarea, {
      target: { value: "  Permit set v1, all sheets cleaned.  " },
    });
    fireEvent.click(screen.getByTestId("submit-jurisdiction-confirm"));
    expect(hoisted.mutateMock).toHaveBeenCalledWith({
      id: "eng-7",
      data: { note: "Permit set v1, all sheets cleaned." },
    });
  });

  it("disables Submit / Cancel and flips the button label while the mutation is pending", () => {
    hoisted.state.isPending = true;
    renderDialog();
    const submit = screen.getByTestId("submit-jurisdiction-confirm");
    expect(submit).toBeDisabled();
    expect(submit).toHaveTextContent(/Submitting/i);
    expect(
      screen.getByRole("button", { name: /^Cancel$/i }),
    ).toBeDisabled();
    expect(screen.getByTestId("submit-jurisdiction-note")).toBeDisabled();

    // Clicking the in-flight button must not enqueue another mutation.
    fireEvent.click(submit);
    expect(hoisted.mutateMock).not.toHaveBeenCalled();
  });

  it("does not call onClose when the backdrop is clicked while pending", () => {
    // Mid-flight backdrop clicks must not tear the dialog down — the
    // mutation is still resolving and dropping the dialog would lose
    // the operator's view of the in-flight state.
    hoisted.state.isPending = true;
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.click(screen.getByTestId("submit-jurisdiction-dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("invalidates the engagement / atom-history / past-submissions caches and closes on success", async () => {
    const onClose = vi.fn();
    const client = makeQueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    renderDialog({ onClose, client, engagementId: "eng-99" });

    // Drive the click so the component records the mutate call,
    // then hand-fire onSuccess (the mock mutate is a no-op spy that
    // never resolves the underlying promise).
    fireEvent.click(screen.getByTestId("submit-jurisdiction-confirm"));
    expect(hoisted.capturedOptions?.mutation?.onSuccess).toBeDefined();
    await act(async () => {
      await hoisted.capturedOptions!.mutation!.onSuccess!(
        { submittedAt: "2026-04-15T10:00:00.000Z" },
        { id: "eng-99", data: {} },
        undefined,
      );
    });

    // All three caches the engagement page reads from must be
    // busted — engagement detail, atom-history timeline, and the
    // past-submissions list.
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["getEngagement", "eng-99"],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["getAtomHistory", "engagement", "eng-99"],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["listEngagementSubmissions", "eng-99"],
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("forwards the server receipt to onSubmitted before closing", async () => {
    // The parent uses the receipt to surface a non-blocking
    // "Submission recorded at <timestamp>" banner — if the receipt
    // ever stopped flowing through, that banner would silently lose
    // its timestamp. Pin the contract here.
    const onSubmitted = vi.fn();
    const onClose = vi.fn();
    renderDialog({ onSubmitted, onClose, engagementId: "eng-12" });
    fireEvent.click(screen.getByTestId("submit-jurisdiction-confirm"));

    const receipt = { submittedAt: "2026-04-15T10:00:00.000Z" };
    await act(async () => {
      await hoisted.capturedOptions!.mutation!.onSuccess!(
        receipt,
        { id: "eng-12", data: {} },
        undefined,
      );
    });

    expect(onSubmitted).toHaveBeenCalledTimes(1);
    expect(onSubmitted).toHaveBeenCalledWith(receipt);
    // onSubmitted must fire before onClose so the parent has the
    // receipt in hand by the time it has to render the banner.
    expect(onSubmitted.mock.invocationCallOrder[0]).toBeLessThan(
      onClose.mock.invocationCallOrder[0]!,
    );
  });

  it("maps a 404 to a friendly 'engagement no longer exists' message", async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId("submit-jurisdiction-confirm"));
    act(() => {
      hoisted.capturedOptions!.mutation!.onError!(
        new hoisted.MockApiError(404, { detail: "not found" }),
        { id: "eng-1", data: {} },
        undefined,
      );
    });

    expect(
      await screen.findByTestId("submit-jurisdiction-error"),
    ).toHaveTextContent(/no longer exists/i);
    // We did NOT close on error — the user gets a chance to retry.
  });

  it("surfaces the server-provided detail for a 400, when present", async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId("submit-jurisdiction-confirm"));
    act(() => {
      hoisted.capturedOptions!.mutation!.onError!(
        new hoisted.MockApiError(400, {
          detail: "Note contains forbidden control characters.",
        }),
        { id: "eng-1", data: {} },
        undefined,
      );
    });
    expect(
      await screen.findByTestId("submit-jurisdiction-error"),
    ).toHaveTextContent("Note contains forbidden control characters.");
  });

  it("falls back to a generic note-may-be-too-long message for a 400 with no detail", async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId("submit-jurisdiction-confirm"));
    act(() => {
      hoisted.capturedOptions!.mutation!.onError!(
        new hoisted.MockApiError(400, {}),
        { id: "eng-1", data: {} },
        undefined,
      );
    });
    expect(
      await screen.findByTestId("submit-jurisdiction-error"),
    ).toHaveTextContent(/Note may be too long \(max 2048 chars\)/i);
  });

  it("maps any 5xx status to a generic 'server hit a snag' retry message", async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId("submit-jurisdiction-confirm"));
    act(() => {
      hoisted.capturedOptions!.mutation!.onError!(
        new hoisted.MockApiError(503, { detail: "db down" }),
        { id: "eng-1", data: {} },
        undefined,
      );
    });
    expect(
      await screen.findByTestId("submit-jurisdiction-error"),
    ).toHaveTextContent(/server hit a snag/i);
  });

  it("clears the previous error when the user resubmits", async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId("submit-jurisdiction-confirm"));
    act(() => {
      hoisted.capturedOptions!.mutation!.onError!(
        new hoisted.MockApiError(503),
        { id: "eng-1", data: {} },
        undefined,
      );
    });
    expect(
      await screen.findByTestId("submit-jurisdiction-error"),
    ).toBeInTheDocument();

    // Re-clicking submit should wipe the visible error before the
    // next mutate fires; otherwise stale 5xx text would linger over
    // a new in-flight attempt.
    fireEvent.click(screen.getByTestId("submit-jurisdiction-confirm"));
    await waitFor(() => {
      expect(
        screen.queryByTestId("submit-jurisdiction-error"),
      ).toBeNull();
    });
  });
});
