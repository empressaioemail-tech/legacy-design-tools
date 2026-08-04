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
    // sources is grounding-derived (2026-08-03 ruling): it reflects every
    // atom actually SUPPLIED to the prompt, not just the ones the model's
    // prose happened to cite with a surviving marker — so [2] (ADU
    // standards, delivered but uncited in this answer) legitimately
    // appears here even though it is absent from `citations`. No
    // fabrication risk: [2] is a real delivered source, unlike the
    // invented [99]/[7]/[3] markers, which never resolve anywhere.
    expect(r.sources.map((c) => c.n)).toEqual([1, 2]);
    // The one real MARKER-PARSED citation maps VERBATIM to the delivered source.
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

  it("REGRESSION (2026-08-03 ruling): consumer mode with a MARKERLESS answer still carries a non-empty grounding-derived sources array", async () => {
    // The model followed its own consumer-mode instruction and emitted NO
    // [n] markers at all. Before the ruling, sources === citations (a
    // regex parse of markers), so this answer would have shipped ZERO
    // attribution despite two atoms having grounded it. sources must now
    // populate from what was actually SUPPLIED to the prompt.
    const r = await chat(
      "Front setback is fifteen feet, and accessory dwelling units are allowed subject to standards.",
      { presentationMode: "consumer" },
    );
    expect(r.message).not.toMatch(/\[\d+\]/);
    expect(r.citations).toEqual([]); // no markers survived to parse — expected
    expect(r.sources.length).toBeGreaterThan(0); // grounding record fills the gap
    expect(r.sources.map((c) => c.n)).toEqual([1, 2]);
    expect(r.sources[0]!.atomDid).toBe(ATOMS[0]!.atomDid);
    expect(r.sources[1]!.atomDid).toBe(ATOMS[1]!.atomDid);
    expect(r.grounding).toEqual({ atomCount: 2, method: "supplied-atoms" });
  });

  it("HONEST-EMPTY still holds for sources: zero delivered atoms -> zero sources even in consumer mode", async () => {
    const r = await chat("No grounded answer available.", {
      presentationMode: "consumer",
      atoms: [],
    });
    expect(r.sources).toEqual([]);
    expect(r.grounding).toEqual({ atomCount: 0, method: "supplied-atoms" });
  });
});

describe("confidence derives from grounding, not marker survival (2026-08-03 ruling)", () => {
  it("a markerless consumer answer with grounded atoms reports confidence ABOVE the old always-0.5 marker-proxy floor", async () => {
    const r = await chat(
      "Front setback is fifteen feet, and accessory dwelling units are allowed subject to standards.",
      { presentationMode: "consumer" },
    );
    expect(r.citations).toEqual([]); // old proxy would have pinned this at 0.5 forever
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it("zero grounded atoms produces the lowest-band confidence, distinct from the grounded floor", async () => {
    const r = await chat("Nothing to cite.", {
      presentationMode: "pro",
      atoms: [],
    });
    expect(r.confidence).toBeLessThan(0.55);
  });

  it("confidence is deterministic for a fixed grounding set (same atoms -> same score regardless of prose)", async () => {
    const r1 = await chat("Setbacks [1].", { presentationMode: "pro" });
    const r2 = await chat("Totally different wording, no markers at all.", {
      presentationMode: "pro",
    });
    expect(r1.confidence).toBe(r2.confidence);
  });

  it("confidence stays within the documented [0.1, 0.95] band", async () => {
    const r = await chat("Setbacks [1]; ADUs [2].", {
      presentationMode: "pro",
    });
    expect(r.confidence).toBeGreaterThanOrEqual(0.1);
    expect(r.confidence).toBeLessThanOrEqual(0.95);
  });
});

describe("rules-v1 fallback (no LLM completion available) keeps its OWN asserted-not-earned scale", () => {
  it("no LLM + atoms available -> 0.4 confidence, empty sources (nothing was actually grounded into an answer)", async () => {
    completeChatMock.mockResolvedValue(null);
    const r = await generateResearchChat({
      address: "251 Cool Water Dr, Bastrop, TX 78602",
      jurisdiction: "bastrop_tx",
      message: "What are the setbacks?",
      history: [],
      atoms: ATOMS,
      presentationMode: "pro",
    });
    expect(r.method).toBe("rules-v1");
    expect(r.confidence).toBe(0.4);
    expect(r.sources).toEqual([]);
    expect(r.citations).toEqual([]);
  });

  it("no LLM + zero atoms -> 0.1 confidence", async () => {
    completeChatMock.mockResolvedValue(null);
    const r = await generateResearchChat({
      address: "251 Cool Water Dr, Bastrop, TX 78602",
      jurisdiction: "bastrop_tx",
      message: "What are the setbacks?",
      history: [],
      atoms: [],
      presentationMode: "pro",
    });
    expect(r.method).toBe("rules-v1");
    expect(r.confidence).toBe(0.1);
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
