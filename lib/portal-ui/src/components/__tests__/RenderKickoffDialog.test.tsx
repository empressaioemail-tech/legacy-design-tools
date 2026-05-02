/**
 * V1-4 / Task #422 — RenderKickoffDialog regression coverage. The
 * dialog is architect-only by deployment context but lives in
 * portal-ui so the kind selector / camera fields / 503 inline
 * error / 400 detail extraction stay in lock-step with the
 * tested contract.
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
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  createMutationCapture,
  makeCapturingMutationHook,
  MockApiError,
  createQueryKeyStubs,
} from "../../test-utils/mockApiClient";

const kickoff = createMutationCapture<
  { renderId: string },
  { id: string; data: Record<string, unknown> }
>();

vi.mock("@workspace/api-client-react", () => {
  return {
    ApiError: MockApiError,
    ...createQueryKeyStubs([
      "getListEngagementRendersQueryKey",
    ] as const),
    useKickoffRender: makeCapturingMutationHook(kickoff),
  };
});

const { RenderKickoffDialog } = await import("../RenderKickoffDialog");

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderDialog(opts?: { onClose?: () => void; onKickedOff?: () => void }) {
  const client = makeQueryClient();
  const onClose = opts?.onClose ?? vi.fn();
  const onKickedOff = opts?.onKickedOff ?? vi.fn();
  const node: ReactNode = (
    <QueryClientProvider client={client}>
      <RenderKickoffDialog
        engagementId="eng-1"
        defaultGlbUrl="https://example.com/model.glb"
        isOpen
        onClose={onClose}
        onKickedOff={onKickedOff}
      />
    </QueryClientProvider>
  );
  return { ...render(node), onClose, onKickedOff };
}

beforeEach(() => {
  kickoff.reset();
});

afterEach(() => cleanup());

describe("RenderKickoffDialog", () => {
  it("renders nothing when isOpen is false", () => {
    const client = makeQueryClient();
    render(
      <QueryClientProvider client={client}>
        <RenderKickoffDialog
          engagementId="eng-1"
          isOpen={false}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.queryByTestId("render-kickoff-dialog"),
    ).not.toBeInTheDocument();
  });

  it("submits a still kickoff body with the camera fields", () => {
    renderDialog();
    fireEvent.change(screen.getByTestId("render-kickoff-prompt"), {
      target: { value: "modern desert house, golden hour" },
    });
    fireEvent.click(screen.getByTestId("render-kickoff-confirm"));
    expect(kickoff.mutate).toHaveBeenCalledTimes(1);
    const call = kickoff.mutate.mock.calls[0][0] as {
      id: string;
      data: Record<string, unknown>;
    };
    expect(call.id).toBe("eng-1");
    expect(call.data).toMatchObject({
      kind: "still",
      glbUrl: "https://example.com/model.glb",
      prompt: "modern desert house, golden hour",
      cameraPosition: { x: 0, y: 0, z: 10 },
      cameraTarget: { x: 0, y: 0, z: 0 },
    });
  });

  it("switches to elevation-set fields and submits a buildingCenter + cameraDistance body", () => {
    renderDialog();
    fireEvent.change(screen.getByTestId("render-kickoff-kind"), {
      target: { value: "elevation-set" },
    });
    expect(
      screen.getByTestId("render-kickoff-elevation-fields"),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("render-kickoff-prompt"), {
      target: { value: "elevations only" },
    });
    fireEvent.click(screen.getByTestId("render-kickoff-confirm"));
    expect(kickoff.mutate).toHaveBeenCalledTimes(1);
    const call = kickoff.mutate.mock.calls[0][0] as {
      id: string;
      data: Record<string, unknown>;
    };
    expect(call.data).toMatchObject({
      kind: "elevation-set",
      buildingCenter: { x: 0, y: 0, z: 0 },
      cameraDistance: 20,
      cameraHeight: 2,
    });
  });

  it("switches to video fields and submits a duration body", () => {
    renderDialog();
    fireEvent.change(screen.getByTestId("render-kickoff-kind"), {
      target: { value: "video" },
    });
    fireEvent.change(screen.getByTestId("render-kickoff-prompt"), {
      target: { value: "panning shot" },
    });
    fireEvent.change(screen.getByTestId("render-kickoff-duration"), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByTestId("render-kickoff-confirm"));
    const call = kickoff.mutate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(call.data).toMatchObject({
      kind: "video",
      duration: 10,
    });
  });

  it("disables the confirm button when prompt is empty", () => {
    renderDialog();
    expect(
      screen.getByTestId("render-kickoff-confirm") as HTMLButtonElement,
    ).toBeDisabled();
  });

  it("reports the prompt char count and disables submit when over the 2000-char cap", () => {
    renderDialog();
    fireEvent.change(screen.getByTestId("render-kickoff-prompt"), {
      target: { value: "x".repeat(2001) },
    });
    const counter = screen.getByTestId("render-kickoff-prompt-count");
    expect(counter).toHaveTextContent("2001 / 2000");
    expect(
      screen.getByTestId("render-kickoff-confirm") as HTMLButtonElement,
    ).toBeDisabled();
  });

  it("surfaces the friendly 503 renders_preview_disabled message", async () => {
    renderDialog();
    fireEvent.change(screen.getByTestId("render-kickoff-prompt"), {
      target: { value: "anything" },
    });
    fireEvent.click(screen.getByTestId("render-kickoff-confirm"));
    expect(kickoff.capturedOptions?.mutation?.onError).toBeDefined();
    await act(async () => {
      kickoff.capturedOptions!.mutation!.onError!(
        new MockApiError(503, { errorCode: "renders_preview_disabled" }),
        { id: "eng-1", data: {} },
        undefined,
      );
    });
    const err = screen.getByTestId("render-kickoff-error");
    expect(err).toHaveTextContent(/preview is disabled/i);
  });

  it("extracts the API detail message from a 400 response", async () => {
    renderDialog();
    fireEvent.change(screen.getByTestId("render-kickoff-prompt"), {
      target: { value: "anything" },
    });
    fireEvent.click(screen.getByTestId("render-kickoff-confirm"));
    await act(async () => {
      kickoff.capturedOptions!.mutation!.onError!(
        new MockApiError(400, { detail: "Camera position is required." }),
        { id: "eng-1", data: {} },
        undefined,
      );
    });
    expect(screen.getByTestId("render-kickoff-error")).toHaveTextContent(
      "Camera position is required.",
    );
  });

  it("calls onClose and onKickedOff after a successful kickoff", async () => {
    const { onClose, onKickedOff } = renderDialog();
    fireEvent.change(screen.getByTestId("render-kickoff-prompt"), {
      target: { value: "anything" },
    });
    fireEvent.click(screen.getByTestId("render-kickoff-confirm"));
    expect(kickoff.capturedOptions?.mutation?.onSuccess).toBeDefined();
    await act(async () => {
      await kickoff.capturedOptions!.mutation!.onSuccess!(
        {
          renderId: "render-new",
          state: "queued",
          kind: "still",
          cost: { credits: 5, breakdown: [] },
        },
        { id: "eng-1", data: {} },
        undefined,
      );
    });
    expect(onKickedOff).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
