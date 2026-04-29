/**
 * Unit tests for the pure prompt-assembly module. No DB, no network.
 *
 * The point of these tests is to lock the contract that downstream UI/model
 * behavior relies on:
 *   - the citation instruction only appears when there are atoms to cite
 *   - atom bodies are hard-trimmed (so we never blow Anthropic's context)
 *   - the section ref fallback chain matches what CitationChip renders
 *   - omittable framing pieces (address / jurisdiction) drop cleanly
 *   - sheet attachments switch the user message into a multimodal block array
 *   - history is forwarded in original order, before the new turn
 *   - relativeTime crosses every bucket boundary deterministically
 */

import { describe, it, expect } from "vitest";
import {
  buildChatPrompt,
  relativeTime,
  MAX_ATOM_BODY_CHARS,
  type BuildChatPromptInput,
} from "./promptFormatter";
import type { RetrievedAtom } from "./retrieval";

const baseAtom: RetrievedAtom = {
  id: "atom-1",
  sourceName: "grand_county_html",
  jurisdictionKey: "grand_county_ut",
  codeBook: "IRC_R301",
  edition: "IRC 2021",
  sectionNumber: "R301.2(1)",
  sectionTitle: "Climatic Criteria",
  body: "Ground snow load 50 psf, basic wind speed 110 mph.",
  sourceUrl: "https://example.com/r301",
  score: 0.9,
  retrievalMode: "vector",
};

function baseInput(over: Partial<BuildChatPromptInput> = {}): BuildChatPromptInput {
  return {
    engagement: {
      name: "Test House",
      address: "1 Main St, Moab, UT",
      jurisdiction: "Grand County, UT",
    },
    latestSnapshot: {
      receivedAt: new Date("2026-04-01T12:00:00Z"),
      payload: { kind: "stub", count: 3 },
    },
    allAtoms: [],
    attachedSheets: [],
    question: "What is the design wind speed?",
    history: [],
    now: () => new Date("2026-04-01T12:00:30Z"), // 30s after snapshot
    ...over,
  };
}

describe("buildChatPrompt: citation instruction gating", () => {
  it("omits the citation instruction when no atoms are present", () => {
    const { systemPrompt } = buildChatPrompt(baseInput({ allAtoms: [] }));
    expect(systemPrompt).not.toMatch(/\[\[CODE:/);
    expect(systemPrompt).not.toMatch(/<reference_code_atoms>/);
  });

  it("includes the citation instruction when atoms are present", () => {
    const { systemPrompt } = buildChatPrompt(
      baseInput({ allAtoms: [baseAtom] }),
    );
    expect(systemPrompt).toMatch(/\[\[CODE:atomId\]\]/);
    expect(systemPrompt).toMatch(/<reference_code_atoms>/);
    expect(systemPrompt).toMatch(/<atom id="atom-1"/);
    expect(systemPrompt).toMatch(/code_book="IRC_R301"/);
    expect(systemPrompt).toMatch(/edition="IRC 2021"/);
    expect(systemPrompt).toMatch(/section="R301\.2\(1\)"/);
    expect(systemPrompt).toMatch(/mode="vector"/);
  });
});

describe("buildChatPrompt: atom body trimming", () => {
  it("hard-trims atom bodies longer than MAX_ATOM_BODY_CHARS and appends an ellipsis", () => {
    const long = "x".repeat(MAX_ATOM_BODY_CHARS + 500);
    const { systemPrompt } = buildChatPrompt(
      baseInput({ allAtoms: [{ ...baseAtom, body: long }] }),
    );
    // The substring inside the atom block should be exactly
    // (MAX - 1) x's plus the ellipsis character. Find the atom payload by
    // splitting on the open/close tags.
    const open = systemPrompt.indexOf(`mode="vector">\n`);
    const close = systemPrompt.indexOf("\n</atom>");
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    const inner = systemPrompt.slice(
      open + `mode="vector">\n`.length,
      close,
    );
    expect(inner.length).toBe(MAX_ATOM_BODY_CHARS);
    expect(inner.endsWith("…")).toBe(true);
    expect(inner.slice(0, -1)).toBe("x".repeat(MAX_ATOM_BODY_CHARS - 1));
  });

  it("does not modify atom bodies at or under the limit", () => {
    const exact = "y".repeat(MAX_ATOM_BODY_CHARS);
    const { systemPrompt } = buildChatPrompt(
      baseInput({ allAtoms: [{ ...baseAtom, body: exact }] }),
    );
    expect(systemPrompt).toContain(exact);
    expect(systemPrompt).not.toContain("…");
  });
});

describe("buildChatPrompt: ref fallback chain", () => {
  it("uses sectionNumber when present", () => {
    const { systemPrompt } = buildChatPrompt(
      baseInput({
        allAtoms: [
          { ...baseAtom, sectionNumber: "R401.3", sectionTitle: "Drainage" },
        ],
      }),
    );
    expect(systemPrompt).toMatch(/section="R401\.3"/);
  });

  it("falls back to sectionTitle when sectionNumber is null", () => {
    const { systemPrompt } = buildChatPrompt(
      baseInput({
        allAtoms: [
          {
            ...baseAtom,
            sectionNumber: null,
            sectionTitle: "Wind Loads",
          },
        ],
      }),
    );
    expect(systemPrompt).toMatch(/section="Wind Loads"/);
  });

  it("falls back to codeBook when both sectionNumber and sectionTitle are null", () => {
    const { systemPrompt } = buildChatPrompt(
      baseInput({
        allAtoms: [
          {
            ...baseAtom,
            sectionNumber: null,
            sectionTitle: null,
            codeBook: "IRC_GENERAL",
          },
        ],
      }),
    );
    expect(systemPrompt).toMatch(/section="IRC_GENERAL"/);
  });
});

describe("buildChatPrompt: engagement framing", () => {
  it("includes 'at <address>' when address is set", () => {
    const { systemPrompt } = buildChatPrompt(
      baseInput({
        engagement: {
          name: "Test",
          address: "123 Elm",
          jurisdiction: "Moab, UT",
        },
      }),
    );
    expect(systemPrompt).toMatch(/'Test' at 123 Elm/);
  });

  it("omits 'at <address>' when address is null", () => {
    const { systemPrompt } = buildChatPrompt(
      baseInput({
        engagement: {
          name: "Test",
          address: null,
          jurisdiction: "Moab, UT",
        },
      }),
    );
    expect(systemPrompt).not.toMatch(/ at /);
    expect(systemPrompt).toMatch(/'Test' \(Moab, UT\)/);
  });

  it("omits the jurisdiction parenthetical when jurisdiction is null", () => {
    const { systemPrompt } = buildChatPrompt(
      baseInput({
        engagement: {
          name: "Test",
          address: "1 Main",
          jurisdiction: null,
        },
      }),
    );
    expect(systemPrompt).not.toMatch(/\(/); // no parens at all
  });
});

describe("buildChatPrompt: attached sheets shape the user message", () => {
  it("returns a string user.content when no sheets are attached", () => {
    const { messages } = buildChatPrompt(
      baseInput({ question: "Hello?", attachedSheets: [] }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Hello?");
  });

  it("returns a content-block array with image blocks when sheets are attached", () => {
    const { messages } = buildChatPrompt(
      baseInput({
        question: "What's on this sheet?",
        attachedSheets: [
          {
            id: "s1",
            sheetNumber: "A1",
            sheetName: "First Floor Plan",
            pngBase64: "AAAA",
          },
          {
            id: "s2",
            sheetNumber: "A2",
            sheetName: "Second Floor Plan",
            pngBase64: "BBBB",
          },
        ],
      }),
    );
    expect(messages).toHaveLength(1);
    const blocks = messages[0].content;
    expect(Array.isArray(blocks)).toBe(true);
    if (!Array.isArray(blocks)) throw new Error("expected array");
    expect(blocks).toHaveLength(3); // text intro + 2 images
    expect(blocks[0]).toMatchObject({ type: "text" });
    expect((blocks[0] as { text: string }).text).toMatch(
      /User question: What's on this sheet\?/,
    );
    expect((blocks[0] as { text: string }).text).toMatch(
      /A1 First Floor Plan, A2 Second Floor Plan/,
    );
    expect(blocks[1]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
    expect(blocks[2]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "BBBB" },
    });
  });
});

describe("buildChatPrompt: history pass-through", () => {
  it("forwards history in original order, before the new user turn", () => {
    const { messages } = buildChatPrompt(
      baseInput({
        history: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "follow up" },
          { role: "assistant", content: "answer" },
        ],
        question: "new question",
      }),
    );
    expect(messages).toHaveLength(5);
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "hi"],
      ["assistant", "hello"],
      ["user", "follow up"],
      ["assistant", "answer"],
      ["user", "new question"],
    ]);
  });

  it("treats undefined history as empty", () => {
    const { messages } = buildChatPrompt(
      baseInput({ history: undefined, question: "solo" }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: "user", content: "solo" });
  });
});

describe("relativeTime: bucket boundaries", () => {
  const t0 = new Date("2026-04-01T12:00:00Z");

  it("returns 'just now' for diffs under a minute", () => {
    expect(relativeTime(t0, new Date(t0.getTime() + 30_000))).toBe("just now");
  });

  it("returns minutes for sub-hour diffs (singular and plural)", () => {
    expect(relativeTime(t0, new Date(t0.getTime() + 60_000))).toBe(
      "about 1 minute ago",
    );
    expect(relativeTime(t0, new Date(t0.getTime() + 5 * 60_000))).toBe(
      "about 5 minutes ago",
    );
  });

  it("returns hours for sub-day diffs (singular and plural)", () => {
    expect(relativeTime(t0, new Date(t0.getTime() + 60 * 60_000))).toBe(
      "about 1 hour ago",
    );
    expect(relativeTime(t0, new Date(t0.getTime() + 3 * 60 * 60_000))).toBe(
      "about 3 hours ago",
    );
  });

  it("returns days for >=24h diffs (singular and plural)", () => {
    expect(
      relativeTime(t0, new Date(t0.getTime() + 24 * 60 * 60_000)),
    ).toBe("about 1 day ago");
    expect(
      relativeTime(t0, new Date(t0.getTime() + 4 * 24 * 60 * 60_000)),
    ).toBe("about 4 days ago");
  });
});

describe("buildChatPrompt: snapshot payload + receivedAt are embedded", () => {
  it("serializes the snapshot payload as JSON inside the <snapshot> block", () => {
    const { systemPrompt } = buildChatPrompt(
      baseInput({
        latestSnapshot: {
          receivedAt: new Date("2026-04-01T12:00:00Z"),
          payload: { rooms: [{ name: "Kitchen", area: 200 }] },
        },
      }),
    );
    expect(systemPrompt).toMatch(
      /<snapshot received_at='2026-04-01T12:00:00\.000Z'>/,
    );
    expect(systemPrompt).toContain('"name": "Kitchen"');
    expect(systemPrompt).toContain('"area": 200');
  });
});
