import { create } from 'zustand';
import type { SnapshotSummary } from '@workspace/api-client-react';

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface SnapshotsState {
  snapshots: SnapshotSummary[];
  selectedId: string | null;
  detailById: Record<string, any>;
  messagesById: Record<string, ChatMessage[]>;
  streaming: boolean;

  setSnapshots: (snapshots: SnapshotSummary[]) => void;
  select: (id: string) => void;
  setDetail: (id: string, detail: any) => void;
  sendMessage: (snapshotId: string, question: string) => Promise<void>;
}

export const useSnapshotsStore = create<SnapshotsState>((set, get) => ({
  snapshots: [],
  selectedId: null,
  detailById: {},
  messagesById: {},
  streaming: false,

  setSnapshots: (snapshots) => set({ snapshots }),
  
  select: (id) => set({ selectedId: id }),
  
  setDetail: (id, detail) => set((state) => ({
    detailById: { ...state.detailById, [id]: detail }
  })),

  sendMessage: async (snapshotId, question) => {
    set((state) => {
      const msgs = state.messagesById[snapshotId] || [];
      return {
        streaming: true,
        messagesById: {
          ...state.messagesById,
          [snapshotId]: [
            ...msgs, 
            { role: "user", content: question }, 
            { role: "assistant", content: "" }
          ]
        }
      };
    });

    try {
      const state = get();
      // Exclude the newly added user and empty assistant msgs to get prior history
      const history = state.messagesById[snapshotId].slice(0, -2);

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshotId, question, history }),
      });

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
              const { text } = JSON.parse(payload);
              if (text) {
                set((state) => {
                  const msgs = [...(state.messagesById[snapshotId] || [])];
                  const lastIdx = msgs.length - 1;
                  msgs[lastIdx] = { 
                    ...msgs[lastIdx], 
                    content: msgs[lastIdx].content + text 
                  };
                  return {
                    messagesById: {
                      ...state.messagesById,
                      [snapshotId]: msgs
                    }
                  };
                });
              }
            } catch (e) {
              // Ignore partial JSON parse errors
            }
          }
        }
      }
    } catch (err) {
      console.error("Chat error:", err);
    } finally {
      set({ streaming: false });
    }
  }
}));