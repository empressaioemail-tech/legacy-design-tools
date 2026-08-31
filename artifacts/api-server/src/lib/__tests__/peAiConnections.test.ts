import { describe, expect, it } from "vitest";

import {
  isClaudeClient,
  pickClaude,
  type PeAiConnectionView,
} from "../peAiConnectionsClassify";

function conn(
  client: string,
  lastSeenAt: string | null = "2026-08-31T00:00:00.000Z",
): PeAiConnectionView {
  return { client, clientVersion: null, firstSeenAt: lastSeenAt, lastSeenAt };
}

describe("isClaudeClient", () => {
  it("matches the names Claude hosts actually announce (NOT VACUOUS)", () => {
    expect(isClaudeClient("claude-ai")).toBe(true);
    expect(isClaudeClient("claude-code")).toBe(true);
    expect(isClaudeClient("Claude Desktop")).toBe(true);
    expect(isClaudeClient("  Claude  ")).toBe(true);
  });

  it("does not match other hosts", () => {
    expect(isClaudeClient("Cursor")).toBe(false);
    expect(isClaudeClient("cline")).toBe(false);
    expect(isClaudeClient("copilot")).toBe(false);
    expect(isClaudeClient("")).toBe(false);
  });

  it("is a PREFIX, not a substring — a client that merely mentions Claude is not Claude", () => {
    expect(isClaudeClient("acme-claude-bridge")).toBe(false);
    expect(isClaudeClient("my claude helper")).toBe(false);
  });
});

describe("pickClaude", () => {
  it("returns null when nothing Claude has connected", () => {
    expect(pickClaude([])).toBeNull();
    expect(pickClaude([conn("Cursor")])).toBeNull();
  });

  it("finds Claude alongside other clients (NOT VACUOUS)", () => {
    const picked = pickClaude([conn("Cursor"), conn("claude-ai")]);
    expect(picked?.client).toBe("claude-ai");
  });

  it("prefers the most recently seen Claude surface", () => {
    const picked = pickClaude([
      conn("claude-ai", "2026-08-01T00:00:00.000Z"),
      conn("claude-code", "2026-08-30T00:00:00.000Z"),
    ]);
    expect(picked?.client).toBe("claude-code");
  });

  it("never lets a row with no timestamp outrank one that has it", () => {
    const picked = pickClaude([
      conn("claude-ai", null),
      conn("claude-code", "2026-08-30T00:00:00.000Z"),
    ]);
    expect(picked?.client).toBe("claude-code");

    const reversed = pickClaude([
      conn("claude-code", "2026-08-30T00:00:00.000Z"),
      conn("claude-ai", null),
    ]);
    expect(reversed?.client).toBe("claude-code");
  });
});
