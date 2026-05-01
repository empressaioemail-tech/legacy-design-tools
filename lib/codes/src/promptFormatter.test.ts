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
  formatSnapshotFocusBlocks,
  formatSnapshotDiffBlock,
  formatSnapshotDiffBlocks,
  relativeTime,
  shapeSnapshotPayloadForBudget,
  MAX_ATOM_BODY_CHARS,
  MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS,
  MAX_SNAPSHOT_FOCUS_TOTAL_PAYLOAD_CHARS,
  SNAPSHOT_DIFF_NAME_LIMIT,
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
      `{{atom|snapshot|${SNAPSHOT_ID}|focus}}`,
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
    expect(systemPrompt).toContain(`{{atom|snapshot|${SNAP_A}|focus}}`);
    expect(systemPrompt).toContain(`{{atom|snapshot|${SNAP_B}|focus}}`);
  });

  it("focus mode payload over the cap is shape-trimmed (not tail-cut) when shapeable, with a [truncated:] marker", () => {
    // Task #52 changed the per-block over-cap path from raw-JSON
    // tail-cut to a structurally-valid subset chosen by
    // shapeSnapshotPayloadForBudget. A `{ blob: <huge string> }`
    // payload's only key is medium-priority, so the helper drops it
    // outright — the resulting block is tiny but still carries a
    // `[truncated:` marker so the model knows the payload was clipped.
    const big = "x".repeat(MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS + 200);
    const block = formatSnapshotFocus(SNAPSHOT_ID, { blob: big });
    expect(block).toContain("[truncated:");
    expect(block).toContain("shape-trimmed");
    expect(block).toContain("dropped keys: blob");
    // Body length stays bounded — for shapeable payloads we end up
    // well under the per-block cap, not just under it.
    const inner = block
      .replace(`<snapshot_focus snapshot_id="${SNAPSHOT_ID}">\n`, "")
      .replace("\n</snapshot_focus>", "");
    expect(inner.length).toBeLessThanOrEqual(
      MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS + 100,
    );
  });

  it("focus mode falls back to tail-truncation when the helper cannot shape the payload (top-level array)", () => {
    // Top-level arrays / primitives have no key tree to walk, so the
    // smart-trim helper returns the full JSON with fitsBudget=false
    // and the formatter must fall back to tail-truncation. The legacy
    // `[truncated: payload exceeded the focus-mode size cap]` marker
    // (NOT the shape-trim marker) signals this fallback.
    const big = "x".repeat(MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS + 200);
    const block = formatSnapshotFocus(SNAPSHOT_ID, [{ blob: big }]);
    expect(block).toContain(
      "[truncated: payload exceeded the focus-mode size cap]",
    );
    expect(block).not.toContain("shape-trimmed");
    const inner = block
      .replace(`<snapshot_focus snapshot_id="${SNAPSHOT_ID}">\n`, "")
      .replace("\n</snapshot_focus>", "");
    expect(inner.length).toBeLessThanOrEqual(
      MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS + 100,
    );
  });

  it("formatSnapshotFocus emits valid JSON when payload fits under the per-block cap", () => {
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

describe("formatSnapshotFocusBlocks: cumulative cap (Task #47)", () => {
  // Helper that produces a payload whose JSON-serialized form is at
  // least `chars` characters long. Wrapped in a top-level array so the
  // smart-trim helper from Task #52 (which only shapes plain objects)
  // falls through to tail-truncation — these tests exercise the
  // *fallback* tail-truncation path that backstops the cumulative cap.
  // The companion suite below covers the smart-trim path against the
  // same cap.
  function payloadOfRoughSize(
    chars: number,
  ): ReadonlyArray<{ canary: string; blob: string }> {
    return [{ canary: "CANARY", blob: "x".repeat(chars) }];
  }

  it("single block under the per-block cap is emitted intact (no cumulative-cap marker)", () => {
    // Smoke test for the fits-fine path: one focus payload, comfortably
    // under both caps. The combined-cap downgrade markers must not
    // appear — they're reserved for the cumulative-cap path.
    const { blocks, stats } = formatSnapshotFocusBlocks([
      { snapshotId: "snap-only-1", payload: payloadOfRoughSize(1_000) },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain(`<snapshot_focus snapshot_id="snap-only-1">`);
    expect(blocks[0]).toContain("</snapshot_focus>");
    expect(blocks[0]).not.toContain("[truncated:");
    // Cumulative size stays under both caps.
    expect(blocks[0].length).toBeLessThan(MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS);
    expect(blocks[0].length).toBeLessThan(
      MAX_SNAPSHOT_FOCUS_TOTAL_PAYLOAD_CHARS,
    );
    // Stats: every count is zero except `intactCount` and `totalCount`.
    expect(stats).toEqual({
      totalCount: 1,
      intactCount: 1,
      combinedCapTruncatedCount: 0,
      combinedCapOmittedCount: 0,
    });
  });

  it("multiple blocks whose combined size fits under the cumulative cap are all intact", () => {
    // Four moderate payloads that together stay well under the
    // cumulative cap. None should be truncated and the canary string
    // should appear once per block (proving raw payloads were
    // preserved end-to-end).
    const each = 5_000;
    const { blocks, stats } = formatSnapshotFocusBlocks([
      { snapshotId: "snap-a", payload: payloadOfRoughSize(each) },
      { snapshotId: "snap-b", payload: payloadOfRoughSize(each) },
      { snapshotId: "snap-c", payload: payloadOfRoughSize(each) },
      { snapshotId: "snap-d", payload: payloadOfRoughSize(each) },
    ]);
    expect(blocks).toHaveLength(4);
    for (const b of blocks) {
      expect(b).not.toContain("[truncated:");
      expect(b).toContain("CANARY");
    }
    const combined = blocks.reduce((sum, b) => sum + b.length, 0);
    expect(combined).toBeLessThan(MAX_SNAPSHOT_FOCUS_TOTAL_PAYLOAD_CHARS);
    // Stats: nothing was downgraded by the cumulative cap.
    expect(stats).toEqual({
      totalCount: 4,
      intactCount: 4,
      combinedCapTruncatedCount: 0,
      combinedCapOmittedCount: 0,
    });
  });

  it("combined cap fires: first block stays intact, later blocks are progressively trimmed with the cumulative-cap marker", () => {
    // Each payload's JSON form is just over the per-block cap, so each
    // individual block lands at ~per-block-cap chars after the existing
    // per-block truncation. With 4 of them, the worst-case combined
    // size would be ~240 KB — well above the 120 KB cumulative cap.
    const oversized = MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS + 5_000;
    const { blocks, stats } = formatSnapshotFocusBlocks([
      { snapshotId: "snap-1st", payload: payloadOfRoughSize(oversized) },
      { snapshotId: "snap-2nd", payload: payloadOfRoughSize(oversized) },
      { snapshotId: "snap-3rd", payload: payloadOfRoughSize(oversized) },
      { snapshotId: "snap-4th", payload: payloadOfRoughSize(oversized) },
    ]);
    expect(blocks).toHaveLength(4);

    // First block: intact (subject to the per-block cap, which fires
    // here too — but NOT the cumulative-cap marker, which is reserved
    // for downgrades caused by the combined budget).
    expect(blocks[0]).toContain(`<snapshot_focus snapshot_id="snap-1st">`);
    expect(blocks[0]).toContain(
      "[truncated: payload exceeded the focus-mode size cap]",
    );
    expect(blocks[0]).not.toContain(
      "[truncated: combined snapshot focus payloads exceeded the cumulative size cap",
    );
    // Per-block cap bounds the first block.
    expect(blocks[0].length).toBeLessThanOrEqual(
      MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS + 200,
    );

    // At least one subsequent block must carry the combined-cap
    // marker — that's the whole point of the cumulative cap firing.
    const downgraded = blocks
      .slice(1)
      .filter((b) =>
        b.includes(
          "[truncated: combined snapshot focus payloads exceeded the cumulative size cap",
        ),
      );
    expect(downgraded.length).toBeGreaterThan(0);

    // Every block, including the last, retains its `<snapshot_focus
    // snapshot_id="…">` shell so the snapshot ids stay citable in the
    // instruction line above.
    expect(blocks[1]).toContain(`<snapshot_focus snapshot_id="snap-2nd">`);
    expect(blocks[2]).toContain(`<snapshot_focus snapshot_id="snap-3rd">`);
    expect(blocks[3]).toContain(`<snapshot_focus snapshot_id="snap-4th">`);
    for (const b of blocks) {
      expect(b).toContain("</snapshot_focus>");
    }

    // The cumulative size of the emitted blocks must respect the
    // cumulative cap (with a small allowance for the marker and the
    // first block, which is always kept intact). The first block can
    // be up to MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS, and the rest must
    // collectively stay under the remaining cumulative budget.
    const combined = blocks.reduce((sum, b) => sum + b.length, 0);
    expect(combined).toBeLessThanOrEqual(
      MAX_SNAPSHOT_FOCUS_TOTAL_PAYLOAD_CHARS + 500,
    );

    // Stats (Task #51): one block was kept intact (the first), and
    // the remaining three were downgraded by the cumulative cap. The
    // counts must add up to totalCount and at least one downgrade
    // category must be non-zero so the chat route's warn fires.
    expect(stats.totalCount).toBe(4);
    expect(stats.intactCount).toBe(1);
    expect(
      stats.combinedCapTruncatedCount + stats.combinedCapOmittedCount,
    ).toBe(3);
    expect(stats.combinedCapTruncatedCount).toBeGreaterThan(0);
  });

  it("stats reports omitted blocks when the cumulative budget is fully spent before later entries fit", () => {
    // Four oversized payloads — the first block lands at the per-block
    // cap (~60 KB), the second downgrades to a partial body that uses
    // up most of the remaining budget, and the third/fourth end up
    // with zero or near-zero room. We assert the omitted-count
    // category is exercised so chat.ts's warn payload distinguishes
    // partial trims from full omissions (operators tuning the cap
    // care about that distinction).
    const oversized = MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS + 5_000;
    const { blocks, stats } = formatSnapshotFocusBlocks([
      { snapshotId: "snap-1st", payload: payloadOfRoughSize(oversized) },
      { snapshotId: "snap-2nd", payload: payloadOfRoughSize(oversized) },
      { snapshotId: "snap-3rd", payload: payloadOfRoughSize(oversized) },
      { snapshotId: "snap-4th", payload: payloadOfRoughSize(oversized) },
    ]);
    expect(blocks).toHaveLength(4);
    expect(stats.totalCount).toBe(4);
    // The category sums must agree with the block count.
    expect(
      stats.intactCount +
        stats.combinedCapTruncatedCount +
        stats.combinedCapOmittedCount,
    ).toBe(4);
    // For the 4×oversized worst case at least one block is omitted
    // (cumulative budget = ~120 KB; first block alone consumes ~60 KB,
    // second block's truncated form chews most of the remaining
    // budget). If this ever stops being true we want the omitted
    // category to be exercised by another test instead — silently
    // skipping it would leave the chat route's stat untested.
    expect(stats.combinedCapOmittedCount).toBeGreaterThan(0);
  });

  it("buildChatPrompt wires the cumulative cap through so the system prompt stays bounded", () => {
    // End-to-end check: the buildChatPrompt path (the one chat.ts
    // actually calls) must use formatSnapshotFocusBlocks, not the
    // raw per-block helper. Without the wiring fix from Task #47 the
    // emitted system prompt would carry ~240 KB of payload bytes for
    // 4 oversized snapshots; we assert the actual cumulative size of
    // the snapshot focus blocks inside the system prompt is bounded.
    const oversized = MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS + 5_000;
    const { systemPrompt, snapshotFocusStats } = buildChatPrompt({
      engagement: {
        name: "Cap Test",
        address: null,
        jurisdiction: null,
      },
      latestSnapshot: {
        receivedAt: new Date("2026-04-01T12:00:00Z"),
        focusPayloads: [
          { snapshotId: "snap-cap-1", payload: payloadOfRoughSize(oversized) },
          { snapshotId: "snap-cap-2", payload: payloadOfRoughSize(oversized) },
          { snapshotId: "snap-cap-3", payload: payloadOfRoughSize(oversized) },
          { snapshotId: "snap-cap-4", payload: payloadOfRoughSize(oversized) },
        ],
      },
      allAtoms: [],
      attachedSheets: [],
      question: "compare these snapshots",
      now: () => new Date("2026-04-01T12:00:30Z"),
    });

    // Sum the total bytes inside `<snapshot_focus …>…</snapshot_focus>`
    // wrappers in the emitted prompt and verify it respects the cap.
    const re = /<snapshot_focus [^>]*>[\s\S]*?<\/snapshot_focus>/g;
    const matches: string[] = systemPrompt.match(re) ?? [];
    expect(matches).toHaveLength(4);
    const combined = matches.reduce((sum, m) => sum + m.length, 0);
    expect(combined).toBeLessThanOrEqual(
      MAX_SNAPSHOT_FOCUS_TOTAL_PAYLOAD_CHARS + 500,
    );
    // And the cumulative-cap marker must appear at least once,
    // proving the cap actually fired (not just coincidentally fit).
    expect(systemPrompt).toContain(
      "combined snapshot focus payloads exceeded the cumulative size cap",
    );
    // Task #51: buildChatPrompt's output must surface the per-turn
    // downgrade stats so chat.ts can log + warn on them without
    // re-parsing the prompt for marker strings.
    expect(snapshotFocusStats.totalCount).toBe(4);
    expect(snapshotFocusStats.intactCount).toBe(1);
    expect(
      snapshotFocusStats.combinedCapTruncatedCount +
        snapshotFocusStats.combinedCapOmittedCount,
    ).toBe(3);
  });

  it("buildChatPrompt returns zeroed snapshotFocusStats when focus mode is off (Task #51)", () => {
    // Default chat path leaves focusPayloads empty — the stats field
    // must still be present (so the chat route can log a stable
    // shape) but every count is zero. Without this contract chat.ts
    // would have to special-case the no-focus turn, which defeats the
    // point of returning the stats unconditionally.
    const { snapshotFocusStats } = buildChatPrompt({
      engagement: {
        name: "No Focus",
        address: null,
        jurisdiction: null,
      },
      latestSnapshot: {
        receivedAt: new Date("2026-04-01T12:00:00Z"),
      },
      allAtoms: [],
      attachedSheets: [],
      question: "any question",
      now: () => new Date("2026-04-01T12:00:30Z"),
    });
    expect(snapshotFocusStats).toEqual({
      totalCount: 0,
      intactCount: 0,
      combinedCapTruncatedCount: 0,
      combinedCapOmittedCount: 0,
    });
  });
});

describe("shapeSnapshotPayloadForBudget: smart trim (Task #52)", () => {
  // Helper: build a top-level key whose JSON-stringified value clears
  // the requested character budget. Wrapping in an object ensures the
  // helper actually walks the key tree (top-level arrays/primitives
  // are intentionally not shapeable).
  function bigString(chars: number): string {
    return "x".repeat(chars);
  }

  it("returns the full JSON verbatim when it already fits the budget", () => {
    const payload = { rooms: [{ id: "r1", area: 100 }] };
    const result = shapeSnapshotPayloadForBudget(payload, 10_000);
    expect(result.fitsBudget).toBe(true);
    expect(result.trimmed).toBe(false);
    expect(result.droppedKeys).toEqual([]);
    expect(result.truncatedArrays).toEqual([]);
    expect(JSON.parse(result.json)).toEqual(payload);
  });

  it("drops low-priority keys before medium-priority keys", () => {
    // `families` is low priority, `customField` is medium. With a
    // budget that forces dropping exactly one, the helper must shed
    // `families` and keep `customField` intact.
    const payload = {
      families: { lib: bigString(5_000) },
      customField: { value: "keep-me" },
    };
    const fullSize = JSON.stringify(payload, null, 2).length;
    const budget = fullSize - 1_000;
    const result = shapeSnapshotPayloadForBudget(payload, budget);
    expect(result.fitsBudget).toBe(true);
    expect(result.trimmed).toBe(true);
    expect(result.droppedKeys).toContain("families");
    expect(result.droppedKeys).not.toContain("customField");
    const parsed = JSON.parse(result.json);
    expect(parsed.families).toBeUndefined();
    expect(parsed.customField).toEqual({ value: "keep-me" });
  });

  it("drops medium-priority keys before high-priority keys", () => {
    // `unknownKey` is medium, `rooms` is high. Budget forces dropping
    // one — must be the medium one.
    const payload = {
      unknownKey: { lib: bigString(5_000) },
      rooms: [{ id: "r1", area: 100 }],
    };
    const fullSize = JSON.stringify(payload, null, 2).length;
    const budget = fullSize - 1_000;
    const result = shapeSnapshotPayloadForBudget(payload, budget);
    expect(result.fitsBudget).toBe(true);
    expect(result.droppedKeys).toContain("unknownKey");
    expect(result.droppedKeys).not.toContain("rooms");
    const parsed = JSON.parse(result.json);
    expect(parsed.unknownKey).toBeUndefined();
    expect(parsed.rooms).toEqual([{ id: "r1", area: 100 }]);
  });

  it("shrinks high-priority arrays before dropping them", () => {
    // Only one high-priority key, payload over budget. Phase 3 must
    // halve the array length until it fits — Phase 4's drop-the-key
    // path must NOT fire.
    const rooms = Array.from({ length: 1_000 }, (_, i) => ({
      id: `room-${i}`,
      area: 100 + i,
      department: "Lab",
    }));
    const payload = { rooms };
    const result = shapeSnapshotPayloadForBudget(payload, 5_000);
    expect(result.fitsBudget).toBe(true);
    expect(result.trimmed).toBe(true);
    expect(result.droppedKeys).toEqual([]);
    expect(result.truncatedArrays).toHaveLength(1);
    const trim = result.truncatedArrays[0];
    expect(trim.key).toBe("rooms");
    expect(trim.total).toBe(1_000);
    expect(trim.kept).toBeLessThan(1_000);
    expect(trim.kept).toBeGreaterThan(0);
    // The retained items are a leading slice of the original array
    // (callers can rely on the first N being preserved for stable
    // comparison questions).
    const parsed = JSON.parse(result.json);
    expect(parsed.rooms).toHaveLength(trim.kept);
    expect(parsed.rooms[0]).toEqual(rooms[0]);
    expect(parsed.rooms[trim.kept - 1]).toEqual(rooms[trim.kept - 1]);
  });

  it("falls back to dropping high-priority keys as a last resort", () => {
    // A single high-priority key whose value is one giant primitive
    // (not an array) cannot be shrunk via Phase 3, so Phase 4 must
    // drop the key outright. The helper still returns parseable JSON.
    const payload = { rooms: bigString(20_000) };
    const result = shapeSnapshotPayloadForBudget(payload, 1_000);
    expect(result.fitsBudget).toBe(true);
    expect(result.droppedKeys).toContain("rooms");
    const parsed = JSON.parse(result.json);
    expect(parsed.rooms).toBeUndefined();
  });

  it("always returns parseable JSON, even when heavily trimmed", () => {
    // Mixed payload across all three priorities; budget forces
    // aggressive trimming. The result MUST still parse — this is the
    // core contract distinguishing smart trim from tail-truncation.
    const payload = {
      families: { lib: bigString(3_000) },
      materials: { lib: bigString(3_000) },
      customA: { lib: bigString(3_000) },
      customB: { lib: bigString(3_000) },
      rooms: Array.from({ length: 500 }, (_, i) => ({ id: `r-${i}` })),
      doors: Array.from({ length: 500 }, (_, i) => ({ id: `d-${i}` })),
    };
    const result = shapeSnapshotPayloadForBudget(payload, 2_000);
    expect(result.fitsBudget).toBe(true);
    expect(result.json.length).toBeLessThanOrEqual(2_000);
    expect(() => JSON.parse(result.json)).not.toThrow();
    // Low-priority keys went first.
    expect(result.droppedKeys).toContain("families");
    expect(result.droppedKeys).toContain("materials");
    // Low-priority drops appear before high-priority drops in the
    // shed order.
    const familiesIdx = result.droppedKeys.indexOf("families");
    const roomsIdx = result.droppedKeys.indexOf("rooms");
    if (roomsIdx >= 0) {
      expect(familiesIdx).toBeLessThan(roomsIdx);
    }
  });

  it("returns fitsBudget=false (and full JSON) when payload is a top-level array", () => {
    // The helper only walks plain object keys; arrays/primitives are
    // returned verbatim so the caller can fall back to tail-truncation.
    const payload = [{ blob: bigString(5_000) }];
    const result = shapeSnapshotPayloadForBudget(payload, 1_000);
    expect(result.fitsBudget).toBe(false);
    expect(result.trimmed).toBe(false);
    expect(result.droppedKeys).toEqual([]);
    expect(result.truncatedArrays).toEqual([]);
    expect(JSON.parse(result.json)).toEqual(payload);
  });

  it("returns fitsBudget=false (and full JSON) when payload is a primitive", () => {
    const payload = bigString(5_000);
    const result = shapeSnapshotPayloadForBudget(payload, 1_000);
    expect(result.fitsBudget).toBe(false);
    expect(result.trimmed).toBe(false);
    expect(JSON.parse(result.json)).toEqual(payload);
  });

  it("recurses into a high-priority sub-tree to peel out a low-priority nested branch (Task #60)", () => {
    // Real-shape Revit case: `schedules` carries both useful data
    // (rooms) AND a noisy nested branch (warnings) that's by far the
    // largest contributor. The pre-Task-#60 helper would Phase-4 drop
    // the entire `schedules` key. With recursion the helper peels
    // `schedules.warnings` out from inside `schedules` and keeps
    // `schedules.rooms` intact.
    const warnings = Array.from({ length: 200 }, (_, i) => ({
      id: i,
      msg: bigString(80),
    }));
    const rooms = [
      { id: "r1", area: 100 },
      { id: "r2", area: 120 },
    ];
    const payload = { schedules: { rooms, warnings } };
    // Tight enough to force a trim, loose enough to keep `rooms`.
    const result = shapeSnapshotPayloadForBudget(payload, 2_000);
    expect(result.fitsBudget).toBe(true);
    expect(result.trimmed).toBe(true);
    // The noisy nested branch is dropped via dotted path; the parent
    // `schedules` survives so its useful sub-key is preserved.
    expect(result.droppedKeys).toContain("schedules.warnings");
    expect(result.droppedKeys).not.toContain("schedules");
    const parsed = JSON.parse(result.json);
    expect(parsed.schedules).toBeDefined();
    expect(parsed.schedules.rooms).toEqual(rooms);
    expect(parsed.schedules.warnings).toBeUndefined();
  });

  it("recurses into a low-priority parent that hides a high-value nested branch (Task #60)", () => {
    // `metadata` is low-priority, but here it carries a nested
    // `rooms` branch that the chat experience cares about. The
    // recursive pass must shed only the noisy `metadata.lib` blob
    // and keep `metadata.rooms` rather than dropping `metadata`
    // wholesale (which would lose the rooms data).
    const rooms = [{ id: "r1", area: 100 }];
    const payload = {
      metadata: { lib: bigString(5_000), rooms },
      customField: { value: "keep-me" },
    };
    const fullSize = JSON.stringify(payload, null, 2).length;
    const budget = fullSize - 4_000;
    const result = shapeSnapshotPayloadForBudget(payload, budget);
    expect(result.fitsBudget).toBe(true);
    expect(result.trimmed).toBe(true);
    expect(result.droppedKeys).toContain("metadata.lib");
    expect(result.droppedKeys).not.toContain("metadata");
    const parsed = JSON.parse(result.json);
    expect(parsed.metadata).toEqual({ rooms });
    expect(parsed.customField).toEqual({ value: "keep-me" });
  });

  it("records nested array truncations with dotted paths (Task #60)", () => {
    // A high-priority parent carrying a nested high-priority array.
    // Phase 3 at depth 1 must shrink the array and report the
    // `schedules.rooms` dotted path so downstream UI / logging can
    // attribute exactly which branch shrank.
    const rooms = Array.from({ length: 500 }, (_, i) => ({
      id: `r-${i}`,
      area: 100 + i,
      department: "Lab",
    }));
    const payload = { schedules: { rooms } };
    const result = shapeSnapshotPayloadForBudget(payload, 1_500);
    expect(result.fitsBudget).toBe(true);
    expect(result.droppedKeys).not.toContain("schedules");
    expect(result.truncatedArrays).toHaveLength(1);
    const trim = result.truncatedArrays[0];
    expect(trim.key).toBe("schedules.rooms");
    expect(trim.total).toBe(500);
    expect(trim.kept).toBeLessThan(500);
    expect(trim.kept).toBeGreaterThan(0);
    const parsed = JSON.parse(result.json);
    expect(parsed.schedules.rooms).toHaveLength(trim.kept);
  });

  it("falls back to dropping the parent when recursion empties out the value (no `{}` left behind)", () => {
    // `unknownKey` is medium priority and its only sub-key is also
    // unknown (medium). The recursive pass would shed `unknownKey.lib`
    // but that empties the value out; in that case the helper should
    // prefer dropping the parent rather than emitting a confusing
    // empty-object literal.
    const payload = {
      unknownKey: { lib: bigString(5_000) },
      rooms: [{ id: "r1", area: 100 }],
    };
    const fullSize = JSON.stringify(payload, null, 2).length;
    const budget = fullSize - 1_000;
    const result = shapeSnapshotPayloadForBudget(payload, budget);
    expect(result.fitsBudget).toBe(true);
    expect(result.droppedKeys).toContain("unknownKey");
    expect(result.droppedKeys).not.toContain("unknownKey.lib");
    const parsed = JSON.parse(result.json);
    expect(parsed.unknownKey).toBeUndefined();
    expect(parsed.rooms).toEqual([{ id: "r1", area: 100 }]);
  });

  it("formatSnapshotFocus uses smart trim and embeds a structurally-valid JSON subset", () => {
    // End-to-end: feed an over-cap payload through the public
    // formatter and confirm (a) the inner body parses as JSON minus
    // the trailing marker, (b) the high-value `rooms` data was
    // preserved, (c) low-priority `families` data was shed.
    const families = { lib: bigString(MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS) };
    const rooms = [{ id: "r1", area: 100 }];
    const block = formatSnapshotFocus("snap-shape-1", { families, rooms });
    expect(block).toContain("[truncated:");
    expect(block).toContain("shape-trimmed");
    expect(block).toContain("dropped keys: families");
    // Carve out the inner body, drop the trailing marker line, and
    // confirm what's left is parseable JSON containing the rooms.
    const inner = block
      .replace(`<snapshot_focus snapshot_id="snap-shape-1">\n`, "")
      .replace("\n</snapshot_focus>", "");
    const markerLineStart = inner.lastIndexOf("\n[truncated:");
    expect(markerLineStart).toBeGreaterThan(-1);
    const jsonOnly = inner.slice(0, markerLineStart);
    const parsed = JSON.parse(jsonOnly);
    expect(parsed.rooms).toEqual(rooms);
    expect(parsed.families).toBeUndefined();
  });

  it("formatSnapshotFocusBlocks uses smart trim for cumulative-cap downgrades (still emits a structurally-valid subset)", () => {
    // Four shapeable payloads, each with a giant low-priority `families`
    // blob plus a small high-priority `rooms` array. Without smart
    // trim each block would tail-truncate to ~60 KB and the cumulative
    // cap would have to fire; with smart trim each block shape-trims
    // to a few hundred bytes and the prompt stays compact.
    const families = { lib: bigString(MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS) };
    const { blocks, stats } = formatSnapshotFocusBlocks([
      { snapshotId: "ss-1", payload: { families, rooms: [{ id: "r1" }] } },
      { snapshotId: "ss-2", payload: { families, rooms: [{ id: "r2" }] } },
      { snapshotId: "ss-3", payload: { families, rooms: [{ id: "r3" }] } },
      { snapshotId: "ss-4", payload: { families, rooms: [{ id: "r4" }] } },
    ]);
    expect(blocks).toHaveLength(4);
    for (const b of blocks) {
      expect(b).toContain("shape-trimmed");
      expect(b).toContain("dropped keys: families");
      // Each block stays well under the per-block cap (smart trim
      // collapses it to a few hundred bytes).
      expect(b.length).toBeLessThan(2_000);
    }
    // Combined size must respect the cumulative cap.
    const combined = blocks.reduce((sum, b) => sum + b.length, 0);
    expect(combined).toBeLessThanOrEqual(
      MAX_SNAPSHOT_FOCUS_TOTAL_PAYLOAD_CHARS,
    );
    // High-priority `rooms` data is preserved on every block.
    expect(blocks[0]).toContain('"r1"');
    expect(blocks[1]).toContain('"r2"');
    expect(blocks[2]).toContain('"r3"');
    expect(blocks[3]).toContain('"r4"');
    // Per-block cap collapsed each block to a few hundred bytes via
    // `formatSnapshotFocus`, so the cumulative cap was never under
    // pressure — every block fits intact in the cumulative pass and
    // no cumulative-cap downgrade fires. (The companion test below
    // covers the case where the cumulative cap DOES drive the smart
    // trim and stats counters must increment.)
    expect(stats.totalCount).toBe(4);
    expect(stats.intactCount).toBe(4);
    expect(stats.combinedCapTruncatedCount).toBe(0);
    expect(stats.combinedCapOmittedCount).toBe(0);
  });

  it("formatSnapshotFocusBlocks counts the smart-trim cumulative-cap branch as a downgrade (so chat-route warn fires for real Revit pushes)", () => {
    // Task #68: the cumulative-cap smart-trim branch (the one that
    // emits a structurally-valid JSON subset + COMBINED_CAP_TRUNC_MARKER
    // because the per-snapshot budget LEFT by the running cumulative
    // tally is too small for the intact block) used to NOT increment
    // `combinedCapTruncatedCount`. As a result the chat route's
    // `downgradedCount > 0` warn ("snapshot focus payloads downgraded
    // by cumulative cap") never fired for shapeable object payloads
    // — exactly the shape real Revit pushes have. This test pins the
    // counter so the regression cannot recur silently.
    //
    // Sizing rationale (per-block cap = 60K, cumulative cap = 120K):
    //   Each payload is ~45K stringified — under the per-block cap
    //   (so `formatSnapshotFocus` returns it intact) and shapeable
    //   (top-level object, low-priority bulk in `families`, small
    //   high-priority `rooms`).
    //
    //   Cumulative pass:
    //     block 1: emitted intact, cumulative ~45K
    //     block 2: emitted intact, cumulative ~90K
    //     block 3: full block ~45K wouldn't fit (remaining ~30K) →
    //              re-enter smart trim with reduced budget → drops
    //              `families`, fits → COMBINED_CAP_TRUNC_MARKER
    //              branch + counter increment
    //     block 4: even less remaining → smart-trimmed too
    const families = { lib: bigString(45_000) };
    const { blocks, stats } = formatSnapshotFocusBlocks([
      { snapshotId: "ss-1", payload: { families, rooms: [{ id: "r1" }] } },
      { snapshotId: "ss-2", payload: { families, rooms: [{ id: "r2" }] } },
      { snapshotId: "ss-3", payload: { families, rooms: [{ id: "r3" }] } },
      { snapshotId: "ss-4", payload: { families, rooms: [{ id: "r4" }] } },
    ]);
    expect(blocks).toHaveLength(4);

    // The first two blocks are intact: no cumulative-cap marker, the
    // bulky `families.lib` filler is preserved verbatim.
    for (const b of blocks.slice(0, 2)) {
      expect(b).not.toContain(
        "combined snapshot focus payloads exceeded the cumulative size cap",
      );
    }
    expect(blocks[0]).toContain(bigString(45_000));

    // Blocks 3 + 4 carry the cumulative-cap marker AND a structurally-
    // valid JSON subset (the smart-trim path, not the tail-cut path).
    for (const b of blocks.slice(2)) {
      expect(b).toContain(
        "combined snapshot focus payloads exceeded the cumulative size cap",
      );
      // Smart-trim emits valid JSON (no trailing "…" tail-cut
      // sentinel) and the high-priority `rooms` data survives.
      expect(b).not.toContain("…");
    }
    expect(blocks[2]).toContain('"r3"');
    expect(blocks[3]).toContain('"r4"');

    // Cumulative cap is respected.
    const combined = blocks.reduce((sum, b) => sum + b.length, 0);
    expect(combined).toBeLessThanOrEqual(
      MAX_SNAPSHOT_FOCUS_TOTAL_PAYLOAD_CHARS,
    );

    // The point of the task: stats counters MUST attribute the smart-
    // trim downgrade to `combinedCapTruncatedCount` so chat-route
    // alerting (`downgradedCount = combinedCapTruncatedCount +
    // combinedCapOmittedCount`) fires for the realistic shapeable-
    // object case (real Revit pushes), not just for top-level arrays
    // / primitives that fall through to the tail-truncation branch.
    expect(stats.totalCount).toBe(4);
    expect(stats.intactCount).toBe(2);
    expect(stats.combinedCapTruncatedCount).toBe(2);
    expect(stats.combinedCapOmittedCount).toBe(0);
  });

  // --------------------------------------------------------------
  // Task #61: fixture-driven test against a realistic Revit-shaped
  // payload. The fixture mirrors the top-level keys observed in real
  // production `snapshots.payload` rows (rooms/sheets/levels arrays,
  // doors/windows/walls count+family objects, project-identity
  // scalars like address/projectName/projectNumber, plus the noise
  // keys: activeViewName/activeViewType, units, and the snapshot
  // ingest request envelope fields engagementId/createNewEngagement
  // /revitCentralGuid/revitDocumentPath that the route stores
  // verbatim because `payload = req.body`).
  //
  // Audit provenance — the validated key list was enumerated by
  // running this against the production replica (15 rows across 4
  // engagements: Snowdon Towers, 3514 E ARENA ROJA, Jones Garage_B,
  // Balsley):
  //
  //   SELECT DISTINCT top_key
  //   FROM (
  //     SELECT jsonb_object_keys(payload::jsonb) AS top_key
  //     FROM snapshots
  //     WHERE jsonb_typeof(payload::jsonb) = 'object'
  //   ) keys
  //   ORDER BY top_key;
  //
  // The 20 distinct keys observed (capturedAt + documentPath are
  // medium-priority — small scalars carrying low chat signal but
  // enough provenance value to stay unranked):
  //   activeViewName, activeViewType, address, capturedAt,
  //   clientName, createNewEngagement, documentPath, documentTitle,
  //   doors, engagementId, levels, projectName, projectNumber,
  //   revitCentralGuid, revitDocumentPath, rooms, sheets, units,
  //   walls, windows.
  //
  // No occurrences of the existing low-priority Revit-metadata names
  // (families/materials/parameters/warnings/...) or the high-priority
  // schedules/spaces/areas/projectInformation defensive entries; those
  // are kept because they match Revit conventions and we want the
  // priority order locked before the first push that includes them
  // hits production.
  //
  // The fixture is deliberately inflated past the per-block cap by
  // bloating a medium-priority `customBloat` branch so the helper has
  // to make actual prioritisation decisions — not just trim a single
  // pathological key. The assertions guard the intent of the priority
  // sets: validated low-priority + envelope keys go FIRST, unknown
  // medium keys go BEFORE the high-priority set, and the project-
  // identity scalars that the chat answer needs survive.
  // --------------------------------------------------------------
  it("realistic Revit-shaped over-cap payload preserves project-identity + structural-element keys and sheds capture-time / envelope noise first", () => {
    // Mirror the real production shape (Snowdon Towers et al.).
    // Numbers/strings are illustrative; what matters is that every
    // key on the priority sets is present so the helper has to
    // actually choose between them.
    const fixture: Record<string, unknown> = {
      // High-priority structural collections.
      rooms: Array.from({ length: 200 }, (_, i) => ({
        name: `Room ${i + 1}`,
        level: `L1 - Block ${i % 10}`,
        number: String(101 + i),
        areaSqFt: 100 + i,
      })),
      sheets: Array.from({ length: 80 }, (_, i) => ({
        name: `Sheet ${i + 1}`,
        number: `A${100 + i}`,
        viewCount: 1,
      })),
      levels: Array.from({ length: 18 }, (_, i) => ({
        name: `Level ${i + 1}`,
        elevationFeet: -16.9 + i * 10,
      })),
      doors: { count: 142, doorFamilies: ["Door-Single-Flush", "Door-Double"] },
      windows: { count: 106, windowFamilies: ["Window-Fixed", "Window-Sliding"] },
      walls: {
        count: 1152,
        wallTypes: ["Block 37 Pilaster", "Core - Concrete 12\""],
        totalLengthFeet: 12750.2,
      },
      // High-priority project-identity scalars (small, but they
      // must survive even an aggressive squeeze so chat can answer
      // "what's the address?" / "what's the project number?").
      address: "1 Main St, Moab, UT 84532",
      projectName: "Snowdon Towers",
      projectNumber: "2024-001",
      documentTitle: "Snowdon Towers - Architecture",
      clientName: "Block 37 LLC",
      // Capture-time view metadata (low-priority — should be shed
      // first even though it's tiny).
      activeViewName: "Cover",
      activeViewType: "DrawingSheet",
      // Units-system marker (low-priority).
      units: "feetFractionalInches-1.0.0",
      // Snapshot ingest request envelope (low-priority — request
      // metadata, not Revit content).
      engagementId: "00000000-0000-0000-0000-000000000001",
      createNewEngagement: false,
      revitCentralGuid: "abc-revit-guid",
      revitDocumentPath: "C:/Projects/SnowdonTowers.rvt",
      // Medium-priority unknown keys: a chunky one (the squeeze
      // target) and a small one (the survivor probe). `customMeta`
      // is small enough to survive after the bloated key is shed.
      customBloat: {
        notes: bigString(40_000),
      },
      customMeta: { reviewer: "alice", lastReview: "2026-04-30" },
    };

    // Confirm the fixture actually exceeds the per-block cap before
    // we ask the helper to shape it — otherwise the assertions
    // below would silently exercise the no-trim happy path.
    const fullSize = JSON.stringify(fixture, null, 2).length;
    expect(fullSize).toBeGreaterThan(MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS);

    const result = shapeSnapshotPayloadForBudget(
      fixture,
      MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS,
    );

    expect(result.fitsBudget).toBe(true);
    expect(result.trimmed).toBe(true);
    expect(result.json.length).toBeLessThanOrEqual(
      MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS,
    );
    expect(() => JSON.parse(result.json)).not.toThrow();

    const parsed = JSON.parse(result.json) as Record<string, unknown>;

    // The validated low-priority keys must all be among the first
    // dropped — no high-priority key may be dropped before any of
    // them. (The fixture is sized so the squeeze stops well before
    // Phase 4 has to drop any high-priority key, but we still want
    // the *order* invariant locked.)
    const lowPriorityValidated = [
      "activeViewName",
      "activeViewType",
      "units",
      "engagementId",
      "createNewEngagement",
      "revitCentralGuid",
      "revitDocumentPath",
    ];
    for (const lowKey of lowPriorityValidated) {
      const lowIdx = result.droppedKeys.indexOf(lowKey);
      // It is OK for a low-priority key to NOT be dropped (the
      // squeeze may have completed before reaching it). What's not
      // OK is for it to be shed AFTER any high-priority key.
      if (lowIdx < 0) continue;
      for (const highKey of HIGH_PRIORITY_VALIDATED_KEYS) {
        const highIdx = result.droppedKeys.indexOf(highKey);
        if (highIdx >= 0) {
          expect(lowIdx).toBeLessThan(highIdx);
        }
      }
    }

    // The bloated medium-priority key is the squeeze target — it
    // must be dropped, and it must be dropped AFTER the validated
    // low-priority keys present in the dropped set.
    expect(result.droppedKeys).toContain("customBloat");
    for (const lowKey of lowPriorityValidated) {
      const lowIdx = result.droppedKeys.indexOf(lowKey);
      const bloatIdx = result.droppedKeys.indexOf("customBloat");
      if (lowIdx >= 0) {
        expect(lowIdx).toBeLessThan(bloatIdx);
      }
    }

    // The small medium-priority survivor probe (`customMeta`) is
    // expected to survive — the helper stops the squeeze as soon as
    // it fits, and dropping the bloated key alone clears the budget.
    expect(parsed.customMeta).toEqual({
      reviewer: "alice",
      lastReview: "2026-04-30",
    });

    // Project-identity scalars and structural-element collections —
    // the validated high-priority keys — must all survive. This is
    // the core contract chat answers depend on.
    expect(parsed.address).toBe("1 Main St, Moab, UT 84532");
    expect(parsed.projectName).toBe("Snowdon Towers");
    expect(parsed.projectNumber).toBe("2024-001");
    expect(parsed.documentTitle).toBe("Snowdon Towers - Architecture");
    expect(parsed.clientName).toBe("Block 37 LLC");
    expect(parsed.doors).toEqual({
      count: 142,
      doorFamilies: ["Door-Single-Flush", "Door-Double"],
    });
    expect(parsed.windows).toEqual({
      count: 106,
      windowFamilies: ["Window-Fixed", "Window-Sliding"],
    });
    expect(parsed.walls).toEqual({
      count: 1152,
      wallTypes: ["Block 37 Pilaster", "Core - Concrete 12\""],
      totalLengthFeet: 12750.2,
    });
    // The structural arrays may be shrunk by Phase 3 (or survive
    // intact if the Phase 1/2 drops alone freed enough budget); in
    // either case a non-empty leading slice must remain so chat can
    // still answer about the project's rooms / sheets / levels.
    expect(Array.isArray(parsed.rooms)).toBe(true);
    expect((parsed.rooms as unknown[]).length).toBeGreaterThan(0);
    expect(Array.isArray(parsed.sheets)).toBe(true);
    expect((parsed.sheets as unknown[]).length).toBeGreaterThan(0);
    expect(Array.isArray(parsed.levels)).toBe(true);
    expect((parsed.levels as unknown[]).length).toBeGreaterThan(0);
  });
});

/**
 * Validated high-priority top-level keys — the ones actually observed
 * in production `snapshots.payload` rows. Used by the fixture-driven
 * test above to assert no high-priority key is shed before any
 * validated low-priority key. Kept as a local constant (rather than
 * exporting it from the formatter) because it's a test-only invariant
 * — the formatter's HIGH_PRIORITY set intentionally includes
 * defensive entries that production hasn't exercised yet.
 */
const HIGH_PRIORITY_VALIDATED_KEYS = [
  "rooms",
  "sheets",
  "levels",
  "doors",
  "windows",
  "walls",
  "address",
  "projectName",
  "projectNumber",
  "documentTitle",
  "clientName",
] as const;

describe("formatSnapshotDiffBlock: pairwise per-entity diff (Task #54)", () => {
  // Sample payloads modelled after the real Revit ingest shape: rooms
  // keyed by `number` + a human `name`, sheets by `sheetNumber` +
  // `sheetName`, levels by `name`, walls by raw array. The diff helper
  // is supposed to collapse "what's in head but not base" into a
  // labelled added/removed list per bucket.
  const BASE_ID = "snap-base-1111";
  const HEAD_ID = "snap-head-2222";

  function payloadA() {
    return {
      rooms: [
        { number: "101", name: "Lobby" },
        { number: "102", name: "Office" },
        { number: "103", name: "Storage" },
      ],
      sheets: [
        { sheetNumber: "A101", sheetName: "First Floor Plan" },
        { sheetNumber: "A102", sheetName: "Second Floor Plan" },
      ],
      levels: [{ name: "L1" }, { name: "L2" }],
      walls: new Array(20).fill({}),
    };
  }
  function payloadB() {
    return {
      rooms: [
        { number: "101", name: "Lobby" }, // unchanged
        { number: "102", name: "Open Office" }, // renamed (key matches)
        { number: "104", name: "Mechanical" }, // added
        { number: "105", name: "Electrical" }, // added
      ],
      sheets: [
        { sheetNumber: "A101", sheetName: "First Floor Plan" },
        { sheetNumber: "A102", sheetName: "Second Floor Plan" },
        { sheetNumber: "A301", sheetName: "Roof Plan" }, // added
      ],
      levels: [{ name: "L1" }, { name: "L2" }, { name: "L3" }], // L3 added
      walls: new Array(35).fill({}),
    };
  }

  it("emits a `<snapshot_diff base='…' head='…'>` block with rooms/sheets/levels/walls deltas", () => {
    const block = formatSnapshotDiffBlock(
      { snapshotId: BASE_ID, payload: payloadA() },
      { snapshotId: HEAD_ID, payload: payloadB() },
    );
    expect(block).toContain(`<snapshot_diff base="${BASE_ID}" head="${HEAD_ID}">`);
    expect(block).toContain("</snapshot_diff>");
    // Rooms: 3 → 4 with two added (104, 105) and one removed (103). The
    // 102-name change is NOT counted as add/remove because the identity
    // key (`number`) matches.
    expect(block).toMatch(/Rooms: 3 → 4 \(\+2\/-1\)/);
    expect(block).toMatch(/added: 104 Mechanical; 105 Electrical/);
    expect(block).toMatch(/removed: 103 Storage/);
    // Sheets: 2 → 3, +1/-0
    expect(block).toMatch(/Sheets: 2 → 3 \(\+1\/-0\)/);
    expect(block).toMatch(/added: A301 Roof Plan/);
    // Levels: 2 → 3, +1/-0 (key == name → label collapses to bare key)
    expect(block).toMatch(/Levels: 2 → 3 \(\+1\/-0\)/);
    expect(block).toMatch(/added: L3/);
    // Walls: count-only, +15
    expect(block).toMatch(/Walls: 20 → 35 \(\+15\)/);
  });

  it("includes only per-bucket entries when at least one side has that bucket; skips buckets absent from both", () => {
    // Areas absent from both payloads → no Areas line. Walls present in
    // both → Walls line emitted even when delta is zero.
    const block = formatSnapshotDiffBlock(
      { snapshotId: BASE_ID, payload: { rooms: [], walls: [{}, {}] } },
      { snapshotId: HEAD_ID, payload: { rooms: [{ number: "1" }], walls: [{}, {}] } },
    );
    expect(block).toMatch(/Rooms: 0 → 1 \(\+1\/-0\)/);
    expect(block).toMatch(/Walls: 2 → 2 \(\+0\)/);
    expect(block).not.toMatch(/Areas:/);
    expect(block).not.toMatch(/Sheets:/);
    expect(block).not.toMatch(/Levels:/);
  });

  it("falls back through identity fields (number → id → name) so partial-shape payloads still diff", () => {
    // Some Revit pushes ship rooms keyed only by `id` (e.g. unplaced
    // rooms with no number assigned yet). The fallback chain should
    // pick `id` and still produce stable add/remove sets.
    const block = formatSnapshotDiffBlock(
      {
        snapshotId: "a",
        payload: {
          rooms: [
            { id: "uuid-aaa", name: "Room A" },
            { id: "uuid-bbb", name: "Room B" },
          ],
        },
      },
      {
        snapshotId: "b",
        payload: {
          rooms: [
            { id: "uuid-aaa", name: "Room A" },
            { id: "uuid-ccc", name: "Room C" },
          ],
        },
      },
    );
    expect(block).toMatch(/Rooms: 2 → 2 \(\+1\/-1\)/);
    expect(block).toMatch(/added: uuid-aaa Room A|added: uuid-ccc Room C/);
    expect(block).toMatch(/removed: uuid-bbb Room B/);
  });

  it("caps the inline label list at SNAPSHOT_DIFF_NAME_LIMIT and surfaces a `+N more` tail", () => {
    // Adding a whole floor of rooms (50+ entries) should not let the
    // diff block balloon — only the first N are listed by name and the
    // remainder collapse to `+N more`. The headline count is still
    // exact so the model can answer "how many rooms were added?"
    const big = Array.from({ length: SNAPSHOT_DIFF_NAME_LIMIT + 7 }, (_, i) => ({
      number: `9${String(i).padStart(2, "0")}`,
      name: `Room ${i}`,
    }));
    const block = formatSnapshotDiffBlock(
      { snapshotId: "a", payload: { rooms: [] } },
      { snapshotId: "b", payload: { rooms: big } },
    );
    expect(block).toMatch(
      new RegExp(`Rooms: 0 → ${big.length} \\(\\+${big.length}\\/-0\\)`),
    );
    expect(block).toMatch(new RegExp(`\\+${7} more`));
    // Bound: number of `;` separators in the added list is at most
    // (LIMIT - 1) + 1 (for the "+N more" suffix). Easier to check is
    // that the cap fired by counting the named entries:
    const addedLine = block.split("\n").find((l) => l.startsWith("  added:"))!;
    const named = addedLine.replace("  added: ", "").split("; ");
    // Last entry is `+7 more`; rest are real labels capped at LIMIT.
    expect(named).toHaveLength(SNAPSHOT_DIFF_NAME_LIMIT + 1);
    expect(named[named.length - 1]).toMatch(/^\+\d+ more$/);
  });

  it("emits the no-deltas placeholder when both sides match across every bucket", () => {
    const same = payloadA();
    const block = formatSnapshotDiffBlock(
      { snapshotId: "x", payload: same },
      { snapshotId: "y", payload: same },
    );
    // Each bucket still gets a headline (count → count, +0/-0) so the
    // model sees positive evidence of "nothing changed in rooms" rather
    // than ambiguous absence. Walls are count-only so they show 20 → 20.
    expect(block).toMatch(/Rooms: 3 → 3 \(\+0\/-0\)/);
    expect(block).toMatch(/Sheets: 2 → 2 \(\+0\/-0\)/);
    expect(block).toMatch(/Walls: 20 → 20 \(\+0\)/);
    expect(block).not.toMatch(/added:/);
    expect(block).not.toMatch(/removed:/);
  });
});

describe("formatSnapshotDiffBlocks: consecutive-pair sequencing (Task #54)", () => {
  it("returns [] for fewer than two payloads (single-snapshot turn has nothing to diff against)", () => {
    expect(formatSnapshotDiffBlocks([])).toEqual([]);
    expect(
      formatSnapshotDiffBlocks([{ snapshotId: "only", payload: {} }]),
    ).toEqual([]);
  });

  it("emits N-1 blocks for N payloads, in input order, each pair base→head", () => {
    // Three snapshots A→B→C means two diff blocks: A→B and B→C.
    // Star-diff against A would have produced A→B, A→C and lost the
    // incremental story — this test locks the consecutive-pair contract.
    const blocks = formatSnapshotDiffBlocks([
      { snapshotId: "snap-A", payload: { rooms: [{ number: "1" }] } },
      { snapshotId: "snap-B", payload: { rooms: [{ number: "1" }, { number: "2" }] } },
      { snapshotId: "snap-C", payload: { rooms: [{ number: "2" }, { number: "3" }] } },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('base="snap-A"');
    expect(blocks[0]).toContain('head="snap-B"');
    expect(blocks[1]).toContain('base="snap-B"');
    expect(blocks[1]).toContain('head="snap-C"');
  });
});

describe("buildChatPrompt: snapshot diff wiring (Task #54)", () => {
  it("does NOT emit a `<snapshot_diff>` block or instruction when only one focus snapshot is present", () => {
    // Single-snapshot focus mode is the original Task #39 path; no
    // diff makes sense. The Task #54 wiring must not regress it.
    const { systemPrompt } = buildChatPrompt({
      engagement: { name: "x", address: null, jurisdiction: null },
      latestSnapshot: {
        receivedAt: new Date("2026-04-01T12:00:00Z"),
        focusPayloads: [{ snapshotId: "lone", payload: { rooms: [] } }],
      },
      allAtoms: [],
      attachedSheets: [],
      question: "what changed?",
      now: () => new Date("2026-04-01T12:00:30Z"),
    });
    expect(systemPrompt).not.toContain("<snapshot_diff");
    expect(systemPrompt).not.toMatch(/snapshot_diff/);
  });

  it("emits one `<snapshot_diff>` per consecutive pair AND mentions the diff-block instruction when 2+ focus snapshots are present", () => {
    const { systemPrompt } = buildChatPrompt({
      engagement: { name: "x", address: null, jurisdiction: null },
      latestSnapshot: {
        receivedAt: new Date("2026-04-01T12:00:00Z"),
        focusPayloads: [
          { snapshotId: "snap-1", payload: { rooms: [{ number: "1" }] } },
          { snapshotId: "snap-2", payload: { rooms: [{ number: "1" }, { number: "2" }] } },
          { snapshotId: "snap-3", payload: { rooms: [{ number: "2" }] } },
        ],
      },
      allAtoms: [],
      attachedSheets: [],
      question: "compare",
      now: () => new Date("2026-04-01T12:00:30Z"),
    });
    // Two diff blocks for three snapshots, in order.
    const matches = systemPrompt.match(/<snapshot_diff [^>]*>/g) ?? [];
    expect(matches).toHaveLength(2);
    expect(matches[0]).toBe('<snapshot_diff base="snap-1" head="snap-2">');
    expect(matches[1]).toBe('<snapshot_diff base="snap-2" head="snap-3">');
    // Instruction line names the diff block so the model is steered
    // toward it rather than re-deriving deltas from the raw payloads.
    expect(systemPrompt).toMatch(/`<snapshot_diff>` block is also included/);
  });
});
