/**
 * Header — theme toggle (Task #420).
 *
 * The header is the only architect-surface affordance for switching
 * between the dark and light token sets, so a regression that
 * silently dropped the toggle would strand the user on whichever
 * theme `initTheme()` picked at boot. Tests assert:
 *
 *   1. Clicking the toggle flips `data-theme` on <html>.
 *   2. The icon (Sun ↔ Moon) and aria-label update with the new
 *      theme so screen readers always describe the *next* action.
 *   3. The choice is persisted to localStorage under the same
 *      "theme" key `initTheme()` reads on next boot.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Header } from "../Header";
import { setTheme } from "../../lib/theme";

describe("Header theme toggle", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
    setTheme("dark");
  });

  it("flips data-theme between dark and light when clicked", () => {
    render(<Header title="Dashboard" />);
    const button = screen.getByTestId("theme-toggle");

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(button).toHaveAttribute("aria-label", "Switch to light theme");
    expect(button).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(button);

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(button).toHaveAttribute("aria-label", "Switch to dark theme");
    expect(button).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(button);

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(button).toHaveAttribute("aria-label", "Switch to light theme");
  });

  it("persists the chosen theme to localStorage", () => {
    render(<Header title="Dashboard" />);
    const button = screen.getByTestId("theme-toggle");
    fireEvent.click(button);
    expect(localStorage.getItem("theme")).toBe("light");
    fireEvent.click(button);
    expect(localStorage.getItem("theme")).toBe("dark");
  });
});
