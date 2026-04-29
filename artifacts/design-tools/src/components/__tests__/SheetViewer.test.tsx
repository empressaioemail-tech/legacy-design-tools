/**
 * SheetViewer — null-sheet branch, header content, close handlers
 * (button + Escape key), and the "Ask Claude about this sheet" callback.
 *
 * react-zoom-pan-pinch is stubbed because its viewport math depends on
 * layout APIs happy-dom does not implement, and is not the unit under test.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import type { SheetSummary } from "@workspace/api-client-react";

vi.mock("react-zoom-pan-pinch", () => ({
  TransformWrapper: ({ children }: { children: ReactNode }) => <>{children}</>,
  TransformComponent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const { SheetViewer } = await import("../SheetViewer");

function mkSheet(over: Partial<SheetSummary> & Pick<SheetSummary, "id">): SheetSummary {
  return {
    id: over.id,
    snapshotId: over.snapshotId ?? "snap-1",
    sheetNumber: over.sheetNumber ?? "A1.0",
    sheetName: over.sheetName ?? "First Floor Plan",
    width: 1024,
    height: 768,
    hasFull: true,
    hasThumb: true,
    receivedAt: new Date().toISOString(),
  } as SheetSummary;
}

describe("SheetViewer", () => {
  it("renders nothing when the sheet prop is null", () => {
    const { container } = render(
      <SheetViewer sheet={null} onClose={vi.fn()} onAskClaude={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a dialog with the sheet number and name in the header", () => {
    render(
      <SheetViewer
        sheet={mkSheet({ id: "s1" })}
        onClose={vi.fn()}
        onAskClaude={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("A1.0")).toBeInTheDocument();
    expect(screen.getByText("First Floor Plan")).toBeInTheDocument();
  });

  it("invokes onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(
      <SheetViewer
        sheet={mkSheet({ id: "s1" })}
        onClose={onClose}
        onAskClaude={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText(/Close sheet viewer/i));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("invokes onClose when Escape is pressed at the window level", () => {
    const onClose = vi.fn();
    render(
      <SheetViewer
        sheet={mkSheet({ id: "s1" })}
        onClose={onClose}
        onAskClaude={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("invokes onAskClaude with the current sheet when 'Ask Claude' is clicked", () => {
    const onAskClaude = vi.fn();
    const sheet = mkSheet({ id: "s1" });
    render(
      <SheetViewer
        sheet={sheet}
        onClose={vi.fn()}
        onAskClaude={onAskClaude}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Ask Claude about this sheet/i }),
    );
    expect(onAskClaude).toHaveBeenCalledTimes(1);
    expect(onAskClaude).toHaveBeenCalledWith(sheet);
  });
});
