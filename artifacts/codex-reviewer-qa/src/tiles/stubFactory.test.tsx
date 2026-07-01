import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { makeStubTile } from "./stubFactory";

describe("makeStubTile", () => {
  it("renders planned placeholder with category", () => {
    const el = makeStubTile({
      id: "stormwater",
      label: "Stormwater / Detention",
      category: "Site Analysis",
      status: "planned",
    });
    render(el());
    expect(screen.getByTestId("planned-tile-stormwater")).toBeTruthy();
    expect(screen.getByText(/Planned — not yet built/i)).toBeTruthy();
    expect(screen.getByText("Site Analysis")).toBeTruthy();
  });

  it("renders degraded banner with disabled run button", () => {
    const el = makeStubTile({
      id: "precedence",
      label: "Precedence Engine",
      category: "Compliance",
      status: "degraded",
      degradedReason: "Production gate not activated.",
    });
    render(el());
    expect(screen.getByTestId("tile-status-banner")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run" })).toHaveProperty(
      "disabled",
      true,
    );
  });
});
