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
    const got = parseInlineReferences("see {{atom:task:t1:Pick HVAC}}.");
    expect(got).toHaveLength(3);
    expect(got[0]).toEqual({ kind: "text", text: "see " });
    expect(got[1]).toMatchObject({
      kind: "atom",
      raw: "{{atom:task:t1:Pick HVAC}}",
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
    const text = "{{atom:a:1:A}}{{atom:b:2:B}} mid {{atom:c:3:C}}";
    const got = parseInlineReferences(text);
    expect(got.filter((s) => s.kind === "atom")).toHaveLength(3);
  });

  it("falls through malformed markers as plain text", () => {
    const got = parseInlineReferences("oops {{atom:onlyone}} done");
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({
      kind: "text",
      text: "oops {{atom:onlyone}} done",
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
    expect(text).toBe("{{atom:task:t1:t1}}");
  });
});
