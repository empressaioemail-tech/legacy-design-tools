/**
 * DismissReviewerRequestDialog — Wave 2 Sprint D / V1-2 / Task #423.
 *
 * Coverage isolated to dialog-internal contract (the strip-level
 * round-trip is covered by `ReviewerRequestsStrip.test.tsx`):
 *
 *   - Renders the original reviewer reason verbatim + the
 *     request-kind chip in the header so the architect has full
 *     context before typing.
 *   - The Dismiss button stays disabled until the architect types a
 *     non-trivial reason (whitespace-only doesn't unlock it).
 *   - Submitting the dialog calls the mutation with the trimmed
 *     reason on the right request id.
 *   - Server errors render an inline alert, do not close the
 *     dialog, and clear when the architect resubmits.
 *   - Esc closes when the dialog is idle, but is suppressed while a
 *     dismiss is in flight (so the architect can't strand a
 *     half-applied optimistic write off-screen).
 *   - The reason textarea auto-focuses on open so the architect can
 *     start typing immediately.
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
  cleanup,
  act,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const hoisted = vi.hoisted(() => ({
  dismissMutate: vi.fn(),
  dismissIsPending: false,
  dismissOnMutate: undefined as
    | ((vars: { id: string; data: { dismissalReason: string } }) =>
        | Promise<unknown>
        | unknown)
    | undefined,
  dismissOnSuccess: undefined as
    | ((response: { request: unknown }) => void)
    | undefined,
  dismissOnError: undefined as
    | ((err: unknown, vars: unknown, context: unknown) => void)
    | undefined,
}));

class MockApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, data?: unknown) {
    super(`MockApiError ${status}`);
    this.status = status;
    this.data = data ?? {};
  }
}

vi.mock("@workspace/api-client-react", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/api-client-react")>(
      "@workspace/api-client-react",
    );
  return {
    ...actual,
    ApiError: MockApiError,
    useDismissReviewerRequest: (opts?: {
      mutation?: {
        onMutate?: (vars: {
          id: string;
          data: { dismissalReason: string };
        }) => Promise<unknown> | unknown;
        onSuccess?: (response: { request: unknown }) => void;
        onError?: (err: unknown, vars: unknown, context: unknown) => void;
      };
    }) => {
      hoisted.dismissOnMutate = opts?.mutation?.onMutate;
      hoisted.dismissOnSuccess = opts?.mutation?.onSuccess;
      hoisted.dismissOnError = opts?.mutation?.onError;
      return {
        mutate: hoisted.dismissMutate,
        isPending: hoisted.dismissIsPending,
      };
    },
    getListEngagementReviewerRequestsQueryKey: (
      id: string,
      params?: unknown,
    ) => {
      const base: unknown[] = ["listEngagementReviewerRequests", id];
      if (params) base.push(params);
      return base;
    },
    getGetAtomHistoryQueryKey: (entityType: string, entityId: string) => [
      "getAtomHistory",
      entityType,
      entityId,
    ],
  };
});

const { DismissReviewerRequestDialog } = await import(
  "../DismissReviewerRequestDialog"
);

const REQUEST = {
  id: "req-99",
  engagementId: "eng-7",
  requestKind: "refresh-bim-model" as const,
  targetEntityType: "bim-model" as const,
  targetEntityId: "bim-uuid-1",
  reason: "BIM model is missing the south-elevation update.",
  status: "pending" as const,
  requestedBy: {
    kind: "user" as const,
    id: "reviewer-9",
    displayName: "Sam Reviewer",
  },
  requestedAt: new Date("2026-04-30T12:00:00Z").toISOString(),
  dismissedBy: null,
  dismissedAt: null,
  dismissalReason: null,
  resolvedAt: null,
  triggeredActionEventId: null,
  createdAt: new Date("2026-04-30T12:00:00Z").toISOString(),
  updatedAt: new Date("2026-04-30T12:00:00Z").toISOString(),
};

function renderDialog(overrides: {
  isOpen?: boolean;
  onClose?: () => void;
  onDismissed?: (req: unknown) => void;
} = {}) {
  const onClose = overrides.onClose ?? vi.fn();
  const onDismissed = overrides.onDismissed ?? vi.fn();
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const ui: ReactNode = (
    <QueryClientProvider client={client}>
      <DismissReviewerRequestDialog
        request={REQUEST}
        isOpen={overrides.isOpen ?? true}
        onClose={onClose}
        onDismissed={onDismissed}
      />
    </QueryClientProvider>
  );
  const utils = render(ui);
  return { ...utils, onClose, onDismissed, client };
}

describe("DismissReviewerRequestDialog", () => {
  beforeEach(() => {
    hoisted.dismissMutate.mockReset();
    hoisted.dismissIsPending = false;
    hoisted.dismissOnMutate = undefined;
    hoisted.dismissOnSuccess = undefined;
    hoisted.dismissOnError = undefined;
  });
  afterEach(() => cleanup());

  it("renders nothing when isOpen is false", () => {
    const { container } = renderDialog({ isOpen: false });
    expect(container.firstChild).toBeNull();
  });

  it("surfaces the original reviewer reason and the request-kind chip in the header", () => {
    renderDialog();
    expect(
      screen.getByTestId("dismiss-reviewer-request-original-reason"),
    ).toHaveTextContent(/missing the south-elevation update/);
    // The header explains which action the reviewer asked for so the
    // architect knows what they're declining.
    expect(screen.getByText(/refresh BIM model/i)).toBeInTheDocument();
  });

  it("renders the requester identity in the summary so the architect knows who filed the request", () => {
    renderDialog();
    expect(
      screen.getByTestId("dismiss-reviewer-request-requester"),
    ).toHaveTextContent(/Sam Reviewer/);
  });

  it("keeps the Dismiss button disabled until a non-trivial reason is typed", () => {
    renderDialog();
    const submit = screen.getByTestId(
      "dismiss-reviewer-request-confirm",
    ) as HTMLButtonElement;
    expect(submit).toBeDisabled();

    // Whitespace-only reason: still disabled (server-side guard
    // would 400, so we mirror it client-side).
    fireEvent.change(
      screen.getByTestId("dismiss-reviewer-request-reason"),
      { target: { value: "   \n\t  " } },
    );
    expect(submit).toBeDisabled();

    // Real content: enabled.
    fireEvent.change(
      screen.getByTestId("dismiss-reviewer-request-reason"),
      { target: { value: "Source is current." } },
    );
    expect(submit).not.toBeDisabled();
  });

  it("submits the trimmed reason against the request id", () => {
    renderDialog();
    fireEvent.change(
      screen.getByTestId("dismiss-reviewer-request-reason"),
      { target: { value: "  Source is current.  " } },
    );
    fireEvent.click(screen.getByTestId("dismiss-reviewer-request-confirm"));
    expect(hoisted.dismissMutate).toHaveBeenCalledWith({
      id: "req-99",
      data: { dismissalReason: "Source is current." },
    });
  });

  it("renders the formatted error inline on a 500 and keeps the dialog open", async () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.change(
      screen.getByTestId("dismiss-reviewer-request-reason"),
      { target: { value: "no" } },
    );
    fireEvent.click(screen.getByTestId("dismiss-reviewer-request-confirm"));
    act(() => {
      hoisted.dismissOnError!(
        new MockApiError(500, {}),
        { id: "req-99", data: { dismissalReason: "no" } },
        undefined,
      );
    });
    expect(
      await screen.findByTestId("dismiss-reviewer-request-error"),
    ).toHaveTextContent(/snag/i);
    // Dialog stays open so the architect can adjust + retry.
    expect(
      screen.getByTestId("dismiss-reviewer-request-dialog"),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("clears a previous error when the architect resubmits", async () => {
    renderDialog();
    fireEvent.change(
      screen.getByTestId("dismiss-reviewer-request-reason"),
      { target: { value: "no" } },
    );
    fireEvent.click(screen.getByTestId("dismiss-reviewer-request-confirm"));
    act(() => {
      hoisted.dismissOnError!(
        new MockApiError(500, {}),
        { id: "req-99", data: { dismissalReason: "no" } },
        undefined,
      );
    });
    expect(
      await screen.findByTestId("dismiss-reviewer-request-error"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("dismiss-reviewer-request-confirm"));
    await waitFor(() => {
      expect(
        screen.queryByTestId("dismiss-reviewer-request-error"),
      ).toBeNull();
    });
  });

  it("closes on Escape when idle but is suppressed mid-flight", () => {
    const onClose = vi.fn();
    renderDialog({ onClose });

    // Idle: Esc closes.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    cleanup();
    // Re-render in a "submitting" state; Esc must NOT close so the
    // architect can't strand a half-applied optimistic write
    // off-screen.
    hoisted.dismissIsPending = true;
    renderDialog({ onClose });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("auto-focuses the reason textarea on open so the architect can type immediately", async () => {
    renderDialog();
    const textarea = screen.getByTestId("dismiss-reviewer-request-reason");
    await waitFor(() => {
      expect(document.activeElement).toBe(textarea);
    });
  });

  it("notifies the parent via onDismissed and closes on success", async () => {
    const onClose = vi.fn();
    const onDismissed = vi.fn();
    renderDialog({ onClose, onDismissed });
    fireEvent.change(
      screen.getByTestId("dismiss-reviewer-request-reason"),
      { target: { value: "Source is current." } },
    );
    fireEvent.click(screen.getByTestId("dismiss-reviewer-request-confirm"));

    await act(async () => {
      await hoisted.dismissOnSuccess!({
        request: { ...REQUEST, status: "dismissed" },
      });
    });
    expect(onDismissed).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
