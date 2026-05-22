/**
 * Tests for the Hauska substrate client (QA-17).
 *
 * Covers the mock client, the MCP `list_jurisdictions` envelope parser,
 * the env-driven factory, and the boot validator. The live MCP transport
 * itself is not exercised here — that needs a deployed server + a minted
 * product key and is the operator's end-to-end verification step.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  MockHauskaSubstrateClient,
  McpHauskaSubstrateClient,
  MOCK_SUBSTRATE_JURISDICTIONS,
  SubstrateError,
  parseListJurisdictionsResult,
  getHauskaSubstrateClient,
  setHauskaSubstrateClient,
  validateHauskaSubstrateEnvAtBoot,
  __hauskaSubstrateClientIsFromEnvForTests,
} from "./hauskaSubstrateClient";

// --- env save/restore -------------------------------------------------------

const ENV_KEYS = [
  "HAUSKA_SUBSTRATE_MODE",
  "HAUSKA_MCP_URL",
  "HAUSKA_MCP_KEY",
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  setHauskaSubstrateClient(null);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  setHauskaSubstrateClient(null);
});

// --- mock client ------------------------------------------------------------

describe("MockHauskaSubstrateClient", () => {
  it("returns the five-jurisdiction fixture catalog tagged source=mock", async () => {
    const catalog = await new MockHauskaSubstrateClient().listJurisdictions();
    expect(catalog.source).toBe("mock");
    expect(catalog.jurisdictions).toHaveLength(5);
    const free = catalog.jurisdictions.filter(
      (j) => j.accessPolicy === "public-free",
    );
    const internal = catalog.jurisdictions.filter(
      (j) => j.accessPolicy === "platform-internal",
    );
    // QA-17: two public-free, three partnership-pending platform-internal.
    expect(free).toHaveLength(2);
    expect(internal).toHaveLength(3);
  });

  it("the fixture carries Bastrop County, Elgin, and Hutto as platform-internal", () => {
    const internalKeys = MOCK_SUBSTRATE_JURISDICTIONS.filter(
      (j) => j.accessPolicy === "platform-internal",
    ).map((j) => j.key);
    expect(internalKeys).toEqual(
      expect.arrayContaining(["bastrop-county-tx", "elgin-tx", "hutto-tx"]),
    );
  });

  it("throws the configured error when failWith is set", async () => {
    const client = new MockHauskaSubstrateClient({
      failWith: new SubstrateError("substrate_unreachable", "boom"),
    });
    await expect(client.listJurisdictions()).rejects.toBeInstanceOf(
      SubstrateError,
    );
  });

  it("honors a pinned jurisdiction override", async () => {
    const client = new MockHauskaSubstrateClient({
      jurisdictions: [
        {
          key: "k",
          displayName: "K",
          atomCount: 1,
          accessPolicy: "public-free",
          qualityBar: "passing",
          driftStatus: "clean",
          lastRefreshedAt: null,
        },
      ],
    });
    const catalog = await client.listJurisdictions();
    expect(catalog.jurisdictions).toHaveLength(1);
    expect(catalog.jurisdictions[0].key).toBe("k");
  });
});

// --- envelope parser --------------------------------------------------------

function envelopeResult(jurisdictions: unknown[]): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          data: { jurisdictions },
          atoms: [],
          meta: {},
        }),
      },
    ],
  };
}

describe("parseListJurisdictionsResult", () => {
  it("maps a well-formed envelope and preserves accessPolicy", () => {
    const out = parseListJurisdictionsResult(
      envelopeResult([
        {
          jurisdictionTenant: "bastrop-tx",
          jurisdictionName: "Bastrop, TX",
          atomCount: 412,
          accessPolicy: "public-free",
          qualityBar: "passing",
          driftStatus: "clean",
          lastRefreshedAt: "2026-05-19T00:00:00.000Z",
        },
        {
          jurisdictionTenant: "elgin-tx",
          jurisdictionName: "Elgin, TX",
          atomCount: 268,
          accessPolicy: "platform-internal",
          qualityBar: "passing",
          driftStatus: "clean",
          lastRefreshedAt: null,
        },
      ]),
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ key: "bastrop-tx", atomCount: 412 });
    expect(out[1].accessPolicy).toBe("platform-internal");
  });

  it("defaults an absent accessPolicy to public-free (ADR-017)", () => {
    const out = parseListJurisdictionsResult(
      envelopeResult([
        { jurisdictionTenant: "legacy-tx", atomCount: 10 },
      ]),
    );
    expect(out[0].accessPolicy).toBe("public-free");
    // displayName falls back to the key when the wire omits the name.
    expect(out[0].displayName).toBe("legacy-tx");
  });

  it("skips rows missing a jurisdiction tenant slug", () => {
    const out = parseListJurisdictionsResult(
      envelopeResult([{ jurisdictionName: "no key" }, { jurisdictionTenant: "ok-tx" }]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe("ok-tx");
  });

  it("throws substrate_rejected when the tool returns an error envelope", () => {
    expect(() =>
      parseListJurisdictionsResult({
        isError: true,
        content: [{ type: "text", text: "engine unreachable" }],
      }),
    ).toThrow(SubstrateError);
  });

  it("throws substrate_invalid_response on non-JSON content", () => {
    try {
      parseListJurisdictionsResult({
        content: [{ type: "text", text: "not json" }],
      });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SubstrateError);
      expect((err as SubstrateError).code).toBe("substrate_invalid_response");
    }
  });

  it("throws substrate_invalid_response when data.jurisdictions is missing", () => {
    expect(() =>
      parseListJurisdictionsResult({
        content: [{ type: "text", text: JSON.stringify({ data: {} }) }],
      }),
    ).toThrow(/data\.jurisdictions/);
  });

  it("throws substrate_invalid_response when there is no text content block", () => {
    expect(() => parseListJurisdictionsResult({ content: [] })).toThrow(
      SubstrateError,
    );
  });
});

// --- env factory + boot validator ------------------------------------------

describe("getHauskaSubstrateClient / buildFromEnv", () => {
  it("defaults to the mock client when HAUSKA_SUBSTRATE_MODE is unset", () => {
    const client = getHauskaSubstrateClient();
    expect(client).toBeInstanceOf(MockHauskaSubstrateClient);
    expect(__hauskaSubstrateClientIsFromEnvForTests()).toBe(true);
  });

  it("falls back to mock for an unrecognized mode", () => {
    process.env.HAUSKA_SUBSTRATE_MODE = "banana";
    expect(getHauskaSubstrateClient()).toBeInstanceOf(MockHauskaSubstrateClient);
  });

  it("throws when mode=mcp but URL/key are missing", () => {
    process.env.HAUSKA_SUBSTRATE_MODE = "mcp";
    expect(() => getHauskaSubstrateClient()).toThrow(/HAUSKA_MCP_URL/);
  });

  it("builds the MCP client when mode=mcp and URL/key are set", () => {
    process.env.HAUSKA_SUBSTRATE_MODE = "mcp";
    process.env.HAUSKA_MCP_URL = "https://mcp.example.test/mcp";
    process.env.HAUSKA_MCP_KEY = "ctx-key";
    expect(getHauskaSubstrateClient()).toBeInstanceOf(McpHauskaSubstrateClient);
  });

  it("setHauskaSubstrateClient overrides the singleton and flips the from-env flag", () => {
    const injected = new MockHauskaSubstrateClient();
    setHauskaSubstrateClient(injected);
    expect(getHauskaSubstrateClient()).toBe(injected);
    expect(__hauskaSubstrateClientIsFromEnvForTests()).toBe(false);
  });
});

describe("validateHauskaSubstrateEnvAtBoot", () => {
  it("is a no-op in mock mode (the default)", () => {
    expect(() => validateHauskaSubstrateEnvAtBoot()).not.toThrow();
  });

  it("throws in mcp mode when URL/key are missing", () => {
    process.env.HAUSKA_SUBSTRATE_MODE = "mcp";
    expect(() => validateHauskaSubstrateEnvAtBoot()).toThrow(/HAUSKA_MCP_KEY/);
  });

  it("passes in mcp mode when URL/key are set", () => {
    process.env.HAUSKA_SUBSTRATE_MODE = "mcp";
    process.env.HAUSKA_MCP_URL = "https://mcp.example.test/mcp";
    process.env.HAUSKA_MCP_KEY = "ctx-key";
    expect(() => validateHauskaSubstrateEnvAtBoot()).not.toThrow();
  });
});
