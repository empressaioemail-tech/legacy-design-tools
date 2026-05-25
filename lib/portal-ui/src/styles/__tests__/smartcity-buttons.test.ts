import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import "@workspace/portal-ui/styles";

describe("sc-btn icon+label alignment", () => {
  it("applies inline-flex centering on outlined ghost buttons", () => {
    render(
      <button type="button" className="sc-btn-ghost sc-btn-sm">
        <span aria-hidden="true">↗</span>
        Open map
      </button>,
    );
    const btn = screen.getByRole("button", { name: /open map/i });
    const style = getComputedStyle(btn);
    expect(style.display).toBe("inline-flex");
    expect(style.alignItems).toBe("center");
  });
});
