/**
 * CitationChip — the inline `CodeAtomChip` rendered by ClaudeChat when an
 * assistant message contains `[[CODE:atomId]]` markers. The chip is not
 * exported on its own, so this test renders ClaudeChat with a stubbed
 * assistant message and asserts the resulting anchor.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const stores = vi.hoisted(() => ({
  messagesByEngagement: { "e1": [] as Array<{ role: string; content: string }> },
  attachedSheetsByEngagement: {} as Record<string, unknown[]>,
  pendingChatInputByEngagement: {} as Record<string, string>,
  streaming: false,
  rightCollapsed: false,
}));

function makeStore<T extends Record<string, unknown>>(state: T) {
  // Mimic zustand's selector-style hook signature.
  return <U,>(sel: (s: T) => U): U => sel(state);
}

vi.mock("../../store/engagements", () => ({
  useEngagementsStore: makeStore({
    messagesByEngagement: stores.messagesByEngagement,
    attachedSheetsByEngagement: stores.attachedSheetsByEngagement,
    pendingChatInputByEngagement: stores.pendingChatInputByEngagement,
    streaming: stores.streaming,
    sendMessage: vi.fn(),
    detachSheet: vi.fn(),
    clearAttachedSheets: vi.fn(),
    consumePendingChatInput: () => null,
  }),
}));

vi.mock("@workspace/portal-ui", () => ({
  useSidebarState: makeStore({
    rightCollapsed: stores.rightCollapsed,
    toggleRight: vi.fn(),
  }),
}));

const { ClaudeChat } = await import("../ClaudeChat");

describe("CitationChip (CodeAtomChip rendered inside ClaudeChat)", () => {
  it("renders an anchor with the truncated atom id when an assistant message contains a [[CODE:uuid]] marker", () => {
    const atomId = "deadbeef-1234-5678-9abc-def012345678";
    stores.messagesByEngagement["e1"] = [
      { role: "assistant", content: `See this rule [[CODE:${atomId}]] please.` },
    ];

    render(<ClaudeChat engagementId="e1" hasSnapshots={true} />);

    const link = screen.getByTitle(`Open atom ${atomId} in Code Library`);
    expect(link).toBeInTheDocument();
    expect(link.tagName).toBe("A");
    // href encodes the atom id as a query param against the code-library route.
    expect(link.getAttribute("href")).toContain(`atom=${atomId}`);
    // Visible label uses the first 8 chars of the id (the "short" prefix).
    expect(link.textContent).toMatch(/CODE.deadbeef/);
  });

  it("ignores tokens whose ids are too short (regex requires 8+ hex chars)", () => {
    stores.messagesByEngagement["e1"] = [
      { role: "assistant", content: "Bad token [[CODE:abc]] should be plain text." },
    ];
    render(<ClaudeChat engagementId="e1" hasSnapshots={true} />);
    expect(screen.queryByTitle(/Open atom abc/)).toBeNull();
    // The literal text should still render somewhere in the DOM.
    expect(screen.getByText(/Bad token/)).toBeInTheDocument();
  });

  it("does not render any chip when the message has no markers", () => {
    stores.messagesByEngagement["e1"] = [
      { role: "assistant", content: "Plain assistant reply." },
    ];
    render(<ClaudeChat engagementId="e1" hasSnapshots={true} />);
    expect(screen.queryByText(/CODE\u00B7/)).toBeNull();
  });
});
