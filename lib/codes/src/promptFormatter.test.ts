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
  formatSnapshotFocus,
  relativeTime,
  MAX_ATOM_BODY_CHARS,
  MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS,
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

describe("buildChatPrompt: snapshot framing without raw payload (Task #34)", () => {
  it("renders the captured-time framing sentence using receivedAt", () => {
    // The opening framing sentence still has to land — the snapshot
    // atom's prose covers identity/counts, but the prompt itself owns
    // the "captured X ago" line so even when the snapshot atom is
    // skipped (warn path in chat.ts) the model still sees recency.
    const { systemPrompt } = buildChatPrompt(
      baseInput({
        latestSnapshot: { receivedAt: new Date("2026-04-01T12:00:00Z") },
        now: () => new Date("2026-04-01T12:00:30Z"),
      }),
    );
    expect(systemPrompt).toContain(
      "The most recent snapshot was captured just now.",
    );
  });

  it("does NOT emit a <snapshot> block or pass through any raw payload bytes", () => {
    // Pre-Task-#34 the system prompt always carried
    // `<snapshot received_at='…'>{full JSON}</snapshot>`. That block is
    // intentionally retired — for real Revit pushes it ran tens of KB
    // and dominated the prompt token budget. The snapshot atom (in
    // <framework_atoms>) covers the same information with a typed
    // prose summary instead.
    const { systemPrompt } = buildChatPrompt(
      baseInput({
        latestSnapshot: { receivedAt: new Date("2026-04-01T12:00:00Z") },
      }),
    );
    expect(systemPrompt).not.toContain("<snapshot ");
    expect(systemPrompt).not.toContain("</snapshot>");
    // The ISO timestamp itself is not embedded anywhere in the system
    // prompt either — the framing uses the relative-time bucket. If a
    // future change adds back an ISO field, update this assertion.
    expect(systemPrompt).not.toContain("2026-04-01T12:00:00.000Z");
  });

  it("retires the 'snapshot data below' phrasing in favor of 'structured atoms below'", () => {
    // Locks the wording change so a future grep for "snapshot data
    // below" surfaces this test (and not just a stale prompt). The new
    // phrasing accurately describes what's actually below: framework
    // atoms + reference code atoms + atom vocabulary, never raw JSON.
    const { systemPrompt } = buildChatPrompt(baseInput());
    expect(systemPrompt).not.toContain("snapshot data below");
    expect(systemPrompt).toContain(
      "Answer grounded in the structured atoms below.",
    );
  });
});

describe("buildChatPrompt: snapshot focus mode (Task #39)", () => {
  // Marker string the chat route's payload-leak canary uses; we reuse
  // it here so a regression that lets the formatter swallow the raw
  // payload (or stop emitting the focus block entirely) trips both
  // suites consistently.
  const MARKER = "FOCUS_PAYLOAD_MARKER_a91b3c";
  const SNAPSHOT_ID = "snap-focus-aaaa-bbbb";

  it("default chat (no focusPayloads) does NOT emit a <snapshot_focus> block or instruction", () => {
    // Regression guard for the Task #34 contract: opting OUT of focus
    // mode (the default) keeps the prompt JSON-free. If a future
    // refactor accidentally always-passes focusPayloads through, this
    // assertion catches it before it lands in production.
    const { systemPrompt } = buildChatPrompt(
      baseInput({
        latestSnapshot: { receivedAt: new Date("2026-04-01T12:00:00Z") },
      }),
    );
    expect(systemPrompt).not.toContain("<snapshot_focus");
    expect(systemPrompt).not.toContain("</snapshot_focus>");
    expect(systemPrompt).not.toMatch(/snapshot focus.*block[s]? below/i);
  });

  it("focus mode emits a <snapshot_focus> block with the JSON payload AND an instruction line", () => {
    // The block carries the snapshot id (so it lines up with the
    // <framework_atoms> snapshot entry) and the JSON-stringified
    // payload verbatim. The instruction line names the snapshot id
    // in the citation form so the model has an unambiguous attribution
    // target — without that, multi-snapshot debugging becomes a guess.
    const payload = {
      canary: MARKER,
      rooms: [{ number: "204", areaSqft: 312 }],
    };
    const { systemPrompt } = buildChatPrompt(
      baseInput({
        latestSnapshot: {
          receivedAt: new Date("2026-04-01T12:00:00Z"),
          focusPayloads: [{ snapshotId: SNAPSHOT_ID, payload }],
        },
      }),
    );

    expect(systemPrompt).toContain(`<snapshot_focus snapshot_id="${SNAPSHOT_ID}">`);
    expect(systemPrompt).toContain("</snapshot_focus>");
    // Marker proves the actual structured payload is present, not a
    // summary or a placeholder. The room area is the kind of question
    // focus mode exists to answer — assert the data the model would
    // need is in the prompt verbatim.
    expect(systemPrompt).toContain(MARKER);
    expect(systemPrompt).toContain('"number": "204"');
    expect(systemPrompt).toContain('"areaSqft": 312');
    // Instruction line: presence + snapshot-id citation hint. The
    // single-block phrasing is "A `<snapshot_focus>` block below";
    // see the multi-snapshot test for the plural variant.
    expect(systemPrompt).toContain("`<snapshot_focus>` block below");
    expect(systemPrompt).toContain(
      `{{atom:snapshot:${SNAPSHOT_ID}:focus}}`,
    );
  });

  it("focus mode (Task #44) emits one <snapshot_focus> block per id with all snapshot ids cited in the instruction", () => {
    // Comparison-style questions ("how did the room schedule change
    // between yesterday's push and today's?") need the model to mine
    // more than just the latest snapshot's payload. The formatter
    // emits one block per requested id and the instruction line lists
    // every snapshot id as a candidate citation target so the model
    // can attribute each piece of its answer to the correct snapshot.
    const SNAP_A = "snap-aaaa-1111";
    const SNAP_B = "snap-bbbb-2222";
    const MARK_A = "MULTI_FOCUS_PAYLOAD_A_d4f2";
    const MARK_B = "MULTI_FOCUS_PAYLOAD_B_e9a3";
    const { systemPrompt } = buildChatPrompt(
      baseInput({
        latestSnapshot: {
          receivedAt: new Date("2026-04-01T12:00:00Z"),
          focusPayloads: [
            { snapshotId: SNAP_A, payload: { canary: MARK_A } },
            { snapshotId: SNAP_B, payload: { canary: MARK_B } },
          ],
        },
      }),
    );

    expect(systemPrompt).toContain(`<snapshot_focus snapshot_id="${SNAP_A}">`);
    expect(systemPrompt).toContain(`<snapshot_focus snapshot_id="${SNAP_B}">`);
    expect(systemPrompt).toContain(MARK_A);
    expect(systemPrompt).toContain(MARK_B);
    // Plural-block phrasing + per-id citation hints joined by " or "
    // so the model sees each candidate target verbatim.
    expect(systemPrompt).toContain("`<snapshot_focus>` blocks below");
    expect(systemPrompt).toContain(`{{atom:snapshot:${SNAP_A}:focus}}`);
    expect(systemPrompt).toContain(`{{atom:snapshot:${SNAP_B}:focus}}`);
  });

  it("focus mode payload is hard-truncated when JSON exceeds the cap, with a [truncated] marker", () => {
    // Build a payload whose JSON form clears the cap. We ship a
    // single string field full of `x`s — its JSON-encoded length is
    // (chars + 2) for the surrounding quotes, plus the field-name
    // overhead, all comfortably above MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS
    // when we feed in cap+200 raw chars.
    const big = "x".repeat(MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS + 200);
    const block = formatSnapshotFocus(SNAPSHOT_ID, { blob: big });
    // The `[truncated: …]` marker is what the LLM sees; absence of it
    // would mean the cap silently failed and the prompt could blow
    // budget on a degenerate payload.
    expect(block).toContain("[truncated:");
    // Body length stays bounded — the cap (and a small fixed marker
    // suffix) is the upper bound on the inner block size.
    const inner = block.replace(
      `<snapshot_focus snapshot_id="${SNAPSHOT_ID}">\n`,
      "",
    ).replace("\n</snapshot_focus>", "");
    expect(inner.length).toBeLessThanOrEqual(
      MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS + 100,
    );
  });

  it("formatSnapshotFocus emits valid JSON when payload fits under the cap", () => {
    // Round-trip sanity: under the cap we should ship parseable JSON
    // so a human reading the prompt (or a future tool that parses it)
    // can rely on the contents. Above the cap we explicitly do NOT
    // promise valid JSON (see the cap test above).
    const payload = { rooms: [{ id: "r1" }, { id: "r2" }] };
    const block = formatSnapshotFocus(SNAPSHOT_ID, payload);
    const inner = block
      .replace(`<snapshot_focus snapshot_id="${SNAPSHOT_ID}">\n`, "")
      .replace("\n</snapshot_focus>", "");
    expect(() => JSON.parse(inner)).not.toThrow();
    expect(JSON.parse(inner)).toEqual(payload);
  });
});
