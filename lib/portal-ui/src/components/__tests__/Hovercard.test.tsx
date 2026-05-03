/**
 * `Hovercard` — Track 1 / addendum D3.
 *
 * Pins the four primitives the Inbox triage strip relies on:
 *  - mouseenter opens the popover; mouseleave closes it,
 *  - focus opens the popover (keyboard a11y); blur closes it,
 *  - the open/close state is exposed on `data-open` so surface
 *    tests can assert visibility without inspecting CSS,
 *  - a custom `placement` prop maps to a `data-placement` attribute
 *    on the popover so a future change can't silently re-anchor
 *    every consumer.
 */

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Hovercard } from "../Hovercard";

describe("Hovercard", () => {
  it("starts closed and opens on mouseenter", () => {
    render(
      <Hovercard
        trigger={<button type="button">Trigger</button>}
        data-testid="test-hc"
      >
        <div>Tooltip body</div>
      </Hovercard>,
    );
    const root = screen.getByTestId("test-hc");
    expect(root).toHaveAttribute("data-open", "false");
    fireEvent.mouseEnter(root);
    expect(root).toHaveAttribute("data-open", "true");
  });

  it("closes on mouseleave", () => {
    render(
      <Hovercard
        trigger={<button type="button">Trigger</button>}
        data-testid="test-hc"
      >
        <div>Tooltip body</div>
      </Hovercard>,
    );
    const root = screen.getByTestId("test-hc");
    fireEvent.mouseEnter(root);
    expect(root).toHaveAttribute("data-open", "true");
    fireEvent.mouseLeave(root);
    expect(root).toHaveAttribute("data-open", "false");
  });

  it("opens on focus and closes on blur (keyboard a11y)", () => {
    render(
      <Hovercard
        trigger={<button type="button">Trigger</button>}
        data-testid="test-hc"
      >
        <div>Tooltip body</div>
      </Hovercard>,
    );
    const root = screen.getByTestId("test-hc");
    fireEvent.focus(root);
    expect(root).toHaveAttribute("data-open", "true");
    fireEvent.blur(root);
    expect(root).toHaveAttribute("data-open", "false");
  });

  it("renders the popover with role='tooltip' and aria-describedby wired when open", () => {
    render(
      <Hovercard
        trigger={<button type="button">Trigger</button>}
        data-testid="test-hc"
      >
        <div data-testid="body">Tooltip body</div>
      </Hovercard>,
    );
    const root = screen.getByTestId("test-hc");
    fireEvent.mouseEnter(root);
    const popover = screen.getByTestId("test-hc-popover");
    expect(popover).toHaveAttribute("role", "tooltip");
    expect(popover).toHaveAttribute("aria-hidden", "false");
    // The trigger is wrapped in an inner span so screen readers can
    // associate it with the open popover via aria-describedby — check
    // the id-pointer wiring without depending on the generated id.
    const triggerWrap = root.firstElementChild as HTMLElement;
    expect(triggerWrap.getAttribute("aria-describedby")).toBe(popover.id);
  });

  it("aria-hidden stays true while the popover is closed (so screen readers ignore stale content)", () => {
    render(
      <Hovercard
        trigger={<button type="button">Trigger</button>}
        data-testid="test-hc"
      >
        <div>Tooltip body</div>
      </Hovercard>,
    );
    const popover = screen.getByTestId("test-hc-popover");
    expect(popover).toHaveAttribute("aria-hidden", "true");
    expect(popover.style.visibility).toBe("hidden");
    expect(popover.style.pointerEvents).toBe("none");
  });

  it("forwards the placement prop to a data-placement attribute on the popover", () => {
    render(
      <Hovercard
        trigger={<span>Trigger</span>}
        placement="right"
        data-testid="test-hc"
      >
        <div>Tooltip body</div>
      </Hovercard>,
    );
    const popover = screen.getByTestId("test-hc-popover");
    expect(popover).toHaveAttribute("data-placement", "right");
    expect(
      popover.classList.contains("sc-hovercard-popover-right"),
    ).toBe(true);
  });
});
