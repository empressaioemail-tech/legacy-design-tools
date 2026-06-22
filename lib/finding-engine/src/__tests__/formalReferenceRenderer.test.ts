import { describe, expect, it } from "vitest";
import {
  formatReferenceLine,
  renderFormalReferenceBlock,
} from "../formalReferenceRenderer";
import type { CodeReferenceEntry } from "../types";

const sample: CodeReferenceEntry = {
  atomId: "code-ibc-404",
  sectionIdentifier: "§404",
  sectionTitle: "Door Clearance",
  edition: "2021",
  sourceUrl: "https://example.test/ibc/404",
  codeTitle: "IBC",
};

describe("formalReferenceRenderer", () => {
  it("defaults to section number + heading + edition", () => {
    expect(formatReferenceLine(sample)).toBe(
      "IBC §404 — Door Clearance (2021)",
    );
  });

  it("supports alternate identifier formats as a render parameter", () => {
    expect(formatReferenceLine(sample, "section-number-only")).toBe("IBC §404");
    expect(formatReferenceLine(sample, "heading-edition")).toBe(
      "Door Clearance (2021)",
    );
    expect(formatReferenceLine(sample, "section-number-heading")).toBe(
      "IBC §404 — Door Clearance",
    );
  });

  it("renders a clean reference block without section bodies", () => {
    const block = renderFormalReferenceBlock([sample]);
    expect(block).toContain("References");
    expect(block).toContain("1. IBC §404 — Door Clearance (2021)");
    expect(block).not.toContain("https://");
  });

  it("returns empty string when there are no references", () => {
    expect(renderFormalReferenceBlock([])).toBe("");
  });
});
