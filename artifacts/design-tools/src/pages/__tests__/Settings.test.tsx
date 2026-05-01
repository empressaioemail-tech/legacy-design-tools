/**
 * Settings — coverage for the architect's two self-edit forms:
 *
 *   - Profile (displayName / email) — Task #366.
 *   - Stakeholder briefing PDF header (DA-PI-6 / Task #322), plus its
 *     live mini-preview (Task #365).
 *
 * Each form mounts its own mutation hook from `@workspace/api-client-react`;
 * the test mocks both alongside the shared `useGetSession` /
 * `useGetUser` queries so the page renders end-to-end without an HTTP
 * round trip. The forbidden path (anonymous / agent caller) is pinned
 * once at the top — neither form should render an input in that state.
 *
 * The PDF-header section also pins the live-preview contract from
 * Task #365: the preview renders the seeded value, updates as the
 * architect types, and falls back to the platform default (in a
 * muted/italic style) when the input is empty / whitespace-only.
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
import {
  BRIEFING_PDF_FOOTER_TOKENS,
  BRIEFING_PDF_HEADER_TOKENS,
  DEFAULT_BRIEFING_PDF_HEADER,
  DEFAULT_FOOTER_WATERMARK,
} from "@workspace/briefing-pdf-tokens";

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
    pdfHeaderCapturedOptions: null as null | {
      mutation?: { onSuccess?: (data: FakeUser) => void };
    },
    pdfHeaderMutateSpy: vi.fn(),
    pdfHeaderPending: false,
    pdfHeaderError: null as null | Error,
    profileCapturedOptions: null as null | {
      mutation?: { onSuccess?: (data: FakeUser) => void };
    },
    profileMutateSpy: vi.fn(),
    profilePending: false,
    profileError: null as null | Error,
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
      options: typeof hoisted.pdfHeaderCapturedOptions,
    ) => {
      hoisted.pdfHeaderCapturedOptions = options;
      return {
        mutate: hoisted.pdfHeaderMutateSpy,
        isPending: hoisted.pdfHeaderPending,
        isError: !!hoisted.pdfHeaderError,
        error: hoisted.pdfHeaderError,
      };
    },
    useUpdateMyProfile: (
      options: typeof hoisted.profileCapturedOptions,
    ) => {
      hoisted.profileCapturedOptions = options;
      return {
        mutate: hoisted.profileMutateSpy,
        isPending: hoisted.profilePending,
        isError: !!hoisted.profileError,
        error: hoisted.profileError,
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
  hoisted.pdfHeaderCapturedOptions = null;
  hoisted.pdfHeaderMutateSpy.mockReset();
  hoisted.pdfHeaderPending = false;
  hoisted.pdfHeaderError = null;
  hoisted.profileCapturedOptions = null;
  hoisted.profileMutateSpy.mockReset();
  hoisted.profilePending = false;
  hoisted.profileError = null;
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
    expect(screen.queryByTestId("settings-display-name-input")).toBeNull();
    expect(screen.queryByTestId("settings-email-input")).toBeNull();
    expect(hoisted.pdfHeaderMutateSpy).not.toHaveBeenCalled();
    expect(hoisted.profileMutateSpy).not.toHaveBeenCalled();
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
    expect(screen.queryByTestId("settings-display-name-input")).toBeNull();
  });
});

describe("Settings — PDF header form", () => {
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

    expect(hoisted.pdfHeaderMutateSpy).toHaveBeenCalledTimes(1);
    expect(hoisted.pdfHeaderMutateSpy).toHaveBeenCalledWith({
      data: { architectPdfHeader: "  Studio Bar — Briefing  " },
    });

    // Simulate the server's "trimmed" response landing — the input
    // should reflect what the server actually persisted, not the
    // raw draft.
    act(() => {
      hoisted.pdfHeaderCapturedOptions?.mutation?.onSuccess?.({
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
    expect(hoisted.pdfHeaderMutateSpy).toHaveBeenCalledWith({
      data: { architectPdfHeader: "" },
    });

    // Server returns null — the status banner should call out the
    // "now using the default" outcome.
    act(() => {
      hoisted.pdfHeaderCapturedOptions?.mutation?.onSuccess?.({
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

    expect(preview.textContent).toBe(DEFAULT_BRIEFING_PDF_HEADER);
    expect(preview.getAttribute("data-preview-fallback")).toBe("true");
    // Muted-style contract: italic + lighter colour than the live
    // value. The muted #888 is preview-only ("this is the platform
    // default" affordance) and intentionally not in the shared
    // token lib — only the live-value styling has to stay in
    // lockstep with the printed header.
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
    // Live value reads its typography from the shared
    // `@workspace/briefing-pdf-tokens` lib — the same source the
    // renderer's `@page @top-left` margin box interpolates from.
    // The contract this test pins is "preview stays in lockstep
    // with the rendered header by construction".
    expect(preview.style.color).toBe(BRIEFING_PDF_HEADER_TOKENS.color);
    expect(preview.style.fontSize).toBe(BRIEFING_PDF_HEADER_TOKENS.fontSize);
    expect(preview.style.fontFamily).toBe(
      BRIEFING_PDF_HEADER_TOKENS.fontFamily,
    );
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
      expect(preview.textContent).toBe(DEFAULT_BRIEFING_PDF_HEADER),
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
      expect(preview.textContent).toBe(DEFAULT_BRIEFING_PDF_HEADER),
    );
    expect(preview.getAttribute("data-preview-fallback")).toBe("true");
  });
});

describe("Settings — footer watermark preview (Task #404)", () => {
  it("renders the platform default watermark and pins typography to the shared tokens", async () => {
    // The renderer in `briefingHtml.ts` paints the watermark into
    // the `@page @bottom-center` margin box, sourcing the wording
    // from `DEFAULT_FOOTER_WATERMARK` and the typography from
    // `BRIEFING_PDF_FOOTER_TOKENS`. The preview must read from the
    // same shared exports so the two surfaces can't drift — a
    // designer tweaking the renderer's footer colour or wording
    // would otherwise silently desync this card. Mirrors the
    // renderer-side pin in `briefing-export-pdf.test.ts`.
    renderPage();

    const preview = (await screen.findByTestId(
      "settings-footer-watermark-preview",
    )) as HTMLElement;

    expect(preview.textContent).toBe(DEFAULT_FOOTER_WATERMARK);
    expect(preview.style.fontFamily).toBe(
      BRIEFING_PDF_FOOTER_TOKENS.fontFamily,
    );
    expect(preview.style.fontSize).toBe(BRIEFING_PDF_FOOTER_TOKENS.fontSize);
    expect(preview.style.color).toBe(BRIEFING_PDF_FOOTER_TOKENS.color);
  });

  it("renders the same watermark regardless of the architect's header override (footer is platform-wide)", async () => {
    // The footer is not architect-editable today — overriding the
    // header has no effect on the footer card. This test pins that
    // contract so a future "per-architect footer" feature has to
    // explicitly opt-in rather than accidentally branching off the
    // header field.
    hoisted.user = {
      ...hoisted.user!,
      architectPdfHeader: "Studio Foo — Pre-Design Briefing",
    };
    renderPage();

    const preview = (await screen.findByTestId(
      "settings-footer-watermark-preview",
    )) as HTMLElement;
    await waitFor(() =>
      expect(preview.textContent).toBe(DEFAULT_FOOTER_WATERMARK),
    );
  });
});

describe("Settings — profile form (displayName + email)", () => {
  it("seeds both inputs with the persisted values and disables Save when clean", async () => {
    hoisted.user = {
      ...hoisted.user!,
      displayName: "Alex Architect",
      email: "alex@example.com",
    };
    renderPage();

    const name = (await screen.findByTestId(
      "settings-display-name-input",
    )) as HTMLInputElement;
    const email = screen.getByTestId(
      "settings-email-input",
    ) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe("Alex Architect"));
    expect(email.value).toBe("alex@example.com");

    const save = screen.getByTestId(
      "settings-profile-save",
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("treats null email from the server as an empty input", async () => {
    // The User shape has `email: string | null`; coercing the null
    // to "" lets the controlled input render without warnings and
    // matches the "blank means clear" semantics the server enforces.
    renderPage();
    const email = (await screen.findByTestId(
      "settings-email-input",
    )) as HTMLInputElement;
    await waitFor(() => expect(email.value).toBe(""));
  });

  it("forwards only the changed fields to the mutation (partial update)", async () => {
    hoisted.user = {
      ...hoisted.user!,
      displayName: "Old Name",
      email: "old@example.com",
    };
    renderPage();

    const name = (await screen.findByTestId(
      "settings-display-name-input",
    )) as HTMLInputElement;
    const email = screen.getByTestId(
      "settings-email-input",
    ) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe("Old Name"));

    // Only edit displayName — email should not appear in the payload
    // (matches the server's "omit a field to leave it unchanged"
    // contract and avoids ticking updatedAt on untouched columns).
    fireEvent.change(name, { target: { value: "New Name" } });
    expect(email.value).toBe("old@example.com");

    const save = screen.getByTestId(
      "settings-profile-save",
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(hoisted.profileMutateSpy).toHaveBeenCalledTimes(1);
    expect(hoisted.profileMutateSpy).toHaveBeenCalledWith({
      data: { displayName: "New Name" },
    });
  });

  it("forwards both fields when both have changed", async () => {
    renderPage();
    const name = (await screen.findByTestId(
      "settings-display-name-input",
    )) as HTMLInputElement;
    const email = screen.getByTestId(
      "settings-email-input",
    ) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe("Arch"));

    fireEvent.change(name, { target: { value: "Architect Renamed" } });
    fireEvent.change(email, { target: { value: "arch@example.com" } });

    fireEvent.click(
      screen.getByTestId("settings-profile-save") as HTMLButtonElement,
    );
    expect(hoisted.profileMutateSpy).toHaveBeenCalledWith({
      data: {
        displayName: "Architect Renamed",
        email: "arch@example.com",
      },
    });
  });

  it("reflects the server's persisted (trimmed) values back on success", async () => {
    renderPage();
    const name = (await screen.findByTestId(
      "settings-display-name-input",
    )) as HTMLInputElement;
    const email = screen.getByTestId(
      "settings-email-input",
    ) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe("Arch"));

    fireEvent.change(name, { target: { value: "  Padded Name  " } });
    fireEvent.change(email, { target: { value: "  padded@example.com  " } });
    fireEvent.click(
      screen.getByTestId("settings-profile-save") as HTMLButtonElement,
    );

    act(() => {
      hoisted.profileCapturedOptions?.mutation?.onSuccess?.({
        ...hoisted.user!,
        displayName: "Padded Name",
        email: "padded@example.com",
      });
    });
    await waitFor(() => expect(name.value).toBe("Padded Name"));
    expect(email.value).toBe("padded@example.com");
    expect(
      screen.getByTestId("settings-profile-status").textContent,
    ).toMatch(/Saved/i);
  });

  it("disables Save and surfaces an inline error when displayName is blanked out", async () => {
    // The server rejects an empty displayName with 400 — the form
    // mirrors that locally so the architect doesn't have to round-
    // trip through the server to learn their input is invalid.
    hoisted.user = { ...hoisted.user!, displayName: "Original" };
    renderPage();

    const name = (await screen.findByTestId(
      "settings-display-name-input",
    )) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe("Original"));

    fireEvent.change(name, { target: { value: "   " } });
    const save = screen.getByTestId(
      "settings-profile-save",
    ) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(true));
    expect(
      screen.getByTestId("settings-display-name-error").textContent,
    ).toMatch(/can't be blank/i);
    expect(hoisted.profileMutateSpy).not.toHaveBeenCalled();
  });

  it("treats whitespace-only edits as no-ops (matches server's trim)", async () => {
    // Padding "Arch" with surrounding whitespace produces the same
    // trimmed value as the persisted "Arch", so Save must stay
    // disabled — otherwise we'd fire a write that ticks updatedAt
    // for no actual change.
    renderPage();
    const name = (await screen.findByTestId(
      "settings-display-name-input",
    )) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe("Arch"));

    fireEvent.change(name, { target: { value: "  Arch  " } });
    const save = screen.getByTestId(
      "settings-profile-save",
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("clears the email column when the input is blanked out", async () => {
    hoisted.user = {
      ...hoisted.user!,
      email: "old@example.com",
    };
    renderPage();
    const email = (await screen.findByTestId(
      "settings-email-input",
    )) as HTMLInputElement;
    await waitFor(() => expect(email.value).toBe("old@example.com"));

    fireEvent.change(email, { target: { value: "" } });
    fireEvent.click(
      screen.getByTestId("settings-profile-save") as HTMLButtonElement,
    );
    expect(hoisted.profileMutateSpy).toHaveBeenCalledWith({
      data: { email: "" },
    });

    // Server returns null — the input should reflect that.
    act(() => {
      hoisted.profileCapturedOptions?.mutation?.onSuccess?.({
        ...hoisted.user!,
        email: null,
      });
    });
    await waitFor(() => expect(email.value).toBe(""));
  });

  it("surfaces a save error when the mutation fails", async () => {
    hoisted.profileError = new Error("Network down");
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByTestId("settings-profile-error").textContent,
      ).toMatch(/Couldn't save/i),
    );
  });
});
