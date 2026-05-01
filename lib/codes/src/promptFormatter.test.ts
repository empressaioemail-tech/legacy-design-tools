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
  relativeTime,
  MAX_ATOM_BODY_CHARS,
  MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS,
  MAX_SNAPSHOT_FOCUS_TOTAL_PAYLOAD_CHARS,
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
  // least `chars` characters long. We ship a single string field full
  // of `x`s; the JSON encoding adds a few bytes of overhead (field
  // name + quotes + braces + indentation) so the resulting block is
  // always strictly larger than the requested `chars` value.
  function payloadOfRoughSize(
    chars: number,
  ): { canary: string; blob: string } {
    return { canary: "CANARY", blob: "x".repeat(chars) };
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
