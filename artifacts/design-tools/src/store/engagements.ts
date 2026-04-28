import { create } from "zustand";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface EngagementsUiState {
  selectedSnapshotIdByEngagement: Record<string, string | null>;
  messagesByEngagement: Record<string, ChatMessage[]>;
  streaming: boolean;

  selectSnapshot: (engagementId: string, snapshotId: string | null) => void;
  sendMessage: (engagementId: string, question: string) => Promise<void>;
}

const API_BASE = `${import.meta.env.BASE_URL}api`;

export const useEngagementsStore = create<EngagementsUiState>((set, get) => ({
  selectedSnapshotIdByEngagement: {},
  messagesByEngagement: {},
  streaming: false,

  selectSnapshot: (engagementId, snapshotId) =>
    set((state) => ({
      selectedSnapshotIdByEngagement: {
        ...state.selectedSnapshotIdByEngagement,
        [engagementId]: snapshotId,
      },
    })),

  sendMessage: async (engagementId, question) => {
    set((state) => {
      const msgs = state.messagesByEngagement[engagementId] || [];
      return {
        streaming: true,
        messagesByEngagement: {
          ...state.messagesByEngagement,
          [engagementId]: [
            ...msgs,
            { role: "user", content: question },
            { role: "assistant", content: "" },
          ],
        },
      };
    });

    try {
      const state = get();
      const all = state.messagesByEngagement[engagementId] || [];
      const history = all.slice(0, -2);

      const res = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engagementId, question, history }),
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
