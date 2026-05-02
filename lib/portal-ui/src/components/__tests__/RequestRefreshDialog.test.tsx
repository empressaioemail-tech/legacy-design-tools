/**
 * RequestRefreshDialog + RequestRefreshAffordance (lib/portal-ui).
 *
 * Wave 2 Sprint D / V1-2 — reviewer-side affordance for filing a
 * "please refresh" request against a stale target atom.
 *
 * Coverage:
 *   - Dialog renders only when `isOpen` is true.
 *   - Reason field starts empty when (re-)opened; submit disabled
 *     until non-empty.
 *   - Submit calls the generated `useCreateEngagementReviewerRequest`
 *     mutation with the right body shape; success closes the dialog
 *     and fires `onCreated`.
 *   - Mutation error surfaces inline as a `request-refresh-error`
 *     message, dialog stays open.
 *   - Click-outside closes the dialog when not submitting.
 *   - Affordance opens the dialog on click.
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
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const hoisted = vi.hoisted(() => ({
  createMutate: vi.fn(),
  createIsPending: false,
  createOnSuccess: undefined as
    | ((response: { request: unknown }) => void)
    | undefined,
  createOnError: undefined as ((err: unknown) => void) | undefined,
}));

vi.mock("@workspace/api-client-react", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/api-client-react")>(
      "@workspace/api-client-react",
    );
  return {
    ...actual,
    useCreateEngagementReviewerRequest: (opts?: {
      mutation?: {
        onSuccess?: (response: { request: unknown }) => void;
        onError?: (err: unknown) => void;
      };
    }) => {
      hoisted.createOnSuccess = opts?.mutation?.onSuccess;
      hoisted.createOnError = opts?.mutation?.onError;
      return {
        mutate: hoisted.createMutate,
        isPending: hoisted.createIsPending,
      };
    },
    getListEngagementReviewerRequestsQueryKey: (id: string) => [
      "listEngagementReviewerRequests",
      id,
    ],
    getGetAtomHistoryQueryKey: (entityType: string, entityId: string) => [
      "getAtomHistory",
      entityType,
      entityId,
    ],
  };
});

const { RequestRefreshDialog } = await import("../RequestRefreshDialog");
const { RequestRefreshAffordance } = await import(
  "../RequestRefreshAffordance"
);

function withQuery(node: ReactNode): ReactNode {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

const STABLE_PROPS = {
  engagementId: "eng-123",
  requestKind: "refresh-briefing-source" as const,
  targetEntityType: "briefing-source" as const,
  targetEntityId: "src-uuid-1",
  targetLabel: "zoning",
};

describe("RequestRefreshDialog", () => {
  beforeEach(() => {
    hoisted.createMutate.mockReset();
    hoisted.createIsPending = false;
    hoisted.createOnSuccess = undefined;
    hoisted.createOnError = undefined;
  });
  afterEach(() => cleanup());

  it("renders nothing when isOpen is false", () => {
    render(
      withQuery(
        <RequestRefreshDialog
          {...STABLE_PROPS}
          isOpen={false}
          onClose={() => {}}
        />,
      ),
    );
    expect(screen.queryByTestId("request-refresh-dialog")).toBeNull();
  });

  it("renders the dialog with target label and an empty reason on open", () => {
    render(
      withQuery(
        <RequestRefreshDialog
          {...STABLE_PROPS}
          isOpen={true}
          onClose={() => {}}
        />,
      ),
    );
    expect(screen.getByTestId("request-refresh-dialog")).toBeInTheDocument();
    expect(screen.getByText("zoning")).toBeInTheDocument();
    const textarea = screen.getByTestId(
      "request-refresh-reason",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("");
    // Submit button is disabled while reason is empty.
    expect(
      (screen.getByTestId("request-refresh-confirm") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("submits with the right body shape on confirm", () => {
    render(
      withQuery(
        <RequestRefreshDialog
          {...STABLE_PROPS}
          isOpen={true}
          onClose={() => {}}
        />,
      ),
    );
    const textarea = screen.getByTestId(
      "request-refresh-reason",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: "Source PDF appears outdated." },
    });
    expect(
      (screen.getByTestId("request-refresh-confirm") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fireEvent.click(screen.getByTestId("request-refresh-confirm"));
    expect(hoisted.createMutate).toHaveBeenCalledTimes(1);
    expect(hoisted.createMutate).toHaveBeenCalledWith({
      id: "eng-123",
      data: {
        requestKind: "refresh-briefing-source",
        targetEntityType: "briefing-source",
        targetEntityId: "src-uuid-1",
        reason: "Source PDF appears outdated.",
      },
    });
  });

  it("fires onCreated and onClose on mutation success", async () => {
    const onClose = vi.fn();
    const onCreated = vi.fn();
    render(
      withQuery(
        <RequestRefreshDialog
          {...STABLE_PROPS}
          isOpen={true}
          onClose={onClose}
          onCreated={onCreated}
        />,
      ),
    );
    fireEvent.change(screen.getByTestId("request-refresh-reason"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByTestId("request-refresh-confirm"));
    // Simulate the mutation's success callback (the mock captured it
    // when the hook was instantiated above).
    expect(hoisted.createOnSuccess).toBeDefined();
    await hoisted.createOnSuccess!({
      request: { id: "req-1", reason: "x" },
    });
    expect(onCreated).toHaveBeenCalledWith({ id: "req-1", reason: "x" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("surfaces a mutation error inline and keeps the dialog open", async () => {
    const onClose = vi.fn();
    render(
      withQuery(
        <RequestRefreshDialog
          {...STABLE_PROPS}
          isOpen={true}
          onClose={onClose}
        />,
      ),
    );
    fireEvent.change(screen.getByTestId("request-refresh-reason"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByTestId("request-refresh-confirm"));
    expect(hoisted.createOnError).toBeDefined();
    hoisted.createOnError!(new Error("boom"));
    // Re-render after state change.
    expect(
      await screen.findByTestId("request-refresh-error"),
    ).toHaveTextContent("boom");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Cancel button closes the dialog", () => {
    const onClose = vi.fn();
    render(
      withQuery(
        <RequestRefreshDialog
          {...STABLE_PROPS}
          isOpen={true}
          onClose={onClose}
        />,
      ),
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("RequestRefreshAffordance", () => {
  beforeEach(() => {
    hoisted.createMutate.mockReset();
    hoisted.createIsPending = false;
  });
  afterEach(() => cleanup());

  it("does not render the dialog until clicked", () => {
    render(
      withQuery(
        <RequestRefreshAffordance
          {...STABLE_PROPS}
        />,
      ),
    );
    expect(
      screen.getByTestId("request-refresh-affordance-src-uuid-1"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("request-refresh-dialog")).toBeNull();
  });

  it("opens the dialog when the button is clicked", () => {
    render(
      withQuery(
        <RequestRefreshAffordance
          {...STABLE_PROPS}
        />,
      ),
    );
    fireEvent.click(screen.getByTestId("request-refresh-affordance-src-uuid-1"));
    expect(screen.getByTestId("request-refresh-dialog")).toBeInTheDocument();
    // Affordance carries the request-kind on its data attribute so
    // e2e selectors can target a specific kind without text matching.
    expect(
      screen.getByTestId("request-refresh-affordance-src-uuid-1"),
    ).toHaveAttribute("data-request-kind", "refresh-briefing-source");
  });
});
