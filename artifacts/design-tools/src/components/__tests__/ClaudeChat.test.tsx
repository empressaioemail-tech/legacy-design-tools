/**
 * ClaudeChat — input + send wiring, disabled-state when no snapshot, and
 * collapsed-pane render branch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const sendMessage = vi.hoisted(() => vi.fn());
const toggleRight = vi.hoisted(() => vi.fn());
const toggleFocusSnapshot = vi.hoisted(() => vi.fn());
const clearFocusSnapshots = vi.hoisted(() => vi.fn());
const stores = vi.hoisted(() => ({
  messagesByEngagement: {} as Record<string, Array<{ role: string; content: string; snapshotFocusIds?: string[] }>>,
  attachedSheetsByEngagement: {} as Record<string, unknown[]>,
  pendingChatInputByEngagement: {} as Record<string, string>,
  focusSnapshotIdsByEngagement: {} as Record<string, string[]>,
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
      focusSnapshotIdsByEngagement: stores.focusSnapshotIdsByEngagement,
      streaming: stores.streaming,
      sendMessage,
      detachSheet: vi.fn(),
      clearAttachedSheets: vi.fn(),
      toggleFocusSnapshot,
      clearFocusSnapshots,
      consumePendingChatInput: () => null,
    }),
}));

vi.mock("@workspace/portal-ui", () => ({
  useSidebarState: <U,>(sel: (s: Record<string, unknown>) => U): U =>
    sel({ rightCollapsed: stores.rightCollapsed, toggleRight }),
}));

const { ClaudeChat } = await import("../ClaudeChat");

describe("ClaudeChat", () => {
  beforeEach(() => {
    sendMessage.mockClear();
    toggleFocusSnapshot.mockClear();
    clearFocusSnapshots.mockClear();
    stores.streaming = false;
    stores.rightCollapsed = false;
    stores.messagesByEngagement = {};
    stores.focusSnapshotIdsByEngagement = {};
  });

  it("calls sendMessage with the typed input when Send is clicked (snapshot present)", () => {
    render(<ClaudeChat engagementId="eng-1" hasSnapshots={true} />);
    const textarea = screen.getByPlaceholderText(/Ask a question/i);
    fireEvent.change(textarea, { target: { value: "what is the IBC?" } });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/i }));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("eng-1", "what is the IBC?", {
      snapshotFocus: false,
    });
    // Input cleared after send.
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("forwards snapshotFocus=true when the Dive deeper toggle is on, and resets it after send", () => {
    sendMessage.mockClear();
    stores.streaming = false;
    stores.rightCollapsed = false;
    stores.messagesByEngagement = {};

    render(<ClaudeChat engagementId="eng-1" hasSnapshots={true} />);
    const toggle = screen.getByRole("button", {
      name: /Dive deeper into the latest snapshot/i,
    });
    // Off by default.
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    const textarea = screen.getByPlaceholderText(/Ask a question/i);
    fireEvent.change(textarea, { target: { value: "area of room 204?" } });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/i }));

    expect(sendMessage).toHaveBeenCalledWith("eng-1", "area of room 204?", {
      snapshotFocus: true,
    });
    // Resets per turn so follow-ups don't accidentally pay the focus cost.
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("disables the Dive deeper toggle when there is no snapshot", () => {
    stores.streaming = false;
    stores.rightCollapsed = false;
    render(<ClaudeChat engagementId="eng-1" hasSnapshots={false} />);
    const toggle = screen.getByRole("button", {
      name: /Dive deeper into the latest snapshot/i,
    });
    expect(toggle).toBeDisabled();
  });

  it("disables the Dive deeper toggle while a previous turn is still streaming", () => {
    stores.streaming = true;
    stores.rightCollapsed = false;
    render(<ClaudeChat engagementId="eng-1" hasSnapshots={true} />);
    const toggle = screen.getByRole("button", {
      name: /Dive deeper into the latest snapshot/i,
    });
    expect(toggle).toBeDisabled();
    stores.streaming = false;
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

  it("renders the Snapshot focus chip on user messages that opted in", () => {
    stores.streaming = false;
    stores.rightCollapsed = false;
    stores.messagesByEngagement = {
      "eng-1": [
        { role: "user", content: "with focus", snapshotFocus: true },
        { role: "assistant", content: "ok" },
        { role: "user", content: "without focus" },
        { role: "assistant", content: "ok again" },
      ] as Array<{ role: string; content: string; snapshotFocus?: boolean }>,
    };

    render(<ClaudeChat engagementId="eng-1" hasSnapshots={true} />);
    // Exactly one chip — only the first user turn was sent with focus.
    const chips = screen.getAllByText(/Snapshot focus/i);
    expect(chips).toHaveLength(1);
  });

  it("does not call sendMessage when input is whitespace only", () => {
    sendMessage.mockClear();
    stores.streaming = false;
    stores.rightCollapsed = false;
    render(<ClaudeChat engagementId="eng-1" hasSnapshots={true} />);
    const textarea = screen.getByPlaceholderText(/Ask a question/i);
    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/i }));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // ── Snapshot comparison picker ──────────────────────────────────────────

  // Build minimal SnapshotSummary fixtures. Field shape mirrors
  // lib/snapshots-types so the lookup map / display logic exercises the same
  // surface in tests as in production.
  const mkSnap = (id: string, secondsAgo: number) => ({
    id,
    engagementId: "eng-1",
    engagementName: "Test Engagement",
    projectName: "Test Project",
    sheetCount: 4,
    roomCount: 12,
    levelCount: 2,
    wallCount: 30,
    receivedAt: new Date(Date.now() - secondsAgo * 1000).toISOString(),
  });

  const SNAP_A = "aaaaaaaaaaaa1111aaaaaaaaaaaa1111";
  const SNAP_B = "bbbbbbbbbbbb2222bbbbbbbbbbbb2222";
  const SNAP_C = "cccccccccccc3333cccccccccccc3333";

  it("toggles the comparison picker open and lists every available snapshot", () => {
    const snapshots = [mkSnap(SNAP_A, 60), mkSnap(SNAP_B, 600), mkSnap(SNAP_C, 6000)];
    render(
      <ClaudeChat
        engagementId="eng-1"
        hasSnapshots={true}
        snapshots={snapshots}
      />,
    );
    // Closed by default — no picker region rendered.
    expect(screen.queryByRole("region", { name: /Compare snapshots/i })).toBeNull();

    const compareBtn = screen.getByRole("button", { name: /Compare past snapshots/i });
    fireEvent.click(compareBtn);

    expect(
      screen.getByRole("region", { name: /Compare snapshots/i }),
    ).toBeInTheDocument();
    // One row per snapshot.
    expect(screen.getByTestId(`snapshot-picker-row-${SNAP_A}`)).toBeInTheDocument();
    expect(screen.getByTestId(`snapshot-picker-row-${SNAP_B}`)).toBeInTheDocument();
    expect(screen.getByTestId(`snapshot-picker-row-${SNAP_C}`)).toBeInTheDocument();
  });

  it("disables the Compare button when there are no snapshots to pick from", () => {
    render(<ClaudeChat engagementId="eng-1" hasSnapshots={true} snapshots={[]} />);
    expect(
      screen.getByRole("button", { name: /Compare past snapshots/i }),
    ).toBeDisabled();
  });

  it("delegates checkbox ticks to the store via toggleFocusSnapshot", () => {
    const snapshots = [mkSnap(SNAP_A, 60), mkSnap(SNAP_B, 600)];
    render(
      <ClaudeChat
        engagementId="eng-1"
        hasSnapshots={true}
        snapshots={snapshots}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Compare past snapshots/i }));

    const row = screen.getByTestId(`snapshot-picker-row-${SNAP_A}`);
    const checkbox = row.querySelector("input[type=checkbox]") as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(toggleFocusSnapshot).toHaveBeenCalledWith("eng-1", SNAP_A);
  });

  it("forwards staged snapshotFocusIds on send and clears them after dispatch", () => {
    stores.focusSnapshotIdsByEngagement = { "eng-1": [SNAP_A, SNAP_B] };
    render(
      <ClaudeChat
        engagementId="eng-1"
        hasSnapshots={true}
        snapshots={[mkSnap(SNAP_A, 60), mkSnap(SNAP_B, 600)]}
      />,
    );

    // Compare button surfaces a count badge whenever ids are staged.
    expect(
      screen.getByRole("button", { name: /Compare past snapshots/i }),
    ).toHaveTextContent(/Compare\s*\(2\)/i);

    const textarea = screen.getByPlaceholderText(/Ask a question/i);
    fireEvent.change(textarea, { target: { value: "what changed?" } });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/i }));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("eng-1", "what changed?", {
      snapshotFocus: false,
      snapshotFocusIds: [SNAP_A, SNAP_B],
    });
    // Clearing the staged ids is part of the same UI turn so the next
    // follow-up doesn't accidentally re-compare.
    expect(clearFocusSnapshots).toHaveBeenCalledWith("eng-1");
  });

  it("renders a Comparing N pushes chip on user messages that staged snapshotFocusIds", () => {
    stores.messagesByEngagement = {
      "eng-1": [
        {
          role: "user",
          content: "diff please",
          snapshotFocusIds: [SNAP_A, SNAP_B],
        },
        { role: "assistant", content: "ok" },
        { role: "user", content: "no compare" },
      ] as Array<{ role: string; content: string; snapshotFocusIds?: string[] }>,
    };
    render(<ClaudeChat engagementId="eng-1" hasSnapshots={true} />);
    expect(screen.getByText(/Comparing 2 pushes/i)).toBeInTheDocument();
  });

  it("renders snapshot citation chips across multiple paragraphs (regex lastIndex regression)", () => {
    // Repro for a stateful-regex bug: the module-scoped /g regexes used to
    // be precheck-tested with `.test`, which advances `lastIndex` and made
    // the *second* (and later) paragraphs randomly miss their snapshot
    // token. Using two paragraphs forces ReactMarkdown to invoke
    // renderWithAtomChips multiple times in a single render pass.
    stores.messagesByEngagement = {
      "eng-1": [
        { role: "user", content: "compare" },
        {
          role: "assistant",
          content: `First paragraph cites {{atom|snapshot|${SNAP_A}|focus}}.\n\nSecond paragraph cites {{atom|snapshot|${SNAP_B}|focus}} too.\n\nThird paragraph cites {{atom|snapshot|${SNAP_C}|focus}} as well.`,
        },
      ] as Array<{ role: string; content: string }>,
    };
    render(
      <ClaudeChat
        engagementId="eng-1"
        hasSnapshots={true}
        snapshots={[
          mkSnap(SNAP_A, 60),
          mkSnap(SNAP_B, 600),
          mkSnap(SNAP_C, 6000),
        ]}
      />,
    );
    // Every snapshot marker, regardless of paragraph order, must render
    // as a chip — none should leak through as raw text.
    expect(screen.getByTestId(`snapshot-citation-${SNAP_A}`)).toBeInTheDocument();
    expect(screen.getByTestId(`snapshot-citation-${SNAP_B}`)).toBeInTheDocument();
    expect(screen.getByTestId(`snapshot-citation-${SNAP_C}`)).toBeInTheDocument();
    expect(screen.queryByText(/\{\{atom\|snapshot\|/)).toBeNull();
  });

  it("renders {{atom|snapshot|<id>|focus}} markers as snapshot citation chips", () => {
    stores.messagesByEngagement = {
      "eng-1": [
        { role: "user", content: "compare" },
        {
          role: "assistant",
          content: `Per {{atom|snapshot|${SNAP_A}|focus}} the wall count rose from 12 to {{atom|snapshot|${SNAP_B}|focus}}.`,
        },
      ] as Array<{ role: string; content: string }>,
    };
    render(
      <ClaudeChat
        engagementId="eng-1"
        hasSnapshots={true}
        snapshots={[mkSnap(SNAP_A, 120), mkSnap(SNAP_B, 7200)]}
      />,
    );
    // Both citation tokens become interactive chips with stable testids.
    expect(screen.getByTestId(`snapshot-citation-${SNAP_A}`)).toBeInTheDocument();
    expect(screen.getByTestId(`snapshot-citation-${SNAP_B}`)).toBeInTheDocument();
    // The raw token must not leak into the rendered DOM.
    expect(
      screen.queryByText(/\{\{atom\|snapshot\|/),
    ).toBeNull();
  });

  it("links snapshot citation chips to the compare view when the preceding user turn focused 2+ snapshots", () => {
    // Task #54: when the user pinned a multi-snapshot compare on the
    // preceding turn, every chip in the assistant reply should deep-link
    // to /engagements/<id>/compare?a=<chip-id>&b=<other-id> so a click
    // takes the engineer straight to a side-by-side diff. Single-focus
    // turns (and orphan citations) fall back to the engagement detail
    // page so we never break navigation.
    stores.messagesByEngagement = {
      "eng-1": [
        {
          role: "user",
          content: "diff",
          snapshotFocusIds: [SNAP_A, SNAP_B],
        },
        {
          role: "assistant",
          content: `Compared {{atom|snapshot|${SNAP_A}|focus}} vs {{atom|snapshot|${SNAP_B}|focus}}.`,
        },
      ] as Array<{ role: string; content: string; snapshotFocusIds?: string[] }>,
    };
    render(
      <ClaudeChat
        engagementId="eng-1"
        hasSnapshots={true}
        snapshots={[mkSnap(SNAP_A, 60), mkSnap(SNAP_B, 600)]}
      />,
    );
    const chipA = screen.getByTestId(`snapshot-citation-${SNAP_A}`);
    const chipB = screen.getByTestId(`snapshot-citation-${SNAP_B}`);
    // Each chip pins itself as `a` and the *other* picked id as `b`,
    // so symmetric clicks stay coherent: clicking A flips a/b vs B.
    expect(chipA.tagName).toBe("A");
    expect(chipA.getAttribute("href")).toMatch(
      new RegExp(`engagements/eng-1/compare\\?a=${SNAP_A}&b=${SNAP_B}$`),
    );
    expect(chipB.getAttribute("href")).toMatch(
      new RegExp(`engagements/eng-1/compare\\?a=${SNAP_B}&b=${SNAP_A}$`),
    );
  });

  it("falls back to the engagement detail href when only one snapshot is in focus", () => {
    // Single-focus turns have nothing to compare against, so the chip
    // routes back to the engagement detail (where the latest snapshot
    // lives). Also exercises the no-focus-ids fallback for older
    // assistant replies that predate the compare feature.
    stores.messagesByEngagement = {
      "eng-1": [
        {
          role: "user",
          content: "summarize",
          snapshotFocusIds: [SNAP_A],
        },
        {
          role: "assistant",
          content: `See {{atom|snapshot|${SNAP_A}|focus}}.`,
        },
      ] as Array<{ role: string; content: string; snapshotFocusIds?: string[] }>,
    };
    render(
      <ClaudeChat
        engagementId="eng-1"
        hasSnapshots={true}
        snapshots={[mkSnap(SNAP_A, 60)]}
      />,
    );
    const chip = screen.getByTestId(`snapshot-citation-${SNAP_A}`);
    expect(chip.tagName).toBe("A");
    expect(chip.getAttribute("href")).toMatch(/engagements\/eng-1$/);
    expect(chip.getAttribute("href")).not.toContain("compare");
  });
});
