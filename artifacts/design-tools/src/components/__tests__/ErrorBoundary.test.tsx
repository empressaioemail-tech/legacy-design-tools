/**
 * ErrorBoundary — global render-error catch at the app root. Verifies:
 *   1. Children render normally when nothing throws.
 *   2. A child that throws during render triggers the fallback card.
 *   3. The fallback exposes the documented testids for the recovery
 *      affordances ("Refresh page" + "Report") so the dispatch's manual
 *      test plan ("recovery path: refresh + report") stays observable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "../ErrorBoundary";

function Boom(): JSX.Element {
  throw new Error("kaboom");
}

describe("ErrorBoundary", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // React 18+ still prints the caught error to console.error even
    // when an error boundary handles it. Silence the noise so the
    // test output stays readable.
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <div data-testid="happy-path">all good</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("happy-path")).toHaveTextContent("all good");
  });

  it("renders the fallback card when a child throws", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    const fallback = screen.getByTestId("error-boundary-fallback");
    expect(fallback).toBeInTheDocument();
    expect(screen.getByTestId("error-boundary-refresh")).toBeInTheDocument();
    expect(screen.getByTestId("error-boundary-report")).toBeInTheDocument();
    // The error message surfaces inside the <details> block.
    expect(fallback).toHaveTextContent("kaboom");
  });
});
