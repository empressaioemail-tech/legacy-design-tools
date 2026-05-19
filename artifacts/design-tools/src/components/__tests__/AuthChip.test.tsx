/**
 * AuthChip — gateway-assumed top-right auth affordance for the
 * design-tools SPA. Verifies:
 *   1. The user-indicator chip and the sign-out button render.
 *   2. Clicking sign-out redirects to /logout — the chip's stub
 *      contract until a real /api/me + signOut endpoint lands.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AuthChip } from "../AuthChip";

describe("AuthChip", () => {
  beforeEach(() => {
    // happy-dom permits direct assignment to location.href; replace
    // the property with a vi-tracked setter so we can assert the
    // sign-out redirect without navigating the test JSDOM.
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { ...window.location, href: "" },
    });
  });

  it("renders the user indicator and sign-out button", () => {
    render(<AuthChip />);
    expect(screen.getByTestId("auth-chip")).toBeInTheDocument();
    expect(screen.getByTestId("auth-chip-user")).toHaveTextContent("Operator");
    expect(screen.getByTestId("auth-chip-signout")).toHaveAttribute(
      "aria-label",
      "Sign out",
    );
  });

  it("redirects to /logout on sign-out click", () => {
    render(<AuthChip />);
    fireEvent.click(screen.getByTestId("auth-chip-signout"));
    expect(window.location.href).toBe("/logout");
  });
});
