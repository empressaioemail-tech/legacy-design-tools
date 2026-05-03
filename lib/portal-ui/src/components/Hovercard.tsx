/**
 * `Hovercard` — Track 1 / addendum D3.
 *
 * Minimal CSS-only hovercard primitive used by the Inbox triage
 * strip's applicant-history pill. Opens on hover OR keyboard focus
 * (a11y), closes on leave OR blur, with a 200ms enter/exit. Built
 * because no shared HoverCard / Tooltip / Popover primitive exists
 * in lib/portal-ui — see SC's recon (dispatch addendum D3). Reusable
 * for Tracks 4/5/7 later.
 *
 * Positioning is CSS-only (relative to the trigger). The four
 * placements use absolute-position + transform; no portal, no
 * collision-avoidance. Callers that need fancier positioning can
 * pick a placement that suits their context — every existing Track 1
 * call site renders inside a card with enough room.
 */
import { useId, useState } from "react";
import "../styles/hovercard.css";

export type HovercardPlacement = "top" | "bottom" | "left" | "right";

export interface HovercardProps {
  /** The interactive element the user hovers / focuses. */
  trigger: React.ReactNode;
  /** The hovercard body content. */
  children: React.ReactNode;
  /** Position relative to the trigger. Defaults to `bottom`. */
  placement?: HovercardPlacement;
  /**
   * Defaults to 200ms — D3 spec. Affects both the open and close
   * transition; not the appearance delay (the open is immediate on
   * mouse-enter / focus and the CSS transition handles fade-in).
   */
  transitionMs?: number;
  /** Width of the popover surface. Defaults to 280. */
  width?: number | string;
  "data-testid"?: string;
}

export function Hovercard({
  trigger,
  children,
  placement = "bottom",
  transitionMs = 200,
  width = 280,
  "data-testid": testId = "hovercard",
}: HovercardProps) {
  const generated = useId();
  const popoverId = `${testId}-popover-${generated}`;
  const [open, setOpen] = useState(false);

  return (
    <span
      className="sc-hovercard"
      data-testid={testId}
      data-open={open ? "true" : "false"}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      style={{ position: "relative", display: "inline-block" }}
    >
      <span
        aria-describedby={open ? popoverId : undefined}
        tabIndex={0}
        style={{ outline: "none" }}
      >
        {trigger}
      </span>
      <span
        id={popoverId}
        role="tooltip"
        data-testid={`${testId}-popover`}
        data-placement={placement}
        aria-hidden={!open}
        className={`sc-hovercard-popover sc-hovercard-popover-${placement}`}
        style={{
          width,
          opacity: open ? 1 : 0,
          visibility: open ? "visible" : "hidden",
          transition: `opacity ${transitionMs}ms ease, visibility 0s linear ${
            open ? 0 : transitionMs
          }ms`,
          pointerEvents: open ? "auto" : "none",
        }}
      >
        {children}
      </span>
    </span>
  );
}
