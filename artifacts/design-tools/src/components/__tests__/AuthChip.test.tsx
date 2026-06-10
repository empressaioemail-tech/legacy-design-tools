/**
 * AuthChip — anonymous guest label + minimal sign-in affordance.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthChip } from "../AuthChip";

const getSessionMock = vi.fn();

vi.mock("@workspace/api-client-react", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/api-client-react")
  >("@workspace/api-client-react");
  return {
    ...actual,
    useGetSession: (opts?: { query?: { queryKey?: readonly unknown[] } }) =>
      getSessionMock(opts),
  };
});

function renderChip() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthChip />
    </QueryClientProvider>,
  );
}

describe("AuthChip", () => {
  beforeEach(() => {
    getSessionMock.mockReturnValue({ data: { audience: "user" } });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      }),
    );
  });

  it("renders Guest and sign-in button for anonymous sessions", () => {
    renderChip();
    expect(screen.getByTestId("auth-chip")).toBeInTheDocument();
    expect(screen.getByTestId("auth-chip-user")).toHaveTextContent("Guest");
    expect(screen.getByTestId("auth-chip-signin")).toHaveAttribute(
      "aria-label",
      "Sign in",
    );
  });

  it("renders signed-in label and sign-out for user sessions", () => {
    getSessionMock.mockReturnValue({
      data: {
        audience: "user",
        requestor: { kind: "user", id: "user-42", disciplines: [] },
      },
    });
    renderChip();
    expect(screen.getByTestId("auth-chip-user")).toHaveTextContent("user-42");
    expect(screen.getByTestId("auth-chip-signout")).toBeInTheDocument();
  });

  it("opens login dialog and submits credentials", async () => {
    renderChip();
    fireEvent.click(screen.getByTestId("auth-chip-signin"));
    expect(screen.getByTestId("auth-chip-dialog")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("auth-chip-email"), {
      target: { value: "demo@example.com" },
    });
    fireEvent.change(screen.getByTestId("auth-chip-password"), {
      target: { value: "password123" },
    });
    fireEvent.click(screen.getByTestId("auth-chip-submit"));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/auth/login",
        expect.objectContaining({ method: "POST", credentials: "include" }),
      );
    });
  });
});
