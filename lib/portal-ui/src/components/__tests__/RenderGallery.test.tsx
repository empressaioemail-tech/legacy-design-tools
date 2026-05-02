/**
 * RenderGallery regression coverage. Pins the loading / error /
 * empty / grid states the architect tab and reviewer strip both
 * depend on, plus the 503 `renders_preview_disabled` inline notice,
 * the per-card cancel-with-confirmation flow, and the `canCancel`
 * audience gate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  createMutationCapture,
  makeCapturingMutationHook,
  MockApiError,
  createQueryKeyStubs,
} from "../../test-utils/mockApiClient";
import {
  fixtureReadyStill,
  fixtureReadyStillDetail,
  fixtureRenderingStill,
  fixtureRenderingStillDetail,
} from "../../test-utils/renderFixtures";
import type {
  RenderDetailResponse,
  RenderListItem,
} from "@workspace/api-client-react";

const hoisted = vi.hoisted(() => ({
  items: [] as RenderListItem[],
  detailById: new Map<string, RenderDetailResponse>(),
  listError: null as Error | null,
  listLoading: false,
}));

const cancel = createMutationCapture<unknown, { id: string }>();

vi.mock("@workspace/api-client-react", () => {
  return {
    ApiError: MockApiError,
    ...createQueryKeyStubs([
      "getListEngagementRendersQueryKey",
      "getGetRenderQueryKey",
    ] as const),
    useListEngagementRenders: () => ({
      data: hoisted.listError ? undefined : { items: hoisted.items },
      error: hoisted.listError,
      isLoading: hoisted.listLoading,
    }),
    useGetRender: (id: string) => ({
      data: hoisted.detailById.get(id) ?? undefined,
      error: null,
      isLoading: false,
    }),
    useCancelRender: makeCapturingMutationHook(cancel),
  };
});

const { RenderGallery } = await import("../RenderGallery");

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderGallery(props?: { canCancel?: boolean }) {
  const client = makeQueryClient();
  const node: ReactNode = (
    <QueryClientProvider client={client}>
      <RenderGallery
        engagementId="eng-1"
        canCancel={props?.canCancel ?? true}
      />
    </QueryClientProvider>
  );
  return { ...render(node), client };
}

let confirmSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  hoisted.items = [];
  hoisted.detailById = new Map();
  hoisted.listError = null;
  hoisted.listLoading = false;
  cancel.reset();
  confirmSpy = vi
    .spyOn(window, "confirm")
    .mockImplementation(() => true);
});

afterEach(() => {
  cleanup();
  confirmSpy?.mockRestore();
  confirmSpy = null;
});

describe("RenderGallery", () => {
  it("shows the loading state on first paint", () => {
    hoisted.listLoading = true;
    renderGallery();
    expect(screen.getByTestId("renders-gallery-loading")).toBeInTheDocument();
  });

  it("shows the empty state when the list is empty", () => {
    renderGallery();
    expect(screen.getByTestId("renders-gallery-empty")).toBeInTheDocument();
  });

  it("renders the inline 'preview disabled' notice when the listing endpoint returns 503 renders_preview_disabled", () => {
    hoisted.listError = new MockApiError(503, {
      errorCode: "renders_preview_disabled",
    });
    renderGallery();
    expect(
      screen.getByTestId("renders-preview-disabled"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("renders-gallery-error"),
    ).not.toBeInTheDocument();
  });

  it("renders the generic error state for non-503 errors", () => {
    hoisted.listError = new Error("network blew up");
    renderGallery();
    const err = screen.getByTestId("renders-gallery-error");
    expect(err).toHaveTextContent(/network blew up/i);
  });

  it("renders one card per render in a responsive grid (no master/detail)", () => {
    hoisted.items = [fixtureRenderingStill, fixtureReadyStill];
    hoisted.detailById.set(
      fixtureRenderingStillDetail.id,
      fixtureRenderingStillDetail,
    );
    hoisted.detailById.set(
      fixtureReadyStillDetail.id,
      fixtureReadyStillDetail,
    );
    renderGallery();
    const grid = screen.getByTestId("renders-gallery");
    expect(grid).toBeInTheDocument();
    expect(
      screen.getByTestId(`render-card-${fixtureRenderingStill.id}`),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`render-card-${fixtureReadyStill.id}`),
    ).toBeInTheDocument();
  });

  it("fires the cancel mutation after window.confirm() returns true", () => {
    hoisted.items = [fixtureRenderingStill];
    hoisted.detailById.set(
      fixtureRenderingStillDetail.id,
      fixtureRenderingStillDetail,
    );
    renderGallery();
    const cancelBtn = screen.getByTestId(
      `render-cancel-${fixtureRenderingStill.id}`,
    );
    fireEvent.click(cancelBtn);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(cancel.mutate).toHaveBeenCalledWith({
      id: fixtureRenderingStill.id,
    });
  });

  it("does not fire the cancel mutation when window.confirm() returns false", () => {
    confirmSpy?.mockImplementation(() => false);
    hoisted.items = [fixtureRenderingStill];
    hoisted.detailById.set(
      fixtureRenderingStillDetail.id,
      fixtureRenderingStillDetail,
    );
    renderGallery();
    fireEvent.click(
      screen.getByTestId(`render-cancel-${fixtureRenderingStill.id}`),
    );
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(cancel.mutate).not.toHaveBeenCalled();
  });

  it("hides the cancel affordance when canCancel is false (reviewer surface)", () => {
    hoisted.items = [fixtureRenderingStill];
    hoisted.detailById.set(
      fixtureRenderingStillDetail.id,
      fixtureRenderingStillDetail,
    );
    renderGallery({ canCancel: false });
    expect(
      screen.queryByTestId(`render-cancel-${fixtureRenderingStill.id}`),
    ).not.toBeInTheDocument();
  });

  it("surfaces the cancel error inline after the mutation fails", async () => {
    hoisted.items = [fixtureRenderingStill];
    hoisted.detailById.set(
      fixtureRenderingStillDetail.id,
      fixtureRenderingStillDetail,
    );
    renderGallery();
    fireEvent.click(
      screen.getByTestId(`render-cancel-${fixtureRenderingStill.id}`),
    );
    expect(cancel.capturedOptions?.mutation?.onError).toBeDefined();
    await act(async () => {
      cancel.capturedOptions!.mutation!.onError!(
        new MockApiError(409, { errorCode: "render_already_terminal" }),
        { id: fixtureRenderingStill.id },
        undefined,
      );
    });
    const err = screen.getByTestId(
      `render-cancel-error-${fixtureRenderingStill.id}`,
    );
    expect(err).toHaveTextContent(/already in a terminal state/i);
  });
});
