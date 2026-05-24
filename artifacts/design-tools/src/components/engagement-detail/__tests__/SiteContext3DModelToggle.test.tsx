import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SiteContext3DModelToggle } from "../SiteContext3DModelToggle";

describe("SiteContext3DModelToggle", () => {
  it("renders nothing when onToggleShowBuilding is omitted", () => {
    const { container } = render(
      <SiteContext3DModelToggle buildingGlbUrl="https://example.com/b.glb" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("disables the switch when no GLB URL is available", () => {
    render(
      <SiteContext3DModelToggle
        buildingGlbUrl={null}
        showBuilding={false}
        onToggleShowBuilding={vi.fn()}
      />,
    );
    const toggle = screen.getByTestId("site-context-3d-model-toggle");
    expect(toggle).toHaveAttribute(
      "title",
      "No BIM model yet — push briefing to Revit to enable 3D model overlay.",
    );
    expect(screen.getByTestId("site-context-3d-model-switch")).toBeDisabled();
  });

  it("calls onToggleShowBuilding when the switch is flipped", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <SiteContext3DModelToggle
        buildingGlbUrl="https://example.com/b.glb"
        showBuilding={false}
        onToggleShowBuilding={onToggle}
      />,
    );
    await user.click(screen.getByTestId("site-context-3d-model-switch"));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("surfaces loading and error copy on the label", () => {
    const { rerender } = render(
      <SiteContext3DModelToggle
        buildingGlbUrl="https://example.com/b.glb"
        showBuilding
        buildingState="loading"
        onToggleShowBuilding={vi.fn()}
      />,
    );
    expect(screen.getByTestId("site-context-3d-model-toggle")).toHaveAttribute(
      "data-state",
      "loading",
    );
    expect(screen.getByText(/3D model · Loading…/)).toBeInTheDocument();

    rerender(
      <SiteContext3DModelToggle
        buildingGlbUrl="https://example.com/b.glb"
        showBuilding
        buildingState="error"
        onToggleShowBuilding={vi.fn()}
      />,
    );
    expect(screen.getByTestId("site-context-3d-model-toggle")).toHaveAttribute(
      "data-state",
      "error",
    );
    expect(screen.getByText(/3D model · Load failed/)).toBeInTheDocument();
  });
});
