/**
 * SubmitToJurisdictionDialog — fast component tests for the "submit to
 * jurisdiction" flow that was previously only verified end-to-end against
 * the live API.
 *
 * We mock @workspace/api-client-react so we can:
 *   - control what the (otherwise generated) `useCreateEngagementSubmission`
 *     hook returns (mutate spy + isPending flag),
 *   - capture the mutation options the component registered, so we can
 *     drive onSuccess / onError manually instead of standing up a fake
 *     network layer,
 *   - export a real `ApiError` class with the same shape the component
 *     branches on (`instanceof ApiError`, `.status`, `.data`).
 *
 * A real QueryClient is wired in so we can spy on `invalidateQueries` and
 * verify the engagement + atom-history caches are busted on success.
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

// ── Hoisted state shared with the mocks ─────────────────────────────────
//
// `mutateMock` is the spy the component's submit button drives, and
// `capturedOptions` is the mutation-options object the component passed
// into useCreateEngagementSubmission — we reach into it to fire onSuccess
// / onError without needing a real network round-trip.
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

// Replace the placeholder with a real spy after vi.hoisted.
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

// 2 KB note ceiling — match the real generated constant so over-limit
// boundaries line up with the component's threshold.
vi.mock("@workspace/api-zod", () => ({
  createEngagementSubmissionBodyNoteMax: 2048,
}));

const { SubmitToJurisdictionDialog } = await import("@workspace/portal-ui");

// ── Render helpers ──────────────────────────────────────────────────────

function makeQueryClient() {
  // Retry off so any failure surfaces immediately without backoff,
  // matching the convention used by DevAtomsProbe.test.tsx.
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
  engagementId?: string;
  engagementName?: string;
  jurisdiction?: string | null;
  client?: QueryClient;
} = {}) {
  const onClose = overrides.onClose ?? vi.fn();
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

afterEach(() => {
  cleanup();
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
    // Jurisdiction is concatenated into the meta line.
    expect(screen.getByText(/to Moab, UT\.?/)).toBeInTheDocument();
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

  it("disables the Submit button (and keeps Cancel enabled) when the note exceeds 2 KB", () => {
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
    // trimming the note.
    expect(screen.getByRole("button", { name: /^Cancel$/i })).not.toBeDisabled();
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

  it("sends an empty body when the note is whitespace-only (coercion)", () => {
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
    expect(screen.getByRole("button", { name: /^Cancel$/i })).toBeDisabled();
    expect(screen.getByTestId("submit-jurisdiction-note")).toBeDisabled();

    // Clicking the in-flight button must not enqueue another mutation.
    fireEvent.click(submit);
    expect(hoisted.mutateMock).not.toHaveBeenCalled();
  });

  it("does not call onClose when the backdrop is clicked while pending", () => {
    hoisted.state.isPending = true;
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.click(screen.getByTestId("submit-jurisdiction-dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("invalidates the engagement and atom-history caches and closes on success", async () => {
    const onClose = vi.fn();
    const client = makeQueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    renderDialog({ onClose, client, engagementId: "eng-99" });

    // Drive the click so the component records the mutate call, then
    // hand-fire onSuccess (the mock mutate is a no-op spy that never
    // resolves the underlying promise).
    fireEvent.click(screen.getByTestId("submit-jurisdiction-confirm"));
    expect(hoisted.capturedOptions?.mutation?.onSuccess).toBeDefined();
    await act(async () => {
      await hoisted.capturedOptions!.mutation!.onSuccess!(
        undefined,
        { id: "eng-99", data: {} },
        undefined,
      );
    });

    // Both caches the engagement page reads from must be busted.
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["getEngagement", "eng-99"],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["getAtomHistory", "engagement", "eng-99"],
    });
    expect(onClose).toHaveBeenCalledTimes(1);
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

    // Re-clicking submit should wipe the visible error before the next
    // mutate fires; otherwise stale 5xx text would linger over a new
    // in-flight attempt.
    fireEvent.click(screen.getByTestId("submit-jurisdiction-confirm"));
    await waitFor(() => {
      expect(
        screen.queryByTestId("submit-jurisdiction-error"),
      ).toBeNull();
    });
  });
});
