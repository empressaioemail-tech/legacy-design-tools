/**
 * Users page — regression test for the "save fails → user retries → save
 * succeeds with the right avatar" flow (Task #114).
 *
 * Background:
 *   - Task #98 made the API delete a freshly-uploaded avatar whenever the
 *     PATCH/POST that referenced it fails, plugging the orphan-bucket leak.
 *   - That left a UX wrinkle: the form still held the now-deleted serving
 *     URL in state, so a second Save would write a broken `avatar_url`.
 *   - Task #114 fixes that by deferring the GCS upload until Save click.
 *
 * What we pin here:
 *   1. Picking a file does NOT trigger the upload (no `useUpload.uploadFile`
 *      call) — it just stages the File and shows a local preview.
 *   2. The first Save click uploads once, then PATCHes with the resulting
 *      serving URL.
 *   3. After the PATCH errors out, retrying Save uploads AGAIN (a fresh
 *      object path), then PATCHes with that new URL — never the stale one.
 *
 * The hooks are mocked so we can drive `onSuccess`/`onError` deterministically
 * and capture the request payloads without a real network round trip.
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

// ── Hoisted mock state shared with vi.mock factories ────────────────────
const hoisted = vi.hoisted(() => ({
  // useUpload state — a counter so consecutive picks of "the same File"
  // still produce distinct object paths, mirroring real presigned uploads.
  uploadCallCount: 0,
  uploadFile: null as null | ((file: File) => Promise<unknown>),
  uploadShouldFail: false,

  // useUpdateUser captured options + spy
  updateMutate: null as null | ((args: unknown) => void),
  updateOptions: null as null | {
    mutation?: {
      onSuccess?: (data: unknown, vars: unknown, ctx: unknown) => void;
      onError?: (err: unknown, vars: unknown, ctx: unknown) => void;
    };
  },
  updateState: { isPending: false },

  // useListUsers fixture
  users: [] as Array<{
    id: string;
    displayName: string;
    email: string | null;
    avatarUrl: string | null;
  }>,
}));

// ── Module mocks ────────────────────────────────────────────────────────
vi.mock("@workspace/object-storage-web", () => ({
  useUpload: () => ({
    uploadFile: hoisted.uploadFile!,
    isUploading: false,
    error: null,
    progress: 0,
  }),
}));

vi.mock("@workspace/api-client-react", () => ({
  useListUsers: () => ({
    data: hoisted.users,
    isLoading: false,
    error: null,
  }),
  useCreateUser: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useUpdateUser: (options: typeof hoisted.updateOptions) => {
    hoisted.updateOptions = options;
    return {
      mutate: hoisted.updateMutate!,
      isPending: hoisted.updateState.isPending,
    };
  },
  useDeleteUser: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  getListUsersQueryKey: () => ["listUsers"],
}));

vi.mock("@workspace/portal-ui", () => ({
  // The real DashboardLayout pulls in the full sidebar/header chrome which
  // is irrelevant to this test — render the children inline so the modal
  // tree is reachable without rebuilding the whole app shell.
  DashboardLayout: ({ children }: { children: ReactNode }) => (
    <div data-testid="dashboard-layout">{children}</div>
  ),
}));

vi.mock("../../components/NavGroups", () => ({
  useNavGroups: () => [],
}));

// `resizeAvatar` uses `createImageBitmap` which happy-dom does not support.
// The retry-flow contract is "the picked File round-trips through Save", so
// pass it through unchanged here.
vi.mock("../../lib/resizeAvatar", () => ({
  resizeAvatar: async (file: File) => file,
}));

// Some useUpload consumers expect URL.createObjectURL — stub it so the
// preview branch doesn't crash in happy-dom.
if (typeof URL.createObjectURL !== "function") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (URL as any).createObjectURL = () => "blob:mock-preview";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (URL as any).revokeObjectURL = () => {};
}

const Users = (await import("../Users")).default;

// ── Test setup ──────────────────────────────────────────────────────────
beforeEach(() => {
  hoisted.uploadCallCount = 0;
  hoisted.uploadShouldFail = false;
  hoisted.uploadFile = vi.fn(async (_file: File) => {
    if (hoisted.uploadShouldFail) {
      return null; // mirrors useUpload's "error" branch
    }
    hoisted.uploadCallCount += 1;
    return {
      uploadURL: "https://signed-url.example/" + hoisted.uploadCallCount,
      objectPath: `/objects/uploads/avatar-${hoisted.uploadCallCount}`,
      metadata: {
        name: "avatar.png",
        size: 100,
        contentType: "image/png",
      },
    };
  });

  hoisted.updateMutate = vi.fn();
  hoisted.updateOptions = null;
  hoisted.updateState = { isPending: false };

  hoisted.users = [
    {
      id: "u_jane",
      displayName: "Jane Reviewer",
      email: "jane@example.com",
      avatarUrl: null,
    },
  ];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── Helpers ─────────────────────────────────────────────────────────────
function renderUsers() {
  // Retry off so any failure surfaces immediately without backoff.
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <Users />
    </QueryClientProvider>,
  );
}

async function pickFile(testId: string) {
  const input = screen.getByTestId(testId) as HTMLInputElement;
  const file = new File(["fake-bytes"], "headshot.png", { type: "image/png" });
  // happy-dom doesn't let us assign FileList directly via `change`, but
  // fireEvent.change accepts a `target.files` override.
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
  // Allow the resizeAvatar promise + setState to flush.
  await waitFor(() => {
    expect(screen.queryByTestId("user-edit-avatar-pending-note")).not.toBeNull();
  });
  return file;
}

function lastUpdatePayload(): {
  id: string;
  data: { avatarUrl?: string | null };
} | null {
  const calls = (hoisted.updateMutate as unknown as { mock: { calls: unknown[][] } })
    .mock.calls;
  if (calls.length === 0) return null;
  return calls[calls.length - 1]![0] as {
    id: string;
    data: { avatarUrl?: string | null };
  };
}

// ── Test ────────────────────────────────────────────────────────────────
describe("Users page — avatar upload retry", () => {
  it(
    "defers GCS upload until Save, and re-uploads on retry after a failed " +
      "PATCH so the persisted avatarUrl always points at a live object",
    async () => {
      renderUsers();

      // Open Edit modal for Jane.
      fireEvent.click(screen.getByTestId("user-edit-u_jane"));
      expect(screen.getByTestId("user-edit-display-name")).toBeDefined();

      // 1️⃣  Pick a file. The upload must NOT have fired yet — the file is
      //     just staged in modal state with a local preview.
      await pickFile("user-edit-avatar-file");
      expect(hoisted.uploadFile).not.toHaveBeenCalled();
      expect(hoisted.updateMutate).not.toHaveBeenCalled();
      expect(
        screen.getByTestId("user-edit-avatar-pending-note"),
      ).toBeDefined();

      // 2️⃣  First Save click → upload once, then PATCH with that URL.
      const submitButton = screen.getByTestId("user-form-submit");
      await act(async () => {
        fireEvent.click(submitButton);
      });
      await waitFor(() => {
        expect(hoisted.uploadFile).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(hoisted.updateMutate).toHaveBeenCalledTimes(1);
      });
      const firstPayload = lastUpdatePayload();
      expect(firstPayload).not.toBeNull();
      expect(firstPayload!.id).toBe("u_jane");
      expect(firstPayload!.data.avatarUrl).toBe(
        "/api/storage/objects/uploads/avatar-1",
      );

      // 3️⃣  Simulate the PATCH failing — useUpdateUser invokes its onError
      //     (and the server has already rolled back the orphan upload).
      const onError = hoisted.updateOptions?.mutation?.onError;
      expect(onError).toBeDefined();
      await act(async () => {
        const fakeResponse = new Response(
          JSON.stringify({ error: "Conflict" }),
          { status: 409 },
        );
        onError!(fakeResponse, undefined, undefined);
      });
      await waitFor(() => {
        expect(screen.getByText(/Conflict/)).toBeDefined();
      });

      // 4️⃣  Second Save click (the "retry") — must upload AGAIN (so the
      //     URL we PATCH with points at a freshly-created object), not
      //     reuse the now-deleted /objects/uploads/avatar-1 path.
      await act(async () => {
        fireEvent.click(submitButton);
      });
      await waitFor(() => {
        expect(hoisted.uploadFile).toHaveBeenCalledTimes(2);
      });
      await waitFor(() => {
        expect(hoisted.updateMutate).toHaveBeenCalledTimes(2);
      });
      const retryPayload = lastUpdatePayload();
      expect(retryPayload).not.toBeNull();
      // New object path on retry — proves it wasn't a stale URL re-sent.
      expect(retryPayload!.data.avatarUrl).toBe(
        "/api/storage/objects/uploads/avatar-2",
      );
    },
  );

  it("does not re-upload when the user only edits text fields after a pick", async () => {
    // Sanity check on the "no double-upload per Save click" contract: a
    // single Save → exactly one upload call, even if the user types in
    // other fields beforehand.
    renderUsers();
    fireEvent.click(screen.getByTestId("user-edit-u_jane"));

    await pickFile("user-edit-avatar-file");

    const nameInput = screen.getByTestId(
      "user-edit-display-name",
    ) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Jane R." } });

    await act(async () => {
      fireEvent.click(screen.getByTestId("user-form-submit"));
    });

    await waitFor(() => {
      expect(hoisted.uploadFile).toHaveBeenCalledTimes(1);
    });
    expect(hoisted.updateMutate).toHaveBeenCalledTimes(1);
    const payload = lastUpdatePayload();
    expect(payload!.data).toMatchObject({
      displayName: "Jane R.",
      avatarUrl: "/api/storage/objects/uploads/avatar-1",
    });
  });
});
