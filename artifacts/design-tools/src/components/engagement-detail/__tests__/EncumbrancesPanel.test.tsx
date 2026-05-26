import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EncumbrancesPanel } from "../EncumbrancesPanel";

function wrap(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

describe("EncumbrancesPanel", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ instruments: [], clauses: [] }),
      })) as unknown as typeof fetch,
    );
  });

  it("renders empty state with upload CTA", async () => {
    wrap(<EncumbrancesPanel engagementId="00000000-0000-4000-8000-000000000001" />);
    expect(await screen.findByTestId("encumbrances-empty")).toBeTruthy();
    expect(screen.getByTestId("encumbrances-upload-cta")).toBeTruthy();
    expect(screen.getByText(/not municipal code/i)).toBeTruthy();
  });
});
