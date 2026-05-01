/**
 * Settings — coverage for the architect-PDF-header self-edit surface
 * (DA-PI-6 / Task #322).
 *
 * The page wires three generated hooks together:
 *
 *   - `useGetSession`    — gates on a `user`-kind requestor.
 *   - `useGetUser(id)`   — seeds the input with the persisted value.
 *   - `useUpdateMyArchitectPdfHeader` — PATCH self-edit.
 *
 * Tests pin the behaviors the spec calls out:
 *
 *   1. Anonymous / agent sessions are turned away with a "sign in"
 *      prompt — no input renders, no PATCH fires.
 *   2. The input is seeded from the server value once it loads.
 *   3. Submitting forwards the raw draft to the mutation, then the
 *      server's persisted value is reflected back into the input on
 *      success (the FE never invents the trimmed/cleared value
 *      itself).
 *   4. Empty / whitespace-only input clears the override — the Save
 *      button relabels to "Clear override" so the architect knows
 *      what they're about to do.
 *   5. The Save button is disabled when the trimmed draft equals the
 *      currently-persisted value (idle / no-op state).
 *   6. The live PDF-header preview (Task #365) renders the seeded
 *      value, updates as the architect types, and falls back to the
 *      platform default — in a muted/italic style — when the input
 *      is empty or whitespace-only.
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

type Session =
  | { audience: "user"; requestor: { kind: "user"; id: string }; permissions: string[] }
  | { audience: "user"; requestor: { kind: "agent"; id: string }; permissions: string[] }
  | { audience: "user"; permissions: string[] };

interface FakeUser {
  id: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  architectPdfHeader: string | null;
  createdAt: string;
  updatedAt: string;
}

const hoisted = vi.hoisted(() => {
  return {
    session: {
      audience: "user",
      requestor: { kind: "user", id: "u-arch" },
      permissions: [],
    } as Session,
    user: {
      id: "u-arch",
      displayName: "Arch",
      email: null,
      avatarUrl: null,
      architectPdfHeader: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as FakeUser | null,
    capturedMutationOptions: null as null | {
      mutation?: {
        onSuccess?: (data: FakeUser) => void;
      };
    },
    mutateSpy: vi.fn(),
    mutationPending: false,
    mutationError: null as null | Error,
  };
});

vi.mock("@workspace/api-client-react", async () => {
  const { useQuery } =
    await vi.importActual<typeof import("@tanstack/react-query")>(
      "@tanstack/react-query",
    );
  return {
    getGetSessionQueryKey: () => ["getSession"] as const,
    getGetUserQueryKey: (id: string) => ["getUser", id] as const,
    useGetSession: (opts?: { query?: { queryKey?: readonly unknown[] } }) =>
      useQuery({
        queryKey: opts?.query?.queryKey ?? (["getSession"] as const),
        queryFn: async () => hoisted.session,
      }),
    useGetUser: (
      id: string,
      opts?: {
        query?: { queryKey?: readonly unknown[]; enabled?: boolean };
      },
    ) =>
      useQuery({
        queryKey: opts?.query?.queryKey ?? (["getUser", id] as const),
        queryFn: async () => {
          if (!hoisted.user || hoisted.user.id !== id) {
            throw new Error("user not found");
          }
          return { ...hoisted.user };
        },
        enabled: opts?.query?.enabled ?? true,
      }),
    useUpdateMyArchitectPdfHeader: (
      options: typeof hoisted.capturedMutationOptions,
    ) => {
      hoisted.capturedMutationOptions = options;
      return {
        mutate: hoisted.mutateSpy,
        isPending: hoisted.mutationPending,
        isError: !!hoisted.mutationError,
        error: hoisted.mutationError,
      };
    },
  };
});

const { Settings } = await import("../Settings");

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderPage() {
  const client = makeQueryClient();
  const node: ReactNode = (
    <QueryClientProvider client={client}>
      <Settings />
    </QueryClientProvider>
  );
  const utils = render(node);
  return { ...utils, client };
}

beforeEach(() => {
  hoisted.session = {
    audience: "user",
    requestor: { kind: "user", id: "u-arch" },
    permissions: [],
  };
  hoisted.user = {
    id: "u-arch",
    displayName: "Arch",
    email: null,
    avatarUrl: null,
    architectPdfHeader: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  hoisted.capturedMutationOptions = null;
  hoisted.mutateSpy.mockReset();
  hoisted.mutationPending = false;
  hoisted.mutationError = null;
});

afterEach(() => {
  cleanup();
});

describe("Settings — auth gate", () => {
  it("renders a sign-in prompt and no input when the session is anonymous", async () => {
    hoisted.session = { audience: "user", permissions: [] };
    renderPage();

    await screen.findByText(/Sign in required/i);
    expect(
      screen.queryByTestId("settings-architect-pdf-header-input"),
    ).toBeNull();
    expect(
      screen.queryByTestId("settings-architect-pdf-header-save"),
    ).toBeNull();
    expect(hoisted.mutateSpy).not.toHaveBeenCalled();
  });

  it("renders a sign-in prompt for agent-kind requestors", async () => {
    // Agents have no profile to edit; the gate must turn them away
    // even though `requestor` is present.
    hoisted.session = {
      audience: "user",
      requestor: { kind: "agent", id: "snapshot-ingest" },
      permissions: [],
    };
    renderPage();

    await screen.findByText(/Sign in required/i);
    expect(
      screen.queryByTestId("settings-architect-pdf-header-input"),
    ).toBeNull();
  });
});

describe("Settings — happy paths", () => {
  it("seeds the input with the persisted value and disables Save when clean", async () => {
    hoisted.user = {
      ...hoisted.user!,
      architectPdfHeader: "Studio Foo — Pre-Design Briefing",
    };
    renderPage();

    const input = (await screen.findByTestId(
      "settings-architect-pdf-header-input",
    )) as HTMLInputElement;
    await waitFor(() =>
      expect(input.value).toBe("Studio Foo — Pre-Design Briefing"),
    );

    const save = screen.getByTestId(
      "settings-architect-pdf-header-save",
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.textContent).toMatch(/Save/);
  });

  it("forwards the raw draft to the mutation and reflects the server value back on success", async () => {
    renderPage();

    const input = (await screen.findByTestId(
      "settings-architect-pdf-header-input",
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(""));

    fireEvent.change(input, {
      target: { value: "  Studio Bar — Briefing  " },
    });
    expect(input.value).toBe("  Studio Bar — Briefing  ");

    const save = screen.getByTestId(
      "settings-architect-pdf-header-save",
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    expect(hoisted.mutateSpy).toHaveBeenCalledTimes(1);
    expect(hoisted.mutateSpy).toHaveBeenCalledWith({
      data: { architectPdfHeader: "  Studio Bar — Briefing  " },
    });

    // Simulate the server's "trimmed" response landing — the input
    // should reflect what the server actually persisted, not the
    // raw draft.
    act(() => {
      hoisted.capturedMutationOptions?.mutation?.onSuccess?.({
        ...hoisted.user!,
        architectPdfHeader: "Studio Bar — Briefing",
      });
    });
    await waitFor(() => expect(input.value).toBe("Studio Bar — Briefing"));
    expect(
      screen.getByTestId("settings-architect-pdf-header-status").textContent,
    ).toMatch(/Saved/i);
  });

  it("clears the override when the input is empty — Save relabels to 'Clear override'", async () => {
    hoisted.user = {
      ...hoisted.user!,
      architectPdfHeader: "Studio Foo",
    };
    renderPage();

    const input = (await screen.findByTestId(
      "settings-architect-pdf-header-input",
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("Studio Foo"));

    fireEvent.change(input, { target: { value: "" } });
    const save = screen.getByTestId(
      "settings-architect-pdf-header-save",
    ) as HTMLButtonElement;
    await waitFor(() => expect(save.textContent).toMatch(/Clear override/i));
    expect(save.disabled).toBe(false);

    fireEvent.click(save);
    expect(hoisted.mutateSpy).toHaveBeenCalledWith({
      data: { architectPdfHeader: "" },
    });

    // Server returns null — the status banner should call out the
    // "now using the default" outcome.
    act(() => {
      hoisted.capturedMutationOptions?.mutation?.onSuccess?.({
        ...hoisted.user!,
        architectPdfHeader: null,
      });
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("settings-architect-pdf-header-status").textContent,
      ).toMatch(/default/i),
    );
    expect(input.value).toBe("");
  });

  it("treats whitespace-only input as a clear (matches server semantics)", async () => {
    hoisted.user = {
      ...hoisted.user!,
      architectPdfHeader: "Studio Foo",
    };
    renderPage();

    const input = (await screen.findByTestId(
      "settings-architect-pdf-header-input",
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("Studio Foo"));

    fireEvent.change(input, { target: { value: "   " } });
    const save = screen.getByTestId(
      "settings-architect-pdf-header-save",
    ) as HTMLButtonElement;
    await waitFor(() => expect(save.textContent).toMatch(/Clear override/i));
    expect(save.disabled).toBe(false);
  });

  it("disables Save when the trimmed draft equals the persisted value (no-op state)", async () => {
    // Pads the persisted "Studio Foo" with surrounding whitespace —
    // since the server trims, the persisted value the form
    // compares against is "Studio Foo", and the trimmed draft is
    // also "Studio Foo", so Save must stay disabled.
    hoisted.user = {
      ...hoisted.user!,
      architectPdfHeader: "Studio Foo",
    };
    renderPage();

    const input = (await screen.findByTestId(
      "settings-architect-pdf-header-input",
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("Studio Foo"));

    fireEvent.change(input, { target: { value: "  Studio Foo  " } });
    const save = screen.getByTestId(
      "settings-architect-pdf-header-save",
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });
});

describe("Settings — live PDF header preview (Task #365)", () => {
  it("renders the platform default in a muted/italic style when the seeded value is empty", async () => {
    // No override on the user — preview must show the fallback in
    // its muted contract so the architect can see what an export
    // would print today.
    renderPage();

    const preview = (await screen.findByTestId(
      "settings-architect-pdf-header-preview",
    )) as HTMLElement;

    expect(preview.textContent).toBe(
      "SmartCity Design Tools — Pre-Design Briefing",
    );
    expect(preview.getAttribute("data-preview-fallback")).toBe("true");
    // Muted-style contract: italic + lighter colour than the live
    // value. Inline styles are the source of truth for the preview's
    // typography (mirrors the renderer's CSS literals), so we read
    // them directly off the DOM rather than asserting on class names.
    expect(preview.style.fontStyle).toBe("italic");
    expect(preview.style.color).toBe("#888");
  });

  it("renders the seeded override verbatim and drops the muted styling", async () => {
    hoisted.user = {
      ...hoisted.user!,
      architectPdfHeader: "Studio Foo — Pre-Design Briefing",
    };
    renderPage();

    const preview = (await screen.findByTestId(
      "settings-architect-pdf-header-preview",
    )) as HTMLElement;

    await waitFor(() =>
      expect(preview.textContent).toBe("Studio Foo — Pre-Design Briefing"),
    );
    expect(preview.getAttribute("data-preview-fallback")).toBe("false");
    expect(preview.style.fontStyle).toBe("normal");
    // Live value uses the same #555 the PDF renderer's @top-left
    // margin box does — the contract this test pins is "preview
    // typography stays in lockstep with the rendered header".
    expect(preview.style.color).toBe("#555");
    expect(preview.style.fontSize).toBe("9pt");
    expect(preview.style.fontFamily).toContain("system-ui");
  });

  it("updates live as the architect types and snaps back to the fallback when the input is cleared", async () => {
    renderPage();

    const input = (await screen.findByTestId(
      "settings-architect-pdf-header-input",
    )) as HTMLInputElement;
    const preview = screen.getByTestId(
      "settings-architect-pdf-header-preview",
    ) as HTMLElement;

    // Starts on the fallback (no override).
    await waitFor(() =>
      expect(preview.getAttribute("data-preview-fallback")).toBe("true"),
    );

    fireEvent.change(input, { target: { value: "Studio Bar" } });
    await waitFor(() => expect(preview.textContent).toBe("Studio Bar"));
    expect(preview.getAttribute("data-preview-fallback")).toBe("false");

    // Clearing the input snaps back to the muted fallback in real
    // time — no Save round-trip required.
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() =>
      expect(preview.textContent).toBe(
        "SmartCity Design Tools — Pre-Design Briefing",
      ),
    );
    expect(preview.getAttribute("data-preview-fallback")).toBe("true");
  });

  it("treats whitespace-only input as the fallback, matching the server's trim semantics", async () => {
    // Mirrors the server-side `header && header.trim().length > 0`
    // check in `briefingHtml.ts` — a whitespace-only override
    // resolves to the default at render time, so the preview must
    // resolve the same way to avoid teaching the wrong contract.
    hoisted.user = {
      ...hoisted.user!,
      architectPdfHeader: "Studio Foo",
    };
    renderPage();

    const input = (await screen.findByTestId(
      "settings-architect-pdf-header-input",
    )) as HTMLInputElement;
    const preview = screen.getByTestId(
      "settings-architect-pdf-header-preview",
    ) as HTMLElement;

    await waitFor(() => expect(preview.textContent).toBe("Studio Foo"));

    fireEvent.change(input, { target: { value: "   " } });
    await waitFor(() =>
      expect(preview.textContent).toBe(
        "SmartCity Design Tools — Pre-Design Briefing",
      ),
    );
    expect(preview.getAttribute("data-preview-fallback")).toBe("true");
  });
});
