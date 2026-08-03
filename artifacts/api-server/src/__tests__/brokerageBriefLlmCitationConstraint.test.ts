/**
 * R2 — pin the ANTI-FABRICATION constraint on research-chat citations.
 *
 * The load-bearing guarantee behind the PE chat citation layer: the model is
 * prompted "Use ONLY the numbered code atom sources. Do not invent code.",
 * may only cite [n] for delivered sources, and parseInlineCitations DROPS any
 * out-of-range [n] — an invented citation can never surface as a chip. These
 * tests force answers with invented / malformed markers through the pipeline
 * (unit level: generateResearchChat with a mocked LLM client) and assert
 * nothing fabricated survives, and that PRO-mode answers keep their inline
 * [n] markers (consumer mode strips them).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const completeChatMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/briefingLlmClient", () => ({
  getBriefingLlmClient: vi.fn(async () => ({
    kind: "grok" as const,
    client: { completeChat: completeChatMock },
  })),
}));

// brokerageSiteContext pulls the full adapter stack — not under test here.
vi.mock("../lib/brokerageSiteContext", () => ({
  formatBrokerageContextForLlm: () => "",
}));

const { generateResearchChat } = await import("../lib/brokerageBriefLlm");
type BriefAtomInput = Parameters<typeof generateResearchChat>[0]["atoms"][number];

const ATOMS: BriefAtomInput[] = [
  {
    atomDid: "did:hauska:code-section:bastrop-udc-5-1",
    label: "Setbacks",
    snippet: "Front setback shall be fifteen feet…",
  },
  {
    atomDid: "did:hauska:code-section:bastrop-udc-4-2",
    label: "ADU standards",
    snippet: "Accessory dwelling units are permitted subject to…",
  },
];

function llmAnswers(answer: string): void {
  completeChatMock.mockResolvedValue(JSON.stringify({ answer }));
}

async function chat(
  answer: string,
  opts: { presentationMode?: "consumer" | "pro"; atoms?: typeof ATOMS } = {},
) {
  llmAnswers(answer);
  return generateResearchChat({
    address: "251 Cool Water Dr, Bastrop, TX 78602",
    jurisdiction: "bastrop_tx",
    message: "What are the setbacks?",
    history: [],
    atoms: opts.atoms ?? ATOMS,
    presentationMode: opts.presentationMode ?? "pro",
  });
}

beforeEach(() => {
  completeChatMock.mockReset();
});

describe("anti-fabrication: invented [n] never survives", () => {
  it("out-of-range markers ([99], [7], [3] with 2 sources) are DROPPED from citations", async () => {
    const r = await chat(
      "Front setback is 15 ft [1] per invented provisions [99], [7] and [3].",
    );
    expect(r.citations.map((c) => c.n)).toEqual([1]);
    expect(r.sources.map((c) => c.n)).toEqual([1]);
    // The one real citation maps VERBATIM to the delivered source.
    expect(r.citations[0]!.atomDid).toBe(
      "did:hauska:code-section:bastrop-udc-5-1",
    );
  });

  it("[0] and huge indexes never resolve (n must be 1..sources.length)", async () => {
    const r = await chat("Zero-indexed [0] and absurd [100000] markers.");
    expect(r.citations).toEqual([]);
  });

  it("malformed markers ([abc], [1.5], [ 2 ], [-1], unclosed [12) never parse", async () => {
    const r = await chat(
      "See [abc] and [1.5] and [ 2 ] and [-1] and unclosed [12",
    );
    expect(r.citations).toEqual([]);
  });

  it("duplicate markers dedupe to one citation", async () => {
    const r = await chat("Setbacks [1] apply; again, setbacks [1].");
    expect(r.citations.map((c) => c.n)).toEqual([1]);
  });

  it("HONEST-EMPTY: zero delivered sources → every [n] is fabricated → zero citations", async () => {
    const r = await chat("Confident-sounding claim [1] with sources [2].", {
      atoms: [],
    });
    expect(r.citations).toEqual([]);
    expect(r.sources).toEqual([]);
  });

  it("a citation can only carry a did from the delivered source list — never an invented id", async () => {
    const r = await chat("Setbacks [1] and ADUs [2].");
    const deliveredDids = new Set(ATOMS.map((a) => a.atomDid));
    for (const c of [...r.citations, ...r.sources]) {
      expect(deliveredDids.has(c.atomDid)).toBe(true);
    }
  });
});

describe("presentation modes — pro keeps [n], consumer strips", () => {
  it("PRO-mode answers carry inline [n] markers in the message text", async () => {
    const r = await chat("Front setback is 15 ft [1]; ADUs allowed [2].", {
      presentationMode: "pro",
    });
    expect(r.presentationMode).toBe("pro");
    expect(r.message).toContain("[1]");
    expect(r.message).toContain("[2]");
    expect(r.citations.map((c) => c.n)).toEqual([1, 2]);
  });

  it("consumer mode strips markers from the text but citations still parse", async () => {
    const r = await chat("Front setback is 15 ft [1].", {
      presentationMode: "consumer",
    });
    expect(r.message).not.toContain("[1]");
    expect(r.citations.map((c) => c.n)).toEqual([1]);
  });

  it("consumer mode: no [n] markers in the text, but the structured sources array is still populated", async () => {
    const r = await chat("Front setback is 15 ft [1]; ADUs allowed [2].", {
      presentationMode: "consumer",
    });
    expect(r.message).not.toMatch(/\[\d+\]/);
    expect(r.sources.length).toBeGreaterThan(0);
    expect(r.sources.map((c) => c.n)).toEqual([1, 2]);
    expect(r.sources[0]!.atomDid).toBe(ATOMS[0]!.atomDid);
  });

  it("PRO mode: an invented [99] may remain in TEXT but resolves to NO citation (the client renders it plain)", async () => {
    const r = await chat("Real [1] and invented [99].", {
      presentationMode: "pro",
    });
    expect(r.message).toContain("[99]"); // text survives…
    expect(r.citations.some((c) => c.n === 99)).toBe(false); // …evidence does not
  });
});

describe("the prompt carries the constraint", () => {
  it('system prompt instructs "Use ONLY the numbered code atom sources" + pro-mode inline-[n] rule', async () => {
    await chat("Answer [1].", { presentationMode: "pro" });
    const call = completeChatMock.mock.calls[0]![0] as { system: string };
    expect(call.system).toContain(
      "Use ONLY the numbered code atom sources. Do not invent code.",
    );
    expect(call.system).toContain(
      "Cite with [n] inline matching source numbers.",
    );
  });

  it("consumer prompt forbids [n] markers in the answer text", async () => {
    await chat("Answer.", { presentationMode: "consumer" });
    const call = completeChatMock.mock.calls[0]![0] as { system: string };
    expect(call.system).toContain("Do NOT include [n] citation markers");
  });
});

describe("DID-less entity-sourced entries (subject-parcel-facts citability)", () => {
  it("a source entry with entityId but no did numbers normally and carries entityId through the citation, did left undefined", async () => {
    const atomsWithParcelEntry = [
      {
        atomDid: "node-abc123",
        entityId: "node-abc123",
        label: "Parcel record — 251 Cool Water Dr (Hauska property atom chain)",
        snippet: "SUBJECT PARCEL CONSTRAINTS: Zoning district: R-1",
      },
      ...ATOMS,
    ];
    const r = await chat("Setbacks per the parcel record [1] and code [2].", {
      presentationMode: "pro",
      atoms: atomsWithParcelEntry,
    });
    const parcelCitation = r.citations.find((c) => c.n === 1);
    expect(parcelCitation).toBeTruthy();
    expect(parcelCitation!.atomDid).toBe("node-abc123");
    expect(parcelCitation!.entityId).toBe("node-abc123");
    expect(parcelCitation!.did).toBeUndefined();
    // Second numbered source is unaffected — same sequence space, not a
    // separate parallel numbering.
    const codeCitation = r.citations.find((c) => c.n === 2);
    expect(codeCitation!.atomDid).toBe(ATOMS[0]!.atomDid);
  });
});
