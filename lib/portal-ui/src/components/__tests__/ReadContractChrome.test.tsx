import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SAMPLE_READ_CONTRACT } from "@hauska/atom-contract/read-contract";
import type { ReadContract as WireReadContract } from "@workspace/api-client-react";
import { ReadContractChrome } from "../ReadContractChrome";

const SAMPLE_WIRE: WireReadContract = SAMPLE_READ_CONTRACT as unknown as WireReadContract;

describe("ReadContractChrome", () => {
  it("renders widthed confidence with provenance — no bare percent chip", () => {
    render(<ReadContractChrome readContract={SAMPLE_WIRE} />);
    expect(screen.getByTestId("read-contract-confidence")).toBeTruthy();
    expect(screen.getByTestId("read-contract-confidence").textContent).toMatch(
      /Asserted|Live-earned|Backtest|Seed/,
    );
    expect(screen.queryByText(/^\d+%$/)).toBeNull();
  });

  it("returns null when readContract is absent", () => {
    const { container } = render(<ReadContractChrome readContract={null} />);
    expect(container.firstChild).toBeNull();
  });
});
