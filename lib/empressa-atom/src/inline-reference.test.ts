import { describe, it, expect } from "vitest";
import {
  parseInlineReferences,
  serializeInlineReference,
} from "./inline-reference";

describe("parseInlineReferences", () => {
  it("returns a single text segment when there are no references", () => {
    const got = parseInlineReferences("plain prose with no markers");
    expect(got).toEqual([
      { kind: "text", text: "plain prose with no markers" },
    ]);
  });

  it("returns [] for an empty string", () => {
    expect(parseInlineReferences("")).toEqual([]);
  });

  it("parses a single reference", () => {
    const got = parseInlineReferences("see {{atom|task|t1|Pick HVAC}}.");
    expect(got).toHaveLength(3);
    expect(got[0]).toEqual({ kind: "text", text: "see " });
    expect(got[1]).toMatchObject({
      kind: "atom",
      raw: "{{atom|task|t1|Pick HVAC}}",
      reference: {
        kind: "atom",
        entityType: "task",
        entityId: "t1",
        displayLabel: "Pick HVAC",
      },
    });
    expect(got[2]).toEqual({ kind: "text", text: "." });
  });

  it("parses many references with empty separators preserved", () => {
    const text = "{{atom|a|1|A}}{{atom|b|2|B}} mid {{atom|c|3|C}}";
    const got = parseInlineReferences(text);
    expect(got.filter((s) => s.kind === "atom")).toHaveLength(3);
  });

  it("falls through malformed markers as plain text", () => {
    const got = parseInlineReferences("oops {{atom|onlyone}} done");
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({
      kind: "text",
      text: "oops {{atom|onlyone}} done",
    });
  });

  it("round-trips through serializeInlineReference", () => {
    const ref = {
      kind: "atom" as const,
      entityType: "decision",
      entityId: "d1",
      displayLabel: "Pick HVAC vendor",
    };
    const text = serializeInlineReference(ref);
    const parsed = parseInlineReferences(text);
    expect(parsed).toHaveLength(1);
    if (parsed[0]?.kind === "atom") {
      expect(parsed[0].reference.entityType).toBe(ref.entityType);
      expect(parsed[0].reference.entityId).toBe(ref.entityId);
      expect(parsed[0].reference.displayLabel).toBe(ref.displayLabel);
    }
  });

  it("uses entityId for the label when displayLabel is missing", () => {
    const text = serializeInlineReference({
      kind: "atom",
      entityType: "task",
      entityId: "t1",
    });
    expect(text).toBe("{{atom|task|t1|t1}}");
  });

  it("round-trips a Spec 51 colon-bearing entityId (DA-PI-1F1: the case the `|` delimiter exists to support)", () => {
    // Real-shape Spec 51 entityIds embed `:` themselves (parcel-briefing,
    // intent, briefing-source, neighboring-context). Pre-DA-PI-1F1 the
    // `:`-delimited token shape collided with these and the third+
    // colon in the input was treated as a delimiter, splitting the id
    // across the entityId and displayLabel slots. The `|` delimiter
    // makes them round-trip losslessly. This test is the positive
    // proof: if a future change reintroduces a `:`-sensitive parser,
    // this assertion fails before the regression ships.
    const ref = {
      kind: "atom" as const,
      entityType: "parcel-briefing",
      entityId: "parcel-briefing:p-001:hash-abc",
      displayLabel: "Brief for parcel p-001",
    };
    const text = serializeInlineReference(ref);
    expect(text).toBe(
      "{{atom|parcel-briefing|parcel-briefing:p-001:hash-abc|Brief for parcel p-001}}",
    );
    const parsed = parseInlineReferences(text);
    expect(parsed).toHaveLength(1);
    if (parsed[0]?.kind === "atom") {
      expect(parsed[0].reference.entityType).toBe("parcel-briefing");
      expect(parsed[0].reference.entityId).toBe(
        "parcel-briefing:p-001:hash-abc",
      );
      expect(parsed[0].reference.displayLabel).toBe(
        "Brief for parcel p-001",
      );
    }
  });

  it("old-shape {{atom:...}} tokens do not parse (no dual-parse contract)", () => {
    // DA-PI-1F1 contract enforcement. The token shape changed from
    // `{{atom:type:id:label}}` (colon-delimited) to
    // `{{atom|type|id|label}}` (pipe-delimited) precisely so colon-
    // bearing Spec 51 entityIds stop colliding with the delimiter.
    // We deliberately do NOT support dual-parse / backward-compat:
    // an old-shape token in chat content is treated as opaque prose
    // and falls through as a single text segment. If a well-meaning
    // future PR adds backward-compat parsing for the old delimiter,
    // this test fails — that's the regression guard. Future agents
    // reading this test name should understand it's the contract
    // enforcement, not a typo.
    const oldShape = "see {{atom:task:t1:Pick HVAC}} please";
    const got = parseInlineReferences(oldShape);
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({ kind: "text", text: oldShape });
  });
});
