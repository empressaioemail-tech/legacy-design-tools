import { create } from "zustand";
import type { SheetSummary } from "@workspace/api-client-react";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  // True when this user turn was sent with the "Dive deeper" toggle on, so the
  // transcript can show a chip indicating the full snapshot payload was loaded.
  snapshotFocus?: boolean;
  // The explicit set of snapshot ids the user opted into comparing on this
  // turn (Task #48). Stored on the user message so the transcript can show a
  // "Compared N pushes" chip even after the focus picker resets.
  snapshotFocusIds?: string[];
}

interface EngagementsUiState {
  selectedSnapshotIdByEngagement: Record<string, string | null>;
  messagesByEngagement: Record<string, ChatMessage[]>;
  attachedSheetsByEngagement: Record<string, SheetSummary[]>;
  pendingChatInputByEngagement: Record<string, string>;
  // Snapshot ids the user has staged for the next comparison turn, keyed by
  // engagement (Task #48). One-shot: cleared after each successful send so
  // follow-up turns don't accidentally keep paying the focus cost.
  focusSnapshotIdsByEngagement: Record<string, string[]>;
  streaming: boolean;

  selectSnapshot: (engagementId: string, snapshotId: string | null) => void;
  attachSheet: (engagementId: string, sheet: SheetSummary) => void;
  detachSheet: (engagementId: string, sheetId: string) => void;
  clearAttachedSheets: (engagementId: string) => void;
  setPendingChatInput: (engagementId: string, value: string) => void;
  consumePendingChatInput: (engagementId: string) => string | null;
  toggleFocusSnapshot: (engagementId: string, snapshotId: string) => void;
  clearFocusSnapshots: (engagementId: string) => void;
  sendMessage: (
    engagementId: string,
    question: string,
    options?: { snapshotFocus?: boolean; snapshotFocusIds?: string[] },
  ) => Promise<void>;
}

const API_BASE = `${import.meta.env.BASE_URL}api`;

export const useEngagementsStore = create<EngagementsUiState>((set, get) => ({
  selectedSnapshotIdByEngagement: {},
  messagesByEngagement: {},
  attachedSheetsByEngagement: {},
  pendingChatInputByEngagement: {},
  focusSnapshotIdsByEngagement: {},
  streaming: false,

  selectSnapshot: (engagementId, snapshotId) =>
    set((state) => ({
      selectedSnapshotIdByEngagement: {
        ...state.selectedSnapshotIdByEngagement,
        [engagementId]: snapshotId,
      },
    })),

  attachSheet: (engagementId, sheet) =>
    set((state) => {
      const existing = state.attachedSheetsByEngagement[engagementId] ?? [];
      if (existing.some((s) => s.id === sheet.id)) return {};
      return {
        attachedSheetsByEngagement: {
          ...state.attachedSheetsByEngagement,
          [engagementId]: [...existing, sheet],
        },
      };
    }),

  detachSheet: (engagementId, sheetId) =>
    set((state) => {
      const existing = state.attachedSheetsByEngagement[engagementId] ?? [];
      return {
        attachedSheetsByEngagement: {
          ...state.attachedSheetsByEngagement,
          [engagementId]: existing.filter((s) => s.id !== sheetId),
        },
      };
    }),

  clearAttachedSheets: (engagementId) =>
    set((state) => ({
      attachedSheetsByEngagement: {
        ...state.attachedSheetsByEngagement,
        [engagementId]: [],
      },
    })),

  setPendingChatInput: (engagementId, value) =>
    set((state) => ({
      pendingChatInputByEngagement: {
        ...state.pendingChatInputByEngagement,
        [engagementId]: value,
      },
    })),

  consumePendingChatInput: (engagementId) => {
    const v = get().pendingChatInputByEngagement[engagementId] ?? null;
    if (v !== null) {
      set((state) => {
        const next = { ...state.pendingChatInputByEngagement };
        delete next[engagementId];
        return { pendingChatInputByEngagement: next };
      });
    }
    return v;
  },

  toggleFocusSnapshot: (engagementId, snapshotId) =>
    set((state) => {
      const existing =
        state.focusSnapshotIdsByEngagement[engagementId] ?? [];
      const isSelected = existing.includes(snapshotId);
      const next = isSelected
        ? existing.filter((id) => id !== snapshotId)
        : [...existing, snapshotId];
      return {
        focusSnapshotIdsByEngagement: {
          ...state.focusSnapshotIdsByEngagement,
          [engagementId]: next,
        },
      };
    }),

  clearFocusSnapshots: (engagementId) =>
    set((state) => ({
      focusSnapshotIdsByEngagement: {
        ...state.focusSnapshotIdsByEngagement,
        [engagementId]: [],
      },
    })),

  sendMessage: async (engagementId, question, options) => {
    const snapshotFocus = options?.snapshotFocus === true;
    const snapshotFocusIds = options?.snapshotFocusIds ?? [];
    set((state) => {
      const msgs = state.messagesByEngagement[engagementId] || [];
      const userMsg: ChatMessage = { role: "user", content: question };
      if (snapshotFocus) userMsg.snapshotFocus = true;
      if (snapshotFocusIds.length > 0)
        userMsg.snapshotFocusIds = [...snapshotFocusIds];
      return {
        streaming: true,
        messagesByEngagement: {
          ...state.messagesByEngagement,
          [engagementId]: [
            ...msgs,
            userMsg,
            { role: "assistant", content: "" },
          ],
        },
        // One-shot: clear staged focus snapshots as the request fires so
        // the picker resets in the UI before the response starts streaming.
        focusSnapshotIdsByEngagement: {
          ...state.focusSnapshotIdsByEngagement,
          [engagementId]: [],
        },
      };
    });

    try {
      const state = get();
      const all = state.messagesByEngagement[engagementId] || [];
      const history = all.slice(0, -2);
      const attachedSheets =
        state.attachedSheetsByEngagement[engagementId] ?? [];
      const referencedSheetIds = attachedSheets.map((s) => s.id);

      // One-shot attachment: clear before the response starts streaming so
      // the chips disappear from the UI as soon as the request is in flight.
      if (referencedSheetIds.length > 0) {
        set((s) => ({
          attachedSheetsByEngagement: {
            ...s.attachedSheetsByEngagement,
            [engagementId]: [],
          },
        }));
      }

      const res = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          engagementId,
          question,
          history,
          ...(referencedSheetIds.length > 0 ? { referencedSheetIds } : {}),
          ...(snapshotFocus ? { snapshotFocus: true } : {}),
          ...(snapshotFocusIds.length > 0 ? { snapshotFocusIds } : {}),
        }),
      });

      if (!res.ok) {
        let errMsg = `Chat error (HTTP ${res.status})`;
        try {
          const errBody = await res.json();
          if (errBody?.message) errMsg = errBody.message;
          else if (errBody?.error) errMsg = errBody.error;
        } catch {
          // body not JSON
        }
        set((state) => {
          const msgs = [...(state.messagesByEngagement[engagementId] || [])];
          const lastIdx = msgs.length - 1;
          msgs[lastIdx] = { role: "assistant", content: `⚠️ ${errMsg}` };
          return {
            messagesByEngagement: {
              ...state.messagesByEngagement,
              [engagementId]: msgs,
            },
          };
        });
        return;
      }

      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);

          for (const line of raw.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") return;

            try {
              const parsed = JSON.parse(payload);
              if (parsed.text) {
                set((state) => {
                  const msgs = [
                    ...(state.messagesByEngagement[engagementId] || []),
                  ];
                  const lastIdx = msgs.length - 1;
                  msgs[lastIdx] = {
                    ...msgs[lastIdx],
                    content: msgs[lastIdx].content + parsed.text,
                  };
                  return {
                    messagesByEngagement: {
                      ...state.messagesByEngagement,
                      [engagementId]: msgs,
                    },
                  };
                });
              }
            } catch {
              // ignore partial chunks
            }
          }
        }
      }
    } catch (err) {
      console.error("Chat error:", err);
      set((state) => {
        const msgs = [...(state.messagesByEngagement[engagementId] || [])];
        const lastIdx = msgs.length - 1;
        if (lastIdx >= 0 && msgs[lastIdx].role === "assistant" && !msgs[lastIdx].content) {
          msgs[lastIdx] = {
            role: "assistant",
            content: "⚠️ Connection error. Please try again.",
          };
          return {
            messagesByEngagement: {
              ...state.messagesByEngagement,
              [engagementId]: msgs,
            },
          };
        }
        return {};
      });
    } finally {
      set({ streaming: false });
    }
  },
}));
