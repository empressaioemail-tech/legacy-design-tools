import { describe, expect, it } from "vitest";

import {
  buildVocabularyResourceText,
  DERIVED_FIGURES_POLICY,
  registerVocabularyResource,
  STANDING_VOCAB_BLOCK_TEXT,
  STANDING_VOCAB_CONTENT_PART,
  VOCABULARY,
  VOCABULARY_MIME,
  VOCABULARY_RESOURCE_URI,
  WIRE_DISPOSITION_DISPLAY_TEXT,
  type VocabularyEntry,
} from "../src/vocabulary.js";

/**
 * V1 required coverage, per the P-91 v3 build plan: the disposition enum,
 * the refusal codes, the two Open failure strings, citationsDegraded,
 * confidence seed, edge role side_corner, and frame quality
 * gis-approximate. Every one of these was grepped out of the live source
 * (mcp-app.ts, tool-honesty.ts, tools.ts, and their tests, plus
 * api-server's parcelDrawStub.ts for the two upstream wire values) before
 * being added to VOCABULARY; this list is the coverage half of that check.
 */
const REQUIRED_TOKENS = [
  "present",
  "absent",
  "absent-verified",
  "unknown",
  "refused",
  "unread",
  "citationsDegraded",
  "gis-approximate",
  "seed",
  "side_corner",
  "atom_path_pending",
  "upgrade_required",
  "parcel_not_found",
  "baked_snapshot_not_found",
  "parcel_batch_cap",
  "open_did_not_reach_me",
  "depth_not_implemented",
  "declined-in-bake",
  "not-in-bake",
] as const;

function entryFor(token: string): VocabularyEntry {
  const entry = VOCABULARY.find((e) => e.token === token);
  if (!entry) throw new Error(`vocabulary: no entry for token "${token}"`);
  return entry;
}

describe("VOCABULARY (V1)", () => {
  it("has between 15 and 20 entries", () => {
    expect(VOCABULARY.length).toBeGreaterThanOrEqual(15);
    expect(VOCABULARY.length).toBeLessThanOrEqual(20);
  });

  it("every token is unique", () => {
    const tokens = VOCABULARY.map((e) => e.token);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("falsifier: the uniqueness check fails on a table with a repeated token", () => {
    const withDupe: VocabularyEntry[] = [
      ...VOCABULARY,
      { ...VOCABULARY[0]! },
    ];
    const tokens = withDupe.map((e) => e.token);
    expect(new Set(tokens).size).not.toBe(tokens.length);
  });

  it("every entry has a non-empty token, displayText, and meaning", () => {
    for (const entry of VOCABULARY) {
      expect(entry.token.length).toBeGreaterThan(0);
      expect(entry.displayText.length).toBeGreaterThan(0);
      expect(entry.meaning.length).toBeGreaterThan(0);
    }
  });

  it("covers every required token", () => {
    const tokens = new Set(VOCABULARY.map((e) => e.token));
    const missing = REQUIRED_TOKENS.filter((t) => !tokens.has(t));
    expect(missing).toEqual([]);
  });

  it("falsifier: the coverage check fails when a required token is dropped", () => {
    const withoutSideCorner = VOCABULARY.filter((e) => e.token !== "side_corner");
    const tokens = new Set(withoutSideCorner.map((e) => e.token));
    const missing = REQUIRED_TOKENS.filter((t) => !tokens.has(t));
    expect(missing).toEqual(["side_corner"]);
  });

  it("the two Open failure sentences stay distinct sentences (V1)", () => {
    // Hardcoded literals, not re-derived from the source constants: a test
    // that imports OPEN_DID_NOT_REACH_ME and NOT_ON_FILE_PREFIX and compares
    // the table against them is circular, and cannot fail when both sides
    // are wrong the same way.
    expect(entryFor("open_did_not_reach_me").displayText).toBe("Open did not reach me");
    expect(entryFor("parcel_not_found").displayText).toBe("Not on file in <county>");
    expect(entryFor("open_did_not_reach_me").displayText).not.toBe(
      entryFor("parcel_not_found").displayText,
    );
  });

  it("unknown's display text is the bare word, never a sentence a lay reader could mistake for a finding", () => {
    expect(entryFor("unknown").displayText).toBe("unknown");
    expect(entryFor("unknown").meaning).toContain("Not a finding either way");
  });

  it("absent, absent-verified, unread, and unknown are four distinct display strings", () => {
    const words = [
      entryFor("absent").displayText,
      entryFor("absent-verified").displayText,
      entryFor("unread").displayText,
      entryFor("unknown").displayText,
    ];
    expect(new Set(words).size).toBe(4);
    expect(words.sort()).toEqual(
      ["Reported absent", "absent, verified", "Not read", "unknown"].sort(),
    );
  });

  it("byte-matches the panel's own copy for tokens that have one (hardcoded, not re-derived)", () => {
    expect(entryFor("citationsDegraded").displayText).toBe("citation degraded");
    expect(entryFor("side_corner").displayText).toBe("corner side");
    expect(entryFor("atom_path_pending").displayText).toBe("Withheld, setbacks unruled");
    expect(entryFor("upgrade_required").displayText).toBe("Upgrade to open this parcel");
    expect(entryFor("depth_not_implemented").displayText).toBe("Not implemented");
    expect(entryFor("baked_snapshot_not_found").displayText).toBe(
      "No baked snapshot yet for <parcelNodeId>",
    );
  });

  it("WIRE_DISPOSITION_DISPLAY_TEXT has exactly the four wire disposition words, each distinct", () => {
    expect(WIRE_DISPOSITION_DISPLAY_TEXT).toEqual({
      present: "Present",
      refused: "Refused",
      absent: "Reported absent",
      unread: "Not read",
    });
    expect(new Set(Object.values(WIRE_DISPOSITION_DISPLAY_TEXT)).size).toBe(4);
  });
});

describe("DERIVED_FIGURES_POLICY (V5)", () => {
  it("is a fixed deny list with a reason, not a convention", () => {
    expect(DERIVED_FIGURES_POLICY).toEqual({
      denies: ["area", "coverage_ratio", "lot_coverage_pct", "setback_distance", "buildable_area"],
      reason:
        "ring, edges, and overlays are for rendering only. Do not compute an area, a coverage ratio, a percentage, or a distance from them; use a brief section's own figure, or say the figure is not on record.",
    });
  });

  it("denies area and coverage_ratio by name, the two figures a live session actually computed", () => {
    expect(DERIVED_FIGURES_POLICY.denies).toContain("area");
    expect(DERIVED_FIGURES_POLICY.denies).toContain("coverage_ratio");
  });
});

describe("buildVocabularyResourceText / registerVocabularyResource (V2, resource leg)", () => {
  it("the resource text is valid JSON carrying every VOCABULARY entry", () => {
    const parsed = JSON.parse(buildVocabularyResourceText()) as {
      vocabulary: VocabularyEntry[];
    };
    expect(parsed.vocabulary).toHaveLength(VOCABULARY.length);
    for (const token of REQUIRED_TOKENS) {
      expect(parsed.vocabulary.some((e) => e.token === token)).toBe(true);
    }
  });

  it("registers via registerResource with the documented URI and JSON mime type", async () => {
    let registered: { name: string; uri: string; config: Record<string, unknown> } | undefined;
    let read: { contents: Array<{ uri: string; mimeType: string; text: string }> } | undefined;
    const server = {
      registerResource: (
        name: string,
        uri: string,
        config: Record<string, unknown>,
        handler: (u: { href: string }) => Promise<{
          contents: Array<{ uri: string; mimeType: string; text: string }>;
        }>,
      ) => {
        registered = { name, uri, config };
        void handler({ href: uri }).then((r) => {
          read = r;
        });
      },
    };
    registerVocabularyResource(server);
    await new Promise((r) => setTimeout(r, 0));
    expect(registered?.uri).toBe(VOCABULARY_RESOURCE_URI);
    expect(registered?.config).toEqual({ mimeType: VOCABULARY_MIME });
    expect(read?.contents[0]?.mimeType).toBe(VOCABULARY_MIME);
    expect(read?.contents[0]?.uri).toBe(VOCABULARY_RESOURCE_URI);
    const body = JSON.parse(read?.contents[0]?.text ?? "{}") as { vocabulary: VocabularyEntry[] };
    expect(body.vocabulary.length).toBe(VOCABULARY.length);
  });

  it("falls back to the legacy resource() signature when registerResource is absent", async () => {
    let calledWith: string | undefined;
    const server = {
      resource: (_name: string, uri: string) => {
        calledWith = uri;
      },
    };
    registerVocabularyResource(server);
    expect(calledWith).toBe(VOCABULARY_RESOURCE_URI);
  });

  it("does nothing (does not throw) when the server object exposes neither signature", () => {
    expect(() => registerVocabularyResource({})).not.toThrow();
  });
});

describe("STANDING_VOCAB_CONTENT_PART (V2, standing-block leg)", () => {
  it("is a text content part carrying token/displayText/meaning triples only, plus the resource pointer", () => {
    expect(STANDING_VOCAB_CONTENT_PART.type).toBe("text");
    const parsed = JSON.parse(STANDING_VOCAB_CONTENT_PART.text) as {
      smartSiteVocabulary: Array<{ token: string; displayText: string; meaning: string }>;
      resource: string;
    };
    expect(parsed.resource).toBe(VOCABULARY_RESOURCE_URI);
    expect(parsed.smartSiteVocabulary.length).toBe(VOCABULARY.length);
    for (const row of parsed.smartSiteVocabulary) {
      expect(Object.keys(row).sort()).toEqual(["displayText", "meaning", "token"]);
    }
  });

  it("carries no behavioural instruction: no 'do not' imperative anywhere, sentence-initial or mid-sentence", () => {
    // Lookup only. agentGuidance is where instructions live (tool-honesty.ts,
    // attached per-facet, explicitly allowed to instruct); this block is not
    // that, and must not become it. "do not" has no natural descriptive
    // English use in this domain (a descriptive negative reads "does not"),
    // so it is a safe, low-false-positive proxy for "contains a command".
    const parsed = JSON.parse(STANDING_VOCAB_CONTENT_PART.text) as {
      smartSiteVocabulary: Array<{ meaning: string; displayText: string }>;
    };
    for (const row of parsed.smartSiteVocabulary) {
      expect(row.meaning.toLowerCase()).not.toMatch(/\bdo not\b/);
      expect(row.meaning).not.toMatch(/^\s*(Never |Always |Must )/);
      expect(row.displayText.toLowerCase()).not.toMatch(/\bdo not\b/);
    }
  });

  it("falsifier: the no-instruction check fails on a meaning carrying a 'do not' imperative, sentence-initial or mid-sentence", () => {
    expect("Do not ever say this out loud.".toLowerCase()).toMatch(/\bdo not\b/);
    expect("A present claim; do not invent a figure from it.".toLowerCase()).toMatch(/\bdo not\b/);
  });

  it("is byte-identical across repeated reads (computed once, no per-call field)", () => {
    const a = STANDING_VOCAB_CONTENT_PART.text;
    const b = STANDING_VOCAB_CONTENT_PART.text;
    expect(a).toBe(b);
    expect(a).toBe(STANDING_VOCAB_BLOCK_TEXT);
  });
});
