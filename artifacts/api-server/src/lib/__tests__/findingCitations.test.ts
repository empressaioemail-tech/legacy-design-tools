import { describe, expect, it } from "vitest";
import {
  buildFindingCitationsFromManualCreateBody,
  parseFindingCitationsArray,
  resolveOverrideFindingCitations,
} from "../findingCitations";

describe("findingCitations", () => {
  it("buildFindingCitationsFromManualCreateBody mirrors manual-create assembly", () => {
    expect(
      buildFindingCitationsFromManualCreateBody({
        codeCitation: "  code:section-1  ",
        sourceCitation: { id: "src-1", label: "Survey note" },
      }),
    ).toEqual([
      { kind: "code-section", atomId: "code:section-1" },
      { kind: "briefing-source", id: "src-1", label: "Survey note" },
    ]);
  });

  it("parseFindingCitationsArray rejects invalid wire shapes", () => {
    expect(parseFindingCitationsArray([{ kind: "code-section" }]).ok).toBe(
      false,
    );
    expect(parseFindingCitationsArray("not-array").ok).toBe(false);
  });

  it("resolveOverrideFindingCitations carries forward when body omits citations", () => {
    const original = [{ kind: "code-section" as const, atomId: "code:a" }];
    expect(
      resolveOverrideFindingCitations({
        bodyCitations: undefined,
        originalCitations: original,
      }),
    ).toEqual({ ok: true, citations: original });
  });

  it("resolveOverrideFindingCitations carries forward when body sends empty array", () => {
    const original = [{ kind: "code-section" as const, atomId: "code:a" }];
    expect(
      resolveOverrideFindingCitations({
        bodyCitations: [],
        originalCitations: original,
      }),
    ).toEqual({ ok: true, citations: original });
  });

  it("resolveOverrideFindingCitations replaces when body sends non-empty citations", () => {
    const replacement = [{ kind: "code-section" as const, atomId: "code:b" }];
    expect(
      resolveOverrideFindingCitations({
        bodyCitations: replacement,
        originalCitations: [{ kind: "code-section", atomId: "code:a" }],
      }),
    ).toEqual({ ok: true, citations: replacement });
  });
});
