import { describe, expect, it } from "vitest";

import { isInitialize, readClientIdentity } from "../src/connection-record.js";

/** The handshake Claude actually sends when a custom connector is approved. */
function initialize(clientInfo: unknown) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo },
  };
}

describe("readClientIdentity — what earns a connection row", () => {
  it("reads a named client (NOT VACUOUS — this is the positive case)", () => {
    expect(
      readClientIdentity(initialize({ name: "claude-ai", version: "0.1.0" })),
    ).toEqual({ name: "claude-ai", version: "0.1.0" });
  });

  it("reads a named client with no version as version null, not empty string", () => {
    expect(readClientIdentity(initialize({ name: "Claude Desktop" }))).toEqual({
      name: "Claude Desktop",
      version: null,
    });
  });

  it("finds the initialize inside a JSON-RPC batch", () => {
    const batch = [
      { jsonrpc: "2.0", id: 0, method: "ping" },
      initialize({ name: "Cursor", version: "1.2" }),
    ];
    expect(readClientIdentity(batch)).toEqual({
      name: "Cursor",
      version: "1.2",
    });
  });

  it("trims a padded name and version", () => {
    expect(
      readClientIdentity(
        initialize({ name: "  claude-code  ", version: " 2 " }),
      ),
    ).toEqual({ name: "claude-code", version: "2" });
  });
});

describe("readClientIdentity — what does NOT earn a row", () => {
  it("refuses an initialize with no clientInfo", () => {
    expect(readClientIdentity(initialize(undefined))).toBeNull();
  });

  it("refuses an initialize whose clientInfo has no name", () => {
    expect(readClientIdentity(initialize({ version: "9" }))).toBeNull();
  });

  it("refuses a blank name rather than recording an empty client", () => {
    expect(readClientIdentity(initialize({ name: "   " }))).toBeNull();
  });

  it("refuses a non-string name rather than coercing it", () => {
    expect(readClientIdentity(initialize({ name: 42 }))).toBeNull();
    expect(readClientIdentity(initialize({ name: null }))).toBeNull();
  });

  it("refuses a tools/call — only initialize carries clientInfo", () => {
    expect(
      readClientIdentity({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "find_parcel", arguments: {} },
      }),
    ).toBeNull();
  });

  it("refuses a body that is not a message at all", () => {
    expect(readClientIdentity(null)).toBeNull();
    expect(readClientIdentity("initialize")).toBeNull();
    expect(readClientIdentity([])).toBeNull();
  });
});

describe("isInitialize — the unnamed/not-an-initialize split", () => {
  it("separates an unnamed initialize from a non-initialize", () => {
    // Both yield a null identity, and they are DIFFERENT facts: one client
    // connected without naming itself, the other never handshook at all.
    expect(readClientIdentity(initialize({}))).toBeNull();
    expect(isInitialize(initialize({}))).toBe(true);

    const call = { jsonrpc: "2.0", id: 3, method: "tools/list" };
    expect(readClientIdentity(call)).toBeNull();
    expect(isInitialize(call)).toBe(false);
  });

  it("sees an initialize inside a batch", () => {
    expect(isInitialize([{ method: "ping" }, initialize({})])).toBe(true);
    expect(isInitialize([{ method: "ping" }])).toBe(false);
  });
});
