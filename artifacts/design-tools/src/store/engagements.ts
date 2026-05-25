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
  // WS-C — tool names the in-app agent invoked while producing this
  // assistant turn, in call order. Rendered as muted "used <tool>" status
  // lines so the operator can see what the agent did.
  toolActivity?: string[];
}

/**
 * WS-C — one write the in-app agent performed this session. Fed by the
 * `agent_action` SSE event the chat route emits; surfaced in the chat
 * panel's agent-action log with a one-click reverse (WSC.5).
 */
export interface AgentActionEntry {
  kind: "response-task-created";
  entityType: "response-task";
  entityId: string;
  engagementId: string;
  /** Human label for the log row (the response-task title). */
  label: string;
  /** `cancel` → reverse transitions the task to the L1 `cancelled` state. */
  reverseHint: "cancel";
  /** Set once the operator has reversed the write. */
  reversed?: boolean;
}

/**
 * WS-C — a spec draft the in-app agent prepared (L4 detail-callout-spec
 * or L5 product-spec-reference). Fed by the `agent_draft` SSE event; the
 * engagement page routes it to the matching manual form, pre-filled for
 * operator review and save (WSC.4). Nothing is persisted until the
 * operator submits that form.
 */
export interface SpecDraftEntry {
  draftKind: "detail-callout-spec" | "product-spec-reference";
  engagementId: string;
  /** Validated draft payload the manual form pre-fills from. */
  payload: Record<string, unknown>;
  /** The agent's one-line rationale, shown in the form banner. */
  reasoning: string;
}

/**
 * QA-18 — a client document attached to an engagement (PDF, photo, or
 * note). The chat panel lists these so the operator can see what client
 * material the in-app agent can reach; the agent reads them via its
 * `list_attached_documents` / `read_attached_document` tools.
 */
export interface AttachedDocumentSummary {
  id: string;
  title: string;
  documentType: string;
}

interface EngagementsUiState {
  selectedSnapshotIdByEngagement: Record<string, string | null>;
  messagesByEngagement: Record<string, ChatMessage[]>;
  attachedSheetsByEngagement: Record<string, SheetSummary[]>;
  // QA-18 — persisted client documents per engagement, the upload-in-
  // flight flag, and the last upload error (cleared when one succeeds).
  attachedDocumentsByEngagement: Record<string, AttachedDocumentSummary[]>;
  uploadingDocumentByEngagement: Record<string, boolean>;
  documentUploadErrorByEngagement: Record<string, string | null>;
  pendingChatInputByEngagement: Record<string, string>;
  // Snapshot ids the user has staged for the next comparison turn, keyed by
  // engagement (Task #48). One-shot: cleared after each successful send so
  // follow-up turns don't accidentally keep paying the focus cost.
  focusSnapshotIdsByEngagement: Record<string, string[]>;
  // WS-C — the session agent-action log, keyed by engagement. Accumulates
  // across the session (session-only, like the chat transcript itself).
  agentActionsByEngagement: Record<string, AgentActionEntry[]>;
  // WS-C — the latest pending spec draft per engagement, awaiting the
  // engagement page to route it to the L4/L5 form. `null`/absent == none.
  specDraftByEngagement: Record<string, SpecDraftEntry | null>;
  streaming: boolean;

  selectSnapshot: (engagementId: string, snapshotId: string | null) => void;
  attachSheet: (engagementId: string, sheet: SheetSummary) => void;
  detachSheet: (engagementId: string, sheetId: string) => void;
  clearAttachedSheets: (engagementId: string) => void;
  /** QA-18 — load the engagement's persisted client documents. */
  loadAttachedDocuments: (engagementId: string) => Promise<void>;
  /** QA-18 — upload a client PDF / photo / note to the engagement. */
  uploadAttachedDocument: (engagementId: string, file: File) => Promise<void>;
  setPendingChatInput: (engagementId: string, value: string) => void;
  consumePendingChatInput: (engagementId: string) => string | null;
  toggleFocusSnapshot: (engagementId: string, snapshotId: string) => void;
  clearFocusSnapshots: (engagementId: string) => void;
  /** Pull (and clear) the pending spec draft for an engagement. */
  consumeSpecDraft: (engagementId: string) => SpecDraftEntry | null;
  /**
   * Reverse an agent-created response-task by transitioning it to the L1
   * `cancelled` state. Resolves `true` on success and marks the
   * agent-action log entry reversed.
   */
  reverseAgentAction: (
    engagementId: string,
    entityId: string,
  ) => Promise<boolean>;
  sendMessage: (
    engagementId: string,
    question: string,
    options?: {
      snapshotFocus?: boolean;
      snapshotFocusIds?: string[];
      /** The engagement-detail tab the operator is currently viewing. */
      activeTab?: string;
      /** QA-45 — portfolio chat from dashboard without an engagement open. */
      chatScope?: "workspace" | "engagement";
    },
  ) => Promise<void>;
}

const API_BASE = `${import.meta.env.BASE_URL}api`;

/** QA-18 — map an upload route error code to an operator-facing message. */
function uploadErrorMessage(code: unknown, status: number): string {
  switch (code) {
    case "file_too_large":
      return "That file is too large (max 25 MB).";
    case "unsupported_document_type":
      return "Unsupported file type — upload a PDF, image, or text note.";
    case "empty_file":
      return "That file is empty.";
    case "missing_file_part":
      return "No file was selected.";
    case "engagement_not_found":
      return "Engagement not found.";
    default:
      return `Upload failed (HTTP ${status}).`;
  }
}

export const useEngagementsStore = create<EngagementsUiState>((set, get) => ({
  selectedSnapshotIdByEngagement: {},
  messagesByEngagement: {},
  attachedSheetsByEngagement: {},
  attachedDocumentsByEngagement: {},
  uploadingDocumentByEngagement: {},
  documentUploadErrorByEngagement: {},
  pendingChatInputByEngagement: {},
  focusSnapshotIdsByEngagement: {},
  agentActionsByEngagement: {},
  specDraftByEngagement: {},
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

  loadAttachedDocuments: async (engagementId) => {
    try {
      const res = await fetch(
        `${API_BASE}/engagements/${engagementId}/attached-documents`,
      );
      if (!res.ok) return;
      const body = await res.json();
      const raw = Array.isArray(body?.attachedDocuments)
        ? (body.attachedDocuments as Array<Record<string, unknown>>)
        : [];
      const docs: AttachedDocumentSummary[] = raw.map((d) => ({
        id: String(d.entityId ?? ""),
        title: String(d.title ?? "Untitled document"),
        documentType: String(d.documentType ?? "narrative"),
      }));
      set((state) => ({
        attachedDocumentsByEngagement: {
          ...state.attachedDocumentsByEngagement,
          [engagementId]: docs,
        },
      }));
    } catch {
      // Best-effort: a load failure just leaves the panel showing no
      // documents — the upload path still works.
    }
  },

  uploadAttachedDocument: async (engagementId, file) => {
    set((state) => ({
      uploadingDocumentByEngagement: {
        ...state.uploadingDocumentByEngagement,
        [engagementId]: true,
      },
      documentUploadErrorByEngagement: {
        ...state.documentUploadErrorByEngagement,
        [engagementId]: null,
      },
    }));
    try {
      const form = new FormData();
      // The server defaults the title to the filename and the
      // documentType to "narrative" — a bare file upload is enough.
      form.append("file", file);
      const res = await fetch(
        `${API_BASE}/engagements/${engagementId}/attached-documents`,
        { method: "POST", body: form },
      );
      if (!res.ok) {
        let code: unknown;
        try {
          code = (await res.json())?.error;
        } catch {
          // body not JSON
        }
        set((state) => ({
          documentUploadErrorByEngagement: {
            ...state.documentUploadErrorByEngagement,
            [engagementId]: uploadErrorMessage(code, res.status),
          },
        }));
        return;
      }
      const atom = (await res.json())?.attachedDocument as
        | Record<string, unknown>
        | undefined;
      if (atom) {
        const summary: AttachedDocumentSummary = {
          id: String(atom.entityId ?? ""),
          title: String(atom.title ?? file.name),
          documentType: String(atom.documentType ?? "narrative"),
        };
        set((state) => {
          const existing =
            state.attachedDocumentsByEngagement[engagementId] ?? [];
          return {
            attachedDocumentsByEngagement: {
              ...state.attachedDocumentsByEngagement,
              [engagementId]: [
                summary,
                ...existing.filter((d) => d.id !== summary.id),
              ],
            },
          };
        });
      }
    } catch {
      set((state) => ({
        documentUploadErrorByEngagement: {
          ...state.documentUploadErrorByEngagement,
          [engagementId]: "Upload failed — check your connection and retry.",
        },
      }));
    } finally {
      set((state) => ({
        uploadingDocumentByEngagement: {
          ...state.uploadingDocumentByEngagement,
          [engagementId]: false,
        },
      }));
    }
  },

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

  consumeSpecDraft: (engagementId) => {
    const draft = get().specDraftByEngagement[engagementId] ?? null;
    if (draft) {
      set((state) => {
        const next = { ...state.specDraftByEngagement };
        delete next[engagementId];
        return { specDraftByEngagement: next };
      });
    }
    return draft;
  },

  reverseAgentAction: async (engagementId, entityId) => {
    try {
      const res = await fetch(
        `${API_BASE}/response-tasks/${entityId}/state`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: "cancelled" }),
        },
      );
      if (!res.ok) return false;
      set((state) => ({
        agentActionsByEngagement: {
          ...state.agentActionsByEngagement,
          [engagementId]: (
            state.agentActionsByEngagement[engagementId] ?? []
          ).map((a) =>
            a.entityId === entityId ? { ...a, reversed: true } : a,
          ),
        },
      }));
      return true;
    } catch {
      return false;
    }
  },

  sendMessage: async (engagementId, question, options) => {
    const snapshotFocus = options?.snapshotFocus === true;
    const snapshotFocusIds = options?.snapshotFocusIds ?? [];
    const activeTab = options?.activeTab;
    const chatScope = options?.chatScope;
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
          // WS-C — ambient context: which tab the operator is on.
          ...(activeTab ? { activeTab } : {}),
          ...(chatScope ? { chatScope } : {}),
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
              if (parsed.type === "tool_use" && typeof parsed.tool === "string") {
                // WS-C — agent invoked a tool; record it on the streaming
                // assistant message as a status line.
                set((state) => {
                  const msgs = [
                    ...(state.messagesByEngagement[engagementId] || []),
                  ];
                  const lastIdx = msgs.length - 1;
                  if (lastIdx >= 0 && msgs[lastIdx].role === "assistant") {
                    const prev = msgs[lastIdx].toolActivity ?? [];
                    msgs[lastIdx] = {
                      ...msgs[lastIdx],
                      toolActivity: [...prev, parsed.tool],
                    };
                  }
                  return {
                    messagesByEngagement: {
                      ...state.messagesByEngagement,
                      [engagementId]: msgs,
                    },
                  };
                });
              } else if (parsed.type === "agent_action" && parsed.action) {
                // WS-C — agent performed a write; append to the action log.
                set((state) => {
                  const existing =
                    state.agentActionsByEngagement[engagementId] ?? [];
                  const action = parsed.action as AgentActionEntry;
                  if (existing.some((a) => a.entityId === action.entityId)) {
                    return {};
                  }
                  return {
                    agentActionsByEngagement: {
                      ...state.agentActionsByEngagement,
                      [engagementId]: [...existing, action],
                    },
                  };
                });
              } else if (parsed.type === "agent_draft" && parsed.draft) {
                // WS-C — agent prepared an L4/L5 spec draft; stage it for
                // the engagement page to route to the manual form.
                set((state) => ({
                  specDraftByEngagement: {
                    ...state.specDraftByEngagement,
                    [engagementId]: parsed.draft as SpecDraftEntry,
                  },
                }));
              } else if (parsed.text) {
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
