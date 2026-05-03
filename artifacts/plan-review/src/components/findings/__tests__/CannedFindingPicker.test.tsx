/**
 * CannedFindingPicker — picker → manual-add prefill → create POST flow
 * (Task #473).
 *
 * The picker lives inside `FindingsTab`. When a reviewer toggles it
 * open, it issues a GET against the canned-findings list endpoint;
 * clicking a row hands the entry's title, body, citation, severity,
 * and category up through `onPrefill`, which `FindingsTab` threads
 * into the manual-add disclosure form. Submitting that form fires a
 * POST against the create-finding endpoint with the prefilled values.
 *
 * This test stubs `fetch` for both endpoints (mirrors the manual-add
 * test in `FindingsTab.test.tsx:376-484`) so we can assert the create
 * body the form actually sends — proving the prefill values reach the
 * wire untouched.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useState } from "react";

import { FindingsTab } from "../FindingsTab";
import {
  __resetFindingsMockForTests,
  __seedFindingsForTests,
} from "../../../lib/findingsMock";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function ControlledTab() {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <FindingsTab
      submissionId="sub-canned"
      selectedFindingId={selected}
      onSelectFinding={setSelected}
      audience="internal"
    />
  );
}

const CANNED_ROW = {
  id: "00000000-0000-0000-0000-000000000aaa",
  tenantId: "default",
  discipline: "zoning" as const,
  title: "Front setback violation",
  defaultBody: "North wall encroaches the front setback by 0.4m.",
  severity: "blocker" as const,
  category: "setback",
  color: "#aa0000",
  codeAtomCitations: [{ kind: "code-section" as const, atomId: "code:zoning-19.3.2" }],
  archivedAt: null,
  createdAt: "2026-04-30T12:00:00.000Z",
  updatedAt: "2026-04-30T12:00:00.000Z",
};

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe("CannedFindingPicker (Task #473)", () => {
  beforeEach(() => {
    __resetFindingsMockForTests();
    // Seed an existing finding so the FindingsTab renders past its
    // empty state and the manual-add + picker disclosures appear.
    __seedFindingsForTests("sub-canned", []);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("opens the picker, clicks a row, and creates a finding with the prefilled fields", async () => {
    const createCalls: Array<Record<string, unknown>> = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = urlOf(input);
        // List canned findings — picker fires this when toggled open.
        if (url.includes("/api/tenants/default/canned-findings")) {
          return new Response(
            JSON.stringify({ cannedFindings: [CANNED_ROW] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        // Create-finding POST — manual-add submit fires this with the
        // values the picker prefilled.
        if (url === "/api/submissions/sub-canned/findings") {
          expect(init?.method).toBe("POST");
          createCalls.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response(
            JSON.stringify({
              finding: {
                id: "finding:sub-canned:server-1",
                submissionId: "sub-canned",
                severity: "blocker",
                category: "setback",
                status: "ai-produced",
                text: "Front setback violation\n\nNorth wall encroaches the front setback by 0.4m.",
                citations: [
                  { kind: "code-section", atomId: "code:zoning-19.3.2" },
                ],
                confidence: 1,
                lowConfidence: false,
                reviewerStatusBy: {
                  kind: "user",
                  id: "reviewer-current",
                  displayName: "Reviewer",
                },
                reviewerStatusChangedAt: "2026-04-30T12:00:00.000Z",
                reviewerComment: null,
                elementRef: null,
                sourceRef: null,
                aiGeneratedAt: "2026-04-30T12:00:00.000Z",
                revisionOf: null,
              },
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected fetch in test: ${init?.method ?? "GET"} ${url}`);
      });

    render(<ControlledTab />, { wrapper });

    // Open the picker disclosure.
    fireEvent.click(
      await screen.findByTestId("findings-canned-picker-toggle"),
    );

    // Picker fires the list query on open — wait for the row to render.
    const row = await screen.findByTestId(
      `findings-canned-picker-item-${CANNED_ROW.id}`,
    );
    fireEvent.click(row);

    // Clicking the row prefills the manual-add form, which auto-opens.
    // Assert the form fields carry the canned row's values verbatim.
    await waitFor(() => {
      const titleInput = screen.getByTestId(
        "findings-manual-add-title",
      ) as HTMLInputElement;
      expect(titleInput.value).toBe(CANNED_ROW.title);
    });
    expect(
      (screen.getByTestId("findings-manual-add-description") as HTMLTextAreaElement)
        .value,
    ).toBe(CANNED_ROW.defaultBody);
    expect(
      (screen.getByTestId("findings-manual-add-code-citation") as HTMLInputElement)
        .value,
    ).toBe("code:zoning-19.3.2");
    expect(
      (screen.getByTestId("findings-manual-add-severity") as HTMLSelectElement)
        .value,
    ).toBe("blocker");
    expect(
      (screen.getByTestId("findings-manual-add-category") as HTMLSelectElement)
        .value,
    ).toBe("setback");

    // Submit the manual-add form — this is the POST whose body should
    // carry the prefilled values.
    await act(async () => {
      fireEvent.click(screen.getByTestId("findings-manual-add-submit"));
    });

    await waitFor(() => {
      expect(createCalls).toHaveLength(1);
    });
    expect(createCalls[0]).toMatchObject({
      title: CANNED_ROW.title,
      description: CANNED_ROW.defaultBody,
      severity: "blocker",
      category: "setback",
      codeCitation: "code:zoning-19.3.2",
      elementRef: null,
    });

    // Sanity: the spy did get the GET for the canned list.
    expect(
      fetchSpy.mock.calls.some(([input]) =>
        urlOf(input as RequestInfo | URL).includes(
          "/api/tenants/default/canned-findings",
        ),
      ),
    ).toBe(true);
  });
});
