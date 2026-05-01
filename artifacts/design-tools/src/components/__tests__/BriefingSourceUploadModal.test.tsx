/**
 * BriefingSourceUploadModal — failure-mode coverage (Task #140).
 *
 * The Vitest suite over `parcel-briefings.test.ts` exercises the API
 * route end-to-end, but the modal that actually drives the two-step
 * presigned-URL upload had no component test. This file covers the
 * user-visible failure surfaces that would silently regress otherwise:
 *
 *   1. happy path — upload + metadata POST succeed, modal closes, the
 *      `engagement-briefing` query is invalidated
 *   2. presigned-URL request failure — modal stays open with the
 *      verbatim error from `useUpload`
 *   3. PUT-to-storage failure — same error-surface contract, different
 *      underlying message
 *   4. metadata POST failure (orphan-bytes case) — error renders inline
 *      and the modal does not close so the architect can retry
 *   5. "Other" slug validation — invalid custom slugs are rejected
 *      client-side before any network calls go out
 *
 * The pattern matches `RecordSubmissionResponseDialog.test.tsx`: mock
 * the workspace packages so we can drive the upload + mutation
 * outcomes by hand, but keep a real QueryClient so we can spy on
 * `invalidateQueries`.
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
  createMutationCapture,
  createQueryKeyStubs,
  makeCapturingMutationHook,
} from "@workspace/portal-ui/test-utils";

// Upload-side state (object-storage-web's `useUpload`) stays in a
// dedicated `vi.hoisted` block since it is outside the shared mock
// harness. The api-client-react mutation
// `useCreateEngagementBriefingSource` is captured through the shared
// `createMutationCapture` helper (Task #382): `hoisted.mutateAsync`
// is the spy and `hoisted.capturedOptions` exposes the registered
// `mutation: { onSuccess }` for hand-firing in tests.
const hoistedLocal = vi.hoisted(() => ({
  uploadFileMock: vi.fn(),
  uploadState: {
    isUploading: false,
    error: null as Error | null,
    progress: 0,
  },
}));

const hoisted = createMutationCapture();

vi.mock("@workspace/object-storage-web", () => ({
  useUpload: () => ({
    uploadFile: hoistedLocal.uploadFileMock,
    isUploading: hoistedLocal.uploadState.isUploading,
    error: hoistedLocal.uploadState.error,
    progress: hoistedLocal.uploadState.progress,
  }),
}));

vi.mock("@workspace/api-client-react", () => ({
  useCreateEngagementBriefingSource: makeCapturingMutationHook(hoisted),
  ...createQueryKeyStubs([
    "getGetEngagementBriefingQueryKey",
  ] as const),
}));

const { BriefingSourceUploadModal } = await import(
  "../BriefingSourceUploadModal"
);

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderModal(overrides: {
  engagementId?: string;
  isOpen?: boolean;
  onClose?: () => void;
  existingLayerKinds?: string[];
  client?: QueryClient;
} = {}) {
  const onClose = overrides.onClose ?? vi.fn();
  const client = overrides.client ?? makeQueryClient();
  const node: ReactNode = (
    <QueryClientProvider client={client}>
      <BriefingSourceUploadModal
        engagementId={overrides.engagementId ?? "eng-1"}
        isOpen={overrides.isOpen ?? true}
        onClose={onClose}
        existingLayerKinds={overrides.existingLayerKinds ?? []}
      />
    </QueryClientProvider>
  );
  const utils = render(node);
  return { ...utils, onClose, client };
}

/**
 * Shove a synthetic File into the file <input>. happy-dom's HTMLInputElement
 * supports assigning a FileList-like object directly via Object.defineProperty
 * (the standard `files` setter is a no-op on most file inputs).
 */
function attachFile(file: File) {
  const input = screen.getByLabelText("File") as HTMLInputElement;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [file],
  });
  fireEvent.change(input);
}

const sampleFile = () =>
  new File(["zoning shapefile bytes"], "zoning.zip", {
    type: "application/zip",
  });

beforeEach(() => {
  hoistedLocal.uploadFileMock.mockReset();
  hoistedLocal.uploadState.isUploading = false;
  hoistedLocal.uploadState.error = null;
  hoistedLocal.uploadState.progress = 0;
  hoisted.reset();
});

afterEach(() => {
  cleanup();
});

describe("BriefingSourceUploadModal", () => {
  it("happy path: uploads bytes, posts metadata, closes the modal, and invalidates the briefing query", async () => {
    hoistedLocal.uploadFileMock.mockResolvedValueOnce({
      uploadURL: "https://storage.example/put-target",
      objectPath: "uploads/eng-1/zoning.zip",
      metadata: {
        name: "zoning.zip",
        size: 22,
        contentType: "application/zip",
      },
    });
    hoisted.mutateAsync.mockResolvedValueOnce({
      id: "src-1",
      layerKind: "qgis-zoning",
    });

    const client = makeQueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const onClose = vi.fn();
    renderModal({ engagementId: "eng-42", onClose, client });

    attachFile(sampleFile());
    fireEvent.click(screen.getByRole("button", { name: /^Upload$/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    // The upload hook was driven with the actual File the user picked.
    expect(hoistedLocal.uploadFileMock).toHaveBeenCalledTimes(1);
    const uploadedFile = hoistedLocal.uploadFileMock.mock.calls[0]?.[0] as File;
    expect(uploadedFile.name).toBe("zoning.zip");

    // The metadata mutation got the resolved objectPath + the file's
    // own metadata so the server can land the briefing source row.
    expect(hoisted.mutateAsync).toHaveBeenCalledTimes(1);
    expect(hoisted.mutateAsync).toHaveBeenCalledWith({
      id: "eng-42",
      data: expect.objectContaining({
        layerKind: "qgis-zoning",
        upload: expect.objectContaining({
          objectPath: "uploads/eng-1/zoning.zip",
          originalFilename: "zoning.zip",
          contentType: "application/zip",
          byteSize: 22,
        }),
      }),
    });

    // The modal wires its `onSuccess` into useCreateEngagementBriefingSource
    // options. Real react-query triggers it; in this test the mock
    // doesn't, so we drive it manually to assert the invalidation key.
    expect(hoisted.capturedOptions?.mutation?.onSuccess).toBeDefined();
    await act(async () => {
      await hoisted.capturedOptions!.mutation!.onSuccess!(
        { id: "src-1" },
        { id: "eng-42", data: {} },
        undefined,
      );
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["getEngagementBriefing", "eng-42"],
    });
  });

  it("surfaces the presigned-URL request error verbatim and keeps the modal open", async () => {
    // First step of the two-step flow fails: the storage route returned
    // 4xx and `useUpload` populated `error` before resolving null.
    hoistedLocal.uploadState.error = new Error("Failed to get upload URL");
    hoistedLocal.uploadFileMock.mockResolvedValueOnce(null);

    const onClose = vi.fn();
    renderModal({ onClose });

    attachFile(sampleFile());
    fireEvent.click(screen.getByRole("button", { name: /^Upload$/ }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Failed to get upload URL/);

    // The metadata POST must NOT fire if we never got a presigned URL,
    // and the modal must stay mounted so the architect can retry.
    expect(hoisted.mutateAsync).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /^Upload$/ }),
    ).toBeInTheDocument();
  });

  it("surfaces the PUT-to-storage error and keeps the modal open (mid-upload failure)", async () => {
    // Second step of the two-step flow fails: the bytes never landed.
    // The modal can't tell which step blew up — it just trusts
    // `useUpload`'s error message — so the user-visible contract is
    // "show the verbatim hook error and stay open for retry".
    hoistedLocal.uploadState.error = new Error("Failed to upload file to storage");
    hoistedLocal.uploadFileMock.mockResolvedValueOnce(null);

    const onClose = vi.fn();
    renderModal({ onClose });

    attachFile(sampleFile());
    fireEvent.click(screen.getByRole("button", { name: /^Upload$/ }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Failed to upload file to storage/);
    expect(hoisted.mutateAsync).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("falls back to a generic 'Upload failed.' message when the hook surfaces no error", async () => {
    // Defensive: if uploadFile returns null without populating
    // `error` (shouldn't happen, but the modal hedges), the user must
    // still see *something* rather than a silently dismissed click.
    hoistedLocal.uploadState.error = null;
    hoistedLocal.uploadFileMock.mockResolvedValueOnce(null);

    renderModal();
    attachFile(sampleFile());
    fireEvent.click(screen.getByRole("button", { name: /^Upload$/ }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Upload failed\./);
  });

  it("surfaces the metadata POST failure inline and keeps the modal open (orphan-bytes case)", async () => {
    // Bytes uploaded fine, but the briefing-source POST blew up
    // (e.g. 500, schema mismatch). The bytes are now orphaned in
    // storage — the modal can't undo that, but it MUST keep itself
    // open and show the error so the architect doesn't think the
    // upload silently succeeded.
    hoistedLocal.uploadFileMock.mockResolvedValueOnce({
      uploadURL: "https://storage.example/put-target",
      objectPath: "uploads/eng-1/zoning.zip",
      metadata: {
        name: "zoning.zip",
        size: 22,
        contentType: "application/zip",
      },
    });
    hoisted.mutateAsync.mockRejectedValueOnce(
      new Error("Briefing source insert failed: unique constraint"),
    );

    const onClose = vi.fn();
    renderModal({ onClose });

    attachFile(sampleFile());
    fireEvent.click(screen.getByRole("button", { name: /^Upload$/ }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      /Briefing source insert failed: unique constraint/,
    );
    expect(onClose).not.toHaveBeenCalled();
    // The Upload button is still here — the modal is still mounted
    // and ready for a retry.
    expect(
      screen.getByRole("button", { name: /^Upload$/ }),
    ).toBeInTheDocument();
  });

  it("falls back to a generic message when the metadata POST rejects with a non-Error value", async () => {
    hoistedLocal.uploadFileMock.mockResolvedValueOnce({
      uploadURL: "https://storage.example/put-target",
      objectPath: "uploads/eng-1/zoning.zip",
      metadata: {
        name: "zoning.zip",
        size: 22,
        contentType: "application/zip",
      },
    });
    // Some clients reject with a plain string / object. The modal
    // narrows on `instanceof Error` and otherwise falls back to a
    // generic copy.
    hoisted.mutateAsync.mockRejectedValueOnce("boom");

    renderModal();
    attachFile(sampleFile());
    fireEvent.click(screen.getByRole("button", { name: /^Upload$/ }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Failed to record briefing source\./);
  });

  it("blocks submit and shows a slug-format error when 'Other' is selected with an invalid custom slug", async () => {
    renderModal();
    attachFile(sampleFile());

    // Switch the picker to "Other (custom slug)" so the free-text
    // field appears.
    fireEvent.change(screen.getByLabelText("Layer kind"), {
      target: { value: "__other__" },
    });

    // "QGIS Zoning!" — uppercase + space + "!" all violate the slug
    // pattern (lowercase letters / digits / dashes).
    const slugInput = screen.getByPlaceholderText(
      "qgis-easements",
    ) as HTMLInputElement;
    fireEvent.change(slugInput, { target: { value: "QGIS Zoning!" } });

    fireEvent.click(screen.getByRole("button", { name: /^Upload$/ }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      /Layer slug must be lowercase letters \/ digits \/ dashes/,
    );

    // No network calls should have fired — the validation gate is
    // strictly client-side.
    expect(hoistedLocal.uploadFileMock).not.toHaveBeenCalled();
    expect(hoisted.mutateAsync).not.toHaveBeenCalled();
  });

  it("accepts a valid custom slug under 'Other' and forwards it to the metadata POST", async () => {
    hoistedLocal.uploadFileMock.mockResolvedValueOnce({
      uploadURL: "https://storage.example/put-target",
      objectPath: "uploads/eng-1/easements.zip",
      metadata: {
        name: "easements.zip",
        size: 17,
        contentType: "application/zip",
      },
    });
    hoisted.mutateAsync.mockResolvedValueOnce({ id: "src-2" });

    const onClose = vi.fn();
    renderModal({ onClose });
    attachFile(
      new File(["bytes"], "easements.zip", { type: "application/zip" }),
    );

    fireEvent.change(screen.getByLabelText("Layer kind"), {
      target: { value: "__other__" },
    });
    fireEvent.change(screen.getByPlaceholderText("qgis-easements"), {
      target: { value: "qgis-easements" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Upload$/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(hoisted.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ layerKind: "qgis-easements" }),
      }),
    );
  });

  it("blocks submit when no file is attached and never calls uploadFile", () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: /^Upload$/ }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      /Pick a file to upload\./,
    );
    expect(hoistedLocal.uploadFileMock).not.toHaveBeenCalled();
    expect(hoisted.mutateAsync).not.toHaveBeenCalled();
  });

  // DA-MV-1: the new DXF branch in the picker must (a) flip
  // `upload.kind` to "dxf" so the route takes the converter path, and
  // (b) reject non-`.dxf` files at the client gate so the architect
  // doesn't pay the network round-trip for a guaranteed 4xx.
  it("forwards upload.kind='dxf' for a DXF layer kind and a .dxf file", async () => {
    hoistedLocal.uploadFileMock.mockResolvedValueOnce({
      uploadURL: "https://storage.example/put-target",
      objectPath: "uploads/eng-1/terrain.dxf",
      metadata: {
        name: "terrain.dxf",
        size: 4096,
        contentType: "application/octet-stream",
      },
    });
    hoisted.mutateAsync.mockResolvedValueOnce({
      id: "src-3",
      layerKind: "terrain",
    });

    const onClose = vi.fn();
    renderModal({ engagementId: "eng-9", onClose });

    fireEvent.change(screen.getByLabelText("Layer kind"), {
      target: { value: "terrain" },
    });
    attachFile(
      new File(["dxf bytes"], "terrain.dxf", {
        type: "application/octet-stream",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Upload$/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(hoisted.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "eng-9",
        data: expect.objectContaining({
          layerKind: "terrain",
          upload: expect.objectContaining({
            kind: "dxf",
            objectPath: "uploads/eng-1/terrain.dxf",
            originalFilename: "terrain.dxf",
          }),
        }),
      }),
    );
  });

  it("rejects a non-DXF file under a DXF layer kind before any upload fires", () => {
    renderModal();
    fireEvent.change(screen.getByLabelText("Layer kind"), {
      target: { value: "buildable-envelope" },
    });
    attachFile(
      new File(["not dxf"], "envelope.geojson", {
        type: "application/geo+json",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Upload$/ }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      /3D-geometry layers expect a DXF file/,
    );
    expect(hoistedLocal.uploadFileMock).not.toHaveBeenCalled();
    expect(hoisted.mutateAsync).not.toHaveBeenCalled();
  });

  it("rejects a .dxf file under a 2D-overlay layer kind before any upload fires", () => {
    renderModal();
    // Default selection is the first qgis row (qgis-zoning); attach a
    // .dxf to confirm the inverse mismatch is also caught.
    attachFile(
      new File(["dxf bytes"], "rogue.dxf", {
        type: "application/octet-stream",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Upload$/ }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      /2D-overlay layers expect a vector file/,
    );
    expect(hoistedLocal.uploadFileMock).not.toHaveBeenCalled();
    expect(hoisted.mutateAsync).not.toHaveBeenCalled();
  });

  it("forwards upload.kind='qgis' on the default 2D-overlay branch", async () => {
    hoistedLocal.uploadFileMock.mockResolvedValueOnce({
      uploadURL: "https://storage.example/put-target",
      objectPath: "uploads/eng-1/zoning.zip",
      metadata: {
        name: "zoning.zip",
        size: 22,
        contentType: "application/zip",
      },
    });
    hoisted.mutateAsync.mockResolvedValueOnce({ id: "src-4" });

    const onClose = vi.fn();
    renderModal({ onClose });
    attachFile(sampleFile());
    fireEvent.click(screen.getByRole("button", { name: /^Upload$/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(hoisted.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          upload: expect.objectContaining({ kind: "qgis" }),
        }),
      }),
    );
  });
});
