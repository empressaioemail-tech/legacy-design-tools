import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockSession = vi.hoisted(() => ({
  audience: "internal" as "internal" | "user" | "ai" | null,
  permissions: [] as string[],
}));

const warmupStatusByKey = vi.hoisted<
  Record<
    string,
    {
      jurisdictionKey: string;
      state: "idle" | "running" | "completed" | "failed";
      pending: number;
      processing: number;
      completed: number;
      failed: number;
      total: number;
      startedAt: string | null;
      completedAt: string | null;
      lastError: string | null;
    }
  >
>(() => ({}));

const pollingProbe = vi.hoisted<{
  lastIntervalCallback:
    | null
    | ((query: { state: { data: unknown } }) => number | false);
}>(() => ({ lastIntervalCallback: null }));

const lastListAtomsParams = vi.hoisted<{
  current: Record<string, unknown> | null;
}>(() => ({ current: null }));

vi.mock("@workspace/api-client-react", async () => {
  const { useQuery, useMutation } = await import("@tanstack/react-query");

  const jurisdictions = [
    {
      key: "grand_county_ut",
      displayName: "Grand County, UT",
      atomCount: 3,
      embeddedCount: 2,
      lastFetchedAt: "2026-04-15T12:00:00Z",
      books: [
        {
          codeBook: "zoning",
          edition: "2024",
          label: "Zoning",
          sourceName: "grand_county_html",
          atomCount: 2,
        },
        {
          codeBook: "building",
          edition: "2024",
          label: "Building",
          sourceName: "grand_county_html",
          atomCount: 1,
        },
      ],
    },
    {
      key: "bastrop_tx",
      displayName: "Bastrop, TX",
      atomCount: 0,
      embeddedCount: 0,
      lastFetchedAt: null,
      books: [],
    },
    {
      key: "fully_embedded",
      displayName: "Fully Embedded",
      atomCount: 5,
      embeddedCount: 5,
      lastFetchedAt: "2026-04-15T12:00:00Z",
      books: [],
    },
  ];

  const allAtoms = [
    {
      id: "atom-1",
      jurisdictionKey: "grand_county_ut",
      codeBook: "zoning",
      edition: "2024",
      sectionNumber: "1.2.3",
      sectionTitle: "Setbacks",
      sourceName: "grand_county_html",
      sourceUrl: "https://example.com/zoning/1.2.3",
      embedded: true,
      fetchedAt: "2026-04-15T12:00:00Z",
      bodyPreview: "Side setback minimum five feet from property line.",
    },
    {
      id: "atom-2",
      jurisdictionKey: "grand_county_ut",
      codeBook: "zoning",
      edition: "2024",
      sectionNumber: "1.2.4",
      sectionTitle: "Heights",
      sourceName: "grand_county_html",
      sourceUrl: "https://example.com/zoning/1.2.4",
      embedded: false,
      fetchedAt: "2026-04-15T12:00:00Z",
      bodyPreview: "Maximum building height thirty feet.",
    },
    {
      id: "atom-3",
      jurisdictionKey: "grand_county_ut",
      codeBook: "building",
      edition: "2024",
      sectionNumber: "R301.1",
      sectionTitle: "Application",
      sourceName: "grand_county_html",
      sourceUrl: "https://example.com/building/R301.1",
      embedded: true,
      fetchedAt: "2026-04-15T12:00:00Z",
      bodyPreview: "Buildings shall be designed for live and dead loads.",
    },
  ];

  const atomDetailsById: Record<
    string,
    {
      id: string;
      jurisdictionKey: string;
      codeBook: string;
      edition: string;
      sectionNumber: string | null;
      sectionTitle: string | null;
      sourceName: string;
      sourceUrl: string;
      embedded: boolean;
      fetchedAt: string;
      bodyPreview: string;
      body: string;
      bodyHtml: string | null;
      parentSection: string | null;
      embeddingModel: string | null;
      metadata: Record<string, unknown> | null;
    }
  > = {
    "atom-1": {
      id: "atom-1",
      jurisdictionKey: "grand_county_ut",
      codeBook: "zoning",
      edition: "2024",
      sectionNumber: "1.2.3",
      sectionTitle: "Setbacks",
      sourceName: "grand_county_html",
      sourceUrl: "https://example.com/zoning/1.2.3",
      embedded: true,
      fetchedAt: "2026-04-15T12:00:00Z",
      bodyPreview: "Side setback minimum five feet from property line.",
      body: "Full setback rules text.",
      bodyHtml: null,
      parentSection: "1.2",
      embeddingModel: "text-embedding-3-small",
      metadata: null,
    },
  };

  return {
    useGetSession: () => ({
      data: {
        permissions: mockSession.permissions,
        audience: mockSession.audience,
      },
      isLoading: false,
    }),
    getGetSessionQueryKey: () => ["session"],
    useListMyReviewerRequests: () => ({ data: { requests: [] } }),
    getListMyReviewerRequestsQueryKey: () => ["listMyReviewerRequests"],
    useListCodeJurisdictions: () =>
      useQuery({
        queryKey: ["jurisdictions"],
        queryFn: () => jurisdictions,
      }),
    useListCodeAtoms: (params: Record<string, unknown> = {}) => {
      lastListAtomsParams.current = params;
      const key = params.jurisdictionKey as string | undefined;
      const codeBook = params.codeBook as string | undefined;
      const q = params.q as string | undefined;
      const limit = (params.limit as number | undefined) ?? 50;
      const offset = (params.offset as number | undefined) ?? 0;
      return useQuery({
        queryKey: ["atoms", key, codeBook ?? "all", q ?? "", offset, limit],
        queryFn: () => {
          let filtered = allAtoms.filter((a) => a.jurisdictionKey === key);
          if (codeBook) filtered = filtered.filter((a) => a.codeBook === codeBook);
          if (q) {
            const needle = q.toLowerCase();
            filtered = filtered.filter((a) =>
              [a.sectionNumber ?? "", a.sectionTitle ?? "", a.bodyPreview]
                .join(" ")
                .toLowerCase()
                .includes(needle),
            );
          }
          return {
            total: filtered.length,
            limit,
            offset,
            items: filtered.slice(offset, offset + limit),
          };
        },
      });
    },
    useGetCodeAtom: (id: string) =>
      useQuery({
        queryKey: ["atom", id],
        queryFn: () => atomDetailsById[id]!,
      }),
    useGetWarmupStatus: (
      key: string,
      options?: {
        query?: {
          refetchInterval?: (
            query: { state: { data: unknown } },
          ) => number | false;
        };
      },
    ) => {
      pollingProbe.lastIntervalCallback =
        options?.query?.refetchInterval ?? null;
      return useQuery({
        queryKey: ["warmup-status", key],
        queryFn: () =>
          warmupStatusByKey[key] ?? {
            jurisdictionKey: key,
            state: "idle" as const,
            pending: 0,
            processing: 0,
            completed: 0,
            failed: 0,
            total: 0,
            startedAt: null,
            completedAt: null,
            lastError: null,
          },
      });
    },
    useWarmupJurisdiction: () => useMutation({ mutationFn: async () => ({}) }),
    useBackfillCodeEmbeddings: () =>
      useMutation({ mutationFn: async () => ({}) }),
    getListCodeJurisdictionsQueryKey: () => ["jurisdictions"],
    getListCodeAtomsQueryKey: (params?: Record<string, unknown>) => [
      "atoms",
      params,
    ],
    getGetWarmupStatusQueryKey: (key: string) => ["warmup-status", key],
  };
});

const { default: CodeLibrary } = await import("../CodeLibrary");

function renderPage() {
  const memory = memoryLocation({ path: "/code", record: true });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Router hook={memory.hook}>
        <CodeLibrary />
      </Router>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockSession.audience = "internal";
  mockSession.permissions = [];
  for (const k of Object.keys(warmupStatusByKey)) delete warmupStatusByKey[k];
  pollingProbe.lastIntervalCallback = null;
  lastListAtomsParams.current = null;
});

afterEach(() => {
  cleanup();
});

describe("CodeLibrary", () => {
  it("auto-selects the first jurisdiction and lists its atoms", async () => {
    renderPage();
    await screen.findByTestId("atom-row-atom-1");
    expect(
      screen.getByTestId("jurisdiction-row-grand_county_ut"),
    ).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("atom-row-atom-2")).toBeInTheDocument();
    expect(screen.getByTestId("atom-row-atom-3")).toBeInTheDocument();
  });

  it("filters atoms by codebook server-side", async () => {
    renderPage();
    await screen.findByTestId("atom-row-atom-1");
    fireEvent.click(screen.getByTestId("atom-book-filter-zoning"));
    await waitFor(() => {
      expect(lastListAtomsParams.current?.codeBook).toBe("zoning");
    });
    await waitFor(() => {
      expect(screen.queryByTestId("atom-row-atom-3")).toBeNull();
      expect(screen.getByTestId("atom-row-atom-1")).toBeInTheDocument();
    });
  });

  it("debounces free-text search and forwards it to the server", async () => {
    renderPage();
    await screen.findByTestId("atom-row-atom-1");
    fireEvent.change(screen.getByTestId("atom-search-input"), {
      target: { value: "height" },
    });
    await waitFor(
      () => {
        expect(lastListAtomsParams.current?.q).toBe("height");
      },
      { timeout: 2000 },
    );
    await waitFor(() => {
      expect(screen.queryByTestId("atom-row-atom-1")).toBeNull();
      expect(screen.getByTestId("atom-row-atom-2")).toBeInTheDocument();
    });
  });

  it("opens the atom detail modal with the right atom", async () => {
    renderPage();
    const row = await screen.findByTestId("atom-row-atom-1");
    fireEvent.click(row);
    await screen.findByTestId("atom-detail-content");
    const body = screen.getByTestId("atom-detail-body");
    expect(within(body).getByText("Setbacks")).toBeInTheDocument();
    expect(
      within(body).getByText(/Full setback rules text/),
    ).toBeInTheDocument();
    expect(
      within(body).getByTestId("atom-detail-source-link"),
    ).toHaveAttribute("href", "https://example.com/zoning/1.2.3");
  });

  it("polls the warmup status while running and stops on terminal state", async () => {
    warmupStatusByKey.grand_county_ut = {
      jurisdictionKey: "grand_county_ut",
      state: "running",
      pending: 5,
      processing: 1,
      completed: 0,
      failed: 0,
      total: 6,
      startedAt: "2026-04-15T12:00:00Z",
      completedAt: null,
      lastError: null,
    };
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("warmup-state-pill")).toHaveTextContent(
        "Running",
      );
    });
    expect(pollingProbe.lastIntervalCallback).not.toBeNull();
    const cb = pollingProbe.lastIntervalCallback!;
    expect(cb({ state: { data: { state: "running" } } })).toBe(3000);
    expect(cb({ state: { data: { state: "completed" } } })).toBe(false);
    expect(cb({ state: { data: { state: "failed" } } })).toBe(false);
    expect(cb({ state: { data: { state: "idle" } } })).toBe(false);
  });

  it("surfaces the most recent failed-row error inline", async () => {
    warmupStatusByKey.grand_county_ut = {
      jurisdictionKey: "grand_county_ut",
      state: "failed",
      pending: 0,
      processing: 0,
      completed: 1,
      failed: 1,
      total: 2,
      startedAt: "2026-04-15T12:00:00Z",
      completedAt: "2026-04-15T12:01:00Z",
      lastError: "boom",
    };
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("warmup-last-error")).toHaveTextContent(
        /boom/,
      );
    });
  });

  it("hides the warmup + embed actions for applicant audience", async () => {
    mockSession.audience = "user";
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("warmup-panel")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("warmup-button")).toBeNull();
    expect(screen.queryByTestId("embed-backfill-button")).toBeNull();
  });

  it("shows the warmup + embed actions for reviewer audience", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("warmup-button")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("embed-backfill-button")).toBeInTheDocument();
  });

  it("disables the embed button when every atom already has an embedding", async () => {
    renderPage();
    const fullyRow = await screen.findByTestId(
      "jurisdiction-row-fully_embedded",
    );
    fireEvent.click(fullyRow);
    await waitFor(() => {
      const btn = screen.getByTestId(
        "embed-backfill-button",
      ) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(btn.textContent).toMatch(/All atoms embedded/);
    });
  });
});
