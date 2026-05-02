/**
 * RenderCard regression coverage. Pins the presentational contract
 * the gallery + reviewer strip both rely on: status pill, kind label,
 * primary preview when ready, cancel affordance gating, and the
 * elevation-set 4-cell grid.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RenderCard } from "../RenderCard";
import {
  fixtureFailedStillDetail,
  fixtureReadyStill,
  fixtureReadyStillDetail,
  fixtureRenderingStill,
  fixtureElevationSetDetail,
} from "../../test-utils/renderFixtures";

afterEach(() => cleanup());

describe("RenderCard", () => {
  it("renders the status pill, kind label, and relative timestamp for a slim list item", () => {
    render(<RenderCard render={fixtureRenderingStill} />);
    const card = screen.getByTestId(`render-card-${fixtureRenderingStill.id}`);
    expect(card).toHaveAttribute("data-render-status", "rendering");
    expect(card).toHaveAttribute("data-render-kind", "still");
    expect(screen.getByTestId("render-status-pill")).toHaveTextContent(
      /Rendering/i,
    );
    expect(card).toHaveTextContent("Still");
  });

  it("shows the primary preview + download link wired to the durable file endpoint when ready", () => {
    render(<RenderCard render={fixtureReadyStillDetail} />);
    const output = fixtureReadyStillDetail.outputs[0];
    const preview = screen.getByTestId(`render-primary-preview-${output.id}`);
    expect(preview).toBeInTheDocument();
    const img = preview.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", output.previewUrl!);
    const download = screen.getByTestId(`render-download-${output.id}`);
    expect(download).toHaveAttribute("href", output.downloadUrl!);
  });

  it("renders a placeholder tile when the render is in flight (no preview yet)", () => {
    render(<RenderCard render={fixtureRenderingStill} />);
    const card = screen.getByTestId(`render-card-${fixtureRenderingStill.id}`);
    expect(card).toHaveTextContent(/awaiting render/i);
    expect(
      card.querySelector('[data-testid^="render-primary-preview-"]'),
    ).toBeNull();
  });

  it("renders the failure error message inline when status is failed", () => {
    render(<RenderCard render={fixtureFailedStillDetail} />);
    const err = screen.getByTestId(
      `render-error-${fixtureFailedStillDetail.id}`,
    );
    expect(err).toHaveTextContent("mnml.ai quota exceeded");
  });

  it("hides the cancel affordance when the render is in a terminal state", () => {
    const onCancel = vi.fn();
    render(
      <RenderCard
        render={fixtureReadyStill}
        canCancel
        onCancel={onCancel}
      />,
    );
    expect(
      screen.queryByTestId(`render-cancel-${fixtureReadyStill.id}`),
    ).not.toBeInTheDocument();
  });

  it("hides the cancel affordance when canCancel is false even on an in-flight render", () => {
    render(
      <RenderCard
        render={fixtureRenderingStill}
        canCancel={false}
        onCancel={() => {}}
      />,
    );
    expect(
      screen.queryByTestId(`render-cancel-${fixtureRenderingStill.id}`),
    ).not.toBeInTheDocument();
  });

  it("fires onCancel when the cancel affordance is clicked", () => {
    const onCancel = vi.fn();
    render(
      <RenderCard
        render={fixtureRenderingStill}
        canCancel
        onCancel={onCancel}
      />,
    );
    fireEvent.click(
      screen.getByTestId(`render-cancel-${fixtureRenderingStill.id}`),
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("renders the four cardinal cells for an elevation-set detail", () => {
    render(<RenderCard render={fixtureElevationSetDetail} />);
    const grid = screen.getByTestId(
      `render-elevation-grid-${fixtureElevationSetDetail.id}`,
    );
    expect(grid).toBeInTheDocument();
    for (const role of [
      "elevation-n",
      "elevation-e",
      "elevation-s",
      "elevation-w",
    ] as const) {
      expect(
        screen.getByTestId(
          `render-elevation-cell-${fixtureElevationSetDetail.id}-${role}`,
        ),
      ).toBeInTheDocument();
    }
    // The ready north cell exposes a download link wired to the file endpoint.
    const northDownload = screen.getByTestId(
      `render-elevation-download-${fixtureElevationSetDetail.id}-elevation-n`,
    );
    expect(northDownload).toHaveAttribute(
      "href",
      "/api/render-outputs/output-elev-n/file?download=1",
    );
    // The pending-trigger west cell does NOT.
    expect(
      screen.queryByTestId(
        `render-elevation-download-${fixtureElevationSetDetail.id}-elevation-w`,
      ),
    ).not.toBeInTheDocument();
  });

  it("disables the cancel button while cancelPending is true", () => {
    render(
      <RenderCard
        render={fixtureRenderingStill}
        canCancel
        onCancel={() => {}}
        cancelPending
      />,
    );
    const btn = screen.getByTestId(
      `render-cancel-${fixtureRenderingStill.id}`,
    ) as HTMLButtonElement;
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent(/cancelling/i);
  });

  it("surfaces the cancelError below the card when supplied", () => {
    render(
      <RenderCard
        render={fixtureRenderingStill}
        canCancel
        onCancel={() => {}}
        cancelError="This render is already in a terminal state and cannot be cancelled."
      />,
    );
    const err = screen.getByTestId(
      `render-cancel-error-${fixtureRenderingStill.id}`,
    );
    expect(err).toHaveAttribute("role", "alert");
    expect(err).toHaveTextContent(/already in a terminal state/i);
  });
});
