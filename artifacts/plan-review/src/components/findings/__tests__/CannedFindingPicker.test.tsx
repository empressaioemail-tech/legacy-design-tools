/**
 * CannedFindingPicker — picker → manual-add prefill → create POST flow
 * (Task #473), against the real Orval-client surface.
 *
 * The picker lives inside `FindingsTab`. When a reviewer toggles it
 * open, it issues a GET against the canned-findings list endpoint;
 * clicking a row hands the entry's title, body, citation, severity,
 * and category up through `onPrefill`, which `FindingsTab` threads
 * into the manual-add disclosure form. Submitting that form fires a
 * POST against the create-finding endpoint with the prefilled values.
 *
 * Routes the findings surface through the shared in-memory stub and
 * layers a tenant/session/canned-finding fetch handler on top so this
 * spec stays focused on the picker → form → POST round-trip.
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
  installFindingsFetchStub,
  type FindingsFetchStub,
} from "./__fixtures__/findingsFetchStub";

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

let stub: FindingsFetchStub;

describe("CannedFindingPicker (Task #473) — real Orval client", () => {
  beforeEach(() => {
    stub = installFindingsFetchStub({
      // Session + canned-findings endpoints aren't part of the
      // findings surface; layer them as extra handlers so the picker's
      // gated `useListCannedFindings` query fires.
      extraHandlers: [
        (url) => {
          if (url.includes("/api/session")) {
            return new Response(
              JSON.stringify({
                audience: "internal",
                permissions: [],
                tenantId: "default",
                requestor: { kind: "user", id: "u-test", disciplines: [] },
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            );
          }
          if (url.includes("/api/tenants/default/canned-findings")) {
            return new Response(
              JSON.stringify({ cannedFindings: [CANNED_ROW] }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            );
          }
          return null;
        },
      ],
    });
    stub.seedFindings("sub-canned", []);
  });
  afterEach(() => {
    cleanup();
    stub.restore();
    vi.restoreAllMocks();
  });

  it("opens the picker, clicks a row, and creates a finding with the prefilled fields", async () => {
    render(<ControlledTab />, { wrapper });

    fireEvent.click(
      await screen.findByTestId("findings-canned-picker-toggle"),
    );

    const row = await screen.findByTestId(
      `findings-canned-picker-item-${CANNED_ROW.id}`,
    );
    fireEvent.click(row);

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

    await act(async () => {
      fireEvent.click(screen.getByTestId("findings-manual-add-submit"));
    });

    await waitFor(() => {
      expect(stub.peekFindings("sub-canned").length).toBe(1);
    });
    const stored = stub.peekFindings("sub-canned")[0];
    expect(stored.text).toContain(CANNED_ROW.title);
    expect(stored.text).toContain(CANNED_ROW.defaultBody);
    expect(stored.severity).toBe("blocker");
    expect(stored.category).toBe("setback");
    expect(stored.citations).toEqual([
      { kind: "code-section", atomId: "code:zoning-19.3.2" },
    ]);

    // Sanity: the canned-findings GET fired.
    expect(
      stub.spy.mock.calls.some((call) => {
        const input = (call as [RequestInfo | URL, RequestInit | undefined])[0];
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as Request).url;
        return url.includes("/api/tenants/default/canned-findings");
      }),
    ).toBe(true);
  });
});
