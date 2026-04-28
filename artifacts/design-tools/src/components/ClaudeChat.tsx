import { useState } from "react";
import { useEngagementsStore } from "../store/engagements";

function HexGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M12 2 L21.5 7 L21.5 17 L12 22 L2.5 17 L2.5 7 Z" fill="#6398AA" />
    </svg>
  );
}

interface ClaudeChatProps {
  engagementId: string;
  hasSnapshots: boolean;
}

export function ClaudeChat({ engagementId, hasSnapshots }: ClaudeChatProps) {
  const messagesByEngagement = useEngagementsStore(
    (s) => s.messagesByEngagement,
  );
  const streaming = useEngagementsStore((s) => s.streaming);
  const sendMessage = useEngagementsStore((s) => s.sendMessage);
  const [input, setInput] = useState("");

  const messages = messagesByEngagement[engagementId] || [];

  const handleSend = () => {
    if (!input.trim() || !hasSnapshots || streaming) return;
    sendMessage(engagementId, input);
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  const placeholder = hasSnapshots
    ? "Ask a question (Cmd/Ctrl + Enter to send)"
    : "Send a snapshot from Revit first.";

  return (
    <div className="flex flex-col h-full">
      <div className="sc-card-header flex flex-col gap-1 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <HexGlyph />
            <span className="sc-label">CLAUDE</span>
          </div>
          <div className="sc-body opacity-70">Ask about this model</div>
        </div>
        <div className="sc-meta opacity-60">
          Chat history is session-only — refreshing the page clears it.
        </div>
      </div>

      <div className="flex-1 overflow-y-auto sc-scroll p-4 flex flex-col gap-4">
        {messages.map((msg, i) => {
          const isUser = msg.role === "user";
          const isLastAssistant = !isUser && i === messages.length - 1;

          if (isUser) {
            return (
              <div key={i} className="self-end max-w-[80%]">
                <div
                  className="rounded-lg px-3 py-2 text-white sc-ui"
                  style={{ background: "var(--cyan)" }}
                >
                  {msg.content}
                </div>
              </div>
            );
          }

          return (
            <div key={i} className="self-start max-w-[90%]">
              <div className="sc-card sc-accent-cyan px-3.5 py-2.5">
                <div className="sc-prose whitespace-pre-wrap">
                  {msg.content}
                  {isLastAssistant && streaming && (
                    <span
                      className="inline-block ml-2 w-1.5 h-1.5 rounded-full sc-dot-pulse"
                      style={{
                        background: "var(--cyan)",
                        boxShadow: "0 0 7px rgba(0,180,216,0.75)",
                      }}
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div
        className="p-4 border-t flex-shrink-0"
        style={{ borderColor: "var(--border-default)" }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!hasSnapshots || streaming}
          placeholder={placeholder}
          className="w-full resize-none rounded-md sc-ui sc-scroll"
          style={{
            background: "var(--bg-input)",
            border: "1px solid var(--border-default)",
            color: "var(--text-primary)",
            padding: "8px 12px",
            height: "72px",
            outline: "none",
          }}
          onFocus={(e) =>
            (e.currentTarget.style.borderColor = "var(--border-focus)")
          }
          onBlur={(e) =>
            (e.currentTarget.style.borderColor = "var(--border-default)")
          }
        />
        <div className="mt-2 flex justify-end">
          <button
            className="sc-btn-primary"
            onClick={handleSend}
            disabled={!hasSnapshots || streaming || !input.trim()}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
