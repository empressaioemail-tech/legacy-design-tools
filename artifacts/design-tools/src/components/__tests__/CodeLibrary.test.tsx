/**
 * CodeLibrary — warmup observability + clickable book rows + atom expand.
 *
 * Mocks @workspace/api-client-react so we control hook returns + the two
 * imperative functions (warmupJurisdiction, getWarmupStatus). This keeps the
 * test deterministic without spinning up a fake QueryClient or fetch shims.
 *
 * Polling test uses vi.useFakeTimers — the component's polling loop sleeps
 * for POLL_INTERVAL_MS (2000) between getWarmupStatus calls, so we advance
 * time manually and assert state transitions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

interface Atom {
  id: string;
  jurisdictionKey: string;
  codeBook: string;
  edition: string;
  sectionNumber: string | null;
  sectionTitle: string | null;
  sourceUrl: string;
  sourceName: string;
  embedded: boolean;
  fetchedAt: string;
  bodyPreview: string;
}

interface AtomDetail extends Atom {
  body: string;
  bodyHtml: string | null;
  parentSection: string | null;
  embeddingModel: string | null;
  metadata: Record<string, unknown> | null;
}

interface WarmupStatus {
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

// Centralized mock state — tests mutate these between runs.
const apiState = vi.hoisted(() => ({
  jurisdictions: [
    {
      key: "grand_county_ut",
      displayName: "Grand County, UT",
      atomCount: 4,
      embeddedCount: 4,
      lastFetchedAt: "2026-04-30T10:00:00.000Z",
      books: [
        {
          codeBook: "IRC_R301_2_1",
          edition: "2021",
          label: "2021 IRC R301.2(1)",
          sourceName: "grand_county_html",
          atomCount: 1,
        },
        {
          codeBook: "IWUIC",
          edition: "2006",
          label: "2006 IWUIC",
          sourceName: "grand_county_pdf",
          atomCount: 3,
        },
      ],
    },
  ] as Array<{ key: string; displayName: string; atomCount: number; embeddedCount: number; lastFetchedAt: string | null; books: Array<{ codeBook: string; edition: string; label: string; sourceName: string; atomCount: number }> }>,
  atomsByQuery: new Map<string, Atom[]>(),
  atomDetails: new Map<string, AtomDetail>(),
  warmupStatusQueue: [] as WarmupStatus[],
  lastAtomQueryParams: null as Record<string, unknown> | null,
}));

const warmupJurisdictionMock = vi.hoisted(() => vi.fn());
const getWarmupStatusMock = vi.hoisted(() => vi.fn());

vi.mock("@workspace/api-client-react", () => ({
  useListCodeJurisdictions: () => ({
    data: apiState.jurisdictions,
    isLoading: false,
  }),
  useListJurisdictionAtoms: (
    key: string,
    params: Record<string, unknown>,
  ) => {
    apiState.lastAtomQueryParams = params;
    const filterKey = JSON.stringify({ key, ...params });
    const data =
      apiState.atomsByQuery.get(filterKey) ??
      apiState.atomsByQuery.get(key) ??
      [];
    return { data, isLoading: false };
  },
  useGetCodeAtom: (id: string, opts: { query?: { enabled?: boolean } }) => {
    if (!opts.query?.enabled || !id) return { data: undefined, isLoading: false };
    return {
      data: apiState.atomDetails.get(id),
      isLoading: false,
    };
  },
  warmupJurisdiction: warmupJurisdictionMock,
  getWarmupStatus: getWarmupStatusMock,
  getListCodeJurisdictionsQueryKey: () => ["jurisdictions"],
  getListJurisdictionAtomsQueryKey: (key: string, params: Record<string, unknown>) => ["atoms", key, params],
  getGetCodeAtomQueryKey: (id: string) => ["atom", id],
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

const { CodeLibrary } = await import("../../pages/CodeLibrary");

beforeEach(() => {
  warmupJurisdictionMock.mockReset();
  getWarmupStatusMock.mockReset();
  apiState.atomsByQuery.clear();
  apiState.atomDetails.clear();
  apiState.warmupStatusQueue = [];
  apiState.lastAtomQueryParams = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CodeLibrary — warmup observability (P1.3)", () => {
  it("transitions through running → completed and shows live progress, returning to idle on completion", async () => {
    vi.useFakeTimers();
    apiState.atomsByQuery.set("grand_county_ut", []);

    // Sequence the polling responses:
    //   tick 1: 1 / 4 (still running)
    //   tick 2: 4 / 4 with state=completed
    const responses: WarmupStatus[] = [
      {
        jurisdictionKey: "grand_county_ut",
        state: "running",
        pending: 0,
        processing: 1,
        completed: 1,
        failed: 0,
        total: 4,
        startedAt: "2026-04-30T11:00:00.000Z",
        completedAt: null,
        lastError: null,
      },
      {
        jurisdictionKey: "grand_county_ut",
        state: "completed",
        pending: 0,
        processing: 0,
        completed: 4,
        failed: 0,
        total: 4,
        startedAt: "2026-04-30T11:00:00.000Z",
        completedAt: "2026-04-30T11:01:30.000Z",
        lastError: null,
      },
    ];
    let callIdx = 0;
    getWarmupStatusMock.mockImplementation(async () => {
      const r = responses[Math.min(callIdx, responses.length - 1)];
      callIdx++;
      return r;
    });
    warmupJurisdictionMock.mockResolvedValue({
      jurisdictionKey: "grand_county_ut",
      enqueued: 4,
      skipped: 0,
      drained: { picked: 3, completed: 3, failed: 0, atomsWritten: 3 },
    });

    render(<CodeLibrary />);

    const btn = screen.getByTestId("warmup-btn-grand_county_ut");
    expect(btn).toHaveTextContent(/Warm up now/);

    // Click. The button immediately flips to "Warming up…" before any async resolves.
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(screen.getByTestId("warmup-btn-grand_county_ut")).toHaveTextContent(
      /Warming up…/,
    );
    expect(warmupJurisdictionMock).toHaveBeenCalledWith("grand_county_ut");

    // Advance to first poll tick (2000ms) → status[0] returns running 1/4.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(
      screen.getByTestId("warmup-progress-grand_county_ut"),
    ).toHaveTextContent(/Warming up: 1 \/ 4 sections processed/);

    // Advance to second poll tick (another 2000ms) → status[1] returns completed.
    // The polling loop sees state !== "running" and breaks, then sets the
    // outcome message and flips warming back to false.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    // Button back to idle.
    expect(screen.getByTestId("warmup-btn-grand_county_ut")).toHaveTextContent(
      /Warm up now/,
    );
    // Outcome message visible.
    expect(screen.getByTestId("warmup-msg-grand_county_ut")).toHaveTextContent(
      /Completed 4\/4 sections\./,
    );
  });

  it("surfaces discoveryErrors immediately when warmup enqueued nothing — no silent 'idle' fallthrough", async () => {
    vi.useFakeTimers();
    apiState.atomsByQuery.set("grand_county_ut", []);

    warmupJurisdictionMock.mockResolvedValue({
      jurisdictionKey: "grand_county_ut",
      enqueued: 0,
      skipped: 0,
      drained: { picked: 0, completed: 0, failed: 0, atomsWritten: 0 },
      discoveryErrors: [
        { sourceName: "grand_county_pdf", error: "source_row_missing" },
      ],
    });
    // No polling should happen — but if it did, throwing here would surface
    // the bug. The discoveryErrors short-circuit must skip the loop entirely.
    getWarmupStatusMock.mockRejectedValue(new Error("polling should be skipped"));

    render(<CodeLibrary />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("warmup-btn-grand_county_ut"));
    });
    // No timer advance — the message is set synchronously after the awaited
    // warmupJurisdiction call resolves.
    expect(screen.getByTestId("warmup-msg-grand_county_ut")).toHaveTextContent(
      /Warmup discovered nothing — grand_county_pdf: source_row_missing/,
    );
    // Spinner returns to idle.
    expect(screen.getByTestId("warmup-btn-grand_county_ut")).toHaveTextContent(
      /Warm up now/,
    );
    expect(getWarmupStatusMock).not.toHaveBeenCalled();
  });

  it("surfaces a 'polling unavailable' message after consecutive status-endpoint failures", async () => {
    vi.useFakeTimers();
    apiState.atomsByQuery.set("grand_county_ut", []);

    warmupJurisdictionMock.mockResolvedValue({
      jurisdictionKey: "grand_county_ut",
      enqueued: 4,
      skipped: 0,
      drained: { picked: 3, completed: 3, failed: 0, atomsWritten: 3 },
      discoveryErrors: [],
    });
    // Every status poll throws → after POLL_FAILURE_THRESHOLD (3) the loop
    // breaks with pollUnreachable=true and the user sees a real message.
    getWarmupStatusMock.mockRejectedValue(new Error("ECONNREFUSED"));

    render(<CodeLibrary />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("warmup-btn-grand_county_ut"));
    });
    // Advance 3 polling ticks.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000 * 3);
    });
    expect(screen.getByTestId("warmup-msg-grand_county_ut")).toHaveTextContent(
      /Status polling unavailable/,
    );
    expect(screen.getByTestId("warmup-btn-grand_county_ut")).toHaveTextContent(
      /Warm up now/,
    );
  });

  it("surfaces lastError text on failure, auto-clears the message, and the failed-row warning panel persists", async () => {
    vi.useFakeTimers();
    apiState.atomsByQuery.set("grand_county_ut", []);

    getWarmupStatusMock.mockResolvedValue({
      jurisdictionKey: "grand_county_ut",
      state: "failed",
      pending: 0,
      processing: 0,
      completed: 1,
      failed: 3,
      total: 4,
      startedAt: "2026-04-30T11:00:00.000Z",
      completedAt: "2026-04-30T11:00:30.000Z",
      lastError: "Municode 429: Too Many Requests",
    } satisfies WarmupStatus);
    warmupJurisdictionMock.mockResolvedValue({
      jurisdictionKey: "grand_county_ut",
      enqueued: 4,
      skipped: 0,
      drained: { picked: 3, completed: 1, failed: 2, atomsWritten: 1 },
    });

    render(<CodeLibrary />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("warmup-btn-grand_county_ut"));
    });
    // First poll tick → terminal failed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    // Outcome message includes the lastError text, so the user can debug
    // without going to logs.
    expect(screen.getByTestId("warmup-msg-grand_county_ut")).toHaveTextContent(
      /Warmup failed \(3\/4 sections\): Municode 429: Too Many Requests/,
    );
    // Failed-row warning panel is also visible (independent of the
    // auto-clearing message). This is the load-bearing lastError surface.
    expect(
      screen.getByTestId("warmup-error-grand_county_ut"),
    ).toHaveTextContent(/Last error: Municode 429: Too Many Requests/);

    // Advance past the 5s auto-clear window — the inline message clears,
    // but the warning panel stays as long as warmupStatus has failed rows.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5500);
    });
    expect(screen.queryByTestId("warmup-msg-grand_county_ut")).toBeNull();
    expect(
      screen.getByTestId("warmup-error-grand_county_ut"),
    ).toHaveTextContent(/Municode 429/);
  });
});

describe("CodeLibrary — clickable book rows (P1.4)", () => {
  it("clicking a book pill filters the atom list to just that book and updates the panel header", async () => {
    // Two atoms across two books. The unfiltered list shows both; clicking
    // the IWUIC pill filters to just the IWUIC atom.
    const ircAtom: Atom = {
      id: "atom-irc",
      jurisdictionKey: "grand_county_ut",
      codeBook: "IRC_R301_2_1",
      edition: "2021",
      sectionNumber: "R301.2(1)",
      sectionTitle: "Climatic data",
      sourceName: "grand_county_html",
      sourceUrl: "https://example.com/r301",
      embedded: true,
      fetchedAt: "2026-04-30T10:00:00.000Z",
      bodyPreview: "Wind speed 90 mph, snow load 20 psf…",
    };
    const iwuicAtom: Atom = {
      id: "atom-iwuic",
      jurisdictionKey: "grand_county_ut",
      codeBook: "IWUIC",
      edition: "2006",
      sectionNumber: "1.1",
      sectionTitle: "Scope",
      sourceName: "grand_county_pdf",
      sourceUrl: "https://example.com/iwuic-1-1",
      embedded: true,
      fetchedAt: "2026-04-30T10:00:00.000Z",
      bodyPreview: "This code shall apply to wildland-urban interface…",
    };
    // Unfiltered: both atoms.
    apiState.atomsByQuery.set("grand_county_ut", [ircAtom, iwuicAtom]);
    // IWUIC-filtered: just iwuicAtom. Key matches the params useListJurisdictionAtoms
    // sees when activeBook = IWUIC: { limit: 100, codeBook: "IWUIC", edition: "2006" }
    apiState.atomsByQuery.set(
      JSON.stringify({
        key: "grand_county_ut",
        limit: 100,
        codeBook: "IWUIC",
        edition: "2006",
      }),
      [iwuicAtom],
    );

    render(<CodeLibrary />);

    // Initially: list shows both atoms, header reads "All books".
    expect(screen.getByText(/Grand County, UT · All books/)).toBeInTheDocument();
    expect(screen.getByTestId("atom-row-atom-irc")).toBeInTheDocument();
    expect(screen.getByTestId("atom-row-atom-iwuic")).toBeInTheDocument();

    // Click the IWUIC book pill.
    await act(async () => {
      fireEvent.click(
        screen.getByTestId("book-pill-grand_county_ut-IWUIC"),
      );
    });

    // Header now shows the book label.
    expect(
      screen.getByText(/Grand County, UT · 2006 IWUIC/),
    ).toBeInTheDocument();
    // List filtered to just IWUIC atom.
    expect(screen.queryByTestId("atom-row-atom-irc")).toBeNull();
    expect(screen.getByTestId("atom-row-atom-iwuic")).toBeInTheDocument();
    // The hook was called with the codeBook+edition params.
    expect(apiState.lastAtomQueryParams).toMatchObject({
      limit: 100,
      codeBook: "IWUIC",
      edition: "2006",
    });
    // Clear-filter chip is visible.
    expect(screen.getByTestId("clear-book-filter")).toBeInTheDocument();

    // Clearing the filter restores both atoms.
    await act(async () => {
      fireEvent.click(screen.getByTestId("clear-book-filter"));
    });
    expect(screen.getByText(/Grand County, UT · All books/)).toBeInTheDocument();
    expect(screen.getByTestId("atom-row-atom-irc")).toBeInTheDocument();
    expect(screen.getByTestId("atom-row-atom-iwuic")).toBeInTheDocument();
  });

  it("clicking an atom row expands the right panel to show the full body and source link", async () => {
    const atom: Atom = {
      id: "atom-1",
      jurisdictionKey: "grand_county_ut",
      codeBook: "IRC_R301_2_1",
      edition: "2021",
      sectionNumber: "R301.2(1)",
      sectionTitle: "Climatic data",
      sourceName: "grand_county_html",
      sourceUrl: "https://example.com/r301",
      embedded: true,
      fetchedAt: "2026-04-30T10:00:00.000Z",
      bodyPreview: "Wind speed 90 mph…",
    };
    apiState.atomsByQuery.set("grand_county_ut", [atom]);
    apiState.atomDetails.set("atom-1", {
      ...atom,
      body: "FULL BODY: Wind speed 90 mph, snow load 20 psf, seismic D2, frost line 36 inches.",
      bodyHtml: null,
      parentSection: null,
      embeddingModel: "voyage-3",
      metadata: null,
    });

    render(<CodeLibrary />);

    // Placeholder before click.
    expect(
      screen.getByText(/Select an atom from the list/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("atom-body")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("atom-row-atom-1"));
    });

    // Full body now rendered with source link.
    const body = screen.getByTestId("atom-body");
    expect(body).toHaveTextContent(/FULL BODY: Wind speed 90 mph/);
    expect(body).toHaveTextContent(/frost line 36 inches/);
    const link = screen.getByRole("link", { name: /Open source/ });
    expect(link).toHaveAttribute("href", "https://example.com/r301");
  });
});
