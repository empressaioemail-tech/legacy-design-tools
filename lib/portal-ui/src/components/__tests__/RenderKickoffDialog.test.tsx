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

// Hoisted so the `vi.mock` factory below can close over it — `vi.mock`
// is hoisted to the top of the file before any other `const`s.
const customFetchMock = vi.hoisted(() => vi.fn());

vi.mock("@workspace/api-client-react", () => {
  return {
    ApiError: MockApiError,
    ...createQueryKeyStubs([
      "getListEngagementRendersQueryKey",
      // doc 40c B.6 — the kickoff invalidates the credits key on
      // success so the RenderCreditsBadge refreshes.
      "getGetRenderCreditsQueryKey",
    ] as const),
    useKickoffRender: makeCapturingMutationHook(kickoff),
    // doc 40c B.1 Prompt Generator wiring.
    getGenerateRenderPromptUrl: () => "/api/renders/prompt-generator",
    customFetch: customFetchMock,
    KickoffRenderCommonFieldsExpertName: {
      exterior: "exterior",
      interior: "interior",
      masterplan: "masterplan",
      landscape: "landscape",
      plan: "plan",
      product: "product",
    },
    KickoffRenderCommonFieldsRenderStyle: {
      raw: "raw",
      photoreal: "photoreal",
      cgi_render: "cgi_render",
      cad: "cad",
      freehand_sketch: "freehand_sketch",
      clay_model: "clay_model",
      illustration: "illustration",
      watercolor: "watercolor",
    },
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
  customFetchMock.mockReset();
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

  // ───────────────────────────────────────────────────────────────────
  // doc 40c gap-fill — intent / expert / style / Prompt Generator
  // ───────────────────────────────────────────────────────────────────

  it("defaults to the deliverable intent with exterior + photoreal", () => {
    renderDialog();
    const expert = screen.getByTestId(
      "render-kickoff-expert",
    ) as HTMLSelectElement;
    const style = screen.getByTestId(
      "render-kickoff-style",
    ) as HTMLSelectElement;
    expect(expert.value).toBe("exterior");
    expect(style.value).toBe("photoreal");
    expect(
      screen.getByTestId("render-kickoff-intent-deliverable"),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("flips expert + style to the concept-imagery defaults when the architect picks the concept intent", () => {
    renderDialog();
    fireEvent.click(screen.getByTestId("render-kickoff-intent-concept"));
    const expert = screen.getByTestId(
      "render-kickoff-expert",
    ) as HTMLSelectElement;
    const style = screen.getByTestId(
      "render-kickoff-style",
    ) as HTMLSelectElement;
    expect(expert.value).toBe("plan");
    expect(style.value).toBe("freehand_sketch");
    expect(
      screen.getByTestId("render-kickoff-intent-concept"),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("submits expertName + renderStyle as part of the kickoff body", () => {
    renderDialog();
    fireEvent.click(screen.getByTestId("render-kickoff-intent-concept"));
    fireEvent.change(screen.getByTestId("render-kickoff-prompt"), {
      target: { value: "single-story bungalow plan" },
    });
    fireEvent.click(screen.getByTestId("render-kickoff-confirm"));
    expect(kickoff.mutate).toHaveBeenCalledTimes(1);
    const call = kickoff.mutate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(call.data).toMatchObject({
      kind: "still",
      expertName: "plan",
      renderStyle: "freehand_sketch",
    });
  });

  it("disables the Prompt Generator button until an image is picked", () => {
    renderDialog();
    const generateBtn = screen.getByTestId(
      "render-kickoff-pg-generate",
    ) as HTMLButtonElement;
    expect(generateBtn).toBeDisabled();
    const fileInput = screen.getByTestId(
      "render-kickoff-pg-file-input",
    ) as HTMLInputElement;
    const file = new File(
      [new Uint8Array([0xff, 0xd8, 0xff])],
      "sketch.png",
      { type: "image/png" },
    );
    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(generateBtn).not.toBeDisabled();
  });

  it("uploads the picked image to /api/renders/prompt-generator and drops the result into the prompt textarea", async () => {
    customFetchMock.mockResolvedValueOnce({
      prompt:
        "modern desert house with a courtyard, golden hour, photoreal",
    });
    renderDialog();
    const fileInput = screen.getByTestId(
      "render-kickoff-pg-file-input",
    ) as HTMLInputElement;
    const file = new File(
      [new Uint8Array([0xff, 0xd8, 0xff])],
      "sketch.png",
      { type: "image/png" },
    );
    fireEvent.change(fileInput, { target: { files: [file] } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("render-kickoff-pg-generate"));
    });
    expect(customFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = customFetchMock.mock.calls[0] as [
      string,
      { method: string; body: FormData },
    ];
    expect(url).toBe("/api/renders/prompt-generator");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("image")).toBeInstanceOf(File);
    const promptField = screen.getByTestId(
      "render-kickoff-prompt",
    ) as HTMLTextAreaElement;
    expect(promptField.value).toBe(
      "modern desert house with a courtyard, golden hour, photoreal",
    );
  });

  it("surfaces an oversize-image error without calling customFetch", async () => {
    renderDialog();
    const fileInput = screen.getByTestId(
      "render-kickoff-pg-file-input",
    ) as HTMLInputElement;
    const tooBig = new File(
      [new Uint8Array(9 * 1024 * 1024)],
      "huge.png",
      { type: "image/png" },
    );
    fireEvent.change(fileInput, { target: { files: [tooBig] } });
    expect(customFetchMock).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("render-kickoff-pg-file-error"),
    ).toHaveTextContent(/too large/i);
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
