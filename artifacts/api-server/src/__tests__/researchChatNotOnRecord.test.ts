/**
 * T2-ASK — the research chat answers ONLY from the parcel record and says
 * "Not on record here." when the record lacks something, with the next step.
 *
 * Unit level: generateResearchChat with a mocked model (same seam as
 * brokerageBriefLlmCitationConstraint.test.ts). Two halves:
 *   1. the prompt the model receives carries the record-only rules, in both
 *      presentation modes, and the per-claim [n] rule in pro mode;
 *   2. a "Not on record here." answer from the model passes through intact
 *      with no fabricated citation, while a cited answer keeps its source.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const completeChatMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/briefingLlmClient", () => ({
  getBriefingLlmClient: vi.fn(async () => ({
    kind: "grok" as const,
    client: { completeChat: completeChatMock },
  })),
}));

vi.mock("../lib/brokerageSiteContext", () => ({
  formatBrokerageContextForLlm: () => "",
}));

const {
  generateResearchChat,
  RESEARCH_CHAT_NOT_ON_RECORD,
  RESEARCH_CHAT_RECORD_ONLY_RULES,
} = await import("../lib/brokerageBriefLlm");
type BriefAtomInput = Parameters<typeof generateResearchChat>[0]["atoms"][number];

// Source [1] is the parcel's own record (the route prepends it), [2] a code section.
const ATOMS: BriefAtomInput[] = [
  {
    atomDid: "48209:97651",
    entityId: "48209:97651",
    label: "Parcel record · Sturgeon Dr, San Marcos",
    snippet: "Zoning district: SF-6. Setbacks: front 25 ft, side 5 ft, rear 20 ft.",
  },
  {
    atomDid: "did:hauska:code-section:san-marcos-4-4-1-3",
    label: "City of San Marcos §4.4.1.3",
    snippet: "SF-6 rear setback: twenty feet.",
  },
];

async function ask(
  modelAnswer: string,
  opts: { presentationMode?: "consumer" | "pro"; message?: string } = {},
) {
  completeChatMock.mockResolvedValue(JSON.stringify({ answer: modelAnswer }));
  return generateResearchChat({
    address: "Sturgeon Dr, San Marcos, TX",
    jurisdiction: "san_marcos_tx",
    message: opts.message ?? "Any easements back there?",
    history: [],
    atoms: ATOMS,
    presentationMode: opts.presentationMode ?? "pro",
  });
}

function systemPrompt(): string {
  const call = completeChatMock.mock.calls[0]![0] as { system: string };
  return call.system;
}

beforeEach(() => {
  completeChatMock.mockReset();
});

describe("record-only prompt rules", () => {
  it("the stable phrase is exactly 'Not on record here.'", () => {
    expect(RESEARCH_CHAT_NOT_ON_RECORD).toBe("Not on record here.");
  });

  it.each(["pro", "consumer"] as const)(
    "%s mode: the model is told to answer only from the sources and to open with the not-on-record phrase when they lack it",
    async (mode) => {
      await ask("Not on record here.", { presentationMode: mode });
      const system = systemPrompt();
      for (const rule of RESEARCH_CHAT_RECORD_ONLY_RULES) {
        expect(system).toContain(rule);
      }
      expect(system).toContain('start the answer with exactly "Not on record here."');
      expect(system).toMatch(/never estimate/i);
      expect(system).toMatch(/records request/i);
      expect(system).toMatch(/sale prices/i);
    },
  );

  it("pro mode: every factual sentence must carry its source marker", async () => {
    await ask("20 ft [2].");
    expect(systemPrompt()).toContain(
      "Every sentence that states a fact ends with the [n] marker of the source it comes from.",
    );
  });

  it("consumer mode keeps its no-marker rule (no per-claim [n] instruction)", async () => {
    await ask("20 feet.", { presentationMode: "consumer" });
    expect(systemPrompt()).not.toContain("ends with the [n] marker");
  });
});

describe("not-on-record answers pass through honestly", () => {
  it("a not-on-record answer keeps its words and carries no fabricated citation", async () => {
    const r = await ask(
      "Not on record here. Easements are on the recorded plat at the Hays County clerk; a records request can pull it.",
    );
    expect(r.message.startsWith("Not on record here.")).toBe(true);
    expect(r.citations).toEqual([]);
  });

  it("a cited answer keeps the source it rests on", async () => {
    const r = await ask("20 ft from the rear line [2]. The side lines are 5 ft [1].", {
      message: "How close to the back line can I build?",
    });
    expect(r.citations.map((c) => c.n).sort()).toEqual([1, 2]);
    expect(r.citations.find((c) => c.n === 2)!.atomDid).toBe(
      "did:hauska:code-section:san-marcos-4-4-1-3",
    );
  });
});
