/**
 * doc 40c B.6 — RenderCreditsBadge regression coverage. Pins the four
 * surfaces the chip renders: loading, success, generic error, and the
 * deliberately-quiet 503 `renders_preview_disabled` branch (the
 * gallery owns that user-facing message, so the badge stays out of
 * the way).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MockApiError } from "../../test-utils/mockApiClient";

// Hoisted mutable shape — each `useGetRenderCredits` call returns a
// fresh spread so React Query consumers don't accidentally share
// reference identity across renders.
const queryState = vi.hoisted(() => ({
  data: undefined as { credits: number } | undefined,
  isLoading: false as boolean,
  error: null as unknown,
}));

vi.mock("@workspace/api-client-react", () => {
  return {
    ApiError: MockApiError,
    useGetRenderCredits: () => ({ ...queryState }),
    getGetRenderCreditsQueryKey: () => ["/api/renders/credits"] as const,
  };
});

const { RenderCreditsBadge } = await import("../RenderCreditsBadge");

beforeEach(() => {
  queryState.data = undefined;
  queryState.isLoading = false;
  queryState.error = null;
});

afterEach(() => cleanup());

describe("RenderCreditsBadge", () => {
  it("renders the loading chip while the credits query is in flight", () => {
    queryState.isLoading = true;
    render(<RenderCreditsBadge />);
    expect(
      screen.getByTestId("render-credits-badge-loading"),
    ).toBeInTheDocument();
  });

  it("renders the credit count on success", () => {
    queryState.data = { credits: 1234 };
    render(<RenderCreditsBadge />);
    const badge = screen.getByTestId("render-credits-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent(/1,234 mnml credits/);
  });

  it("renders nothing when the renders preview is disabled (503)", () => {
    queryState.error = new MockApiError(503, {
      errorCode: "renders_preview_disabled",
    });
    const { container } = render(<RenderCreditsBadge />);
    expect(
      screen.queryByTestId("render-credits-badge"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("render-credits-badge-loading"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("render-credits-badge-error"),
    ).not.toBeInTheDocument();
    expect(container.firstChild).toBeNull();
  });

  it("renders the friendly 'unavailable' chip on any other error", () => {
    queryState.error = new MockApiError(500, { error: "internal" });
    render(<RenderCreditsBadge />);
    expect(
      screen.getByTestId("render-credits-badge-error"),
    ).toHaveTextContent(/unavailable/i);
  });
});
