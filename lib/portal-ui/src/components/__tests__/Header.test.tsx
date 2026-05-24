/**
 * Header — theme toggle (Task #420, extended for chrome themes).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Header } from "../Header";
import { setChromeTheme } from "../../lib/theme";

describe("Header theme toggle", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
    setChromeTheme("charcoal");
  });

  it("flips between dark chrome and soft-light when clicked", () => {
    render(<Header title="Dashboard" />);
    const button = screen.getByTestId("chrome-theme-toggle");

    expect(document.documentElement.dataset.theme).toBe("charcoal");
    expect(button).toHaveAttribute("aria-label", "Switch to soft light theme");
    expect(button).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(button);

    expect(document.documentElement.dataset.theme).toBe("soft-light");
    expect(button).toHaveAttribute("aria-label", "Switch to dark theme");
    expect(button).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(button);

    expect(document.documentElement.dataset.theme).toBe("charcoal");
    expect(button).toHaveAttribute("aria-label", "Switch to soft light theme");
  });

  it("persists the chosen theme to localStorage", () => {
    render(<Header title="Dashboard" />);
    const button = screen.getByTestId("chrome-theme-toggle");
    fireEvent.click(button);
    expect(localStorage.getItem("theme")).toBe("soft-light");
    fireEvent.click(button);
    expect(localStorage.getItem("theme")).toBe("charcoal");
    expect(localStorage.getItem("theme-last-dark")).toBe("charcoal");
  });
});
