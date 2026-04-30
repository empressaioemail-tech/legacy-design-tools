/**
 * DevAtomsProbe — three tightly-scoped behavior tests:
 *   1. With a selected engagement + secret + query, clicking Run calls the
 *      probe and renders ranked rows with the threshold divider in the
 *      correct position.
 *   2. Clicking Copy on the assembled prompt block writes it to the
 *      clipboard and the button label flips.
 *   3. URL deep-linking (?engagementId=…&query=…) hydrates the form on
 *      mount.
 *
 * We mock @workspace/api-client-react so `retrieveAtomsProbe` is a vi.fn we
 * control, and wrap renders in a real QueryClientProvider so the
 * component's `useMutation` from @tanstack/react-query actually runs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// Hoisted shared state — tests mutate these between runs to drive what the
// mocked client returns.
const apiState = vi.hoisted(() => ({
  engagements: [
    {
      id: "eng-1",
      name: "Seguin Residence",
      jurisdiction: "Moab, UT",
    },
    {
      id: "eng-2",
      name: "Other Project",
      jurisdiction: "Salt Lake City, UT",
    },
  ] as Array<{ id: string; name: string; jurisdiction: string | null }>,
  jurisdictions: [
    { key: "grand_county_ut", displayName: "Grand County, UT", books: [] },
    { key: "slc_ut", displayName: "Salt Lake City, UT", books: [] },
  ],
}));

const retrieveAtomsProbeMock = vi.hoisted(() => vi.fn());

vi.mock("@workspace/api-client-react", () => ({
  useListEngagements: () => ({
    data: apiState.engagements,
    isLoading: false,
  }),
  useListCodeJurisdictions: () => ({
    data: apiState.jurisdictions,
    isLoading: false,
  }),
  retrieveAtomsProbe: retrieveAtomsProbeMock,
  getListEngagementsQueryKey: () => ["engagements"],
  getListCodeJurisdictionsQueryKey: () => ["jurisdictions"],
}));

const { DevAtomsProbe } = await import("../../pages/DevAtomsProbe");

function makeResults(
  scores: number[],
): Array<{
  rank: number;
  atomId: string;
  codeRef: string;
  sectionTitle: string | null;
  bodyPreview: string;
  similarity: number;
  sourceBook: string;
  sourceUrl: string | null;
  retrievalMode: string;
}> {
  return scores.map((s, i) => ({
    rank: i + 1,
    atomId: `atom-${i + 1}`,
    codeRef: `R${300 + i}`,
    sectionTitle: `Section ${i + 1}`,
    bodyPreview: `Body of section ${i + 1}.`,
    similarity: s,
    sourceBook: "IRC_R301_2_1",
    sourceUrl: `https://example.com/${i + 1}`,
    retrievalMode: "vector",
  }));
}

function renderWithClient(node: ReactNode) {
  // Fresh client per render — defaults retry off so failed mutations surface
  // immediately in the assertion phase instead of waiting for backoff.
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

beforeEach(() => {
  retrieveAtomsProbeMock.mockReset();
  // Pre-stash the secret so canRun gates clear and we can focus assertions
  // on the probe behavior itself, not the secret-paste UX.
  window.localStorage.setItem("devSnapshotSecret", "test-secret");
  // Each test sets its own URL.
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("DevAtomsProbe", () => {
  it("runs the probe for a selected engagement and renders the threshold divider in the correct position", async () => {
    // Two atoms above the server-echoed inclusion threshold (0.35), two
    // below — divider should land between rank 2 and rank 3. The chosen
    // scores (0.55 / 0.42 above; 0.30 / 0.20 below) bracket the 0.35
    // floor cleanly so the test isn't sensitive to small calibration
    // tweaks.
    retrieveAtomsProbeMock.mockResolvedValueOnce({
      resolvedJurisdiction: "grand_county_ut",
      resolvedFromEngagement: true,
      query: "setbacks",
      queryEmbedding: {
        model: "text-embedding-3-small",
        dimension: 1536,
        available: true,
      },
      inclusionThreshold: 0.35,
      results: makeResults([0.55, 0.42, 0.3, 0.2]),
      assembledPromptBlock:
        "<reference_code_atoms>\n<atom>...</atom>\n</reference_code_atoms>",
    });

    renderWithClient(<DevAtomsProbe />);

    fireEvent.change(screen.getByTestId("probe-engagement-select"), {
      target: { value: "eng-1" },
    });
    fireEvent.change(screen.getByTestId("probe-query-textarea"), {
      target: { value: "setbacks" },
    });

    const runBtn = screen.getByTestId("probe-run-button");
    expect(runBtn).not.toBeDisabled();
    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(screen.getAllByTestId("probe-result-row").length).toBe(4);
    });

    // The mock was called exactly once with the engagementId path body and
    // the snapshot-secret header from localStorage.
    expect(retrieveAtomsProbeMock).toHaveBeenCalledTimes(1);
    expect(retrieveAtomsProbeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        engagementId: "eng-1",
        jurisdiction: undefined,
        query: "setbacks",
      }),
      expect.objectContaining({
        headers: { "x-snapshot-secret": "test-secret" },
      }),
    );

    // Divider sits between the 2nd and 3rd result row (i.e. before the
    // first below-threshold row). Use DOM ordering to verify positioning.
    const divider = screen.getByTestId("threshold-divider");
    const rows = screen.getAllByTestId("probe-result-row");
    expect(divider).toBeTruthy();
    // Divider's previous sibling is rank-2 (above-threshold row #2);
    // divider's next sibling is rank-3 (below-threshold row #1).
    expect(divider.previousElementSibling).toBe(rows[1]);
    expect(divider.nextElementSibling).toBe(rows[2]);
  });

  it("copies the assembled prompt block to the clipboard when Copy is clicked", async () => {
    const promptBlock =
      "<reference_code_atoms>\n<atom id=\"atom-1\" ref=\"R301\">body</atom>\n</reference_code_atoms>";
    retrieveAtomsProbeMock.mockResolvedValueOnce({
      resolvedJurisdiction: "grand_county_ut",
      resolvedFromEngagement: false,
      query: "height",
      queryEmbedding: {
        model: "text-embedding-3-small",
        dimension: 1536,
        available: true,
      },
      inclusionThreshold: 0.35,
      results: makeResults([0.81]),
      assembledPromptBlock: promptBlock,
    });

    // Stub clipboard — JSDOM doesn't ship a real one. Use defineProperty
    // so the test passes even if a previous test mutated navigator.clipboard.
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      configurable: true,
    });

    renderWithClient(<DevAtomsProbe />);

    fireEvent.change(screen.getByTestId("probe-jurisdiction-select"), {
      target: { value: "grand_county_ut" },
    });
    fireEvent.change(screen.getByTestId("probe-query-textarea"), {
      target: { value: "height" },
    });
    fireEvent.click(screen.getByTestId("probe-run-button"));

    // Wait for results, then open the prompt-block details and click Copy.
    const copyBtn = await screen.findByTestId("probe-copy-button");
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(promptBlock);
    });
    // Button label flips to "Copied!" once the promise resolves.
    await waitFor(() => {
      expect(copyBtn.textContent).toContain("Copied");
    });
  });

  it("hydrates engagementId + query from the URL on mount", async () => {
    window.history.replaceState(
      null,
      "",
      "/?engagementId=eng-2&query=hydrated+from+url",
    );

    renderWithClient(<DevAtomsProbe />);

    // Engagement select reflects the URL.
    const engSelect = screen.getByTestId(
      "probe-engagement-select",
    ) as HTMLSelectElement;
    expect(engSelect.value).toBe("eng-2");

    // Query textarea reflects the URL (URLSearchParams turns "+" into " ").
    const queryArea = screen.getByTestId(
      "probe-query-textarea",
    ) as HTMLTextAreaElement;
    expect(queryArea.value).toBe("hydrated from url");

    // canRun is true (engagement + query + secret in localStorage), so the
    // Run button is enabled — proves the hydrated state actually feeds
    // the gating logic, not just the inputs visually.
    expect(screen.getByTestId("probe-run-button")).not.toBeDisabled();
  });
});
