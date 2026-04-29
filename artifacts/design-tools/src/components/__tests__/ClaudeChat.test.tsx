/**
 * ClaudeChat — input + send wiring, disabled-state when no snapshot, and
 * collapsed-pane render branch.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const sendMessage = vi.hoisted(() => vi.fn());
const toggleRight = vi.hoisted(() => vi.fn());
const stores = vi.hoisted(() => ({
  messagesByEngagement: {} as Record<string, Array<{ role: string; content: string }>>,
  attachedSheetsByEngagement: {} as Record<string, unknown[]>,
  pendingChatInputByEngagement: {} as Record<string, string>,
  streaming: false,
  rightCollapsed: false,
}));

vi.mock("../../store/engagements", () => ({
  useEngagementsStore: <U,>(
    sel: (s: Record<string, unknown>) => U,
  ): U =>
    sel({
      messagesByEngagement: stores.messagesByEngagement,
      attachedSheetsByEngagement: stores.attachedSheetsByEngagement,
      pendingChatInputByEngagement: stores.pendingChatInputByEngagement,
      streaming: stores.streaming,
      sendMessage,
      detachSheet: vi.fn(),
      clearAttachedSheets: vi.fn(),
      consumePendingChatInput: () => null,
    }),
}));

vi.mock("@workspace/portal-ui", () => ({
  useSidebarState: <U,>(sel: (s: Record<string, unknown>) => U): U =>
    sel({ rightCollapsed: stores.rightCollapsed, toggleRight }),
}));

const { ClaudeChat } = await import("../ClaudeChat");

describe("ClaudeChat", () => {
  it("calls sendMessage with the typed input when Send is clicked (snapshot present)", () => {
    sendMessage.mockClear();
    stores.streaming = false;
    stores.rightCollapsed = false;
    stores.messagesByEngagement = {};

    render(<ClaudeChat engagementId="eng-1" hasSnapshots={true} />);
    const textarea = screen.getByPlaceholderText(/Ask a question/i);
    fireEvent.change(textarea, { target: { value: "what is the IBC?" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/i }));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("eng-1", "what is the IBC?");
    // Input cleared after send.
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("disables the Send button when hasSnapshots is false and shows the snapshot-required placeholder", () => {
    sendMessage.mockClear();
    stores.streaming = false;
    stores.rightCollapsed = false;

    render(<ClaudeChat engagementId="eng-1" hasSnapshots={false} />);
    const send = screen.getByRole("button", { name: /Send/i });
    expect(send).toBeDisabled();
    expect(
      screen.getByPlaceholderText(/Send a snapshot from Revit first/i),
    ).toBeInTheDocument();
  });

  it("renders the collapsed-rail layout (only the expand button) when rightCollapsed is true", () => {
    stores.rightCollapsed = true;
    render(<ClaudeChat engagementId="eng-1" hasSnapshots={true} />);
    expect(
      screen.getByRole("button", { name: /Expand Claude/i }),
    ).toBeInTheDocument();
    // No textarea in the collapsed state.
    expect(screen.queryByPlaceholderText(/Ask a question/i)).toBeNull();
  });

  it("does not call sendMessage when input is whitespace only", () => {
    sendMessage.mockClear();
    stores.streaming = false;
    stores.rightCollapsed = false;
    render(<ClaudeChat engagementId="eng-1" hasSnapshots={true} />);
    const textarea = screen.getByPlaceholderText(/Ask a question/i);
    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /Send/i }));
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
